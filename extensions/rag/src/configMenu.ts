/**
 * Interactive settings menu. Lets users edit any RagConfig field individually,
 * unlike /rag-setup which runs the full wizard. Persists after every change.
 *
 * Surfaces every field in RagConfig:
 *   - folder, formats, exclude (paths / globs)
 *   - ollamaUrl, model, dim, bitWidth (provider/vector config)
 *   - chunkTokens, chunkOverlap (chunker)
 *   - provider (read-only; only "ollama" is supported in v1)
 *
 * Uses the same ctx.ui dialog primitives as setup.ts so it works in any
 * interactive mode.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import type { RagConfig, RagPaths } from "./config.js";
import { DEFAULT_CONFIG, loadConfig, saveConfig } from "./config.js";
import { detectDim, listModels } from "./embed.js";

interface MenuCtx {
	cwd: string;
	ui: {
		input(prompt: string, placeholder?: string): Promise<string | undefined>;
		select<T extends string>(prompt: string, choices: T[]): Promise<T | undefined>;
		confirm(title: string, message: string): Promise<boolean>;
		notify(message: string, level?: "info" | "warning" | "error" | "success"): void;
		setStatus(id: string, message: string | undefined): void;
	};
}

type FieldId =
	| "folder"
	| "formats"
	| "exclude"
	| "ollamaUrl"
	| "model"
	| "chunkTokens"
	| "chunkOverlap"
	| "dim"
	| "bitWidth"
	| "provider"
	| "_reset"
	| "_exit";

interface MenuItem {
	id: FieldId;
	label: string;
	/** Right-hand side: current value displayed in the menu. */
	value: string;
	/** True when this entry can't be edited (display-only). */
	readonly?: boolean;
}

const STATUS_ID = "rag";

export async function runConfigMenu(ctx: MenuCtx, paths: RagPaths): Promise<void> {
	// Loop until the user picks "Done" / ESC.
	while (true) {
		const cfg = loadConfig(paths) ?? { ...DEFAULT_CONFIG };
		const items = buildMenuItems(cfg);
		const choices = items.map(formatChoice);
		const picked = await ctx.ui.select("RAG settings — pick a field to edit (ESC to exit)", choices);
		if (picked === undefined) return;

		const idx = choices.indexOf(picked);
		const item = items[idx];
		if (!item || item.id === "_exit") return;
		if (item.id === "_reset") {
			const ok = await ctx.ui.confirm(
				"Reset to defaults?",
				"Replace the config with the built-in defaults? Embedding dim will be cleared.",
			);
			if (ok) {
				saveConfig(paths, { ...DEFAULT_CONFIG });
				ctx.ui.notify("RAG config reset to defaults.", "success");
			}
			continue;
		}
		if (item.readonly) {
			ctx.ui.notify(`${labelFor(item.id)} is read-only.`, "info");
			continue;
		}

		await editField(ctx, paths, cfg, item.id);
	}
}

// ---------------------------------------------------------------------------
// Menu construction
// ---------------------------------------------------------------------------

function buildMenuItems(cfg: RagConfig): MenuItem[] {
	return [
		{ id: "folder", label: "folder", value: cfg.folder },
		{ id: "formats", label: "formats", value: cfg.formats.join(", ") || "(none)" },
		{ id: "exclude", label: "exclude", value: cfg.exclude.join(", ") || "(none)" },
		{ id: "ollamaUrl", label: "Ollama URL", value: cfg.ollamaUrl },
		{ id: "model", label: "model", value: cfg.model },
		{ id: "chunkTokens", label: "chunk tokens", value: String(cfg.chunkTokens) },
		{ id: "chunkOverlap", label: "chunk overlap", value: String(cfg.chunkOverlap) },
		{
			id: "dim",
			label: "embedding dim",
			value: cfg.dim != null ? `${cfg.dim} (Enter to re-detect)` : "(not detected)",
		},
		{ id: "bitWidth", label: "turbovec bits", value: String(cfg.bitWidth) },
		{ id: "provider", label: "provider", value: cfg.provider, readonly: true },
		{ id: "_reset", label: "↺ Reset to defaults", value: "" },
		{ id: "_exit", label: "✓ Done", value: "" },
	];
}

/** Format a menu row as a single line: "label    value". */
function formatChoice(item: MenuItem): string {
	if (item.id === "_exit" || item.id === "_reset") return item.label;
	const left = labelFor(item.id).padEnd(16);
	const right = item.readonly ? `${item.value} (read-only)` : item.value;
	return `${left}  ${right}`;
}

