import * as fs from "node:fs";
import * as path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import type { RagConfig, RagPaths } from "./config.js";
import { DEFAULT_CONFIG, loadConfig, ragPaths, saveConfig } from "./config.js";
import { openDb, type SearchHit } from "./db.js";
import { detectDim, embedBatch, pingModel } from "./embed.js";
import { runIndex } from "./pipeline.js";

const server = new McpServer({
	name: "rag",
	version: "0.1.0",
});

function rootFrom(inputRoot?: string): string {
	return (
		inputRoot ||
		process.env.CLAUDE_PROJECT_DIR ||
		process.env.MCP_PROJECT_ROOT ||
		process.env.PROJECT_ROOT ||
		process.cwd()
	);
}

function textResult(text: string, isError = false) {
	return {
		content: [{ type: "text" as const, text }],
		...(isError ? { isError: true } : {}),
	};
}

function jsonResult(value: unknown, isError = false) {
	return textResult(JSON.stringify(value, null, 2), isError);
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function normalizeFormats(formats: string[]): string[] {
	return [
		...new Set(
			formats
				.map((f) => f.trim().toLowerCase())
				.filter(Boolean)
				.map((f) => (f.startsWith(".") ? f : `.${f}`)),
		),
	];
}

function cloneDefaultConfig(): RagConfig {
	return {
		...DEFAULT_CONFIG,
		formats: [...DEFAULT_CONFIG.formats],
		exclude: [...DEFAULT_CONFIG.exclude],
	};
}

async function loadConfigured(paths: RagPaths): Promise<RagConfig | null> {
	const cfg = loadConfig(paths);
	return cfg ? { ...cfg, formats: [...cfg.formats], exclude: [...cfg.exclude] } : null;
}

async function ensureIndexableConfig(paths: RagPaths, cfg: RagConfig, signal?: AbortSignal): Promise<RagConfig> {
	await pingModel(cfg, signal);
	if (cfg.dim) return cfg;

	const dim = await detectDim(cfg, signal);
	const next = { ...cfg, dim };
	saveConfig(paths, next);
	return next;
}

function formatHit(h: SearchHit, n: number): string {
	const bits = [`path=${h.path}`, `chunk=${h.chunk_index}`, `score=${h.score.toFixed(4)}`];
	if (h.header_path) bits.push(`section="${h.header_path}"`);
	if (h.page != null) bits.push(`page=${h.page}`);
	if ("token_count" in h && typeof h.token_count === "number") bits.push(`tokens=${h.token_count}`);
	return `### Result ${n}\n${bits.join(" · ")}\n\n${h.text.trim()}`;
}

server.registerTool(
	"rag_search",
	{
		title: "RAG Search",
		description:
			"Semantic search over the current project's local .pi/rag index. Use before answering questions about docs, specs, briefs, raw files, or prior decisions.",
		inputSchema: {
			query: z.string().min(1),
			k: z.number().min(1).max(30).default(8).optional(),
			formats: z.array(z.string()).optional(),
			root: z.string().optional(),
		},
	},
	async ({ query, k = 8, formats = [], root }, extra) => {
		const cwd = rootFrom(root);
		const paths = ragPaths(cwd);
		const cfg = await loadConfigured(paths);

		if (!cfg) {
			return textResult(
				`RAG not configured at ${paths.configFile}. Create it manually or call rag_config_write.`,
				true,
			);
		}

		if (!cfg.dim) {
			return textResult(
				"RAG config exists but dim is missing. Run rag_index first, or call rag_config_write with probeDim=true.",
				true,
			);
		}

		if (!fs.existsSync(paths.dbFile)) {
			return textResult(`RAG database not found at ${paths.dbFile}. Run rag_index first.`, true);
		}

		try {
			const [queryVec] = await embedBatch(cfg, [query], extra?.signal);
			const db = await openDb(paths, cfg.dim, cfg.bitWidth);
			try {
				const hits = db.search(queryVec, k, normalizeFormats(formats));
				if (hits.length === 0) {
					return textResult(`No matches for "${query}" in ${paths.dbFile}.`);
				}
				return textResult(hits.map((h, i) => formatHit(h, i + 1)).join("\n\n---\n\n"));
			} finally {
				db.close();
			}
		} catch (err) {
			return textResult(`rag_search failed: ${errorMessage(err)}`, true);
		}
	},
);

server.registerTool(
	"rag_status",
	{
		title: "RAG Status",
		description: "Show current project's RAG config and index stats.",
		inputSchema: {
			root: z.string().optional(),
		},
	},
	async ({ root }) => {
		const cwd = rootFrom(root);
		const paths = ragPaths(cwd);
		const cfg = await loadConfigured(paths);

		if (!cfg) {
			return jsonResult({
				root: cwd,
				configured: false,
				configFile: paths.configFile,
				db: paths.dbFile,
				index: paths.indexFile,
			});
		}

		let indexed: string;
		if (!cfg.dim) {
			indexed = "no dim in config";
		} else if (!fs.existsSync(paths.dbFile)) {
			indexed = "no db";
		} else {
			let db: Awaited<ReturnType<typeof openDb>> | undefined;
			try {
				db = await openDb(paths, cfg.dim, cfg.bitWidth);
				const s = db.stats();
				const vectors = s.vectorCount == null ? "?" : String(s.vectorCount);
				indexed = `${s.fileCount} files, ${s.chunkCount} chunks, ${vectors} vectors`;
			} catch (err) {
				indexed = `error: ${errorMessage(err)}`;
			} finally {
				db?.close();
			}
		}

		return jsonResult({
			root: cwd,
			configured: true,
			configFile: paths.configFile,
			config: cfg,
			db: paths.dbFile,
			index: paths.indexFile,
			dbExists: fs.existsSync(paths.dbFile),
			indexExists: fs.existsSync(paths.indexFile),
			indexed,
		});
	},
);

server.registerTool(
	"rag_index",
	{
		title: "RAG Index",
		description: "Index or re-index the current project's configured RAG folder.",
		inputSchema: {
			root: z.string().optional(),
			force: z.boolean().default(false).optional(),
		},
	},
	async ({ root, force = false }, extra) => {
		const cwd = rootFrom(root);
		const paths = ragPaths(cwd);
		const cfg = await loadConfigured(paths);

		if (!cfg) {
			return textResult(
				`RAG config missing at ${paths.configFile}. Create it manually or call rag_config_write first.`,
				true,
			);
		}

		try {
			const ready = await ensureIndexableConfig(paths, cfg, extra?.signal);
			const started = Date.now();
			const result = await runIndex(ready, paths, { force, signal: extra?.signal });
			return jsonResult({ root: cwd, db: paths.dbFile, durationMs: Date.now() - started, result });
		} catch (err) {
			return textResult(`rag_index failed: ${errorMessage(err)}`, true);
		}
	},
);

server.registerTool(
	"rag_reset",
	{
		title: "RAG Reset",
		description: "Delete the current project's local RAG database. Keeps .pi/rag/config.json.",
		inputSchema: {
			root: z.string().optional(),
			confirm: z.boolean().default(false).optional(),
		},
	},
	async ({ root, confirm = false }) => {
		const cwd = rootFrom(root);
		const paths = ragPaths(cwd);

		if (!confirm) {
			return textResult("Refusing to delete the RAG database without confirm=true.", true);
		}

		const deleted: string[] = [];
		const missing: string[] = [];
		const errors: Array<{ path: string; error: string }> = [];

		for (const file of [paths.dbFile, `${paths.dbFile}-shm`, `${paths.dbFile}-wal`, paths.indexFile]) {
			if (!fs.existsSync(file)) {
				missing.push(file);
				continue;
			}
			try {
				fs.unlinkSync(file);
				deleted.push(file);
			} catch (err) {
				errors.push({ path: file, error: errorMessage(err) });
			}
		}

		return jsonResult({ root: cwd, db: paths.dbFile, deleted, missing, errors }, errors.length > 0);
	},
);

server.registerTool(
	"rag_config_write",
	{
		title: "RAG Config Write",
		description: "Create or update .pi/rag/config.json without using pi's interactive setup UI.",
		inputSchema: {
			root: z.string().optional(),
			reset: z.boolean().default(false).optional(),
			folder: z.string().optional(),
			formats: z.array(z.string()).optional(),
			exclude: z.array(z.string()).optional(),
			ollamaUrl: z.string().optional(),
			model: z.string().optional(),
			dim: z.number().int().positive().nullable().optional(),
			bitWidth: z.union([z.literal(2), z.literal(3), z.literal(4)]).optional(),
			chunkTokens: z.number().int().min(100).max(4000).optional(),
			chunkOverlap: z.number().int().min(0).optional(),
			createFolder: z.boolean().default(false).optional(),
			probeDim: z.boolean().default(false).optional(),
		},
	},
	async (args, extra) => {
		const cwd = rootFrom(args.root);
		const paths = ragPaths(cwd);
		const existing = args.reset ? null : await loadConfigured(paths);
		let cfg: RagConfig = existing ?? cloneDefaultConfig();

		if (args.folder !== undefined) {
			const folder = args.folder.trim() || DEFAULT_CONFIG.folder;
			if (path.isAbsolute(folder)) {
				return textResult("folder must be relative to the project root.", true);
			}
			cfg = { ...cfg, folder };
		}

		if (args.formats !== undefined) {
			const formats = normalizeFormats(args.formats);
			if (formats.length === 0) return textResult("formats must contain at least one extension.", true);
			cfg = { ...cfg, formats };
		}

		if (args.exclude !== undefined) {
			cfg = { ...cfg, exclude: args.exclude.map((s) => s.trim()).filter(Boolean) };
		}

		if (args.ollamaUrl !== undefined) {
			cfg = { ...cfg, ollamaUrl: args.ollamaUrl.trim() || DEFAULT_CONFIG.ollamaUrl };
		}

		const modelChanged = args.model !== undefined && args.model.trim() !== cfg.model;
		if (args.model !== undefined) {
			cfg = { ...cfg, model: args.model.trim() || DEFAULT_CONFIG.model };
		}

		if (args.bitWidth !== undefined) {
			cfg = { ...cfg, bitWidth: args.bitWidth };
		}

		if (args.chunkTokens !== undefined) {
			cfg = { ...cfg, chunkTokens: args.chunkTokens };
		}

		if (args.chunkOverlap !== undefined) {
			const maxOverlap = Math.floor(cfg.chunkTokens / 2);
			if (args.chunkOverlap > maxOverlap) {
				return textResult(`chunkOverlap must be <= half of chunkTokens (${maxOverlap}).`, true);
			}
			cfg = { ...cfg, chunkOverlap: args.chunkOverlap };
		} else if (cfg.chunkOverlap > Math.floor(cfg.chunkTokens / 2)) {
			cfg = { ...cfg, chunkOverlap: Math.floor(cfg.chunkTokens / 2) };
		}

		if (args.dim !== undefined) {
			cfg = { ...cfg, dim: args.dim };
		} else if (modelChanged) {
			cfg = { ...cfg, dim: null };
		}

		if (args.createFolder) {
			fs.mkdirSync(path.resolve(cwd, cfg.folder), { recursive: true });
		}

		if (args.probeDim) {
			try {
				const dim = await detectDim(cfg, extra?.signal);
				cfg = { ...cfg, dim };
			} catch (err) {
				return textResult(`Failed to probe embedding dim: ${errorMessage(err)}`, true);
			}
		}

		saveConfig(paths, cfg);
		return jsonResult({ root: cwd, configFile: paths.configFile, config: cfg });
	},
);

await server.connect(new StdioServerTransport());
