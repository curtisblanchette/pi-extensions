import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type ToolInfo = {
	name: string;
	sourceInfo?: {
		source?: string;
		path?: string;
		scope?: string;
		origin?: string;
	};
};

export type ExtensionAPI = {
	registerCommand(
		name: string,
		options: { description?: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void },
	): void;
	registerFlag?(name: string, options: { description?: string; type: "boolean"; default?: boolean }): void;
	on?(event: string, handler: (event: any, ctx: ExtensionContext) => Promise<any> | any): void;
	appendEntry?(customType: string, data?: unknown): void;
	sendUserMessage?(content: string, options?: { deliverAs?: "steer" | "followUp" }): void;
	setActiveTools?(names: string[]): void;
	getActiveTools?(): string[];
	getAllTools?(): ToolInfo[];
	getFlag?(name: string): unknown;
};

export type ExtensionContext = {
	cwd: string;
	hasUI?: boolean;
	ui: {
		notify(message: string, level?: "info" | "warning" | "error"): void;
		select?(title: string, options: string[]): Promise<string | undefined>;
		input?(title: string, placeholder?: string): Promise<string | undefined>;
		editor?(title: string, initial?: string): Promise<string | undefined>;
		confirm?(title: string, message: string, options?: unknown): Promise<boolean>;
		setStatus?(key: string, value?: string): void;
		setWidget?(key: string, value?: string[] | undefined, options?: unknown): void;
		theme?: {
			fg?(name: string, text: string): string;
			bold?(text: string): string;
		};
	};
	sessionManager?: {
		getEntries?(): Array<any>;
	};
};

export type ExtensionCommandContext = ExtensionContext & {
	waitForIdle?(): Promise<void>;
};

// `bash` is retained for repository inspection, but every command is validated
// below as a single, non-shell read-only invocation. Shell composition is not
// safe to classify with prefix matching.
export const BASE_READ_ONLY_TOOLS = ["read", "bash", "grep", "find", "ls", "question", "questionnaire"];
export const VECTOR_RETRIEVAL_TOOLS = ["rag_search"];
export const MCP_GATEWAY_TOOLS = ["mcp"];
export const WEB_RETRIEVAL_TOOLS = [
	"web_search",
	"web_fetch",
	"web_read",
	"web_open",
	"search_web",
	"fetch_url",
	"url_fetch",
	"read_url",
	"browser_search",
	"brave_web_search",
	"brave_local_search",
	"duckduckgo_search",
	"google_search",
	"bing_search",
	"kagi_search",
	"serpapi_search",
	"serper_search",
	"tavily_search",
	"tavily_extract",
	"exa_search",
	"exa_get_contents",
	"exa_find_similar",
	"firecrawl_search",
	"firecrawl_scrape",
	"perplexity_search",
	"perplexity_ask",
];

export const GRAPHIFY_MCP_TOOLS = [
	"query_graph",
	"get_node",
	"get_neighbors",
	"get_community",
	"god_nodes",
	"graph_stats",
	"shortest_path",
	"find_all_paths",
	"weighted_path",
	"community_bridges",
	"graph_diff",
	"pagerank",
	"detect_cycles",
	"smart_summary",
	"find_similar",
];

export const READ_ONLY_TOOL_ALLOWLIST = Array.from(
	new Set([
		...BASE_READ_ONLY_TOOLS,
		...VECTOR_RETRIEVAL_TOOLS,
		...MCP_GATEWAY_TOOLS,
		...WEB_RETRIEVAL_TOOLS,
		...GRAPHIFY_MCP_TOOLS,
	]),
);
export const MUTATION_TOOLS = new Set(["edit", "write"]);

const KNOWN_MCP_TOOL_PREFIXES = [
	"mcp_",
	"metalab_",
	"linear_",
	"notion_",
	"screenpipe_",
	"granola_",
	"github_",
	"jira_",
	"slack_",
	"figma_",
];

const READ_ONLY_MCP_TOOL_PATTERNS: RegExp[] = [
	/(^|_)(get|list|search|query|read|fetch|retrieve|find|lookup|describe|inspect|browse|extract|analyze|calculate|forecast|detect|compare|validate|evaluate)(_|$)/,
	/(^|_)(server_info|health_check|check_connection|setup_token|current_context|activity_summary|keyword_search|frame_context|recent_activity|recent_changes|repo_context|pr_context|file_churn|contributor_activity|account_info|team_metrics)(_|$)/,
];