function labelFor(id: FieldId): string {
	switch (id) {
		case "folder":
			return "folder";
		case "formats":
			return "formats";
		case "exclude":
			return "exclude";
		case "ollamaUrl":
			return "Ollama URL";
		case "model":
			return "model";
		case "chunkTokens":
			return "chunk tokens";
		case "chunkOverlap":
			return "chunk overlap";
		case "dim":
			return "embedding dim";
		case "bitWidth":
			return "turbovec bits";
		case "provider":
			return "provider";
		case "_reset":
			return "Reset";
		case "_exit":
			return "Done";
	}
}

// ---------------------------------------------------------------------------
// Per-field editors
// ---------------------------------------------------------------------------

async function editField(ctx: MenuCtx, paths: RagPaths, cfg: RagConfig, id: FieldId): Promise<void> {
	switch (id) {
		case "folder":
			return editFolder(ctx, paths, cfg);
		case "formats":
			return editFormats(ctx, paths, cfg);
		case "exclude":
			return editExclude(ctx, paths, cfg);
		case "ollamaUrl":
			return editOllamaUrl(ctx, paths, cfg);
		case "model":
			return editModel(ctx, paths, cfg);
		case "chunkTokens":
			return editChunkTokens(ctx, paths, cfg);
		case "chunkOverlap":
			return editChunkOverlap(ctx, paths, cfg);
		case "dim":
			return redetectDim(ctx, paths, cfg);
		case "bitWidth":
			return editBitWidth(ctx, paths, cfg);
		default:
			return;
	}
}

async function editFolder(ctx: MenuCtx, paths: RagPaths, cfg: RagConfig): Promise<void> {
	const input = await ctx.ui.input("Source folder to index (relative to project root)", cfg.folder);
	if (input === undefined) return;
	const next = input.trim() || cfg.folder;
	const abs = path.resolve(ctx.cwd, next);
	if (!fs.existsSync(abs)) {
		const create = await ctx.ui.confirm("Folder does not exist", `${abs} does not exist. Create it?`);
		if (!create) {
			ctx.ui.notify("Folder change cancelled.", "info");
			return;
		}
		fs.mkdirSync(abs, { recursive: true });
	}
	saveConfig(paths, { ...cfg, folder: next });
	ctx.ui.notify(`folder = ${next}`, "success");
}

async function editFormats(ctx: MenuCtx, paths: RagPaths, cfg: RagConfig): Promise<void> {
	const input = await ctx.ui.input("File formats (comma-separated, e.g. .md,.pdf,.txt,.docx)", cfg.formats.join(","));
	if (input === undefined) return;
	const next = parseExtList(input);
	if (next.length === 0) {
		ctx.ui.notify("No formats parsed — keeping previous list.", "warning");
		return;
	}
	saveConfig(paths, { ...cfg, formats: next });
	ctx.ui.notify(`formats = ${next.join(" ")}`, "success");
}

async function editExclude(ctx: MenuCtx, paths: RagPaths, cfg: RagConfig): Promise<void> {
	const input = await ctx.ui.input(
		"Exclude patterns (comma-separated, substring match against relative path)",
		cfg.exclude.join(","),
	);
	if (input === undefined) return;
	const next = input
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	saveConfig(paths, { ...cfg, exclude: next });
	ctx.ui.notify(next.length > 0 ? `exclude = ${next.join(" ")}` : "exclude cleared.", "success");
}

async function editOllamaUrl(ctx: MenuCtx, paths: RagPaths, cfg: RagConfig): Promise<void> {
	const input = await ctx.ui.input("Ollama base URL", cfg.ollamaUrl);
	if (input === undefined) return;
	const next = input.trim() || cfg.ollamaUrl;
	saveConfig(paths, { ...cfg, ollamaUrl: next });
	ctx.ui.notify(`ollamaUrl = ${next}`, "success");
}

