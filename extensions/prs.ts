import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { complete, type UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { AGENTIC_REVIEW_INSTRUCTIONS } from "./shared/agentic-review-prompt.ts";

type PrAction = "checkout-branch" | "update-description" | "ready-for-review" | "agentic-review" | "explain-actions-failure" | "refresh";
type FocusMode = "prs" | "actions";

interface GitHubRepo {
	owner: string;
	name: string;
	nameWithOwner: string;
	host: string;
}

interface PullRequestListItem {
	number: number;
	title: string;
	isDraft: boolean;
	nodeId?: string;
	headRefName: string;
	headSha?: string;
	baseRefName: string;
	author?: { login?: string };
	updatedAt: string;
	url: string;
	labels?: string[];
	ciStatus?: CiStatus;
}

interface CiStatus {
	state: "success" | "failure" | "pending" | "neutral" | "unknown";
	label: string;
	requiresAttention: boolean;
}

interface PullRequestSelection {
	pr: PullRequestListItem;
	action: PrAction;
}

interface InlineCommentSuggestion {
	path: string;
	line: number;
	body: string;
	severity?: string;
	selected?: boolean;
}

interface PullRequestDetails extends PullRequestListItem {
	body?: string;
	state?: string;
	additions?: number;
	deletions?: number;
	changedFiles?: number;
	reviewComments?: number;
	files?: Array<{ path?: string; additions?: number; deletions?: number }>;
	commits?: Array<{ messageHeadline?: string; oid?: string }>;
}

interface RestPullRequest {
	number: number;
	title: string;
	draft?: boolean;
	node_id?: string;
	head?: { ref?: string; sha?: string };
	base?: { ref?: string };
	user?: { login?: string };
	updated_at?: string;
	html_url?: string;
	body?: string | null;
	state?: string;
	additions?: number;
	deletions?: number;
	changed_files?: number;
	review_comments?: number;
	labels?: Array<{ name?: string }>;
}

interface RestPullRequestFile {
	filename?: string;
	additions?: number;
	deletions?: number;
}

interface RestPullRequestCommit {
	sha?: string;
	commit?: { message?: string };
}

interface RestCombinedStatus {
	state?: string;
	total_count?: number;
	statuses?: Array<{ context?: string; state?: string; description?: string | null; target_url?: string | null }>;
}

interface RestCheckRun {
	id?: number;
	name?: string;
	status?: string;
	conclusion?: string | null;
	html_url?: string;
	output?: { title?: string | null; summary?: string | null; text?: string | null };
}

interface RestCheckRuns {
	total_count?: number;
	check_runs?: RestCheckRun[];
}

interface RestCheckRunAnnotation {
	path?: string;
	start_line?: number;
	end_line?: number;
	annotation_level?: string;
	message?: string;
	title?: string | null;
	raw_details?: string | null;
}

interface RestReview {
	state?: string;
	user?: { login?: string };
	submitted_at?: string;
}

interface RestReviewComment {
	path?: string;
	line?: number | null;
	start_line?: number | null;
	body?: string;
	user?: { login?: string };
	created_at?: string;
	updated_at?: string;
}

const PR_LABELS = {
	mergeWithComments: "‼️ Merge with comments",
	readyToMerge: "✅ Ready to merge",
	readyForReview: "👀 Ready for review",
	changesRequested: "😭 Changes requested",
	doNotMerge: "🚫 Do not merge",
	workInProgress: "🛠️ Work in progress",
	blocked: "🧱 Blocked",
} as const;

const PR_LABEL_OPTIONS = [
	PR_LABELS.mergeWithComments,
	PR_LABELS.readyToMerge,
	PR_LABELS.readyForReview,
	PR_LABELS.changesRequested,
	PR_LABELS.doNotMerge,
	PR_LABELS.workInProgress,
	PR_LABELS.blocked,
] as const;

const REVIEW_EVENT_OPTIONS = ["Comment", "Approve", "Request Changes"] as const;
type ReviewEventChoice = (typeof REVIEW_EVENT_OPTIONS)[number];

const MANAGED_LABELS: readonly string[] = Object.values(PR_LABELS);

const ACTIONS: Array<{ id: PrAction; label: string; description: string }> = [
	{
		id: "checkout-branch",
		label: "Checkout PR branch locally",
		description: "Fetch and switch your working tree to the selected PR branch.",
	},
	{
		id: "update-description",
		label: "Update PR description",
		description: "Use AI to fill the PR body from the template, metadata, and diff.",
	},
	{
		id: "ready-for-review",
		label: "Set draft ready for review",
		description: "Mark the selected draft PR ready using a minimal GraphQL mutation.",
	},
	{
		id: "agentic-review",
		label: "Agentic review",
		description: "Inspect the PR diff, then propose line-specific comments for approval/posting.",
	},
	{
		id: "explain-actions-failure",
		label: "Explain GitHub Actions failure",
		description: "Fetch failing checks and explain the failure in plain English.",
	},
];

class SimpleSelectComponent implements Component {
	private index = 0;

	constructor(
		private tui: { requestRender(force?: boolean): void },
		private theme: any,
		private title: string,
		private options: string[],
		private done: (result: string | undefined) => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.done(undefined);
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.index = Math.max(0, this.index - 1);
			this.refresh();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.index = Math.min(this.options.length - 1, this.index + 1);
			this.refresh();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.done(this.options[this.index]);
			return;
		}
		const digit = Number(data);
		if (Number.isInteger(digit) && digit >= 1 && digit <= this.options.length) {
			this.done(this.options[digit - 1]);
		}
	}

	render(width: number): string[] {
		// Keep the selector comfortably inside the terminal width and render labels
		// as ASCII text. GitHub label values still keep their emoji; only the TUI
		// display strips them so terminals cannot disagree on emoji cell width and
		// wrap rows behind pi's differential renderer.
		const panelWidth = Math.max(1, width - 2);
		const contentWidth = Math.max(1, panelWidth - 4);
		const body: string[] = [];
		const add = (line = "") => body.push(truncateToWidth(line, contentWidth, "..."));
		add(this.theme.fg("dim", "up/down navigate - Enter select - Esc skip"));
		add(this.theme.fg("dim", "-".repeat(contentWidth)));
		for (let i = 0; i < this.options.length; i++) {
			const active = i === this.index;
			const pointer = active ? this.theme.fg("accent", "> ") : "  ";
			const label = `${i + 1}. ${this.displayLabel(this.options[i])}`;
			add(`${pointer}${active ? this.theme.fg("accent", label) : this.theme.fg("text", label)}`);
		}
		return [this.panelTop(panelWidth), ...body.map((line) => this.panelLine(line, panelWidth)), this.panelBottom(panelWidth)];
	}

	invalidate(): void {}

	private refresh(): void {
		this.tui.requestRender();
	}

	private displayLabel(option: string): string {
		return option
			.replace(/^[^\p{Letter}\p{Number}]+\s*/u, "")
			.replace(/[\uFE0E\uFE0F]/g, "")
			.trim();
	}

	private panelTop(width: number): string {
		const innerWidth = Math.max(0, width - 2);
		const label = ` ${this.title} `;
		const clippedLabel = truncateToWidth(label, innerWidth, "…");
		const fill = Math.max(0, innerWidth - visibleWidth(clippedLabel));
		return this.theme.fg("accent", "╭") + this.theme.fg("accent", this.theme.bold(clippedLabel)) + this.theme.fg("accent", `${"─".repeat(fill)}╮`);
	}

	private panelBottom(width: number): string {
		return this.theme.fg("accent", `╰${"─".repeat(Math.max(0, width - 2))}╯`);
	}

	private panelLine(content: string, width: number): string {
		const contentWidth = Math.max(0, width - 4);
		const clipped = truncateToWidth(content, contentWidth, "…");
		const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)));
		return this.theme.fg("accent", "│") + " " + clipped + padding + " " + this.theme.fg("accent", "│");
	}
}

class FetchPrsProgressComponent implements Component {
	private frame = 0;
	private interval: NodeJS.Timeout;