const MUTATING_MCP_TOOL_PATTERNS: RegExp[] = [
	/(^|_)(create|update|save|delete|remove|set|modify|move|resize|clone|group|transition|post|add|link|prepare|duplicate|connect|disconnect|control|start|stop|merge|rename|trash|copy|open|close|quit|hide|minimize|center|tile|send|run|execute|navigate|reload|write|edit|upload|apply|publish)(_|$)/,
	/(^|_)(evaluate_script|run_.*javascript|export_video|create_attachment|prepare_attachment|create_image|set_image_fill)(_|$)/,
];

const DESTRUCTIVE_BASH_PATTERNS: RegExp[] = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	/(^|[^<])>(?!>)/,
	/>>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish|run\s+(build|deploy|release))/i,
	/\byarn\s+(add|remove|install|publish|run\s+(build|deploy|release))/i,
	/\bpnpm\s+(add|remove|install|publish|run\s+(build|deploy|release))/i,
	/\bbun\s+(add|remove|install|run\s+(build|deploy|release))/i,
	/\bpip\s+(install|uninstall)/i,
	/\bpoetry\s+(add|remove|install|update)/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/\bbrew\s+(install|uninstall|upgrade)/i,
	/\bdocker\s+(build|run|compose\s+up|compose\s+down|push|pull|rm|rmi)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|switch|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone|clean|restore)/i,
	/\bgh\s+(pr\s+(create|merge|close|edit)|issue\s+(create|edit|close)|api\s+--method\s+(POST|PUT|PATCH|DELETE))/i,
	/\bcurl\b.*\b(-X|--request)\s*(POST|PUT|PATCH|DELETE)/i,
	/\bcurl\b.*\b(--data|--data-raw|--data-binary|-d)\b/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)/i,
	/\bservice\s+\S+\s+(start|stop|restart)/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
	/\bfind\b.*\s-(?:delete|exec|execdir|ok|okdir|fprint)\b/i,
	/\bsed\b[^\n]*\s-i(?:\s|$)/i,
];

// These patterns intentionally match only the executable plus its explicitly
// read-only subcommand, when one is required. `isSafeCommand` rejects all shell
// syntax before checking them, so a matching prefix cannot smuggle a second
// command through `;`, a pipeline, substitution, or redirection.
const SAFE_BASH_PATTERNS: RegExp[] = [
	/^\s*cat\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*less\b/,
	/^\s*more\b/,
	/^\s*grep\b/,
	/^\s*find\b/,
	/^\s*ls\b/,
	/^\s*pwd\b/,
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*wc\b/,
	/^\s*sort\b/,
	/^\s*uniq\b/,
	/^\s*diff\b/,
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*du\b/,
	/^\s*df\b/,
	/^\s*tree\b/,
	/^\s*which\b/,
	/^\s*whereis\b/,
	/^\s*type\b/,
	/^\s*env\b/,
	/^\s*printenv\b/,
	/^\s*uname\b/,
	/^\s*whoami\b/,
	/^\s*id\b/,
	/^\s*date\b/,
	/^\s*cal\b/,
	/^\s*uptime\b/,
	/^\s*ps\b/,
	/^\s*top\b/,
	/^\s*htop\b/,
	/^\s*free\b/,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get|rev-parse|ls-files|ls-tree|grep|describe)/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
	/^\s*yarn\s+(list|info|why|audit)/i,
	/^\s*pnpm\s+(list|ls|view|info|why|audit|outdated)/i,
	/^\s*bun\s+(--version|pm\s+ls)/i,
	/^\s*node\s+--version/i,
	/^\s*python\s+--version/i,
	/^\s*python3\s+--version/i,
	/^\s*go\s+(version|list\b|env\b)/i,
	/^\s*cargo\s+(--version|metadata\b|tree\b)/i,
	/^\s*graphify-rs\s+(query|stats|diff|benchmark)\b/i,
	/^\s*jq\b/,
	/^\s*sed\s+-n/i,
	/^\s*awk\b/,
	/^\s*rg\b/,
	/^\s*fd\b/,
	/^\s*bat\b/,
	/^\s*eza\b/,
];

