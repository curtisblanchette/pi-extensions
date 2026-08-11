import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import {
	ensureTrailingNewline,
	extractLastAssistantText,
	firstLine,
	getActiveToolNames,
	getReadOnlyTools,
	isAllowedMcpGatewayReadOnlyCall,
	isAllowedReadOnlyResearchTool,
	isSafeCommand,
	loadPromptFile,
	MUTATION_TOOLS,
	READ_ONLY_TOOL_ALLOWLIST,
	restoreBaselineTools,
	restoreState,
	style,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "../shared/read-only-tools.ts";

/**
 * Technical Researcher — global pi extension.
 *
 * This extension owns only durable research/reference-document generation. It
 * does not switch into or manage planning mode; planning has its own extension.
 *
 * Commands:
 * - /research [context]
 * - /technical-research [context]
 * - /researcher [context]
 * - /research-off
 * - /research-status
 * - /save-research [path]
 */

type ResearcherState = {
	active: boolean;
	/** Exact active tool set before this mode restricted it; persisted for reload-safe restoration. */
	baselineTools?: string[];
	startedAt?: number;
	lastRequest?: string;
	lastResearchMarkdown?: string;
	lastResearchAt?: number;
	lastSavedPath?: string;
};

const STATE_ENTRY_TYPE = "technical-researcher-state";
const STATUS_KEY = "technical-researcher";
const WIDGET_KEY = "technical-researcher-widget";
const MODE_CONTEXT_TYPES = new Set(["technical-researcher-context"]);

export default function technicalResearcherExtension(pi: ExtensionAPI): void {
	let state: ResearcherState = { active: false };
	let baselineTools: string[] | undefined;

	pi.registerFlag?.("technical-researcher", {
		description: "Start pi with Technical Researcher mode enabled",
		type: "boolean",
		default: false,
	});

	pi.registerFlag?.("research", {
		description: "Alias flag for Technical Researcher mode",
		type: "boolean",
		default: false,
	});

	function persistState(): void {
		pi.appendEntry?.(STATE_ENTRY_TYPE, { ...state });
	}

	function updateUi(ctx: ExtensionContext): void {
		if (!state.active) {
			ctx.ui.setStatus?.(STATUS_KEY, undefined);
			ctx.ui.setWidget?.(WIDGET_KEY, undefined);
			return;
		}

		ctx.ui.setStatus?.(STATUS_KEY, style(ctx, "warning", "research"));
		ctx.ui.setWidget?.(WIDGET_KEY, [
			style(ctx, "accent", "Technical Researcher active"),
			"Read-only reference mode: produce KB-ready Markdown with code blocks and Mermaid diagrams.",
			"Disable: /research-off • Save: /save-research [path]",
		]);
	}

	function enableResearch(ctx: ExtensionContext, request?: string): void {
		if (!state.active && !baselineTools) baselineTools = getActiveToolNames(pi);

		state = {
			...state,
			baselineTools,
			active: true,
			startedAt: state.startedAt ?? Date.now(),
			lastRequest: request?.trim() || state.lastRequest,
		};
		pi.setActiveTools?.(getReadOnlyTools(pi));
		updateUi(ctx);
		persistState();
	}

	function disableResearch(ctx: ExtensionContext, notify = true): void {
		const restore = restoreBaselineTools(pi, baselineTools ?? state.baselineTools);
		if (restore.length > 0) pi.setActiveTools?.(restore);
		baselineTools = undefined;
		state = { ...state, active: false, baselineTools: undefined };

		updateUi(ctx);
		persistState();
		if (notify) ctx.ui.notify("Technical Researcher disabled. Restored default tools.", "info");
	}

	async function startResearch(args: string, ctx: ExtensionCommandContext): Promise<void> {
		await ctx.waitForIdle?.();

		let request = args.trim();
		if (!request && ctx.hasUI && ctx.ui.editor) {
			request =
				(await ctx.ui.editor(
					"Technical Researcher — describe research question, project/vault, links, files, and desired artifact",
					[
						"Research question / artifact title:",
						"",
						"Project / knowledgebase / vault path:",
						"",
						"Context, links, files, systems, APIs:",
						"",
						"Must include diagrams for:",
						"- Architecture",
						"- Data flow",
						"- Security / trust boundaries",
						"",
						"Constraints / audience:",
					].join("\n"),
				)) ?? "";
		}

		if (!request.trim()) {
			ctx.ui.notify("Usage: /research <research question/context>", "warning");
			return;
		}

		enableResearch(ctx, request);
		ctx.ui.notify("Technical Researcher enabled in read-only reference-doc mode.", "info");

		const kickoff = buildResearchKickoffPrompt(request, ctx.cwd);
		pi.sendUserMessage?.(kickoff);
	}

	async function saveLastResearch(args: string, ctx: ExtensionCommandContext): Promise<void> {
		await ctx.waitForIdle?.();
		if (!state.lastResearchMarkdown?.trim()) {
			ctx.ui.notify("No captured technical research artifact yet. Run /research first.", "warning");
			return;
		}

		const artifact = state.lastResearchMarkdown;
		let target = args.trim();
		if (!target) {
			const defaultTarget = suggestKnowledgebaseResearchPath(ctx.cwd, artifact, state.lastResearchAt ?? Date.now());
			if (!ctx.hasUI) {
				if (!looksLikeKnowledgebaseRoot(ctx.cwd)) {
					ctx.ui.notify("Provide a knowledgebase path: /save-research <path>. Current cwd is not obviously a vault/project knowledgebase.", "warning");
					return;
				}
				target = defaultTarget;
			} else {
				const title = looksLikeKnowledgebaseRoot(ctx.cwd)
					? "Save technical research artifact path"
					: "Current directory is not obviously a knowledgebase. Choose project/vault artifact path";
				target = (await ctx.ui.input?.(title, defaultTarget))?.trim() ?? "";
				if (!target) {
					ctx.ui.notify("Save cancelled; no knowledgebase path selected.", "info");
					return;
				}
			}
		}

		target = ensureMarkdownPath(target);
		const absolute = isAbsolute(target) ? target : resolve(ctx.cwd, target);
		const ok =
			!ctx.hasUI ||
			!ctx.ui.confirm ||
			(await ctx.ui.confirm("Save technical research artifact?", `Write ${absolute}?`));
		if (!ok) {
			ctx.ui.notify("Save cancelled", "info");
			return;
		}

		await mkdir(dirname(absolute), { recursive: true });
		await writeFile(absolute, ensureTrailingNewline(artifact), "utf8");
		state = { ...state, lastSavedPath: absolute };
		persistState();
		ctx.ui.notify(`Saved technical research artifact to ${absolute}`, "info");
	}

	pi.registerCommand("research", {
		description: "Start Technical Researcher mode for KB-ready Markdown reference documents",
		handler: startResearch,
	});

	pi.registerCommand("technical-research", {
		description: "Alias for /research",
		handler: startResearch,
	});

	pi.registerCommand("researcher", {
		description: "Alias for /research",
		handler: startResearch,
	});

	pi.registerCommand("research-off", {
		description: "Disable Technical Researcher mode and restore default tools",
		handler: async (_args, ctx) => disableResearch(ctx),
	});

	pi.registerCommand("research-status", {
		description: "Show Technical Researcher artifact status",
		handler: async (_args, ctx) => {
			const lines = [
				`Technical Researcher: ${state.active ? "active" : "inactive"}`,
				state.lastRequest ? `Last request: ${firstLine(state.lastRequest)}` : undefined,
				state.lastResearchAt ? `Last artifact: ${new Date(state.lastResearchAt).toLocaleString()}` : undefined,
				state.lastSavedPath ? `Saved path: ${state.lastSavedPath}` : undefined,
			]
				.filter(Boolean)
				.join("\n");
			ctx.ui.notify(lines, "info");
		},
	});

	pi.registerCommand("save-research", {
		description: "Save the last captured Technical Researcher artifact into a knowledgebase path",
		handler: saveLastResearch,
	});

	pi.on?.("session_start", async (_event, ctx) => {
		state = restoreState<ResearcherState>(ctx, STATE_ENTRY_TYPE, normalizeResearcherState) ?? state;
		baselineTools = state.baselineTools;

		if (pi.getFlag?.("technical-researcher") === true || pi.getFlag?.("research") === true) {
			enableResearch(ctx);
		} else if (state.active) {
			pi.setActiveTools?.(getReadOnlyTools(pi));
		}
		updateUi(ctx);
	});

	pi.on?.("before_agent_start", async (event) => {
		if (!state.active) return undefined;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${TECHNICAL_RESEARCHER_SYSTEM_CONTEXT}`,
		};
	});

	pi.on?.("context", async (event) => ({
		messages: event.messages.filter((message: any) => !MODE_CONTEXT_TYPES.has(message.customType)),
	}));

	pi.on?.("tool_call", async (event) => {
		if (!state.active) return;

		if (MUTATION_TOOLS.has(event.toolName)) {
			return {
				block: true,
				reason: "Technical Researcher is read-only. Produce the Markdown artifact in the response; use /save-research [path] to persist captured output.",
			};
		}

		if (event.toolName === "mcp" && !isAllowedMcpGatewayReadOnlyCall(event.input)) {
			return {
				block: true,
				reason: "Technical Researcher allows MCP gateway calls only for discovery and read-only tool calls (get/list/search/query/read/fetch/etc.). MCP mutations remain blocked.",
			};
		}

		if (!isAllowedReadOnlyResearchTool(event.toolName)) {
			return {
				block: true,
				reason: `Technical Researcher only allows read-only/retrieval tools (${READ_ONLY_TOOL_ALLOWLIST.join(", ")}, read-only MCP calls, web-search, and graphify-prefixed aliases). Tool blocked: ${event.toolName}`,
			};
		}

		if (event.toolName === "bash") {
			const command = String(event.input?.command ?? "");
			if (!isSafeCommand(command)) {
				return {
					block: true,
					reason: `Technical Researcher blocked non-read-only bash command. Use read/grep/find/ls/rag_search/web_search or disable research first.\nCommand: ${command}`,
				};
			}
		}
	});

	pi.on?.("agent_end", async (event, ctx) => {
		if (!state.active) return;

		const artifact = extractTechnicalResearchArtifact(extractLastAssistantText(event.messages));
		if (!artifact) return;

		state = { ...state, lastResearchMarkdown: artifact, lastResearchAt: Date.now() };
		persistState();
		updateUi(ctx);
		ctx.ui.notify("Captured technical research artifact. Use /save-research [path] to write it into the knowledgebase, or /research-off to exit research mode.", "info");
	});
}

function buildResearchKickoffPrompt(userContext: string, cwd: string): string {
	return [
		"You are now in Technical Researcher mode for this pi session.",
		"",
		`Working directory: ${cwd}`,
		"",
		"User-provided research context:",
		userContext.trim(),
		"",
		"Follow the active Technical Researcher instructions. Perform read-only research first. If the target project/knowledgebase path is ambiguous, ask before choosing where an artifact should live. Otherwise produce the full knowledgebase-ready Markdown reference document.",
	].join("\n");
}

const TECHNICAL_RESEARCHER_SYSTEM_CONTEXT = loadPromptFile(__dirname, "technical-researcher", "technical-researcher.md");

function normalizeResearcherState(restored: Partial<ResearcherState>): ResearcherState {
	return {
		active: Boolean(restored.active),
		baselineTools: Array.isArray(restored.baselineTools) ? restored.baselineTools.filter((name): name is string => typeof name === "string") : undefined,
		startedAt: restored.startedAt,
		lastRequest: restored.lastRequest,
		lastResearchMarkdown: restored.lastResearchMarkdown,
		lastResearchAt: restored.lastResearchAt,
		lastSavedPath: restored.lastSavedPath,
	};
}

function suggestKnowledgebaseResearchPath(cwd: string, artifact: string, timestamp: number): string {
	const title = extractMarkdownTitle(artifact) ?? "technical-research";
	const slug = slugify(title.replace(/^Technical Research(?:\s+Brief)?:?/i, "").trim() || title);
	const date = new Date(timestamp).toISOString().slice(0, 10);
	const filename = `${date}-${slug || "technical-research"}.md`;
	const preferredDirs = ["Research", "research", "docs/research", "docs/Research", "knowledgebase/research", "Knowledgebase/Research"];
	const existing = preferredDirs.find((candidate) => existsSync(resolve(cwd, candidate)));
	return existing ? `${existing}/${filename}` : `Research/${filename}`;
}

function looksLikeKnowledgebaseRoot(cwd: string): boolean {
	const base = basename(cwd).toLowerCase();
	if (/vault|knowledge|kb|wiki|notes|docs/.test(base)) return true;
	return [".obsidian", "Projects", "projects", "Research", "research", "index.md", "README.md"].some((marker) => existsSync(resolve(cwd, marker)));
}

function ensureMarkdownPath(path: string): string {
	const trimmed = path.trim();
	if (!trimmed) return trimmed;
	return /\.mdx?$/i.test(trimmed) ? trimmed : `${trimmed}.md`;
}

function extractMarkdownTitle(markdown: string): string | undefined {
	return /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim();
}

function slugify(value: string): string {
	return value
		.toLowerCase()
		.replace(/[`*_#[\]()>]/g, "")
		.replace(/&/g, " and ")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-+/g, "-")
		.slice(0, 80);
}

function extractTechnicalResearchArtifact(text: string): string | undefined {
	if (!text.trim()) return undefined;
	const headingMatch =
		/^#\s+Technical Research(?:\s+(?:Brief|Reference|Artifact|Document|Report))?(?::|\s|$).*$/im.exec(text) ??
		/^#\s+Technical Requirements(?:\s+(?:Brief|Reference|Artifact|Document|Report))?(?::|\s|$).*$/im.exec(text) ??
		/^#\s+.*Technical (?:Research|Requirements).*$/im.exec(text);
	if (!headingMatch) return undefined;

	const heading = headingMatch.index;
	const frontmatter = /^\s*---\n[\s\S]*?\n---\s*\n/.exec(text);
	if (frontmatter && frontmatter.index === 0 && frontmatter[0].length <= heading) {
		return text.slice(0).trim();
	}
	return text.slice(heading).trim();
}