	constructor(
		private tui: { requestRender(): void },
		private theme: any,
		private repo: string,
		private done: (result: PullRequestListItem[] | { error: string } | null) => void,
		fetcher: () => Promise<PullRequestListItem[]>,
	) {
		this.interval = setInterval(() => {
			this.frame++;
			this.tui.requestRender();
		}, 120);
		fetcher()
			.then((prs) => this.finish(prs))
			.catch((error) => this.finish({ error: formatError(error) }));
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) this.finish(null);
	}

	render(width: number): string[] {
		const contentWidth = Math.max(10, width - 4);
		const barWidth = Math.min(40, Math.max(10, contentWidth - 18));
		const position = this.frame % barWidth;
		const bar = Array.from({ length: barWidth }, (_, index) => (index === position ? "█" : "░")).join("");
		return [
			this.theme.fg("accent", `╭${"─".repeat(Math.max(0, width - 2))}╮`),
			this.panelLine(`Fetching PRs for ${this.repo}`, width),
			this.panelLine(`[${bar}] aggregating metadata, checks, and labels`, width),
			this.panelLine("Esc cancel", width),
			this.theme.fg("accent", `╰${"─".repeat(Math.max(0, width - 2))}╯`),
		];
	}

	invalidate(): void {
		clearInterval(this.interval);
	}

	private finish(result: PullRequestListItem[] | { error: string } | null): void {
		clearInterval(this.interval);
		this.done(result);
	}

	private panelLine(content: string, width: number): string {
		const contentWidth = Math.max(0, width - 4);
		const clipped = truncateToWidth(content, contentWidth, "…");
		const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)));
		return this.theme.fg("accent", "│") + " " + clipped + padding + " " + this.theme.fg("accent", "│");
	}
}

class InlineCommentApprovalComponent implements Component {
	private index = 0;
	private scroll = 0;

	constructor(
		private tui: { requestRender(): void },
		private theme: any,
		private prNumber: number,
		private suggestions: InlineCommentSuggestion[],
		private done: (result: InlineCommentSuggestion[] | null) => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.done(null);
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.index = Math.max(0, this.index - 1);
			this.ensureVisible();
			this.refresh();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.index = Math.min(this.suggestions.length - 1, this.index + 1);
			this.ensureVisible();
			this.refresh();
			return;
		}
		if (matchesKey(data, Key.space)) {
			const suggestion = this.suggestions[this.index];
			if (suggestion) suggestion.selected = !suggestion.selected;
			this.refresh();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.done(this.suggestions.filter((suggestion) => suggestion.selected));
		}
	}

	render(width: number): string[] {
		if (width < 4) return [truncateToWidth("inline comments", width)];
		const panelWidth = width;
		const contentWidth = Math.max(1, panelWidth - 4);
		const body: string[] = [];
		const add = (line = "") => body.push(truncateToWidth(line, contentWidth, "…"));
		const selectedCount = this.suggestions.filter((suggestion) => suggestion.selected).length;
		add(this.theme.fg("muted", `PR #${this.prNumber} • ${selectedCount}/${this.suggestions.length} selected`));
		add(this.theme.fg("dim", "↑↓ navigate • Space toggle • Enter post selected • Esc cancel"));
		add(this.theme.fg("dim", "─".repeat(contentWidth)));

		this.ensureVisible();
		const visible = this.suggestions.slice(this.scroll, this.scroll + 8);
		if (this.scroll > 0) add(this.theme.fg("dim", `↑ ${this.scroll} more`));
		for (let i = 0; i < visible.length; i++) {
			const absoluteIndex = this.scroll + i;
			const suggestion = visible[i];
			const active = absoluteIndex === this.index;
			const pointer = active ? this.theme.fg("accent", "› ") : "  ";
			const checkbox = suggestion.selected ? this.theme.fg("success", "[x]") : this.theme.fg("muted", "[ ]");
			const location = `${suggestion.path}:${suggestion.line}`;
			add(`${pointer}${checkbox} ${this.theme.fg(active ? "accent" : "text", location)} ${this.theme.fg("muted", suggestion.severity ?? "")}`);
			for (const line of suggestion.body.split("\n").slice(0, 3)) add(`      ${line}`);
		}
		const remaining = this.suggestions.length - this.scroll - visible.length;
		if (remaining > 0) add(this.theme.fg("dim", `↓ ${remaining} more`));

		return [this.panelTop(panelWidth, "Approve Inline PR Comments"), ...body.map((line) => this.panelLine(line, panelWidth)), this.panelBottom(panelWidth)];
	}

	invalidate(): void {}

	private ensureVisible(maxRows = 8): void {
		if (this.index < this.scroll) this.scroll = this.index;
		if (this.index >= this.scroll + maxRows) this.scroll = this.index - maxRows + 1;
	}

	private panelTop(width: number, title: string): string {
		const innerWidth = Math.max(0, width - 2);
		const label = ` ${title} `;
		const clippedLabel = truncateToWidth(label, innerWidth, "…");
		const fill = Math.max(0, innerWidth - visibleWidth(clippedLabel));
		return this.theme.fg("accent", "╭") + this.theme.fg("accent", this.theme.bold(clippedLabel)) + this.theme.fg("accent", `${"─".repeat(fill)}╮`);
	}

	private panelBottom(width: number): string {
		return this.theme.fg("accent", `╰${"─".repeat(Math.max(0, width - 2))}╯`);
	}

	private panelLine(content: string, width: number): string {
		const contentWidth = Math.max(0, width - 4);
		const clipped = truncateToWidth(content, contentWidth, "…");
		const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)));
		return this.theme.fg("accent", "│") + " " + clipped + padding + " " + this.theme.fg("accent", "│");
	}

	private refresh(): void {
		this.tui.requestRender();
	}
}

class PrsComponent implements Component {
	private mode: FocusMode = "prs";
	private prIndex = 0;
	private actionIndex = 0;
	private prScroll = 0;

	constructor(
		private tui: { requestRender(): void },
		private theme: any,
		private repo: string,
		private prs: PullRequestListItem[],
		private done: (result: PullRequestSelection | null) => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			if (this.mode === "actions") {
				this.mode = "prs";
				this.refresh();
				return;
			}
			this.done(null);
			return;
		}

		if (data.toLowerCase() === "r") {
			this.done({ pr: this.selectedPr(), action: "refresh" });
			return;
		}

		if (matchesKey(data, Key.tab) || matchesKey(data, Key.enter)) {
			if (this.mode === "prs") {
				this.mode = "actions";
			} else if (matchesKey(data, Key.tab)) {
				this.mode = "prs";
			} else {
				this.submit();
				return;
			}
			this.refresh();
			return;
		}

		if (this.mode === "prs") {
			if (matchesKey(data, Key.up)) {
				this.prIndex = Math.max(0, this.prIndex - 1);
				this.actionIndex = 0;
				this.ensurePrVisible();
				this.refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				this.prIndex = Math.min(this.prs.length - 1, this.prIndex + 1);
				this.actionIndex = 0;
				this.ensurePrVisible();
				this.refresh();
				return;
			}
		}

