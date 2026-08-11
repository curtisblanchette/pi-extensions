import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import {
	extractLastAssistantText,
	firstLine,
	getActiveToolNames,
	getAllToolNames,
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
	ensureTrailingNewline,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "../shared/read-only-tools.ts";

/**
 * Planning Agent — global pi extension.
 *
 * This extension owns only implementation planning. It does not switch into or
 * manage researcher mode; the researcher has its own extension and commands.
 *
 * Commands:
 * - /implementation-plan [context]
 * - /plan-agent [context]
 * - /planning-agent [context]
 * - /planning-agent-off
 * - /planning-agent-status
 * - /planning-agent-handoff [context / optional Notion target URL]
 * - /planning-agent-handoff-off
 * - /save-plan [path]
 */

type PlanningAgentState = {
	active: boolean;
	/** Exact active tool set before this mode restricted it; persisted for reload-safe restoration. */
	baselineTools?: string[];
	startedAt?: number;
	lastRequest?: string;
	lastPlanMarkdown?: string;
	lastPlanAt?: number;
	lastSavedPath?: string;
	handoffActive?: boolean;
	handoffApprovedAt?: number;
	handoffContext?: string;
	handoffNotionTargetUrl?: string;
	lastHandoffWriteAt?: number;
};

type ToolCallEvent = {
	toolName: string;
	input?: Record<string, unknown>;
};

type BlockResult = { block: true; reason: string } | undefined;

const STATE_ENTRY_TYPE = "planning-agent-state";
const STATUS_KEY = "planning-agent";
const WIDGET_KEY = "planning-agent-widget";
const MODE_CONTEXT_TYPES = new Set([
	"planning-agent-context",
	"planning-agent-handoff-context",
	"plan-mode-context",
	"plan-execution-context",
]);

const DEFAULT_LINEAR_TEAM = process.env.PLANNING_AGENT_LINEAR_TEAM?.trim() || undefined;
const DEFAULT_LINEAR_PROJECT = process.env.PLANNING_AGENT_LINEAR_PROJECT?.trim() || undefined;
const REQUIRED_LINEAR_LABELS = (process.env.PLANNING_AGENT_LINEAR_REQUIRED_LABELS ?? "")
	.split(",")
	.map((label) => label.trim())
	.filter(Boolean);
const NOTION_TARGET_URL_ENV = "PLANNING_AGENT_NOTION_TARGET_URL";
const NOTION_TARGET_ID_ENV = "PLANNING_AGENT_NOTION_TARGET_ID";

export default function planningAgentExtension(pi: ExtensionAPI): void {
	let state: PlanningAgentState = { active: false };
	let baselineTools: string[] | undefined;

	pi.registerFlag?.("planning-agent", {
		description: "Start pi with Planning Agent mode enabled",
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

		const handoff = Boolean(state.handoffActive);
		ctx.ui.setStatus?.(STATUS_KEY, style(ctx, handoff ? "success" : "warning", handoff ? "planning+handoff" : "planning"));
		ctx.ui.setWidget?.(WIDGET_KEY, [
			style(ctx, "accent", handoff ? "Planning Agent handoff mode active" : "Planning Agent active"),
			handoff
				? "Approved handoff mode: read-only planning plus guarded Linear/Notion handoff writes. Each write still requires confirmation."
				: "Read-only planning mode: inspect, ask clarifying questions, then produce an implementation plan.",
			handoff
				? `Linear guardrail: ${describeLinearScope()}.`
				: "Enable handoff: /planning-agent-handoff [context or Notion target URL]",
			handoff
				? `Notion guardrail: ${getConfiguredNotionTarget(state) ? "restricted to approved target" : `writes blocked until ${NOTION_TARGET_URL_ENV} or a target URL is provided`}.`
				: "Disable: /planning-agent-off • Save: /save-plan [path]",
			handoff ? "Disable handoff: /planning-agent-handoff-off • Disable planning: /planning-agent-off" : undefined,
		].filter(Boolean) as string[]);
	}

	function setPlanningTools(): void {
		pi.setActiveTools?.(state.handoffActive ? getHandoffTools(pi) : getReadOnlyTools(pi));
	}

	function enablePlanning(ctx: ExtensionContext, request?: string): void {
		if (!state.active && !baselineTools) baselineTools = getActiveToolNames(pi);

		state = {
			...state,
			baselineTools,
			active: true,
			startedAt: state.startedAt ?? Date.now(),
			lastRequest: request?.trim() || state.lastRequest,
		};
		setPlanningTools();
		updateUi(ctx);
		persistState();
	}

	function disablePlanning(ctx: ExtensionContext, notify = true): void {
		const restore = restoreBaselineTools(pi, baselineTools ?? state.baselineTools);
		if (restore.length > 0) pi.setActiveTools?.(restore);
		baselineTools = undefined;
		state = { ...state, active: false, handoffActive: false, baselineTools: undefined };

		updateUi(ctx);
		persistState();
		if (notify) ctx.ui.notify("Planning Agent disabled. Restored default tools.", "info");
	}

	async function startPlanning(args: string, ctx: ExtensionCommandContext): Promise<void> {
		await ctx.waitForIdle?.();

		let request = args.trim();
		if (!request && ctx.hasUI && ctx.ui.editor) {
			request =
				(await ctx.ui.editor(
					"Planning Agent — paste request, PRD, issue, links, constraints, or repo context",
					[
						"Goal:",
						"",
						"Context / links / files:",
						"",
						"Constraints:",
						"",
						"Desired output / deadline:",
					].join("\n"),
				)) ?? "";
		}

		if (!request.trim()) {
			ctx.ui.notify("Usage: /implementation-plan <request/context>", "warning");
			return;
		}

		state = { ...state, handoffActive: false };
		enablePlanning(ctx, request);
		ctx.ui.notify("Planning Agent enabled in read-only planning mode.", "info");

		const kickoff = buildPlanningKickoffPrompt(request, ctx.cwd);
		pi.sendUserMessage?.(kickoff);
	}

	async function enableHandoff(args: string, ctx: ExtensionCommandContext): Promise<void> {
		await ctx.waitForIdle?.();

		const handoffContext = args.trim();
		const notionTargetUrl =
			extractFirstNotionUrl(handoffContext) ??
			state.handoffNotionTargetUrl ??
			process.env[NOTION_TARGET_URL_ENV]?.trim() ??
			undefined;

		if (!state.active) {
			if (!baselineTools) baselineTools = getActiveToolNames(pi);
			state = {
				...state,
				baselineTools,
				active: true,
				startedAt: state.startedAt ?? Date.now(),
				lastRequest: handoffContext || state.lastRequest,
			};
		}

		const ok =
			ctx.hasUI &&
			ctx.ui.confirm &&
			(await ctx.ui.confirm(
				"Enable Planning Agent handoff mode?",
				[
					"This grants the Planning Agent limited external write access for handoff only.",
					"",
					`Allowed Linear scope: ${describeLinearScope()}.`,
					"Blocked Linear actions: deletes, project/milestone/initiative/status edits, attachments, label creation, and unscoped handoff writes.",
					notionTargetUrl
						? `Allowed Notion target: ${notionTargetUrl}`
						: `Notion writes remain blocked until ${NOTION_TARGET_URL_ENV} / ${NOTION_TARGET_ID_ENV} is set or a Notion target URL is passed.`,
					"Each Linear/Notion write call will still require a separate confirmation before execution.",
				].join("\n"),
			));

		if (!ok) {
			ctx.ui.notify("Planning Agent handoff mode not enabled.", "info");
			return;
		}

		state = {
			...state,
			active: true,
			handoffActive: true,
			handoffApprovedAt: Date.now(),
			handoffContext: handoffContext || state.handoffContext,
			handoffNotionTargetUrl: notionTargetUrl,
		};
		setPlanningTools();
		updateUi(ctx);
		persistState();
		ctx.ui.notify("Planning Agent handoff mode enabled with Linear/Notion guardrails.", "info");

		if (handoffContext) {
			pi.sendUserMessage?.(buildHandoffKickoffPrompt(handoffContext, ctx.cwd, state));
		}
	}

	async function disableHandoff(_args: string, ctx: ExtensionCommandContext): Promise<void> {
		await ctx.waitForIdle?.();
		state = { ...state, handoffActive: false };
		if (state.active) pi.setActiveTools?.(getReadOnlyTools(pi));
		updateUi(ctx);
		persistState();
		ctx.ui.notify("Planning Agent handoff mode disabled. Read-only planning remains active.", "info");
	}

	async function saveLastPlan(args: string, ctx: ExtensionCommandContext): Promise<void> {
		await ctx.waitForIdle?.();
		if (!state.lastPlanMarkdown?.trim()) {
			ctx.ui.notify("No captured implementation plan yet. Run /implementation-plan first.", "warning");
			return;
		}

		let target = args.trim();
		if (!target) {
			const stamp = new Date(state.lastPlanAt ?? Date.now()).toISOString().replace(/[:.]/g, "-");
			target = `.pi/plans/${stamp}-implementation-plan.md`;
		}

		const absolute = isAbsolute(target) ? target : resolve(ctx.cwd, target);
		const ok =
			!ctx.hasUI ||
			!ctx.ui.confirm ||
			(await ctx.ui.confirm("Save implementation plan?", `Write ${absolute}?`));
		if (!ok) {
			ctx.ui.notify("Save cancelled", "info");
			return;
		}

		await mkdir(dirname(absolute), { recursive: true });
		await writeFile(absolute, ensureTrailingNewline(state.lastPlanMarkdown), "utf8");
		state = { ...state, lastSavedPath: absolute };
		persistState();
		ctx.ui.notify(`Saved implementation plan to ${absolute}`, "info");
	}

	async function confirmHandoffWrite(ctx: ExtensionContext, event: ToolCallEvent, summary: string): Promise<BlockResult> {
		if (!ctx.hasUI || !ctx.ui.confirm) {
			return {
				block: true,
				reason: "Planning Agent handoff writes require interactive user confirmation. Re-run in TUI mode or disable handoff.",
			};
		}

		const ok = await ctx.ui.confirm(
			`Approve handoff write: ${event.toolName}?`,
			[
				"Planning Agent handoff mode requires approval for every external write.",
				"",
				summary,
				"",
				"Tool arguments after guardrail normalization:",
				truncateForDialog(JSON.stringify(event.input ?? {}, null, 2)),
			].join("\n"),
		);
		if (!ok) return { block: true, reason: `User denied Planning Agent handoff write: ${event.toolName}` };

		state = { ...state, lastHandoffWriteAt: Date.now() };
		persistState();
		return undefined;
	}

	async function guardLinearToolCall(event: ToolCallEvent, ctx: ExtensionContext): Promise<BlockResult> {
		const op = linearOperationName(event.toolName);
		if (isReadOnlyLinearOperation(op)) return undefined;

		if (isBlockedLinearOperation(op)) {
			return { block: true, reason: `Planning Agent handoff mode blocks this Linear mutation: ${event.toolName}` };
		}

		if (op === "linear_save_issue") {
			const input = asMutableInput(event);
			const issueId = stringValue(input.id);
			const team = stringValue(input.team);
			const project = stringValue(input.project);

			if (!issueId && !team && !DEFAULT_LINEAR_TEAM) {
				return {
					block: true,
					reason: "Planning Agent Linear issue creation must include a team, or set PLANNING_AGENT_LINEAR_TEAM. All Linear projects are allowed; no project allowlist is enforced.",
				};
			}

			if (!issueId) {
				if (!team && DEFAULT_LINEAR_TEAM) input.team = DEFAULT_LINEAR_TEAM;
				if (!project && DEFAULT_LINEAR_PROJECT) input.project = DEFAULT_LINEAR_PROJECT;
			}
			const labels = ensureRequiredLabels(input.labels);
			if (labels) input.labels = labels;

			return confirmHandoffWrite(ctx, event, describeLinearIssueWrite(issueId, stringValue(input.team), stringValue(input.project)));
		}

		if (op === "linear_save_comment") {
			const input = asMutableInput(event);
			if (stringValue(input.id)) {
				return { block: true, reason: "Planning Agent does not update existing Linear comments in handoff mode." };
			}
			if (stringValue(input.parentId)) {
				return { block: true, reason: "Planning Agent does not reply to existing Linear comment threads because scope cannot be verified." };
			}
			const issueId = stringValue(input.issueId);
			const projectId = stringValue(input.projectId);
			if (!issueId && !projectId) {
				return { block: true, reason: "Planning Agent Linear comments must target an explicit Linear issueId or projectId." };
			}
			return confirmHandoffWrite(ctx, event, `Linear comment targets ${issueId ? `issue ${issueId}` : `project ${projectId}`}. All Linear projects are allowed.`);
		}

		if (op === "linear_save_document") {
			const input = asMutableInput(event);
			const issue = stringValue(input.issue);
			const project = stringValue(input.project);
			if (!issue && !project && DEFAULT_LINEAR_PROJECT) input.project = DEFAULT_LINEAR_PROJECT;
			const scopedProject = stringValue(input.project);
			if (!issue && !scopedProject) {
				return { block: true, reason: "Planning Agent Linear documents must include an explicit Linear issue or project, or set PLANNING_AGENT_LINEAR_PROJECT." };
			}
			return confirmHandoffWrite(ctx, event, `Linear document targets ${issue ? `issue ${issue}` : `project ${scopedProject}`}. All Linear projects are allowed.`);
		}

		return { block: true, reason: `Planning Agent handoff mode does not allow this Linear operation: ${event.toolName}` };
	}

	async function guardNotionToolCall(event: ToolCallEvent, ctx: ExtensionContext): Promise<BlockResult> {
		const op = notionOperationName(event.toolName);
		if (isNotionSetupOperation(op) || isReadOnlyNotionOperation(op)) return undefined;

		if (isBlockedNotionOperation(op)) {
			return { block: true, reason: `Planning Agent handoff mode blocks this Notion mutation: ${event.toolName}` };
		}

		if (!isAllowedNotionWriteOperation(op)) {
			return { block: true, reason: `Planning Agent handoff mode does not allow this Notion operation: ${event.toolName}` };
		}

		const target = getConfiguredNotionTarget(state);
		if (!target) {
			return {
				block: true,
				reason: `Planning Agent Notion writes are blocked until an approved target is configured. Set ${NOTION_TARGET_URL_ENV}/${NOTION_TARGET_ID_ENV} or pass a Notion URL to /planning-agent-handoff.`,
			};
		}

		const scopeError = validateNotionWriteTarget(op, event.input ?? {}, target);
		if (scopeError) {
			return {
				block: true,
				reason: scopeError,
			};
		}

		return confirmHandoffWrite(ctx, event, `Notion write is scoped to approved target ${target.display}.`);
	}

	function guardReadOnlyPlanningToolCall(event: ToolCallEvent): BlockResult {
		if (MUTATION_TOOLS.has(event.toolName)) {
			return {
				block: true,
				reason: "Planning Agent is read-only. Produce the Markdown implementation plan in the response; use /save-plan [path] to persist captured output.",
			};
		}

		if (event.toolName === "mcp" && !isAllowedMcpGatewayReadOnlyCall(event.input)) {
			return {
				block: true,
				reason: "Planning Agent allows MCP gateway calls only for discovery and read-only tool calls (get/list/search/query/read/fetch/etc.). MCP mutations remain blocked.",
			};
		}

		if (!isAllowedReadOnlyResearchTool(event.toolName)) {
			return {
				block: true,
				reason: `Planning Agent only allows read-only/retrieval tools (${READ_ONLY_TOOL_ALLOWLIST.join(", ")}, read-only MCP calls, web-search, and graphify-prefixed aliases). Tool blocked: ${event.toolName}`,
			};
		}

		if (event.toolName === "bash") {
			const command = String(event.input?.command ?? "");
			if (!isSafeCommand(command)) {
				return {
					block: true,
					reason: `Planning Agent blocked non-read-only bash command. Use read/grep/find/ls/rag_search/web_search or disable planning first.\nCommand: ${command}`,
				};
			}
		}

		return undefined;
	}

	pi.registerCommand("implementation-plan", {
		description: "Start Planning Agent mode for an engineering-ready implementation plan",
		handler: startPlanning,
	});

	pi.registerCommand("plan-agent", {
		description: "Alias for /implementation-plan",
		handler: startPlanning,
	});

	pi.registerCommand("planning-agent", {
		description: "Alias for /implementation-plan",
		handler: startPlanning,
	});

	pi.registerCommand("planning-agent-off", {
		description: "Disable Planning Agent mode and restore default tools",
		handler: async (_args, ctx) => disablePlanning(ctx),
	});

	pi.registerCommand("planning-agent-handoff", {
		description: "Enable approved Linear/Notion handoff mode with guardrails",
		handler: enableHandoff,
	});

	pi.registerCommand("planning-agent-handoff-off", {
		description: "Disable Planning Agent handoff mode and return to read-only planning",
		handler: disableHandoff,
	});

	pi.registerCommand("planning-agent-status", {
		description: "Show Planning Agent status and captured plan metadata",
		handler: async (_args, ctx) => {
			const notionTarget = getConfiguredNotionTarget(state);
			const lines = [
				`Planning Agent: ${state.active ? "active" : "inactive"}`,
				`Handoff mode: ${state.handoffActive ? "active" : "inactive"}`,
				state.handoffApprovedAt ? `Handoff approved: ${new Date(state.handoffApprovedAt).toLocaleString()}` : undefined,
				state.lastHandoffWriteAt ? `Last handoff write: ${new Date(state.lastHandoffWriteAt).toLocaleString()}` : undefined,
				`Linear scope: ${describeLinearScope()}`,
				`Notion target: ${notionTarget?.display ?? `not configured (${NOTION_TARGET_URL_ENV}/${NOTION_TARGET_ID_ENV})`}`,
				state.lastRequest ? `Last request: ${firstLine(state.lastRequest)}` : undefined,
				state.lastPlanAt ? `Last plan: ${new Date(state.lastPlanAt).toLocaleString()}` : undefined,
				state.lastSavedPath ? `Saved path: ${state.lastSavedPath}` : undefined,
			]
				.filter(Boolean)
				.join("\n");
			ctx.ui.notify(lines, "info");
		},
	});

	pi.registerCommand("save-plan", {
		description: "Save the last captured implementation plan to .pi/plans/ or a provided path",
		handler: saveLastPlan,
	});

	pi.on?.("session_start", async (_event, ctx) => {
		state = restoreState<PlanningAgentState>(ctx, STATE_ENTRY_TYPE, normalizePlanningState) ?? state;
		baselineTools = state.baselineTools;

		if (pi.getFlag?.("planning-agent") === true) {
			enablePlanning(ctx);
		} else if (state.active) {
			setPlanningTools();
		}
		updateUi(ctx);
	});

	pi.on?.("before_agent_start", async (event) => {
		if (!state.active) return undefined;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${PLANNING_AGENT_SYSTEM_CONTEXT}${state.handoffActive ? `\n\n${buildHandoffSystemContext(state)}` : ""}`,
		};
	});

	pi.on?.("context", async (event) => ({
		messages: event.messages.filter((message: any) => !MODE_CONTEXT_TYPES.has(message.customType)),
	}));

	pi.on?.("tool_call", async (event, ctx) => {
		if (!state.active) return;

		if (state.handoffActive) {
			const readOnlyDecision = guardReadOnlyPlanningToolCall(event);
			if (!readOnlyDecision) return undefined;

			if (isLinearTool(event.toolName)) return guardLinearToolCall(event, ctx);
			if (isNotionTool(event.toolName)) return guardNotionToolCall(event, ctx);

			return readOnlyDecision;
		}

		return guardReadOnlyPlanningToolCall(event);
	});

	pi.on?.("agent_end", async (event, ctx) => {
		if (!state.active) return;

		const plan = extractImplementationPlan(extractLastAssistantText(event.messages));
		if (!plan) return;

		state = { ...state, lastPlanMarkdown: plan, lastPlanAt: Date.now() };
		persistState();
		updateUi(ctx);
		ctx.ui.notify("Captured implementation plan. Use /save-plan [path] to write it to disk, or /planning-agent-off to exit planning mode.", "info");
	});
}

function buildPlanningKickoffPrompt(userContext: string, cwd: string): string {
	return [
		"You are now the Planning Agent for this pi session.",
		"",
		`Working directory: ${cwd}`,
		"",
		"User-provided context:",
		userContext.trim(),
		"",
		"Follow the active Planning Agent instructions. Do read-only research first. Ask blocking clarifying questions before producing the plan if required. Otherwise produce the full engineering-ready implementation plan.",
	].join("\n");
}

function buildHandoffKickoffPrompt(userContext: string, cwd: string, state: PlanningAgentState): string {
	return [
		"Planning Agent handoff mode is now approved for this session.",
		"",
		`Working directory: ${cwd}`,
		`Linear scope: ${describeLinearScope()}`,
		`Notion target: ${getConfiguredNotionTarget(state)?.display ?? "not configured; do not attempt Notion writes"}`,
		"",
		"User-provided handoff context:",
		userContext.trim(),
		"",
		"Use only the approved Linear/Notion handoff tools when the user explicitly asked for handoff. Keep writes scoped, minimal, and traceable to the captured plan or user-provided artifact. Do not create or edit unrelated records.",
	].join("\n");
}

const PLANNING_AGENT_SYSTEM_CONTEXT = loadPromptFile(__dirname, "planning-agent", "technical-planning-agent.md");

function buildHandoffSystemContext(state: PlanningAgentState): string {
	return [
		"# Approved Planning Agent handoff mode",
		"",
		"Handoff mode adds limited external write permission for Linear and Notion only after explicit user approval.",
		"",
		"Hard guardrails:",
		`- Linear scope supports all Linear projects/issues: ${describeLinearScope()}.`,
		"- Linear issue creates must include a team unless PLANNING_AGENT_LINEAR_TEAM is configured; project is optional and may be any Linear project.",
		"- Linear comment/document writes must target an explicit Linear issue or project unless a default project is configured.",
		"- Linear deletes, project/milestone/initiative/status mutations, attachments, label creation, and unrelated comment/document updates are forbidden.",
		`- Notion writes are allowed only when targeting the approved RADD/ARD target: ${getConfiguredNotionTarget(state)?.display ?? "not configured; Notion writes are blocked"}.`,
		"- Never use bash, MCP gateway calls, or other integrations to bypass these restrictions; MCP is allowed only for read-only discovery/retrieval unless a guarded Linear/Notion handoff tool is explicitly approved.",
		"- Before each batch post, summarize the intended records and wait for the confirmation dialog shown by the extension.",
		"- If a handoff cannot be completed within these guardrails, stop and explain what configuration or approval is missing.",
	].join("\n");
}

function normalizePlanningState(restored: Partial<PlanningAgentState>): PlanningAgentState {
	return {
		active: Boolean(restored.active),
		baselineTools: Array.isArray(restored.baselineTools) ? restored.baselineTools.filter((name): name is string => typeof name === "string") : undefined,
		startedAt: restored.startedAt,
		lastRequest: restored.lastRequest,
		lastPlanMarkdown: restored.lastPlanMarkdown,
		lastPlanAt: restored.lastPlanAt,
		lastSavedPath: restored.lastSavedPath,
		handoffActive: Boolean(restored.handoffActive),
		handoffApprovedAt: restored.handoffApprovedAt,
		handoffContext: restored.handoffContext,
		handoffNotionTargetUrl: restored.handoffNotionTargetUrl,
		lastHandoffWriteAt: restored.lastHandoffWriteAt,
	};
}

function extractImplementationPlan(text: string): string | undefined {
	if (!text.trim()) return undefined;
	const heading = text.search(/^#\s+Technical Implementation Plan\s*$/im);
	if (heading === -1) return undefined;
	return text.slice(heading).trim();
}

function getHandoffTools(pi: ExtensionAPI): string[] {
	const allTools = getAllToolNames(pi);
	const available = allTools.length > 0 ? allTools : [...READ_ONLY_TOOL_ALLOWLIST];
	const selected = new Set<string>();
	for (const name of available) {
		if (isAllowedReadOnlyResearchTool(name) || isPotentialHandoffTool(name)) selected.add(name);
	}
	return selected.size > 0 ? [...selected] : READ_ONLY_TOOL_ALLOWLIST;
}

function isPotentialHandoffTool(toolName: string): boolean {
	if (isLinearTool(toolName)) {
		const op = linearOperationName(toolName);
		return isReadOnlyLinearOperation(op) || op === "linear_save_issue" || op === "linear_save_comment" || op === "linear_save_document";
	}
	if (isNotionTool(toolName)) {
		const op = notionOperationName(toolName);
		return isNotionSetupOperation(op) || isReadOnlyNotionOperation(op) || (!isBlockedNotionOperation(op) && isAllowedNotionWriteOperation(op));
	}
	return false;
}

function isLinearTool(toolName: string): boolean {
	const name = normalizeToolName(toolName);
	return name.startsWith("linear_") || name.includes("_linear_");
}

function isNotionTool(toolName: string): boolean {
	const name = normalizeToolName(toolName);
	return name.startsWith("notion_") || name.includes("_notion_");
}

function linearOperationName(toolName: string): string {
	const name = normalizeToolName(toolName);
	const index = name.lastIndexOf("linear_");
	return index >= 0 ? name.slice(index) : name;
}

function notionOperationName(toolName: string): string {
	const name = normalizeToolName(toolName);
	const index = name.lastIndexOf("notion_");
	return index >= 0 ? name.slice(index) : name;
}

function isReadOnlyLinearOperation(op: string): boolean {
	return /^linear_(get|list|search|extract)_/.test(op);
}

function isBlockedLinearOperation(op: string): boolean {
	return (
		/^linear_delete_/.test(op) ||
		op === "linear_save_project" ||
		op === "linear_save_milestone" ||
		op === "linear_save_initiative" ||
		op === "linear_save_status_update" ||
		op === "linear_delete_status_update" ||
		op === "linear_create_issue_label" ||
		op.startsWith("linear_prepare_attachment") ||
		op.startsWith("linear_create_attachment")
	);
}

function isNotionSetupOperation(op: string): boolean {
	return op.includes("setup_token") || op.includes("connect_account") || op.includes("check_connection");
}

function isReadOnlyNotionOperation(op: string): boolean {
	return /^notion_(get|list|search|query|retrieve|find|read|server_info)/.test(op);
}

function isBlockedNotionOperation(op: string): boolean {
	return /(^|_)(delete|remove|archive|trash|destroy|wipe)(_|$)/.test(op);
}

function isAllowedNotionWriteOperation(op: string): boolean {
	return /(^|_)(create|update|append|patch|save|post|publish)(_|$)/.test(op);
}

function asMutableInput(event: ToolCallEvent): Record<string, unknown> {
	if (!event.input || typeof event.input !== "object") event.input = {};
	return event.input;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function describeLinearScope(): string {
	const details = [
		"all Linear projects/issues",
		DEFAULT_LINEAR_TEAM ? `default team ${DEFAULT_LINEAR_TEAM}` : undefined,
		DEFAULT_LINEAR_PROJECT ? `default project ${DEFAULT_LINEAR_PROJECT}` : undefined,
		REQUIRED_LINEAR_LABELS.length > 0 ? `injected labels ${REQUIRED_LINEAR_LABELS.join(", ")}` : undefined,
	].filter(Boolean);
	return details.join("; ");
}

function describeLinearIssueWrite(issueId: string | undefined, team: string | undefined, project: string | undefined): string {
	const scope = [team ? `team ${team}` : undefined, project ? `project ${project}` : undefined].filter(Boolean).join(", ");
	return `Linear issue ${issueId ? `update ${issueId}` : "create"}${scope ? ` scoped to ${scope}` : ""}. All Linear projects are allowed.`;
}

function ensureRequiredLabels(value: unknown): string[] | undefined {
	if (REQUIRED_LINEAR_LABELS.length === 0) return Array.isArray(value) ? value.map((label) => String(label)) : undefined;
	const labels = Array.isArray(value) ? value.map((label) => String(label)) : [];
	const normalized = new Set(labels.map(normalizeIdentifier));
	for (const label of REQUIRED_LINEAR_LABELS) {
		if (!normalized.has(normalizeIdentifier(label))) labels.push(label);
	}
	return labels;
}

function normalizeToolName(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function normalizeIdentifier(value: string): string {
	return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

type NotionTarget = { display: string; identifiers: Set<string> };

function getConfiguredNotionTarget(state: PlanningAgentState): NotionTarget | undefined {
	const display = state.handoffNotionTargetUrl ?? process.env[NOTION_TARGET_URL_ENV]?.trim() ?? process.env[NOTION_TARGET_ID_ENV]?.trim();
	const envId = process.env[NOTION_TARGET_ID_ENV]?.trim();
	const urlId = display ? extractNotionId(display) : undefined;
	const identifiers = [display, envId, urlId, urlId ? hyphenateNotionId(urlId) : undefined]
		.filter((value): value is string => Boolean(value && value.trim()))
		.map(normalizeNotionIdentifier);
	if (identifiers.length === 0 || !display) return undefined;
	return { display, identifiers: new Set(identifiers) };
}

function validateNotionWriteTarget(op: string, input: Record<string, unknown>, target: NotionTarget): string | undefined {
	const directTarget = (value: unknown): boolean => typeof value === "string" && target.identifiers.has(normalizeNotionIdentifier(value));
	const parentTarget = (value: unknown): boolean => {
		if (!value || typeof value !== "object" || Array.isArray(value)) return false;
		const parent = value as Record<string, unknown>;
		return [parent.page_id, parent.database_id, parent.data_source_id].some(directTarget);
	};

	const valid =
		(op === "notion_notion_create_pages" && parentTarget(input.parent)) ||
		(op === "notion_notion_update_page" && directTarget(input.page_id)) ||
		(op === "notion_notion_create_database" && parentTarget(input.parent)) ||
		(op === "notion_notion_create_folder" && parentTarget(input.parent)) ||
		(op === "notion_notion_create_view" && (directTarget(input.database_id) || directTarget(input.parent_page_id))) ||
		(op === "notion_notion_update_data_source" && directTarget(input.data_source_id)) ||
		(op === "notion_notion_create_comment" && directTarget(input.page_id));

	if (valid) return undefined;
	return `Planning Agent cannot verify that ${op} is directly scoped to the approved Notion target (${target.display}). Only supported writes with an exact parent/page/database/data-source target are allowed.`;
}

function normalizeNotionIdentifier(value: string): string {
	return value.trim().toLowerCase().replace(/-/g, "").replace(/\/$/, "");
}

function extractFirstNotionUrl(value: string): string | undefined {
	return value.match(/https?:\/\/(?:www\.)?notion\.so\/\S+/i)?.[0]?.replace(/[),.;]+$/, "");
}

function extractNotionId(value: string): string | undefined {
	const compact = value.replace(/-/g, "");
	return compact.match(/[0-9a-f]{32}/i)?.[0]?.toLowerCase();
}

function hyphenateNotionId(value: string): string {
	const compact = value.replace(/-/g, "");
	if (compact.length !== 32) return value;
	return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

function truncateForDialog(value: string, max = 3000): string {
	return value.length <= max ? value : `${value.slice(0, max)}\n… [truncated ${value.length - max} chars]`;
}