export function style(ctx: ExtensionContext, kind: string, text: string): string {
	return ctx.ui.theme?.fg?.(kind, text) ?? text;
}

export function getAllToolInfos(pi: ExtensionAPI): ToolInfo[] {
	try {
		return pi.getAllTools?.() ?? [];
	} catch {
		return [];
	}
}

export function getAllToolNames(pi: ExtensionAPI): string[] {
	return getAllToolInfos(pi).map((tool) => tool.name);
}

export function getActiveToolNames(pi: ExtensionAPI): string[] {
	try {
		return pi.getActiveTools?.() ?? [];
	} catch {
		return [];
	}
}

export function getReadOnlyTools(pi: ExtensionAPI): string[] {
	const available = getAllToolInfos(pi);
	if (available.length === 0) return READ_ONLY_TOOL_ALLOWLIST;
	const filtered = available.filter(isAllowedReadOnlyResearchToolInfo).map((tool) => tool.name);
	return filtered.length > 0 ? filtered : READ_ONLY_TOOL_ALLOWLIST;
}

export function restoreBaselineTools(_pi: ExtensionAPI, baselineTools: string[] | undefined): string[] {
	// Never guess a post-mode tool set. Enabling every registered tool after a
	// session reload can re-enable tools another mode intentionally disabled.
	// Callers persist the exact baseline before restricting tools.
	return baselineTools && baselineTools.length > 0 ? baselineTools : [];
}

function isAllowedReadOnlyResearchToolInfo(tool: ToolInfo): boolean {
	return (
		isAllowedReadOnlyResearchTool(tool.name) ||
		(isMcpToolInfo(tool) && isAllowedReadOnlyMcpTool(tool.name, { allowUnknownPrefix: true }))
	);
}

export function isAllowedReadOnlyResearchTool(toolName: string): boolean {
	const normalized = normalizeToolName(toolName);
	if (READ_ONLY_TOOL_ALLOWLIST.includes(toolName) || READ_ONLY_TOOL_ALLOWLIST.includes(normalized)) return true;
	if (isAllowedWebRetrievalTool(toolName)) return true;

	// MCP gateways often namespace tools (for example graphify_query_graph,
	// graphify:query_graph, or mcp__graphify__query_graph). Allow graphify-rs
	// retrieval aliases without opening arbitrary MCP tools.
	if (GRAPHIFY_MCP_TOOLS.some((tool) => normalized === tool || normalized.endsWith(`_${tool}`))) return true;

	return isAllowedReadOnlyMcpTool(toolName);
}