		if (this.mode === "actions") {
			const actions = this.availableActions(this.selectedPr());
			if (matchesKey(data, Key.up)) {
				this.actionIndex = Math.max(0, this.actionIndex - 1);
				this.refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				this.actionIndex = Math.min(actions.length - 1, this.actionIndex + 1);
				this.refresh();
				return;
			}
			const digit = Number(data);
			if (Number.isInteger(digit) && digit >= 1 && digit <= actions.length) {
				this.actionIndex = digit - 1;
				this.submit();
			}
		}
	}

	render(width: number): string[] {
		if (width < 4) return [truncateToWidth("prs", width)];

		const panelWidth = width;
		const contentWidth = Math.max(1, panelWidth - 4);
		const body: string[] = [];
		const add = (line = "") => body.push(truncateToWidth(line, contentWidth, "…"));
		const rule = () => add(this.theme.fg("dim", "─".repeat(contentWidth)));
		const selected = this.selectedPr();

		add(this.theme.fg("muted", `Repository: ${this.repo}`));
		add(this.theme.fg("dim", "↑↓ navigate • Enter disclose/select • Tab switch • r refresh • Esc back/cancel"));
		rule();

		add(this.sectionTitle(`Open + draft PRs (${this.prs.length})`, this.mode === "prs"));
		for (const line of this.renderPrDetailsSplit(contentWidth)) add(line);
		rule();

		const actions = this.availableActions(selected);
		this.actionIndex = Math.min(this.actionIndex, actions.length - 1);
		if (this.mode === "actions") {
			add(this.sectionTitle(`Actions for #${selected.number}`, true));
			for (let i = 0; i < actions.length; i++) {
				const action = actions[i];
				const active = i === this.actionIndex;
				const prefix = active ? this.theme.fg("accent", "› ") : "  ";
				const label = active ? this.theme.fg("accent", `${i + 1}. ${action.label}`) : this.theme.fg("text", `${i + 1}. ${action.label}`);
				add(`${prefix}${label}`);
				add(`    ${this.theme.fg("muted", action.description)}`);
			}
		} else {
			add(this.sectionTitle("Actions", false));
			add(this.theme.fg("dim", `Press Enter on #${selected.number} to disclose actions:`));
			for (let i = 0; i < actions.length; i++) add(this.theme.fg("dim", `  ${i + 1}. ${actions[i].label}`));
		}

		return [this.panelTop(panelWidth, "Pull Requests"), ...body.map((line) => this.panelLine(line, panelWidth)), this.panelBottom(panelWidth)];
	}

	invalidate(): void {}

	private renderPrDetailsSplit(width: number): string[] {
		if (width < 78) return this.renderStacked(width);

		const leftWidth = Math.min(Math.max(36, Math.floor(width * 0.46)), Math.max(36, width - 36));
		const divider = ` ${this.theme.fg("dim", "│")} `;
		const rightWidth = Math.max(1, width - leftWidth - 3);
		const selected = this.selectedPr();
		const listLines = this.renderPrList(leftWidth, 12);
		const detailLines = this.renderPrDetails(selected, rightWidth);
		const rows = Math.max(listLines.length, detailLines.length);
		const lines: string[] = [];

		for (let i = 0; i < rows; i++) {
			lines.push(`${this.fit(listLines[i] ?? "", leftWidth)}${divider}${this.fit(detailLines[i] ?? "", rightWidth)}`);
		}

		return lines;
	}

	private renderStacked(width: number): string[] {
		return [...this.renderPrList(width, 10), this.theme.fg("dim", "─".repeat(width)), ...this.renderPrDetails(this.selectedPr(), width)];
	}

	private renderPrList(width: number, maxRows: number): string[] {
		const lines: string[] = [];
		this.ensurePrVisible(maxRows);
		const visible = this.prs.slice(this.prScroll, this.prScroll + maxRows);

		for (let i = 0; i < visible.length; i++) {
			const absoluteIndex = this.prScroll + i;
			const pr = visible[i];
			const selected = absoluteIndex === this.prIndex;
			const active = selected && this.mode === "prs";
			const pointer = selected ? this.theme.fg(active ? "accent" : "muted", "› ") : "  ";
			const state = pr.isDraft ? this.theme.fg("warning", "DRAFT") : this.theme.fg("success", "OPEN ");
			const ci = this.renderCiStatus(pr.ciStatus);
			const title = selected ? this.theme.fg(active ? "accent" : "muted", pr.title) : this.theme.fg("text", pr.title);
			lines.push(this.fit(`${pointer}#${pr.number} ${state} ${ci} ${title}`, width));
			lines.push(this.fit(`     ${this.theme.fg("muted", `${pr.headRefName} → ${pr.baseRefName} • @${pr.author?.login ?? "unknown"}`)}`, width));
		}

		if (this.prScroll > 0) lines.unshift(this.theme.fg("dim", `↑ ${this.prScroll} more`));
		const remaining = this.prs.length - this.prScroll - visible.length;
		if (remaining > 0) lines.push(this.theme.fg("dim", `↓ ${remaining} more`));

		return lines;
	}

	private renderPrDetails(pr: PullRequestListItem, width: number): string[] {
		const state = pr.isDraft ? this.theme.fg("warning", "Draft") : this.theme.fg("success", "Open");
		return [
			this.theme.fg("accent", this.theme.bold(`#${pr.number} ${pr.title}`)),
			`${this.theme.fg("muted", "State:")} ${state}`,
			`${this.theme.fg("muted", "Actions:")} ${this.renderCiStatus(pr.ciStatus)} ${pr.ciStatus?.requiresAttention ? this.theme.fg("warning", "requires attention") : ""}`,
			`${this.theme.fg("muted", "Branch:")} ${pr.headRefName} → ${pr.baseRefName}`,
			`${this.theme.fg("muted", "Author:")} @${pr.author?.login ?? "unknown"}`,
			`${this.theme.fg("muted", "Updated:")} ${formatDate(pr.updatedAt)}`,
			`${this.theme.fg("muted", "URL:")} ${pr.url}`,
			"",
			this.theme.fg("dim", this.mode === "actions" ? "Choose an action below." : "Press Enter to disclose actions."),
		].map((line) => this.fit(line, width));
	}

	private selectedPr(): PullRequestListItem {
		return this.prs[this.prIndex];
	}

	private renderCiStatus(status?: CiStatus): string {
		const label = status?.label ?? "actions ?";
		if (!status) return this.theme.fg("muted", label);
		if (status.state === "success") return this.theme.fg("success", label);
		if (status.state === "failure") return this.theme.fg("error", label);
		if (status.state === "pending") return this.theme.fg("warning", label);
		return this.theme.fg("muted", label);
	}

	private submit(): void {
		const pr = this.selectedPr();
		const actions = this.availableActions(pr);
		this.done({ pr, action: actions[Math.min(this.actionIndex, actions.length - 1)].id });
	}

	private availableActions(pr: PullRequestListItem): typeof ACTIONS {
		return ACTIONS.filter((action) => action.id !== "explain-actions-failure" || pr.ciStatus?.state === "failure");
	}

	private ensurePrVisible(maxRows = 12): void {
		if (this.prIndex < this.prScroll) this.prScroll = this.prIndex;
		if (this.prIndex >= this.prScroll + maxRows) this.prScroll = this.prIndex - maxRows + 1;
	}

	private sectionTitle(label: string, active: boolean): string {
		const text = active ? `› ${label}` : `  ${label}`;
		return active ? this.theme.fg("accent", this.theme.bold(text)) : this.theme.fg("muted", this.theme.bold(text));
	}

	private panelTop(width: number, title: string): string {
		const innerWidth = Math.max(0, width - 2);
		const label = ` ${title} `;
		const clippedLabel = truncateToWidth(label, innerWidth, "…");
		const fill = Math.max(0, innerWidth - visibleWidth(clippedLabel));
		return this.theme.fg("accent", "╭") + this.theme.fg("accent", this.theme.bold(clippedLabel)) + this.theme.fg("accent", `${"─".repeat(fill)}╮`);
	}

	private panelBottom(width: number): string {
		return this.theme.fg("accent", `╰${"─".repeat(Math.max(0, width - 2))}╯`);
	}

	private panelLine(content: string, width: number): string {
		const contentWidth = Math.max(0, width - 4);
		const clipped = truncateToWidth(content, contentWidth, "…");
		const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)));
		return this.theme.fg("accent", "│") + " " + clipped + padding + " " + this.theme.fg("accent", "│");
	}

	private fit(content: string, width: number): string {
		const clipped = truncateToWidth(content, width, "…");
		return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
	}

	private refresh(): void {
		this.tui.requestRender();
	}
}

const pendingAgenticReviewApprovals = new Set<number>();

export default function prsExtension(pi: ExtensionAPI) {
	pi.on("agent_end", async (event, ctx) => {
		if (!ctx.hasUI) return;
		const prNumber = findPendingAgenticReviewPrNumber(event.messages as unknown[]);
		if (!prNumber) return;
		// Support both /prs-launched reviews and manually pasted "Agentic review PR #..."
		// prompts. The pending set is only used to avoid stale state, not as a gate.
		pendingAgenticReviewApprovals.delete(prNumber);

		const repo = await getActiveRepo(pi, ctx.cwd);
		const assistantText = extractAssistantText(event.messages as unknown[]);
		const suggestions = parseInlineCommentCandidatesFromReview(assistantText);
		let postedAnyComments = false;
		if (suggestions.length > 0) {
			const approved = await ctx.ui.custom<InlineCommentSuggestion[] | null>((tui, theme, _kb, done) => {
				return new InlineCommentApprovalComponent(tui, theme, prNumber, suggestions, done);
			});
			if (approved === null) {
				ctx.ui.notify("Inline comment posting cancelled", "info");
				return;
			}
			if (approved.length > 0) {
				await postInlineReviewComments(pi, ctx as ExtensionCommandContext, repo, prNumber, approved);
				postedAnyComments = true;
				ctx.ui.notify(`Posted ${approved.length} inline PR comment${approved.length === 1 ? "" : "s"} to #${prNumber}`, "info");
			} else {
				ctx.ui.notify("No inline comments selected", "info");
			}
		} else {
			ctx.ui.notify(`No new inline comment candidates found for PR #${prNumber}`, "info");
		}

		if (postedAnyComments) await finalizeReviewWorkflow(pi, ctx as ExtensionCommandContext, repo, prNumber);
		else await promptForWorkflowLabel(pi, ctx as ExtensionCommandContext, repo, prNumber);
	});

	pi.registerCommand("prs", {
		description: "Browse open and draft GitHub PRs and run PR actions",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/prs requires interactive mode", "error");
				return;
			}

			try {
				await ctx.waitForIdle();
				await execOrThrow(pi, "gh", ["--version"], ctx.cwd, "GitHub CLI (gh) is required");
				const repo = await getActiveRepo(pi, ctx.cwd);

				while (true) {
					const prs = await fetchPullRequestsWithProgress(pi, ctx, repo);

					if (prs.length === 0) {
						ctx.ui.notify(`No open PRs found for ${repo.nameWithOwner}`, "info");
						return;
					}

					const selection = await ctx.ui.custom<PullRequestSelection | null>((tui, theme, _kb, done) => {
						return new PrsComponent(tui, theme, repo.nameWithOwner, prs, done);
					});

					if (!selection) {
						ctx.ui.notify("PR action cancelled", "info");
						return;
					}
					if (selection.action === "refresh") continue;

					await runPrAction(pi, ctx, selection);
					return;
				}
			} catch (error) {
				ctx.ui.notify(formatError(error), "error");
			}
		},
	});
}