async function editModel(ctx: MenuCtx, paths: RagPaths, cfg: RagConfig): Promise<void> {
	ctx.ui.setStatus(STATUS_ID, "Checking Ollama…");
	let available: string[] = [];
	try {
		available = await listModels(cfg);
	} catch (err) {
		ctx.ui.notify(`Ollama check failed: ${(err as Error).message}`, "warning");
	} finally {
		ctx.ui.setStatus(STATUS_ID, undefined);
	}

	const embeddingLikely = available.filter((m) => /embed|bge|nomic|mxbai|e5/i.test(m));
	const candidates = embeddingLikely.length > 0 ? embeddingLikely : available;

	let next = cfg.model;
	if (candidates.length > 0) {
		const choices = [...new Set([cfg.model, ...candidates, "_custom_"])];
		const picked = await ctx.ui.select(`Pick embedding model (or "_custom_" to type one)`, choices);
		if (picked === undefined) return;
		if (picked === "_custom_") {
			const custom = await ctx.ui.input("Model name", cfg.model);
			if (custom === undefined) return;
			next = custom.trim() || cfg.model;
		} else {
			next = picked;
		}
	} else {
		const custom = await ctx.ui.input("Embedding model name (Ollama unreachable — typing blind)", cfg.model);
		if (custom === undefined) return;
		next = custom.trim() || cfg.model;
	}

	if (next === cfg.model) {
		ctx.ui.notify(`model unchanged (${next})`, "info");
		return;
	}

	// Model change implies dim may differ. Clear dim so it's re-detected on next
	// /rag-index (and the user should /rag-reset since old vectors are now stale).
	const changed: RagConfig = { ...cfg, model: next, dim: null };
	saveConfig(paths, changed);
	ctx.ui.notify(`model = ${next}. Dim cleared — run /rag-reset then /rag-index to rebuild.`, "warning");
}

async function editBitWidth(ctx: MenuCtx, paths: RagPaths, cfg: RagConfig): Promise<void> {
	const picked = await ctx.ui.select("turbovec bit width (2=smallest, 4=best recall)", ["2", "3", "4"]);
	if (picked === undefined) return;
	const bitWidth = Number(picked) as 2 | 3 | 4;
	if (bitWidth === cfg.bitWidth) {
		ctx.ui.notify(`bitWidth unchanged (${bitWidth})`, "info");
		return;
	}
	saveConfig(paths, { ...cfg, bitWidth });
	ctx.ui.notify(`bitWidth = ${bitWidth}. Run /rag-reset then /rag-index to rebuild vectors.`, "warning");
}

async function editChunkTokens(ctx: MenuCtx, paths: RagPaths, cfg: RagConfig): Promise<void> {
	const input = await ctx.ui.input("Approx chunk size in tokens (100–4000)", String(cfg.chunkTokens));
	if (input === undefined) return;
	const next = clampInt(parseInt(input, 10), 100, 4000, cfg.chunkTokens);
	// Keep overlap valid against new size.
	const overlap = Math.min(cfg.chunkOverlap, Math.floor(next / 2));
	saveConfig(paths, { ...cfg, chunkTokens: next, chunkOverlap: overlap });
	ctx.ui.notify(
		overlap !== cfg.chunkOverlap
			? `chunkTokens = ${next}, chunkOverlap clamped to ${overlap}`
			: `chunkTokens = ${next}`,
		"success",
	);
}

async function editChunkOverlap(ctx: MenuCtx, paths: RagPaths, cfg: RagConfig): Promise<void> {
	const max = Math.floor(cfg.chunkTokens / 2);
	const input = await ctx.ui.input(`Chunk overlap in tokens (0–${max})`, String(cfg.chunkOverlap));
	if (input === undefined) return;
	const next = clampInt(parseInt(input, 10), 0, max, cfg.chunkOverlap);
	saveConfig(paths, { ...cfg, chunkOverlap: next });
	ctx.ui.notify(`chunkOverlap = ${next}`, "success");
}

async function redetectDim(ctx: MenuCtx, paths: RagPaths, cfg: RagConfig): Promise<void> {
	ctx.ui.setStatus(STATUS_ID, "Probing embedding dim…");
	try {
		const dim = await detectDim(cfg);
		ctx.ui.setStatus(STATUS_ID, undefined);
		if (cfg.dim != null && cfg.dim !== dim) {
			const ok = await ctx.ui.confirm(
				"Embedding dim changed",
				`Old dim ${cfg.dim} → new dim ${dim}. Existing vectors will be incompatible. Save anyway? (You'll need /rag-reset then /rag-index.)`,
			);
			if (!ok) {
				ctx.ui.notify("dim change discarded.", "info");
				return;
			}
		}
		saveConfig(paths, { ...cfg, dim });
		ctx.ui.notify(`dim = ${dim}`, "success");
	} catch (err) {
		ctx.ui.setStatus(STATUS_ID, undefined);
		ctx.ui.notify(`Failed to probe model: ${(err as Error).message}`, "error");
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseExtList(s: string): string[] {
	return s
		.split(",")
		.map((f) => f.trim().toLowerCase())
		.filter(Boolean)
		.map((f) => (f.startsWith(".") ? f : `.${f}`));
}

function clampInt(n: number, min: number, max: number, fallback: number): number {
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, Math.floor(n)));
}
