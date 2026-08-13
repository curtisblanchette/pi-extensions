/**
 * pi-extension-rag
 *
 * Project-local RAG over raw documents.
 * Embeddings: Ollama (default: nomic-embed-text).
 * Storage:    better-sqlite3 metadata + turbovec vectors under .pi/rag/.
 *
 * Commands:
 *   /rag-setup     Interactive setup wizard (first-run / full reconfigure)
 *   /rag-config    Settings menu — edit any single config field via TUI
 *   /rag-index     (Re)index the configured folder (incremental via hash dedup)
 *   /rag <query>   Search and print top-k snippets to the TUI
 *   /rag-status    Show config + index stats
 *   /rag-reset     Delete the local RAG database
 *
 * Agent tool:
 *   rag_search     LLM-callable search; returns chunks + metadata for in-conversation RAG
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { RagConfig, RagPaths } from "./config.js";
import { configExists, DEFAULT_CONFIG, loadConfig, ragPaths, saveConfig } from "./config.js";
import { openDb, type SearchHit } from "./db.js";
import { detectDim, embedBatch, EmbedError, pingModel } from "./embed.js";
import { runConfigMenu } from "./configMenu.js";
import { runIndex } from "./pipeline.js";
import { runSetup } from "./setup.js";

const STATUS_ID = "rag";

export default function (pi: ExtensionAPI) {
	// -------------------------------------------------------------------------
	// /rag-setup
	// -------------------------------------------------------------------------
	pi.registerCommand("rag-setup", {
		description: "Configure project-local RAG (folder, Ollama model, chunking)",
		handler: async (_args, ctx) => {
			const paths = ragPaths(ctx.cwd);
			const result = await runSetup(ctx as unknown as Parameters<typeof runSetup>[0], paths, ctx.cwd);
			if (result.cancelled) {
				ctx.ui.notify(`Setup cancelled${result.reasonOrNote ? ` — ${result.reasonOrNote}` : ""}`, "info");
				return;
			}
			if (!result.cfg) return;
			ctx.ui.notify(
				`RAG configured. Folder: ${result.cfg.folder}, model: ${result.cfg.model}, dim: ${result.cfg.dim ?? "?"}`,
				"info",
			);
			const runNow = await ctx.ui.confirm("Index now?", `Run a first index of ${result.cfg.folder}/ ?`);
			if (runNow) {
				await doIndex(ctx, paths, result.cfg);
			}
		},
	});

	// -------------------------------------------------------------------------
	// /rag-config
	// -------------------------------------------------------------------------
	pi.registerCommand("rag-config", {
		description: "Edit individual RAG settings via TUI menu",
		handler: async (_args, ctx) => {
			const paths = ragPaths(ctx.cwd);
			if (!loadConfig(paths)) {
				const setup = await ctx.ui.confirm("No RAG config", "This project has no RAG config yet. Run /rag-setup now?");
				if (!setup) return;
				const result = await runSetup(ctx as unknown as Parameters<typeof runSetup>[0], paths, ctx.cwd);
				if (result.cancelled || !result.cfg) {
					ctx.ui.notify("Setup cancelled.", "info");
					return;
				}
			}
			await runConfigMenu(ctx as unknown as Parameters<typeof runConfigMenu>[0], paths);
		},
	});

	// -------------------------------------------------------------------------
	// /rag-index
	// -------------------------------------------------------------------------
	pi.registerCommand("rag-index", {
		description: "(Re)index the configured folder (incremental via hash dedup)",
		handler: async (args, ctx) => {
			const paths = ragPaths(ctx.cwd);
			const cfg = await loadOrPrompt(ctx, paths);
			if (!cfg) return;
			const force = args?.trim() === "--force";
			await doIndex(ctx, paths, cfg, { force });
		},
	});

	// -------------------------------------------------------------------------
	// /rag <query>
	// -------------------------------------------------------------------------
	pi.registerCommand("rag", {
		description: "Search the local RAG index (top-k snippets)",
		handler: async (args, ctx) => {
			const query = args?.trim();
			if (!query) {
				ctx.ui.notify("Usage: /rag <query>", "warning");
				return;
			}
			const paths = ragPaths(ctx.cwd);
			const cfg = loadConfig(paths);
			if (!cfg || !cfg.dim) {
				ctx.ui.notify("RAG not configured. Run /rag-setup first.", "warning");
				return;
			}
			try {
				const hits = await searchOnce(cfg, paths, query, 6);
				if (hits.length === 0) {
					ctx.ui.notify("No results.", "info");
					return;
				}
				const lines = hits.map((h, i) => formatHitForTui(h, i + 1));
				// Notify with the first hit; print full list as a widget for browsing.
				ctx.ui.notify(`${hits.length} hits — top: ${hits[0].path}`, "info");
				for (const line of lines) {
					// Multi-line notify isn't great; print to stderr-ish via setStatus
					console.log(line);
					console.log("");
				}
			} catch (err) {
				ctx.ui.notify(`Search failed: ${(err as Error).message}`, "error");
			}
		},
	});

	// -------------------------------------------------------------------------
	// /rag-status
	// -------------------------------------------------------------------------
	pi.registerCommand("rag-status", {
		description: "Show RAG config and index stats",
		handler: async (_args, ctx) => {
			const paths = ragPaths(ctx.cwd);
			const cfg = loadConfig(paths);
			if (!cfg) {
				ctx.ui.notify("No RAG config in this project. Run /rag-setup.", "info");
				return;
			}
			const lines = [
				`folder:    ${cfg.folder}`,
				`formats:   ${cfg.formats.join(" ")}`,
				`exclude:   ${cfg.exclude.length > 0 ? cfg.exclude.join(" ") : "(none)"}`,
				`provider:  ${cfg.provider}`,
				`model:     ${cfg.model}`,
				`ollama:    ${cfg.ollamaUrl}`,
				`dim:       ${cfg.dim ?? "(not detected)"}`,
				`chunk:     ${cfg.chunkTokens} tokens, ${cfg.chunkOverlap} overlap`,
				`turbovec:  ${cfg.bitWidth}-bit`,
				`db:        ${paths.dbFile}`,
				`index:     ${paths.indexFile}`,
			];

			if (cfg.dim && fs.existsSync(paths.dbFile)) {
				try {
					const db = await openDb(paths, cfg.dim, cfg.bitWidth);
					const s = db.stats();
					const vectors = s.vectorCount == null ? "?" : String(s.vectorCount);
					lines.push(`indexed:   ${s.fileCount} files, ${s.chunkCount} chunks, ${vectors} vectors`);
					db.close();
				} catch (err) {
					lines.push(`indexed:   <error opening db: ${(err as Error).message}>`);
				}
			} else {
				lines.push(`indexed:   (no DB yet — run /rag-index)`);
			}

			for (const line of lines) console.log(line);
			ctx.ui.notify(`RAG status printed (${lines.length} lines).`, "info");
		},
	});

	// -------------------------------------------------------------------------
	// /rag-reset
	// -------------------------------------------------------------------------
	pi.registerCommand("rag-reset", {
		description: "Delete the local RAG database (keeps config)",
		handler: async (_args, ctx) => {
			const paths = ragPaths(ctx.cwd);
			const ok = await ctx.ui.confirm(
				"Wipe RAG index?",
				`Delete ${paths.dbFile} and ${paths.indexFile}? Config will be preserved.`,
			);
			if (!ok) return;
			for (const f of [paths.dbFile, `${paths.dbFile}-shm`, `${paths.dbFile}-wal`, paths.indexFile]) {
				if (fs.existsSync(f)) {
					try {
						fs.unlinkSync(f);
					} catch (err) {
						ctx.ui.notify(`Failed to delete ${f}: ${(err as Error).message}`, "error");
					}
				}
			}
			ctx.ui.notify("RAG index wiped.", "info");
		},
	});

	// -------------------------------------------------------------------------
	// Tool: rag_search (LLM-callable)
	// -------------------------------------------------------------------------
	pi.registerTool({
		name: "rag_search",
		label: "RAG Search",
		description:
			"Semantic search over the project's local RAG index of raw documents. " +
			"Use to retrieve grounded snippets from the user's own files (PDF, DOCX, Markdown, text) " +
			"before answering questions about the project's documents. Returns top-k chunks with file path, " +
			"header path, page (if PDF), token count, and a similarity score in [-1, 1] (higher = better).",
		promptSnippet: "Search the project's local document RAG index (turbovec + Ollama embeddings).",
		promptGuidelines: [
			"Prefer rag_search over reading files blindly when answering questions about project documents, briefs, or the raw/ folder.",
			"Cite the returned `path` (and `header_path` or `page` when present) in your response so the user can verify.",
			"If rag_search returns zero results, tell the user the index may not be built (suggest /rag-setup then /rag-index).",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Natural-language search query" }),
			k: Type.Optional(
				Type.Number({
					description: "Number of top results to return (default 8, max 30)",
					default: 8,
				}),
			),
			formats: Type.Optional(
				Type.Array(Type.String(), {
					description: "Filter to specific file extensions, e.g. ['.md', '.pdf']",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const cwd = ctx.cwd;
			const paths = ragPaths(cwd);
			const cfg = loadConfig(paths);
			if (!cfg) {
				throw new Error("RAG is not configured for this project. Run /rag-setup, then /rag-index.");
			}
			if (!cfg.dim) {
				throw new Error(
					"RAG config exists but no embedding dimension was detected. Run /rag-index to build the index.",
				);
			}

			const k = Math.max(1, Math.min(30, params.k ?? 8));
			const formats = (params.formats ?? []).map((f) => (f.startsWith(".") ? f.toLowerCase() : `.${f.toLowerCase()}`));

			try {
				const hits = await searchOnce(cfg, paths, params.query, k, formats, signal);
				if (hits.length === 0) {
					return {
						content: [
							{
								type: "text" as const,
								text: `No matches for "${params.query}" in the local RAG index. Confirm the index is built (\`/rag-status\`).`,
							},
						],
						details: { results: [], query: params.query, k },
					};
				}
				const fullOutput = hits.map((h, i) => formatHitForLLM(h, i + 1)).join("\n\n---\n\n");
				const output = truncateHead(fullOutput, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
				const text = output.truncated
					? `${output.content}\n\n[Output truncated: ${output.outputLines} of ${output.totalLines} lines (${output.outputBytes} of ${output.totalBytes} bytes). Refine the query or reduce k.]`
					: output.content;
				return {
					content: [{ type: "text" as const, text }],
					details: {
						query: params.query,
						k,
						count: hits.length,
						truncated: output.truncated,
						results: hits.map((h) => ({
							path: h.path,
							chunk_index: h.chunk_index,
							header_path: h.header_path,
							page: h.page,
							format: h.format,
							score: Number(h.score.toFixed(4)),
						})),
					},
				};
			} catch (err) {
				throw new Error(`rag_search failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
			}
		},
	});
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function searchOnce(
	cfg: RagConfig,
	paths: RagPaths,
	query: string,
	k: number,
	formats?: string[],
	signal?: AbortSignal,
): Promise<SearchHit[]> {
	const [queryVec] = await embedBatch(cfg, [query], signal);
	const db = await openDb(paths, cfg.dim!, cfg.bitWidth);
	try {
		return db.search(queryVec, k, formats);
	} finally {
		db.close();
	}
}

async function loadOrPrompt(
	ctx: Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1],
	paths: RagPaths,
): Promise<RagConfig | null> {
	let cfg = loadConfig(paths);
	if (!cfg) {
		const setup = await ctx.ui.confirm("No RAG config", "This project has no RAG config yet. Run /rag-setup now?");
		if (!setup) return null;
		const result = await runSetup(ctx as unknown as Parameters<typeof runSetup>[0], paths, ctx.cwd);
		if (result.cancelled || !result.cfg) return null;
		cfg = result.cfg;
	}
	return cfg;
}

async function doIndex(
	ctx: Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1],
	paths: RagPaths,
	cfgIn: RagConfig,
	opts: { force?: boolean } = {},
): Promise<void> {
	let cfg = cfgIn;

	// Sanity: ping Ollama and the model. Detect dim if missing.
	try {
		await pingModel(cfg);
	} catch (err) {
		if (err instanceof EmbedError) {
			ctx.ui.notify(err.message, "error");
			return;
		}
		throw err;
	}

	if (!cfg.dim) {
		try {
			ctx.ui.setStatus(STATUS_ID, "Probing embedding dim…");
			const dim = await detectDim(cfg);
			cfg = { ...cfg, dim };
			saveConfig(paths, cfg);
			ctx.ui.setStatus(STATUS_ID, undefined);
		} catch (err) {
			ctx.ui.setStatus(STATUS_ID, undefined);
			ctx.ui.notify(`Failed to detect embedding dim: ${(err as Error).message}`, "error");
			return;
		}
	}

	ctx.ui.notify(`Indexing ${cfg.folder}/ …`, "info");
	ctx.ui.setStatus(STATUS_ID, "Indexing…");
	try {
		const result = await runIndex(cfg, paths, {
			force: opts.force,
			onProgress: (p) => {
				const tail = p.currentFile ? ` — ${p.currentFile}` : "";
				ctx.ui.setStatus(STATUS_ID, `RAG ${p.scanned}/${p.total} · +${p.added} ~${p.updated} =${p.unchanged}${tail}`);
			},
		});
		ctx.ui.setStatus(STATUS_ID, undefined);
		const errSuffix = result.errors.length > 0 ? ` · ${result.errors.length} errors` : "";
		ctx.ui.notify(
			`Indexed ${result.files} files: +${result.added} added, ~${result.updated} updated, =${result.unchanged} unchanged, −${result.deleted} removed, ${result.chunks} chunks${errSuffix}`,
			result.errors.length > 0 ? "warning" : "info",
		);
		for (const e of result.errors) {
			console.log(`  ERROR ${e.path}: ${e.error}`);
		}
	} catch (err) {
		ctx.ui.setStatus(STATUS_ID, undefined);
		ctx.ui.notify(`Indexing failed: ${(err as Error).message}`, "error");
	}
}

function formatHitForTui(h: SearchHit, n: number): string {
	const locator = locatorString(h);
	const score = (h.score * 100).toFixed(1);
	const snippet = truncate(h.text.replace(/\s+/g, " "), 240);
	return `[${n}] (${score}%) ${h.path}${locator}\n    ${snippet}`;
}

function formatHitForLLM(h: SearchHit, n: number): string {
	const meta: string[] = [`path=${h.path}`, `chunk=${h.chunk_index}`, `score=${h.score.toFixed(4)}`];
	if (h.header_path) meta.push(`section="${h.header_path}"`);
	if (h.page != null) meta.push(`page=${h.page}`);
	return `### Result ${n}\n${meta.join(" · ")}\n\n${h.text.trim()}`;
}

function locatorString(h: SearchHit): string {
	const bits: string[] = [];
	if (h.header_path) bits.push(`#${h.header_path}`);
	if (h.page != null) bits.push(`p.${h.page}`);
	bits.push(`chunk ${h.chunk_index}`);
	return bits.length > 0 ? `  (${bits.join(" · ")})` : "";
}

function truncate(s: string, n: number): string {
	if (s.length <= n) return s;
	return s.slice(0, n - 1).trimEnd() + "…";
}

// silence unused import warnings for future extension surface
void DEFAULT_CONFIG;
void configExists;
void path;