async function fetchPullRequestsWithProgress(pi: ExtensionAPI, ctx: ExtensionCommandContext, repo: GitHubRepo): Promise<PullRequestListItem[]> {
	const result = await ctx.ui.custom<PullRequestListItem[] | { error: string } | null>((tui, theme, _kb, done) => {
		return new FetchPrsProgressComponent(tui, theme, repo.nameWithOwner, done, () => listOpenPullRequests(pi, ctx.cwd, repo));
	});
	if (result === null) throw new Error("PR fetch cancelled");
	if (!Array.isArray(result)) throw new Error(result.error);
	return result;
}

async function runPrAction(pi: ExtensionAPI, ctx: ExtensionCommandContext, selection: PullRequestSelection): Promise<void> {
	const { pr, action } = selection;

	if (action === "checkout-branch") {
		await checkoutPullRequestBranch(pi, ctx, pr);
		return;
	}

	if (action === "update-description") {
		await updatePrDescription(pi, ctx, pr.number);
		return;
	}

	if (action === "ready-for-review") {
		if (!pr.isDraft) {
			ctx.ui.notify(`#${pr.number} is already ready for review`, "info");
			return;
		}
		const repo = await getActiveRepo(pi, ctx.cwd);
		const nodeId = pr.nodeId ?? (await getPullRequestDetails(pi, ctx.cwd, repo, pr.number)).nodeId;
		if (!nodeId) throw new Error(`Could not resolve node_id for PR #${pr.number}`);
		await markPullRequestReadyForReview(pi, ctx.cwd, repo, nodeId, pr.number);
		await maintainPullRequestLabels(pi, ctx.cwd, repo, { ...pr, isDraft: false });
		ctx.ui.notify(`#${pr.number} is ready for review`, "info");
		return;
	}

	if (action === "agentic-review") {
		const repo = await getActiveRepo(pi, ctx.cwd);
		// Queue approval extraction for the completed agent response. This avoids the
		// old parallel generator race while still opening the approval UI after the
		// written review includes appended inline comment candidates.
		pendingAgenticReviewApprovals.add(pr.number);
		pi.sendUserMessage(await buildAgenticReviewPrompt(pi, ctx.cwd, repo, pr));
		return;
	}

	if (action === "explain-actions-failure") {
		await explainActionsFailure(pi, ctx, pr);
	}
}

async function checkoutPullRequestBranch(pi: ExtensionAPI, ctx: ExtensionCommandContext, pr: PullRequestListItem): Promise<void> {
	const repo = await getActiveRepo(pi, ctx.cwd);
	await execOrThrow(
		pi,
		"gh",
		["pr", "checkout", String(pr.number), "--repo", ghRepoSelector(repo)],
		ctx.cwd,
		`Failed to checkout PR #${pr.number}`,
	);
	const branch = await getCurrentGitBranch(pi, ctx.cwd).catch(() => pr.headRefName);
	ctx.ui.notify(`Checked out PR #${pr.number} locally on ${branch}`, "info");
}

async function updatePrDescription(pi: ExtensionAPI, ctx: ExtensionCommandContext, prNumber: number): Promise<void> {
	if (!ctx.model) throw new Error("No model selected for AI PR description generation");

	const generated = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(tui, theme, `Generating PR #${prNumber} description with ${ctx.model!.id}...`);
		loader.onAbort = () => done(null);

		generatePrDescription(pi, ctx, prNumber, loader.signal)
			.then(done)
			.catch((error) => done(`ERROR: ${formatError(error)}`));

		return loader;
	});

	if (generated === null) {
		ctx.ui.notify("PR description update cancelled", "info");
		return;
	}
	if (generated.startsWith("ERROR: ")) throw new Error(generated.slice("ERROR: ".length));

	const edited = await ctx.ui.editor(`Review PR #${prNumber} description before updating`, generated);
	if (edited === undefined) {
		ctx.ui.notify("PR description update cancelled", "info");
		return;
	}

	const repo = await getActiveRepo(pi, ctx.cwd);
	const tempDir = await mkdtemp(join(tmpdir(), "pi-prs-"));
	try {
		const bodyFile = join(tempDir, "pr-body.md");
		await writeFile(bodyFile, ensureTrailingNewline(edited), "utf8");
		// Do not use `gh pr edit`: current gh versions can hit deprecated Projects classic GraphQL fields.
		await ghApi(
			pi,
			ctx.cwd,
			repo,
			["--method", "PATCH", `repos/${repo.owner}/${repo.name}/pulls/${prNumber}`, "-H", "Accept: application/vnd.github+json", "-F", `body=@${bodyFile}`],
			`Failed to update PR #${prNumber} description`,
		);
		ctx.ui.notify(`Updated PR #${prNumber} description`, "info");
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
}

async function explainActionsFailure(pi: ExtensionAPI, ctx: ExtensionCommandContext, pr: PullRequestListItem): Promise<void> {
	const repo = await getActiveRepo(pi, ctx.cwd);
	const failure = await getActionsFailureDetails(pi, ctx.cwd, repo, pr);
	if (!failure.trim()) {
		ctx.ui.notify(`No failing GitHub Actions checks found for PR #${pr.number}`, "info");
		return;
	}

	let explanation = fallbackActionsExplanation(pr, failure);
	if (ctx.model) {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
		if (auth.ok && auth.apiKey) {
			const response = await complete(
				ctx.model,
				{
					systemPrompt: [
						"Explain GitHub Actions failures in plain English for a developer.",
						"Be concise. Identify the failing job/check, likely cause, and next fix to try.",
						"Do not invent details not present in the provided check output.",
					].join("\n"),
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: [`PR #${pr.number}: ${pr.title}`, "", failure].join("\n") }],
							timestamp: Date.now(),
						},
					],
				},
				{ apiKey: auth.apiKey, headers: auth.headers },
			);
			if (response.stopReason !== "aborted") {
				explanation = response.content
					.filter((content): content is { type: "text"; text: string } => content.type === "text")
					.map((content) => content.text)
					.join("\n")
					.trim() || explanation;
			}
		}
	}

	await ctx.ui.editor(`GitHub Actions failure explanation for PR #${pr.number}`, explanation);
}

async function getActionsFailureDetails(pi: ExtensionAPI, cwd: string, repo: GitHubRepo, pr: PullRequestListItem): Promise<string> {
	if (!pr.headSha) return "";
	const [statusOutput, checksOutput] = await Promise.all([
		ghApi(pi, cwd, repo, [`repos/${repo.owner}/${repo.name}/commits/${pr.headSha}/status`]),
		ghApi(pi, cwd, repo, [`repos/${repo.owner}/${repo.name}/commits/${pr.headSha}/check-runs`, "-H", "Accept: application/vnd.github+json", "--paginate", "--slurp"]),
	]);
	const combined = JSON.parse(statusOutput) as RestCombinedStatus;
	const checks = parsePaginatedCheckRuns(checksOutput);
	const failedChecks = (checks.check_runs ?? []).filter((run) => ["failure", "timed_out", "cancelled", "action_required"].includes(run.conclusion ?? ""));
	const failedStatuses = (combined.statuses ?? []).filter((status) => ["failure", "error"].includes(status.state ?? ""));
	if (failedChecks.length === 0 && failedStatuses.length === 0) return "";

	const annotationsByCheck = new Map<number, RestCheckRunAnnotation[]>();
	await Promise.all(
		failedChecks.slice(0, 5).map(async (run) => {
			if (!run.id) return;
			try {
				const output = await ghApi(
					pi,
					cwd,
					repo,
					[`repos/${repo.owner}/${repo.name}/check-runs/${run.id}/annotations`, "-H", "Accept: application/vnd.github+json", "--paginate", "--slurp"],
				);
				annotationsByCheck.set(run.id, parsePaginatedArray<RestCheckRunAnnotation>(output));
			} catch {
				annotationsByCheck.set(run.id, []);
			}
		}),
	);

	const sections: string[] = [];
	for (const run of failedChecks) {
		sections.push(
			[
				`Check: ${run.name ?? "unknown"}`,
				`Conclusion: ${run.conclusion ?? "unknown"}`,
				run.html_url ? `URL: ${run.html_url}` : undefined,
				run.output?.title ? `Title: ${run.output.title}` : undefined,
				run.output?.summary ? `Summary:\n${truncate(run.output.summary, 4000)}` : undefined,
				run.output?.text ? `Output:\n${truncate(run.output.text, 4000)}` : undefined,
				formatAnnotations(annotationsByCheck.get(run.id ?? -1)),
			]
				.filter(Boolean)
				.join("\n"),
		);
	}
	for (const status of failedStatuses) {
		sections.push(
			[
				`Status: ${status.context ?? "unknown"}`,
				`State: ${status.state ?? "unknown"}`,
				status.description ? `Description: ${status.description}` : undefined,
				status.target_url ? `URL: ${status.target_url}` : undefined,
			]
				.filter(Boolean)
				.join("\n"),
		);
	}
	return sections.join("\n\n---\n\n");
}