export function isAllowedWebRetrievalTool(toolName: string): boolean {
	const normalized = normalizeToolName(toolName);
	if (WEB_RETRIEVAL_TOOLS.some((tool) => normalized === tool || normalized.endsWith(`_${tool}`))) return true;

	return WEB_RETRIEVAL_TOOL_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function isAllowedMcpGatewayReadOnlyCall(input: unknown): boolean {
	const payload = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
	const action = typeof payload.action === "string" ? payload.action : undefined;
	if (action && action !== "ui-messages") return false;

	const tool = stringValue(payload.tool);
	if (tool) {
		if (hasUnsafeMcpToolArgs(payload.args)) return false;

		const server = stringValue(payload.server);
		const candidates = [tool, server ? `${server}_${tool}` : undefined].filter(Boolean) as string[];
		return candidates.some(
			(candidate) =>
				isAllowedReadOnlyResearchTool(candidate) ||
				isAllowedWebRetrievalTool(candidate) ||
				isAllowedReadOnlyMcpTool(candidate, { allowUnknownPrefix: true }),
		);
	}

	// Metadata/discovery calls (status, list server tools, search tools, describe
	// schemas, connect to refresh metadata) are allowed so the agent can discover
	// MCP tools before using them.
	if (payload.search || payload.describe || payload.server || payload.connect) return true;
	return Object.keys(payload).length === 0;
}

export function isAllowedReadOnlyMcpTool(toolName: string, options: { allowUnknownPrefix?: boolean } = {}): boolean {
	const normalized = normalizeToolName(toolName);
	if (!options.allowUnknownPrefix && !looksLikeKnownMcpTool(normalized)) return false;
	if (/(^|_)(server_info|health_check|check_connection|setup_token)(_|$)/.test(normalized)) return true;
	if (MUTATING_MCP_TOOL_PATTERNS.some((pattern) => pattern.test(normalized))) return false;
	return READ_ONLY_MCP_TOOL_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isMcpToolInfo(tool: ToolInfo): boolean {
	const source = [tool.sourceInfo?.source, tool.sourceInfo?.path, tool.sourceInfo?.origin]
		.filter((value): value is string => Boolean(value))
		.join(" ")
		.toLowerCase();
	return /(^|[^a-z])mcp([^a-z]|$)/.test(source);
}

function looksLikeKnownMcpTool(normalizedToolName: string): boolean {
	return KNOWN_MCP_TOOL_PREFIXES.some((prefix) => normalizedToolName.startsWith(prefix));
}

const WEB_RETRIEVAL_TOOL_PATTERNS: RegExp[] = [
	/(^|_)(web|internet|online)_(search|fetch|read|open|lookup|retrieve|extract|scrape)(_|$)/,
	/(^|_)search_(web|internet|online)(_|$)/,
	/(^|_)(brave|duckduckgo|google|bing|kagi|serpapi|serper)(_web)?_(search|local_search|news_search|image_search|video_search)(_|$)/,
	/(^|_)tavily_(search|extract|qna)(_|$)/,
	/(^|_)exa_(search|get_contents|find_similar|answer)(_|$)/,
	/(^|_)firecrawl_(search|scrape|extract|map)(_|$)/,
	/(^|_)perplexity_(search|ask|answer|chat)(_|$)/,
];

function normalizeToolName(toolName: string): string {
	return toolName
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function hasUnsafeMcpToolArgs(args: unknown): boolean {
	const text = typeof args === "string" ? args : JSON.stringify(args ?? "");
	if (/"method"\s*:\s*"?(POST|PUT|PATCH|DELETE)"?/i.test(text)) return true;
	if (/"(body|data|payload)"\s*:/i.test(text)) return true;
	return false;
}

const SHELL_COMPOSITION_PATTERN = /[;&|<>`$(){}\n\r]/;

export function isSafeCommand(command: string): boolean {
	const trimmed = command.trim();
	if (!trimmed || SHELL_COMPOSITION_PATTERN.test(trimmed)) return false;
	if (DESTRUCTIVE_BASH_PATTERNS.some((pattern) => pattern.test(trimmed))) return false;
	return SAFE_BASH_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function extractLastAssistantText(messages: any[]): string {
	const assistant = [...(messages ?? [])].reverse().find((message) => message?.role === "assistant");
	if (!assistant) return "";
	return extractText(assistant.content);
}

export function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (typeof block === "string") return block;
			if (block && typeof block === "object" && (block as any).type === "text")
				return String((block as any).text ?? "");
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

export function restoreState<T>(
	ctx: ExtensionContext,
	entryType: string,
	normalize: (state: Partial<T>) => T,
): T | undefined {
	const entries = ctx.sessionManager?.getEntries?.() ?? [];
	const latest = entries.filter((entry) => entry.type === "custom" && entry.customType === entryType).at(-1) as
		{ data?: Partial<T> } | undefined;
	return latest?.data ? normalize(latest.data) : undefined;
}

export function loadPromptFile(extensionDir: string, extensionName: string, filename: string): string {
	const candidates = [
		resolve(extensionDir, "prompts", filename),
		resolve(process.env.HOME ?? "", `.pi/agent/extensions/${extensionName}/prompts`, filename),
	];

	for (const candidate of candidates) {
		if (existsSync(candidate)) return readFileSync(candidate, "utf8").trim();
	}

	throw new Error(`Missing prompt file for ${extensionName}: ${filename}`);
}

export function ensureTrailingNewline(value: string): string {
	return value.endsWith("\n") ? value : `${value}\n`;
}

export function firstLine(value: string): string {
	return value.split("\n")[0].trim();
}
