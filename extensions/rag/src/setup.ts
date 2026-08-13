/**
 * Interactive setup wizard. Uses ctx.ui dialogs (works in any interactive mode).
 */
import * as fs from "node:fs";
import * as path from "node:path";

import type { RagConfig, RagPaths } from "./config.js";
import { DEFAULT_CONFIG, loadConfig, saveConfig } from "./config.js";
import { ensureTurbovecInstalled } from "./db.js";
import { detectDim, listModels } from "./embed.js";

interface SetupCtx {
	ui: {
		input(prompt: string, placeholder?: string): Promise<string | undefined>;
		select<T extends string>(prompt: string, choices: T[]): Promise<T | undefined>;
		confirm(title: string, message: string): Promise<boolean>;
		notify(message: string, level?: "info" | "warning" | "error" | "success"): void;
		setStatus(id: string, message: string | undefined): void;
	};
}

export interface SetupResult {
	cfg?: RagConfig | null;
	cancelled: boolean;
	reasonOrNote?: string;
}

export async function runSetup(ctx: SetupCtx, paths: RagPaths, cwd: string): Promise<SetupResult> {
	const existing = loadConfig(paths);
	const base: RagConfig = existing ?? { ...DEFAULT_CONFIG };

	// 1) Source folder
	const defaultFolder = pickDefaultFolder(cwd, base.folder);
	const folderInput = await ctx.ui.input(
		`Source folder to index (relative to project root) [default: ${defaultFolder}]`,
		defaultFolder,
	);
	if (folderInput === undefined) return { cancelled: true };
	const folder = folderInput.trim() || defaultFolder;
	const folderAbs = path.resolve(cwd, folder);
	if (!fs.existsSync(folderAbs)) {
		const create = await ctx.ui.confirm("Folder does not exist", `${folderAbs} does not exist. Create it?`);
		if (!create) return { cancelled: true, reasonOrNote: "Source folder missing" };
		fs.mkdirSync(folderAbs, { recursive: true });
	}

	// 2) Formats
	const formatsInput = await ctx.ui.input("File formats to index (comma-separated)", base.formats.join(","));
	if (formatsInput === undefined) return { cancelled: true };
	const formats = formatsInput
		.split(",")
		.map((f) => f.trim().toLowerCase())
		.filter(Boolean)
		.map((f) => (f.startsWith(".") ? f : `.${f}`));
	if (formats.length === 0) {
		ctx.ui.notify("No formats specified — using defaults", "warning");
	}

	// 3) Ollama URL
	const urlInput = await ctx.ui.input("Ollama base URL", base.ollamaUrl);
	if (urlInput === undefined) return { cancelled: true };
	const ollamaUrl = urlInput.trim() || base.ollamaUrl;

	// 4) Probe Ollama and pick model
	ctx.ui.setStatus("rag", "Checking Ollama…");
	let availableModels: string[] = [];
	try {
		availableModels = await listModels({ ...base, ollamaUrl } as RagConfig);
	} catch (err) {
		ctx.ui.setStatus("rag", undefined);
		ctx.ui.notify(`Ollama check failed: ${(err as Error).message}`, "error");
		const proceed = await ctx.ui.confirm(
			"Ollama unreachable",
			"Continue setup anyway? (You'll need Ollama running before indexing.)",
		);
		if (!proceed) return { cancelled: true };
	}
	ctx.ui.setStatus("rag", undefined);

	let model = base.model;
	const embeddingLikely = availableModels.filter((m) => /embed|bge|nomic|mxbai|e5/i.test(m));
	const candidates = embeddingLikely.length > 0 ? embeddingLikely : availableModels.length > 0 ? availableModels : [];
	if (candidates.length > 0) {
		const choices = [...new Set([base.model, ...candidates, "_custom_"])] as string[];
		const picked = await ctx.ui.select(`Pick embedding model (or "_custom_" to type one)`, choices);
		if (picked === undefined) return { cancelled: true };
		if (picked === "_custom_") {
			const custom = await ctx.ui.input("Model name", base.model);
			if (custom === undefined) return { cancelled: true };
			model = custom.trim() || base.model;
		} else {
			model = picked;
		}
	} else {
		const custom = await ctx.ui.input("Embedding model name (Ollama unreachable — typing blind)", base.model);
		if (custom === undefined) return { cancelled: true };
		model = custom.trim() || base.model;
	}

	// 5) Ensure turbovec is available before offering vector index settings.
	ctx.ui.setStatus("rag", "Checking turbovec…");
	try {
		ensureTurbovecInstalled();
	} catch (err) {
		ctx.ui.setStatus("rag", undefined);
		ctx.ui.notify(`turbovec install/check failed: ${(err as Error).message}`, "error");
		return { cancelled: true, reasonOrNote: "turbovec unavailable" };
	}
	ctx.ui.setStatus("rag", undefined);

	// 6) turbovec bit width
	const pickedBitWidth = await ctx.ui.select("turbovec bit width (2=smallest, 4=best recall)", [
		...new Set([String(base.bitWidth), "2", "3", "4"]),
	] as string[]);
	if (pickedBitWidth === undefined) return { cancelled: true };
	const bitWidth = Number(pickedBitWidth || base.bitWidth) as 2 | 3 | 4;

	// 7) Chunk size + overlap (with sensible defaults)
	const chunkTokensInput = await ctx.ui.input("Approx chunk size in tokens", String(base.chunkTokens));
	if (chunkTokensInput === undefined) return { cancelled: true };
	const chunkTokens = clampInt(parseInt(chunkTokensInput, 10), 100, 4000, base.chunkTokens);

	const overlapInput = await ctx.ui.input("Chunk overlap in tokens", String(base.chunkOverlap));
	if (overlapInput === undefined) return { cancelled: true };
	const chunkOverlap = clampInt(parseInt(overlapInput, 10), 0, Math.floor(chunkTokens / 2), base.chunkOverlap);

	// 8) Exclude patterns (substring match against the relative path)
	const excludeInput = await ctx.ui.input(
		"Exclude patterns (comma-separated, substring match against relative path)",
		base.exclude.join(","),
	);
	if (excludeInput === undefined) return { cancelled: true };
	const exclude = excludeInput
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);

	// 9) Try to detect dim. This validates the model is actually pullable.
	let dim: number | null = base.dim ?? null;
	ctx.ui.setStatus("rag", "Probing embedding dimensionality…");
	try {
		dim = await detectDim({
			...base,
			ollamaUrl,
			model,
		} as RagConfig);
		ctx.ui.notify(`Detected embedding dim: ${dim}`, "info");
	} catch (err) {
		dim = null;
		ctx.ui.notify(`Could not probe model (${(err as Error).message}). Dim will be detected at first index.`, "warning");
	} finally {
		ctx.ui.setStatus("rag", undefined);
	}

	const cfg: RagConfig = {
		...base,
		folder,
		formats: formats.length > 0 ? formats : DEFAULT_CONFIG.formats,
		exclude: exclude.length > 0 ? exclude : base.exclude,
		provider: "ollama",
		ollamaUrl,
		model,
		bitWidth,
		chunkTokens,
		chunkOverlap,
		dim,
	};

	saveConfig(paths, cfg);
	return { cfg, cancelled: false };
}

function pickDefaultFolder(cwd: string, current: string): string {
	if (current && fs.existsSync(path.join(cwd, current))) return current;
	for (const guess of ["raw", "docs", "documents", "."]) {
		if (fs.existsSync(path.join(cwd, guess))) return guess;
	}
	return "raw";
}

function clampInt(n: number, min: number, max: number, fallback: number): number {
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, Math.floor(n)));
}