function formatAnnotations(annotations?: RestCheckRunAnnotation[]): string | undefined {
	if (!annotations?.length) return undefined;
	return [
		"Annotations:",
		...annotations.slice(0, 10).map((annotation) => {
			const location = annotation.path ? `${annotation.path}:${annotation.start_line ?? "?"}` : "unknown location";
			return `- ${annotation.annotation_level ?? "notice"} ${location}: ${annotation.title ? `${annotation.title}: ` : ""}${annotation.message ?? ""}${annotation.raw_details ? `\n  ${truncate(annotation.raw_details, 1000)}` : ""}`;
		}),
	].join("\n");
}

function fallbackActionsExplanation(pr: PullRequestListItem, failure: string): string {
	return [`GitHub Actions failure for PR #${pr.number}: ${pr.title}`, "", "I found failing check output, but no AI model explanation was available.", "", failure].join("\n");
}

async function generateApproveAndPostInlineComments(pi: ExtensionAPI, ctx: ExtensionCommandContext, prNumber: number): Promise<void> {
	if (!ctx.model) throw new Error("No model selected for AI inline review comment generation");

	const generated = await ctx.ui.custom<InlineCommentSuggestion[] | null>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(tui, theme, `Generating inline review comments for PR #${prNumber} with ${ctx.model!.id}...`);
		loader.onAbort = () => done(null);

		generateInlineCommentSuggestions(pi, ctx, prNumber, loader.signal)
			.then(done)
			.catch((error) => done([{ path: "ERROR", line: 1, body: formatError(error), selected: false }]));

		return loader;
	});

	if (generated === null) {
		ctx.ui.notify("Inline comment generation cancelled", "info");
		return;
	}
	if (generated.length === 1 && generated[0].path === "ERROR") throw new Error(generated[0].body);
	if (generated.length === 0) {
		ctx.ui.notify(`No actionable inline comments suggested for PR #${prNumber}`, "info");
		return;
	}

	const approved = await ctx.ui.custom<InlineCommentSuggestion[] | null>((tui, theme, _kb, done) => {
		return new InlineCommentApprovalComponent(tui, theme, prNumber, generated, done);
	});
	if (approved === null) {
		ctx.ui.notify("Inline comment posting cancelled", "info");
		return;
	}
	if (approved.length === 0) {
		ctx.ui.notify("No inline comments selected", "info");
		return;
	}

	const repo = await getActiveRepo(pi, ctx.cwd);
	await postInlineReviewComments(pi, ctx, repo, prNumber, approved);
	ctx.ui.notify(`Posted ${approved.length} inline PR comment${approved.length === 1 ? "" : "s"} to #${prNumber}`, "info");
}

async function finalizeReviewWorkflow(pi: ExtensionAPI, ctx: ExtensionCommandContext, repo: GitHubRepo, prNumber: number): Promise<void> {
	const reviewChoice = await stableSelect(ctx, "Submit PR review as", [...REVIEW_EVENT_OPTIONS, "Skip"]);
	if (reviewChoice && reviewChoice !== "Skip") {
		await submitPullRequestReview(pi, ctx, repo, prNumber, reviewChoice as ReviewEventChoice);
	}
	await promptForWorkflowLabel(pi, ctx, repo, prNumber);
}

async function promptForWorkflowLabel(pi: ExtensionAPI, ctx: ExtensionCommandContext, repo: GitHubRepo, prNumber: number): Promise<void> {
	const labelChoice = await stableSelect(ctx, "Apply PR workflow label", [...PR_LABEL_OPTIONS, "Skip"]);
	if (labelChoice && labelChoice !== "Skip") {
		await applyWorkflowLabel(pi, ctx, repo, prNumber, labelChoice);
	}
}

async function stableSelect(ctx: ExtensionCommandContext, title: string, options: readonly string[]): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => new SimpleSelectComponent(tui, theme, title, [...options], done));
}

async function submitPullRequestReview(pi: ExtensionAPI, ctx: ExtensionCommandContext, repo: GitHubRepo, prNumber: number, choice: ReviewEventChoice): Promise<void> {
	const event = choice === "Approve" ? "APPROVE" : choice === "Request Changes" ? "REQUEST_CHANGES" : "COMMENT";
	const body = choice === "Approve" ? "Approved after review." : choice === "Request Changes" ? "Requesting changes based on the inline review comments." : "Reviewed with inline comments.";
	await ghApi(
		pi,
		ctx.cwd,
		repo,
		["--method", "POST", `repos/${repo.owner}/${repo.name}/pulls/${prNumber}/reviews`, "-H", "Accept: application/vnd.github+json", "-f", `event=${event}`, "-f", `body=${body}`],
		`Failed to submit ${choice} review for PR #${prNumber}`,
	);
	ctx.ui.notify(`Submitted ${choice} review for PR #${prNumber}`, "info");
}

async function applyWorkflowLabel(pi: ExtensionAPI, ctx: ExtensionCommandContext, repo: GitHubRepo, prNumber: number, label: string): Promise<void> {
	await Promise.all(MANAGED_LABELS.filter((managed) => managed !== label).map((managed) => removeIssueLabel(pi, ctx.cwd, repo, prNumber, managed).catch(() => undefined)));
	await addIssueLabels(pi, ctx.cwd, repo, prNumber, [label]);
	ctx.ui.notify(`Applied label ${label} to PR #${prNumber}`, "info");
}

async function generateInlineCommentSuggestions(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	prNumber: number,
	signal: AbortSignal,
): Promise<InlineCommentSuggestion[]> {
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model!);
	if (!auth.ok) throw new Error("error" in auth ? auth.error : "Failed to resolve model authentication");
	if (!auth.apiKey) throw new Error(`No API key for ${ctx.model!.provider}`);

	const repo = await getActiveRepo(pi, ctx.cwd);
	const details = await getPullRequestDetails(pi, ctx.cwd, repo, prNumber);
	const diff = await getPullRequestDiff(pi, ctx.cwd, repo, prNumber);

	const userMessage: UserMessage = {
		role: "user",
		content: [
			{
				type: "text",
				text: [
					`PR: #${details.number} ${details.title}`,
					`URL: ${details.url}`,
					`Branch: ${details.headRefName} -> ${details.baseRefName}`,
					"",
					"Return only JSON. No markdown. Shape:",
					`[{"path":"relative/file.ts","line":123,"severity":"medium|low","body":"Inline review comment ending with a GitHub suggestion block that replaces the offending line(s)."}]`,
					"Only include actionable findings that belong on a directly offending added/modified line in the PR Files changed view.",
					"Do not include praise, summaries, or non-actionable notes. If there are no actionable inline findings, return [].",
					"Every body MUST include a fenced GitHub code suggestion block using exactly ```suggestion, containing the replacement line(s) for the selected offending line(s).",
					"The suggestion block must be directly applicable on the selected line/range and must replace the offending code, not merely describe the fix.",
					"Prefer concise comments with suggested fixes that correlate directly to the selected line.",
					"",
					"Changed files:",
					formatFiles(details.files),
					"",
					"Unified patch:",
					truncate(diff, 80_000),
				].join("\n"),
			},
		],
		timestamp: Date.now(),
	};

	const response = await complete(
		ctx.model!,
		{
			systemPrompt: [
				"You are a careful GitHub PR reviewer.",
				"Find only actionable bugs, security issues, correctness problems, or maintainability issues suitable for inline PR comments.",
				"Use line numbers from the new/right side of the unified diff. Return strict JSON only.",
				"Each inline comment body must include a GitHub ```suggestion block that directly replaces the offending line(s).",
			].join("\n"),
			messages: [userMessage],
		},
		{ apiKey: auth.apiKey, headers: auth.headers, signal },
	);

	if (response.stopReason === "aborted") throw new Error("Generation aborted");
	const text = response.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map((content) => content.text)
		.join("\n")
		.trim();
	return parseInlineCommentSuggestions(text).map((suggestion) => ({ ...suggestion, selected: true }));
}

async function postInlineReviewComments(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	repo: GitHubRepo,
	prNumber: number,
	comments: InlineCommentSuggestion[],
): Promise<void> {
	const prOutput = await ghApi(pi, ctx.cwd, repo, [`repos/${repo.owner}/${repo.name}/pulls/${prNumber}`], `Failed to load PR #${prNumber}`);
	const pr = JSON.parse(prOutput) as RestPullRequest;
	const commitId = pr.head?.sha;
	if (!commitId) throw new Error(`Could not resolve head SHA for PR #${prNumber}`);

	// Post comments one-by-one instead of as a single review batch. GitHub rejects
	// the whole batch with HTTP 422 if any single line is not commentable in the
	// current diff. Posting individually lets valid approved comments through and
	// reports exactly which candidates need adjustment.
	const failures: string[] = [];
	let posted = 0;
	for (const comment of comments) {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-pr-comment-"));
		try {
			const payloadFile = join(tempDir, "comment.json");
			await writeFile(
				payloadFile,
				JSON.stringify(
					{
						commit_id: commitId,
						path: comment.path,
						line: comment.line,
						side: "RIGHT",
						body: comment.body,
					},
					null,
					2,
				),
				"utf8",
			);
			await ghApi(
				pi,
				ctx.cwd,
				repo,
				["--method", "POST", `repos/${repo.owner}/${repo.name}/pulls/${prNumber}/comments`, "-H", "Accept: application/vnd.github+json", "--input", payloadFile],
				`Failed to post inline comment ${comment.path}:${comment.line}`,
			);
			posted++;
		} catch (error) {
			failures.push(`${comment.path}:${comment.line} — ${firstLine(formatError(error))}`);
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	}

	if (posted === 0 && failures.length > 0) {
		throw new Error([`Failed to post inline review comments to PR #${prNumber}. GitHub rejected all approved candidates.`, ...failures].join("\n"));
	}
	if (failures.length > 0) {
		ctx.ui.notify(`Posted ${posted}; skipped ${failures.length} invalid inline candidate${failures.length === 1 ? "" : "s"}`, "warning");
	}
}

function parseInlineCommentSuggestions(value: string): InlineCommentSuggestion[] {
	const cleaned = value.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
	const parsed = JSON.parse(cleaned) as unknown;
	if (!Array.isArray(parsed)) throw new Error("Inline comment generation did not return a JSON array");
	return parsed
		.map((item) => item as Partial<InlineCommentSuggestion>)
		.filter((item) => typeof item.path === "string" && Number.isInteger(item.line) && item.line! > 0 && typeof item.body === "string" && item.body.trim())
		.map((item) => ({ path: item.path!, line: item.line!, body: item.body!.trim(), severity: item.severity }));
}

async function generatePrDescription(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	prNumber: number,
	signal: AbortSignal,
): Promise<string> {
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model!);
	if (!auth.ok) throw new Error("error" in auth ? auth.error : "Failed to resolve model authentication");
	if (!auth.apiKey) throw new Error(`No API key for ${ctx.model!.provider}`);

	const repo = await getActiveRepo(pi, ctx.cwd);
	const details = await getPullRequestDetails(pi, ctx.cwd, repo, prNumber);
	const diff = await getPullRequestDiff(pi, ctx.cwd, repo, prNumber);
	const template = findPullRequestTemplate(ctx.cwd);

	const userMessage: UserMessage = {
		role: "user",
		content: [
			{
				type: "text",
				text: [
					`PR: #${details.number} ${details.title}`,
					`URL: ${details.url}`,
					`State: ${details.isDraft ? "draft" : "open"}`,
					`Branch: ${details.headRefName} -> ${details.baseRefName}`,
					`Stats: +${details.additions ?? 0} -${details.deletions ?? 0}, ${details.changedFiles ?? details.files?.length ?? 0} files`,
					"",
					"Existing body:",
					details.body?.trim() || "(empty)",
					"",
					"PR template:",
					template?.content.trim() || "(none)",
					"",
					"Changed files:",
					formatFiles(details.files),
					"",
					"Commits:",
					formatCommits(details.commits),
					"",
					"Unified diff:",
					truncate(diff, 60_000),
				].join("\n"),
			},
		],
		timestamp: Date.now(),
	};

	const response = await complete(
		ctx.model!,
		{
			systemPrompt: [
				"You write concise, high-signal GitHub pull request descriptions.",
				"Use the provided pull request template when present and fill its sections according to the changes.",
				"Preserve useful checklist items from the template, checking boxes only when clearly applicable.",
				"Include testing notes. If tests are not evident, say they are not evident from the PR data.",
				"Return only the markdown body. Do not wrap it in code fences.",
			].join("\n"),
			messages: [userMessage],
		},
		{ apiKey: auth.apiKey, headers: auth.headers, signal },
	);

	if (response.stopReason === "aborted") throw new Error("Generation aborted");
	return response.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map((content) => content.text)
		.join("\n")
		.trim();
}

async function getActiveRepo(pi: ExtensionAPI, cwd: string): Promise<GitHubRepo> {
	const remoteNames: string[] = [];
	const branch = await pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeout: 10_000 });
	if (branch.code === 0 && branch.stdout.trim() && branch.stdout.trim() !== "HEAD") {
		const branchRemote = await pi.exec("git", ["config", "--get", `branch.${branch.stdout.trim()}.remote`], { cwd, timeout: 10_000 });
		if (branchRemote.code === 0 && branchRemote.stdout.trim()) remoteNames.push(branchRemote.stdout.trim());
	}
	const pushDefault = await pi.exec("git", ["config", "--get", "remote.pushDefault"], { cwd, timeout: 10_000 });
	if (pushDefault.code === 0 && pushDefault.stdout.trim()) remoteNames.push(pushDefault.stdout.trim());
	remoteNames.push("origin");

	const allRemotes = await pi.exec("git", ["remote"], { cwd, timeout: 10_000 });
	if (allRemotes.code === 0) remoteNames.push(...allRemotes.stdout.split("\n").map((remote) => remote.trim()).filter(Boolean));

	for (const remoteName of Array.from(new Set(remoteNames))) {
		const remoteUrl = await pi.exec("git", ["remote", "get-url", remoteName], { cwd, timeout: 10_000 });
		if (remoteUrl.code !== 0) continue;
		const repo = parseGitHubRemote(remoteUrl.stdout.trim());
		if (repo) return repo;
	}

	throw new Error("Could not resolve GitHub owner/repo from git remotes");
}

function parseGitHubRemote(url: string): GitHubRepo | undefined {
	const normalized = url.trim().replace(/\.git$/, "");
	const match =
		normalized.match(/^git@([^:]+):([^/]+)\/(.+)$/) ??
		normalized.match(/^ssh:\/\/git@([^/]+)\/([^/]+)\/(.+)$/) ??
		normalized.match(/^https?:\/\/([^/]+)\/([^/]+)\/(.+)$/);
	if (!match) return undefined;
	const [, host, owner, name] = match;
	if (!host.toLowerCase().includes("github")) return undefined;
	return { owner, name, host, nameWithOwner: `${owner}/${name}` };
}

async function listOpenPullRequests(pi: ExtensionAPI, cwd: string, repo: GitHubRepo): Promise<PullRequestListItem[]> {
	const output = await ghApi(
		pi,
		cwd,
		repo,
		["--method", "GET", `repos/${repo.owner}/${repo.name}/pulls`, "-f", "state=open", "-f", "per_page=100", "--paginate", "--slurp"],
		"Failed to list open PRs",
	);
	const prs = parsePaginatedArray<RestPullRequest>(output).map(mapRestPullRequestListItem);
	await Promise.all(
		prs.map(async (pr) => {
			pr.ciStatus = await getPullRequestCiStatus(pi, cwd, repo, pr.headSha);
			await maintainPullRequestLabels(pi, cwd, repo, pr).catch(() => undefined);
		}),
	);
	return prs;
}

async function maintainPullRequestLabels(pi: ExtensionAPI, cwd: string, repo: GitHubRepo, pr: PullRequestListItem): Promise<void> {
	const current = new Set(pr.labels ?? []);
	const desired = new Set<string>();
	const manualStop = current.has(PR_LABELS.doNotMerge) || current.has(PR_LABELS.blocked);

	if (pr.isDraft) {
		desired.add(PR_LABELS.workInProgress);
	} else if (!manualStop) {
		const reviews = await getPullRequestReviews(pi, cwd, repo, pr.number);
		const reviewState = summarizeReviewState(reviews);
		if (reviewState === "changes_requested") desired.add(PR_LABELS.changesRequested);
		else if (reviewState === "approved") {
			const details = await getPullRequestDetails(pi, cwd, repo, pr.number);
			if (details.reviewComments) desired.add(PR_LABELS.mergeWithComments);
			else desired.add(PR_LABELS.readyToMerge);
		} else {
			desired.add(PR_LABELS.readyForReview);
		}
	}

	const toAdd = [...desired].filter((label) => !current.has(label));
	const toRemove = MANAGED_LABELS.filter((label) => !desired.has(label) && current.has(label) && label !== PR_LABELS.doNotMerge && label !== PR_LABELS.blocked);
	if (toAdd.length) await addIssueLabels(pi, cwd, repo, pr.number, toAdd);
	await Promise.all(toRemove.map((label) => removeIssueLabel(pi, cwd, repo, pr.number, label)));
	pr.labels = [...current, ...toAdd].filter((label) => !toRemove.includes(label));
}

async function getPullRequestReviews(pi: ExtensionAPI, cwd: string, repo: GitHubRepo, prNumber: number): Promise<RestReview[]> {
	const output = await ghApi(pi, cwd, repo, [`repos/${repo.owner}/${repo.name}/pulls/${prNumber}/reviews`, "--paginate", "--slurp"]);
	return parsePaginatedArray<RestReview>(output);
}

async function getPullRequestReviewComments(pi: ExtensionAPI, cwd: string, repo: GitHubRepo, prNumber: number): Promise<RestReviewComment[]> {
	const output = await ghApi(pi, cwd, repo, [`repos/${repo.owner}/${repo.name}/pulls/${prNumber}/comments`, "--paginate", "--slurp"]);
	return parsePaginatedArray<RestReviewComment>(output);
}

function summarizeReviewState(reviews: RestReview[]): "approved" | "changes_requested" | "none" {
	const latestByUser = new Map<string, RestReview>();
	for (const review of reviews) {
		const user = review.user?.login;
		if (!user) continue;
		latestByUser.set(user, review);
	}
	const states = [...latestByUser.values()].map((review) => review.state?.toUpperCase());
	if (states.includes("CHANGES_REQUESTED")) return "changes_requested";
	if (states.includes("APPROVED")) return "approved";
	return "none";
}

async function addIssueLabels(pi: ExtensionAPI, cwd: string, repo: GitHubRepo, issueNumber: number, labels: string[]): Promise<void> {
	await ghApi(pi, cwd, repo, ["--method", "POST", `repos/${repo.owner}/${repo.name}/issues/${issueNumber}/labels`, "-H", "Accept: application/vnd.github+json", "-f", `labels[]=${labels[0]}`, ...labels.slice(1).flatMap((label) => ["-f", `labels[]=${label}`])]);
}

async function removeIssueLabel(pi: ExtensionAPI, cwd: string, repo: GitHubRepo, issueNumber: number, label: string): Promise<void> {
	await ghApi(pi, cwd, repo, ["--method", "DELETE", `repos/${repo.owner}/${repo.name}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`, "-H", "Accept: application/vnd.github+json"]);
}

async function getPullRequestCiStatus(pi: ExtensionAPI, cwd: string, repo: GitHubRepo, sha?: string): Promise<CiStatus> {
	if (!sha) return { state: "unknown", label: "actions ?", requiresAttention: false };
	try {
		const [statusOutput, checksOutput] = await Promise.all([
			ghApi(pi, cwd, repo, [`repos/${repo.owner}/${repo.name}/commits/${sha}/status`]),
			ghApi(pi, cwd, repo, [`repos/${repo.owner}/${repo.name}/commits/${sha}/check-runs`, "-H", "Accept: application/vnd.github+json", "--paginate", "--slurp"]),
		]);
		const combined = JSON.parse(statusOutput) as RestCombinedStatus;
		const checks = parsePaginatedCheckRuns(checksOutput);
		return summarizeCiStatus(combined, checks);
	} catch {
		return { state: "unknown", label: "actions ?", requiresAttention: false };
	}
}

function summarizeCiStatus(combined: RestCombinedStatus, checks: RestCheckRuns): CiStatus {
	const runs = checks.check_runs ?? [];
	const hasChecks = runs.length > 0;
	const hasCommitStatuses = (combined.total_count ?? combined.statuses?.length ?? 0) > 0;
	const failed = runs.some((run) => ["failure", "timed_out", "cancelled", "action_required"].includes(run.conclusion ?? ""));
	const pending = runs.some((run) => run.status !== "completed");
	const passingChecks = hasChecks && runs.every((run) => ["success", "neutral", "skipped"].includes(run.conclusion ?? ""));

	// GitHub's combined status endpoint reports `state: pending` when there are zero legacy commit statuses.
	// Treat that as "no status data" and let Check Runs be authoritative for GitHub Actions.
	if (failed || (hasCommitStatuses && ["failure", "error"].includes(combined.state ?? ""))) return { state: "failure", label: "actions failing", requiresAttention: true };
	if (pending || (hasCommitStatuses && combined.state === "pending")) return { state: "pending", label: "actions pending", requiresAttention: false };
	if (passingChecks || (hasCommitStatuses && combined.state === "success")) return { state: "success", label: "actions passing", requiresAttention: false };
	if (!hasCommitStatuses && !hasChecks) return { state: "unknown", label: "actions none", requiresAttention: false };
	return { state: "neutral", label: "actions unknown", requiresAttention: false };
}

async function getPullRequestDetails(pi: ExtensionAPI, cwd: string, repo: GitHubRepo, prNumber: number): Promise<PullRequestDetails> {
	const [prOutput, filesOutput, commitsOutput] = await Promise.all([
		ghApi(pi, cwd, repo, [`repos/${repo.owner}/${repo.name}/pulls/${prNumber}`], `Failed to load PR #${prNumber}`),
		ghApi(pi, cwd, repo, [`repos/${repo.owner}/${repo.name}/pulls/${prNumber}/files`, "--paginate", "--slurp"], `Failed to load PR #${prNumber} files`),
		ghApi(pi, cwd, repo, [`repos/${repo.owner}/${repo.name}/pulls/${prNumber}/commits`, "--paginate", "--slurp"], `Failed to load PR #${prNumber} commits`),
	]);
	const pr = JSON.parse(prOutput) as RestPullRequest;
	const details = mapRestPullRequestListItem(pr) as PullRequestDetails;
	details.body = pr.body ?? undefined;
	details.state = pr.state;
	details.additions = pr.additions;
	details.deletions = pr.deletions;
	details.changedFiles = pr.changed_files;
	details.reviewComments = pr.review_comments;
	details.files = parsePaginatedArray<RestPullRequestFile>(filesOutput).map((file) => ({ 
		path: file.filename,
		additions: file.additions,
		deletions: file.deletions,
	}));
	details.commits = parsePaginatedArray<RestPullRequestCommit>(commitsOutput).map((commit) => ({
		oid: commit.sha,
		messageHeadline: commit.commit?.message?.split("\n")[0],
	}));
	return details;
}

async function getPullRequestDiff(pi: ExtensionAPI, cwd: string, repo: GitHubRepo, prNumber: number): Promise<string> {
	return ghApi(
		pi,
		cwd,
		repo,
		["-H", "Accept: application/vnd.github.v3.patch", `repos/${repo.owner}/${repo.name}/pulls/${prNumber}`],
		`Failed to load PR #${prNumber} diff`,
	);
}

async function markPullRequestReadyForReview(pi: ExtensionAPI, cwd: string, repo: GitHubRepo, nodeId: string, prNumber: number): Promise<void> {
	// GitHub has no REST endpoint for this transition. Keep GraphQL minimal and avoid gh pr ready/projectCards.
	const query = `mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { number isDraft } } }`;
	await execOrThrow(
		pi,
		"gh",
		["api", ...ghHostArgs(repo), "graphql", "-f", `query=${query}`, "-F", `id=${nodeId}`],
		cwd,
		`Failed to mark PR #${prNumber} ready for review`,
	);
}

async function buildAgenticReviewPrompt(pi: ExtensionAPI, cwd: string, repo: GitHubRepo, pr: PullRequestListItem): Promise<string> {
	const endpoint = `repos/${repo.owner}/${repo.name}/pulls/${pr.number}`;
	const hostFlag = repo.host !== "github.com" ? `--hostname ${repo.host} ` : "";
	const existingComments = await getPullRequestReviewComments(pi, cwd, repo, pr.number).catch(() => []);
	return [
		`Agentic review PR #${pr.number}: ${pr.title}`,
		"",
		"Use GitHub REST API via gh api to inspect the PR metadata and diff. Do not use gh pr view/edit commands because they can hit deprecated Projects classic GraphQL fields.",
		`- gh api ${hostFlag}${endpoint}`,
		`- gh api ${hostFlag}${endpoint}/files --paginate`,
		`- gh api ${hostFlag}${endpoint}/commits --paginate`,
		`- gh api ${hostFlag}${endpoint}/comments --paginate`,
		`- gh api ${hostFlag}-H 'Accept: application/vnd.github.v3.patch' ${endpoint}`,
		"",
		"Existing PR review comments already posted (append-only/idempotency source of truth; do not duplicate these findings or rephrase them as new comments):",
		formatReviewComments(existingComments),
		"",
		...AGENTIC_REVIEW_INSTRUCTIONS,
	].join("\n");
}

function findPendingAgenticReviewPrNumber(messages: unknown[]): number | undefined {
	for (const message of messages) {
		const candidate = message as { role?: string; content?: unknown };
		if (candidate.role !== "user") continue;
		const text = extractMessageText(candidate);
		const match = text.match(/Agentic review PR #(\d+):/);
		if (match) return Number(match[1]);
	}
	return undefined;
}

function extractAssistantText(messages: unknown[]): string {
	return messages
		.map((message) => message as { role?: string; content?: unknown })
		.filter((message) => message.role === "assistant")
		.map(extractMessageText)
		.filter(Boolean)
		.join("\n\n");
}

function extractMessageText(message: { content?: unknown }): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.map((part) => {
			const value = part as { type?: string; text?: string };
			return value.type === "text" && typeof value.text === "string" ? value.text : "";
		})
		.filter(Boolean)
		.join("\n");
}

function parseInlineCommentCandidatesFromReview(text: string): InlineCommentSuggestion[] {
	const suggestions: InlineCommentSuggestion[] = [];
	const blocks = text.split(/Inline comment candidate:\s*/g).slice(1);
	for (const rawBlock of blocks) {
		const block = rawBlock.split(/\n(?=#{1,6}\s|##\s|###\s|Inline comment candidate:)/)[0];
		const path = cleanInlineCandidatePath(block.match(/^- Path:\s*(.+)$/m)?.[1]);
		const lineValue = block.match(/^- Line:\s*`?(\d+)`?\s*$/m)?.[1];
		const commentMatch = block.match(/^- Comment:\s*\n([\s\S]*?```suggestion[\s\S]*?```)/m);
		const comment = commentMatch?.[1]
			.split("\n")
			.map((line) => line.replace(/^ {2}/, ""))
			.join("\n")
			.trim();
		const line = lineValue ? Number(lineValue) : NaN;
		if (!path || !Number.isInteger(line) || line <= 0 || !comment?.includes("```suggestion")) continue;
		suggestions.push({ path, line, body: comment, selected: true });
	}
	return suggestions;
}

function cleanInlineCandidatePath(value: string | undefined): string | undefined {
	return value
		?.trim()
		.replace(/^`+|`+$/g, "")
		.replace(/^['"]+|['"]+$/g, "")
		.trim();
}

function formatReviewComments(comments: RestReviewComment[]): string {
	if (!comments.length) return "(none)";
	return comments
		.map((comment) => {
			const location = `${comment.path ?? "unknown"}:${comment.line ?? comment.start_line ?? "?"}`;
			const author = comment.user?.login ? ` @${comment.user.login}` : "";
			return `- ${location}${author}: ${truncate((comment.body ?? "").replace(/\s+/g, " ").trim(), 500)}`;
		})
		.join("\n");
}

function mapRestPullRequestListItem(pr: RestPullRequest): PullRequestListItem {
	return {
		number: pr.number,
		title: pr.title,
		isDraft: pr.draft === true,
		nodeId: pr.node_id,
		headRefName: pr.head?.ref ?? "unknown",
		headSha: pr.head?.sha,
		baseRefName: pr.base?.ref ?? "unknown",
		author: { login: pr.user?.login },
		updatedAt: pr.updated_at ?? "",
		url: pr.html_url ?? "",
		labels: pr.labels?.map((label) => label.name).filter((name): name is string => Boolean(name)) ?? [],
	};
}

async function ghApi(pi: ExtensionAPI, cwd: string, repo: GitHubRepo, args: string[], message?: string): Promise<string> {
	return execOrThrow(pi, "gh", ["api", ...ghHostArgs(repo), ...args], cwd, message);
}

function ghHostArgs(repo: GitHubRepo): string[] {
	return repo.host && repo.host !== "github.com" ? ["--hostname", repo.host] : [];
}

function ghRepoSelector(repo: GitHubRepo): string {
	return repo.host && repo.host !== "github.com" ? `${repo.host}/${repo.nameWithOwner}` : repo.nameWithOwner;
}

async function getCurrentGitBranch(pi: ExtensionAPI, cwd: string): Promise<string> {
	const output = await execOrThrow(pi, "git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd);
	const branch = output.trim();
	return branch && branch !== "HEAD" ? branch : "detached HEAD";
}

function parsePaginatedArray<T>(output: string): T[] {
	const parsed = JSON.parse(output);
	if (!Array.isArray(parsed)) return [];
	return Array.isArray(parsed[0]) ? parsed.flat() : parsed;
}

function parsePaginatedCheckRuns(output: string): RestCheckRuns {
	const parsed = JSON.parse(output) as RestCheckRuns | RestCheckRuns[];
	if (!Array.isArray(parsed)) return parsed;
	const checkRuns = parsed.flatMap((page) => page.check_runs ?? []);
	return { total_count: checkRuns.length, check_runs: checkRuns };
}

function findPullRequestTemplate(cwd: string): { path: string; content: string } | undefined {
	const candidates = [
		".github/pull_request_template.md",
		".github/PULL_REQUEST_TEMPLATE.md",
		"docs/pull_request_template.md",
		"docs/PULL_REQUEST_TEMPLATE.md",
		"PULL_REQUEST_TEMPLATE.md",
	];

	for (const relative of candidates) {
		const fullPath = join(cwd, relative);
		if (existsSync(fullPath)) return { path: relative, content: readFileSync(fullPath, "utf8") };
	}

	const dirs = [join(cwd, ".github", "PULL_REQUEST_TEMPLATE"), join(cwd, "docs", "PULL_REQUEST_TEMPLATE")];
	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		const file = readdirSync(dir)
			.filter((entry) => entry.toLowerCase().endsWith(".md"))
			.sort()[0];
		if (file) {
			const fullPath = join(dir, file);
			return { path: fullPath.replace(`${cwd}/`, ""), content: readFileSync(fullPath, "utf8") };
		}
	}

	return undefined;
}

async function execOrThrow(pi: ExtensionAPI, command: string, args: string[], cwd: string, message?: string): Promise<string> {
	const result = await pi.exec(command, args, { cwd, timeout: 60_000 });
	if (result.code !== 0) {
		throw new Error(`${message ?? `${command} ${args.join(" ")} failed`}\n${result.stderr || result.stdout}`.trim());
	}
	return result.stdout;
}

function formatFiles(files?: Array<{ path?: string; additions?: number; deletions?: number }>): string {
	if (!files?.length) return "(not available)";
	return files.map((file) => `- ${file.path ?? "unknown"} (+${file.additions ?? 0} -${file.deletions ?? 0})`).join("\n");
}

function formatCommits(commits?: Array<{ messageHeadline?: string; oid?: string }>): string {
	if (!commits?.length) return "(not available)";
	return commits.map((commit) => `- ${(commit.oid ?? "").slice(0, 8)} ${commit.messageHeadline ?? ""}`.trim()).join("\n");
}

function formatDate(value: string): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function ensureTrailingNewline(value: string): string {
	return value.endsWith("\n") ? value : `${value}\n`;
}

function truncate(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, maxChars)}\n\n[truncated ${value.length - maxChars} chars]`;
}

function firstLine(value: string): string {
	return value.split("\n")[0] ?? value;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
