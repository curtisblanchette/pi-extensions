import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	Input,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	type Focusable,
} from "@earendil-works/pi-tui";

const COMMIT_RE = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9._/-]+\))?(!)?: .+/i;

type PushMode = "current" | "new";
type FocusArea = "branchMode" | "branchName" | "files" | "message" | "action";

interface ChangedFile {
	path: string;
	displayPath: string;
	xy: string;
	staged: boolean;
	selected: boolean;
}

interface CommitMetadata {
	type: string;
	scope?: string;
	summary: string;
	message: string;
}

interface CommitWizardResult {
	selectedFiles: ChangedFile[];
	commitMessage: string;
	pushMode: PushMode;
	branchName: string;
}

interface CommitResult {
	branch: string;
	commitHash: string;
	prUrl?: string;
	prBodyPath?: string;
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

class CommitPrComponent implements Component, Focusable {
	private branchInput = new Input();
	private messageInput = new Input();
	private focus: FocusArea = "branchMode";
	private selectedFileIndex = 0;
	private pushMode: PushMode;
	private branchNameTouched = false;
	private messageTouched = false;
	private diffScroll = 0;
	private error: string | undefined;
	private isFocused = false;

	constructor(
		private tui: { requestRender(): void },
		private theme: any,
		private currentBranch: string,
		private files: ChangedFile[],
		private fileDiffs: Map<string, string>,
		initialMessage: string,
		initialPushMode: PushMode,
		private makeMessage: (files: ChangedFile[]) => string,
		private done: (result: CommitWizardResult | null) => void,
	) {
		this.pushMode = initialPushMode;
		this.focus = initialPushMode === "new" ? "branchName" : "branchMode";
		this.messageInput.setValue(initialMessage);
		this.branchInput.setValue(suggestBranchName(initialMessage));

		this.branchInput.onSubmit = () => {
			this.branchNameTouched = true;
			this.setFocus("files");
		};
		this.branchInput.onEscape = () => this.setFocus("branchMode");
		this.messageInput.onSubmit = () => this.setFocus("action");
		this.messageInput.onEscape = () => this.setFocus("files");
		this.syncInputFocus();
	}

	get focused(): boolean {
		return this.isFocused;
	}

	set focused(value: boolean) {
		this.isFocused = value;
		this.syncInputFocus();
	}

	handleInput(data: string): void {
		this.error = undefined;

		if (matchesKey(data, Key.escape)) {
			if (this.focus === "branchName") {
				this.setFocus("branchMode");
				return;
			}
			if (this.focus === "message") {
				this.setFocus("files");
				return;
			}
			this.done(null);
			return;
		}

		if (matchesKey(data, Key.tab)) {
			this.moveFocus(1);
			return;
		}
		if (matchesKey(data, Key.shift("tab"))) {
			this.moveFocus(-1);
			return;
		}
		if (this.focus === "branchName") {
			const before = this.branchInput.getValue();
			this.branchInput.handleInput(data);
			if (this.branchInput.getValue() !== before) this.branchNameTouched = true;
			this.refresh();
			return;
		}

		if (this.focus === "message") {
			const before = this.messageInput.getValue();
			this.messageInput.handleInput(data);
			const after = this.messageInput.getValue();
			if (after !== before) {
				this.messageTouched = true;
				if (this.pushMode === "new" && !this.branchNameTouched) {
					this.branchInput.setValue(suggestBranchName(after));
				}
			}
			this.refresh();
			return;
		}

		if (this.focus === "branchMode") {
			if (matchesKey(data, Key.left) || matchesKey(data, Key.right) || matchesKey(data, Key.space)) {
				this.togglePushMode();
				return;
			}
			if (matchesKey(data, Key.down) || matchesKey(data, Key.enter)) {
				this.moveFocus(1);
				return;
			}
		}

		if (this.focus === "files") {
			if (matchesKey(data, Key.up)) {
				this.selectedFileIndex = Math.max(0, this.selectedFileIndex - 1);
				this.diffScroll = 0;
				this.refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				this.selectedFileIndex = Math.min(this.files.length - 1, this.selectedFileIndex + 1);
				this.diffScroll = 0;
				this.refresh();
				return;
			}
			if (matchesKey(data, Key.pageUp)) {
				this.diffScroll = Math.max(0, this.diffScroll - 12);
				this.refresh();
				return;
			}
			if (matchesKey(data, Key.pageDown)) {
				this.diffScroll = Math.min(Math.max(0, this.getSelectedDiffLines().length - 1), this.diffScroll + 12);
				this.refresh();
				return;
			}
			if (matchesKey(data, Key.space)) {
				const file = this.files[this.selectedFileIndex];
				if (file) {
					file.selected = !file.selected;
					if (!this.messageTouched) {
						const nextMessage = this.makeMessage(this.selectedFilesOrAll());
						this.messageInput.setValue(nextMessage);
						if (this.pushMode === "new" && !this.branchNameTouched)
							this.branchInput.setValue(suggestBranchName(nextMessage));
					}
				}
				this.refresh();
				return;
			}
			if (matchesKey(data, Key.enter)) {
				this.moveFocus(1);
				return;
			}
		}

		if (this.focus === "action") {
			if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
				this.submit();
				return;
			}
			if (matchesKey(data, Key.up)) {
				this.moveFocus(-1);
				return;
			}
		}
	}

	render(width: number): string[] {
		this.syncInputFocus();

		if (width < 4) return [truncateToWidth("commit", width)];

		const panelWidth = width;
		const contentWidth = Math.max(1, panelWidth - 4);
		const body: string[] = [];
		const add = (line = "") => body.push(truncateToWidth(line, contentWidth, "…"));
		const rule = () => add(this.theme.fg("dim", "─".repeat(contentWidth)));

		add(this.theme.fg("dim", "Tab/Shift+Tab moves focus • Enter on action submits • Esc cancels"));
		add("");

		add(this.sectionTitle("Branch", this.focus === "branchMode" || this.focus === "branchName"));
		add(this.theme.fg("muted", "Current: ") + this.theme.fg("accent", this.currentBranch));
		this.renderBranchMode(add);
		if (this.pushMode === "new")
			this.renderInput(add, "Branch name", this.branchInput, this.focus === "branchName", contentWidth);
		rule();

		const selectedCount = this.files.filter((f) => f.selected).length;
		add(this.sectionTitle(`Changed files (${selectedCount}/${this.files.length} selected)`, this.focus === "files"));
		for (const line of this.renderFileDiffSplit(contentWidth)) add(line);
		add(this.theme.fg("dim", "↑↓ files • Space stage/unstage • PgUp/PgDn diff • Enter next"));
		rule();

		add(this.sectionTitle("Commit message", this.focus === "message"));
		this.renderInput(add, "", this.messageInput, this.focus === "message", contentWidth);
		add(this.theme.fg("dim", "Editable Conventional Commits v1.0.0 message."));
		rule();

		const actionText = `Commit ${selectedCount} file${selectedCount === 1 ? "" : "s"}, push, create draft PR`;
		add(this.focus === "action" ? this.theme.fg("accent", `› [ ${actionText} ]`) : `  [ ${actionText} ]`);
		if (this.error) add(this.theme.fg("error", this.error));

		return [
			this.panelTop(panelWidth, "Commit, Push, and Draft PR"),
			...body.map((line) => this.panelLine(line, panelWidth)),
			this.panelBottom(panelWidth),
		];
	}

	private panelTop(width: number, title: string): string {
		const innerWidth = Math.max(0, width - 2);
		const label = ` ${title} `;
		const clippedLabel = truncateToWidth(label, innerWidth, "…");
		const fill = Math.max(0, innerWidth - visibleWidth(clippedLabel));
		return (
			this.theme.fg("accent", "╭") +
			this.theme.fg("accent", this.theme.bold(clippedLabel)) +
			this.theme.fg("accent", `${"─".repeat(fill)}╮`)
		);
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

	private renderFileDiffSplit(width: number): string[] {
		if (width < 72) return this.renderStackedFilesAndDiff(width);

		const leftWidth = Math.min(Math.max(30, Math.floor(width * 0.38)), Math.max(30, width - 38));
		const divider = ` ${this.theme.fg("dim", "│")} `;
		const dividerWidth = 3;
		const rightWidth = Math.max(1, width - leftWidth - dividerWidth);
		const selectedFile = this.files[this.selectedFileIndex];
		const diffLines = this.getSelectedDiffLines();
		const rows = Math.max(this.files.length, Math.min(18, diffLines.length), 10);
		const maxScroll = Math.max(0, diffLines.length - rows);
		this.diffScroll = Math.min(this.diffScroll, maxScroll);

		const lines: string[] = [];
		const diffTitle = selectedFile ? `Diff: ${selectedFile.displayPath}` : "Diff";
		lines.push(
			`${this.fit(this.theme.fg("muted", "Files"), leftWidth)}${divider}${this.fit(this.theme.fg("muted", diffTitle), rightWidth)}`,
		);
		lines.push(
			`${this.fit(this.theme.fg("dim", "─".repeat(leftWidth)), leftWidth)}${divider}${this.fit(this.theme.fg("dim", "─".repeat(rightWidth)), rightWidth)}`,
		);

		for (let i = 0; i < rows; i++) {
			const left = i < this.files.length ? this.renderFileRow(i, leftWidth) : "";
			let right = diffLines[this.diffScroll + i] ?? "";
			if (i === rows - 1 && this.diffScroll + rows < diffLines.length) {
				right = this.theme.fg("dim", `… ${diffLines.length - this.diffScroll - rows} more diff lines`);
			}
			lines.push(`${this.fit(left, leftWidth)}${divider}${this.fit(right, rightWidth)}`);
		}

		return lines;
	}

	private renderStackedFilesAndDiff(width: number): string[] {
		const lines: string[] = [];
		for (let i = 0; i < this.files.length; i++) lines.push(this.renderFileRow(i, width));
		const selectedFile = this.files[this.selectedFileIndex];
		lines.push(this.theme.fg("dim", "─".repeat(width)));
		lines.push(this.theme.fg("muted", selectedFile ? `Diff: ${selectedFile.displayPath}` : "Diff"));
		const diffLines = this.getSelectedDiffLines();
		const rows = Math.min(14, diffLines.length);
		for (let i = 0; i < rows; i++) lines.push(diffLines[this.diffScroll + i] ?? "");
		if (this.diffScroll + rows < diffLines.length)
			lines.push(this.theme.fg("dim", `… ${diffLines.length - this.diffScroll - rows} more diff lines`));
		return lines;
	}

	private renderFileRow(index: number, width: number): string {
		const file = this.files[index];
		const selected = index === this.selectedFileIndex;
		const active = this.focus === "files" && selected;
		const pointer = selected ? this.theme.fg(active ? "accent" : "muted", "› ") : "  ";
		const checkbox = file.selected ? this.theme.fg("success", "[x]") : this.theme.fg("dim", "[ ]");
		const status = this.theme.fg(file.staged ? "success" : "muted", file.xy.padEnd(2));
		const path = selected
			? this.theme.fg(active ? "accent" : "muted", file.displayPath)
			: this.theme.fg("text", file.displayPath);
		return this.fit(`${pointer}${checkbox} ${status} ${path}`, width);
	}

	private getSelectedDiffLines(): string[] {
		const file = this.files[this.selectedFileIndex];
		if (!file) return [this.theme.fg("dim", "No file selected")];
		const diff = this.fileDiffs.get(file.path)?.trimEnd();
		if (!diff) return [this.theme.fg("dim", "No textual diff available")];
		return diff.split("\n").map((line) => this.colorDiffLine(line));
	}

	private colorDiffLine(line: string): string {
		if (line.startsWith("@@")) return this.theme.fg("accent", line);
		if (line.startsWith("+") && !line.startsWith("+++")) return this.theme.fg("success", line);
		if (line.startsWith("-") && !line.startsWith("---")) return this.theme.fg("error", line);
		if (line.startsWith("+++") || line.startsWith("---")) return this.theme.fg("muted", line);
		if (line.startsWith("# ")) return this.theme.fg("muted", line);
		return line;
	}

	private fit(content: string, width: number): string {
		const clipped = truncateToWidth(content, width, "…");
		return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
	}

	invalidate(): void {
		this.branchInput.invalidate();
		this.messageInput.invalidate();
	}

	private renderBranchMode(add: (line?: string) => void) {
		const current =
			this.pushMode === "current" ? this.theme.fg("success", "● current") : this.theme.fg("dim", "○ current");
		const next =
			this.pushMode === "new" ? this.theme.fg("success", "● new branch") : this.theme.fg("dim", "○ new branch");
		const marker = this.focus === "branchMode" ? this.theme.fg("accent", "› ") : "  ";
		const text = `${marker}Push target: ${current}  ${next}`;
		add(this.focus === "branchMode" ? this.theme.fg("accent", text) : text);
	}

	private renderInput(add: (line?: string) => void, label: string, input: Input, active: boolean, width: number) {
		const prefix = label
			? `${active ? this.theme.fg("accent", "› ") : "  "}${label}: `
			: active
				? this.theme.fg("accent", "› ")
				: "  ";
		const inputWidth = Math.max(1, width - visibleWidth(prefix));
		for (const line of input.render(inputWidth)) {
			add(prefix + line);
		}
	}

	private sectionTitle(label: string, active: boolean): string {
		const text = active ? `› ${label}` : `  ${label}`;
		return active ? this.theme.fg("accent", this.theme.bold(text)) : this.theme.fg("muted", this.theme.bold(text));
	}

	private togglePushMode() {
		this.pushMode = this.pushMode === "current" ? "new" : "current";
		if (this.pushMode === "new") {
			if (!this.branchNameTouched) this.branchInput.setValue(suggestBranchName(this.messageInput.getValue()));
			this.focus = "branchName";
		} else {
			this.focus = "branchMode";
		}
		this.refresh();
	}

	private submit() {
		const selectedFiles = this.files.filter((file) => file.selected);
		if (selectedFiles.length === 0) {
			this.error = "Select at least one file to commit.";
			this.refresh();
			return;
		}

		const commitMessage = this.messageInput.getValue().trim();
		if (!COMMIT_RE.test(commitMessage)) {
			this.error = "Commit message must use Conventional Commits, e.g. feat(scope): summary.";
			this.setFocus("message");
			return;
		}

		const branchName = this.branchInput.getValue().trim();
		if (this.pushMode === "new" && !branchName) {
			this.error = "Enter a branch name.";
			this.setFocus("branchName");
			return;
		}

		this.done({ selectedFiles, commitMessage, pushMode: this.pushMode, branchName });
	}

	private selectedFilesOrAll(): ChangedFile[] {
		const selected = this.files.filter((file) => file.selected);
		return selected.length > 0 ? selected : this.files;
	}

	private focusOrder(): FocusArea[] {
		return this.pushMode === "new"
			? ["branchMode", "branchName", "files", "message", "action"]
			: ["branchMode", "files", "message", "action"];
	}

	private moveFocus(direction: 1 | -1) {
		const order = this.focusOrder();
		const currentIndex = Math.max(0, order.indexOf(this.focus));
		const next = (currentIndex + direction + order.length) % order.length;
		this.setFocus(order[next]);
	}

	private setFocus(focus: FocusArea) {
		this.focus = focus;
		this.syncInputFocus();
		this.refresh();
	}

	private syncInputFocus() {
		this.branchInput.focused = this.isFocused && this.focus === "branchName";
		this.messageInput.focused = this.isFocused && this.focus === "message";
	}

	private refresh() {
		this.invalidate();
		this.tui.requestRender();
	}
}

export default function commitPrExtension(pi: ExtensionAPI) {
	const handler = async (_args: string, ctx: ExtensionCommandContext) => {
		if (!ctx.hasUI) {
			ctx.ui.notify("commit-pr requires interactive mode", "error");
			return;
		}

		try {
			await ctx.waitForIdle();
			await assertGitRepository(pi, ctx.cwd);

			const files = await getChangedFiles(pi, ctx.cwd);
			if (files.length === 0) {
				ctx.ui.notify("No changed files to commit", "info");
				return;
			}

			const currentBranch = await getCurrentBranch(pi, ctx.cwd);
			const diff = await getWorkingDiff(pi, ctx.cwd);
			const fileDiffs = await getFileDiffs(pi, ctx.cwd, files);
			const makeMessage = (changedFiles: ChangedFile[]) => suggestCommitMetadata(changedFiles, diff).message;
			const initialMessage = makeMessage(files);
			const initialPushMode: PushMode = ["main", "master", "develop", "trunk"].includes(currentBranch)
				? "new"
				: "current";

			const result = await ctx.ui.custom<CommitWizardResult | null>((tui, theme, _kb, done) => {
				return new CommitPrComponent(
					tui,
					theme,
					currentBranch,
					files,
					fileDiffs,
					initialMessage,
					initialPushMode,
					makeMessage,
					done,
				);
			});

			if (!result) {
				ctx.ui.notify("Commit cancelled", "info");
				return;
			}

			ctx.ui.setStatus("commit-pr", ctx.ui.theme.fg("accent", "commit-pr: running"));
			const commitResult = await commitPushAndCreatePr(pi, ctx, result, currentBranch);
			ctx.ui.setStatus("commit-pr", undefined);

			const msg = commitResult.prUrl
				? `Committed ${commitResult.commitHash} to ${commitResult.branch} and opened draft PR: ${commitResult.prUrl}`
				: `Committed ${commitResult.commitHash} to ${commitResult.branch}; draft PR creation did not return a URL`;
			ctx.ui.notify(msg, "info");
		} catch (error) {
			ctx.ui.setStatus("commit-pr", undefined);
			ctx.ui.notify(formatError(error), "error");
		}
	};

	pi.registerCommand("commit-pr", {
		description: "Interactively stage files, commit, push, and open a draft GitHub PR",
		handler,
	});

	pi.registerCommand("commit", {
		description: "Open the interactive commit/push/draft PR TUI",
		handler,
	});
}

async function assertGitRepository(pi: ExtensionAPI, cwd: string): Promise<void> {
	await execOrThrow(pi, "git", ["rev-parse", "--is-inside-work-tree"], cwd, "Not inside a git repository");
}

async function getCurrentBranch(pi: ExtensionAPI, cwd: string): Promise<string> {
	const branch = (await execOrThrow(pi, "git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd)).trim();
	if (!branch || branch === "HEAD") throw new Error("Cannot commit from detached HEAD");
	return branch;
}

async function getChangedFiles(pi: ExtensionAPI, cwd: string): Promise<ChangedFile[]> {
	const output = await execOrThrow(pi, "git", ["status", "--porcelain=v1", "-z", "-uall"], cwd);
	const records = output.split("\0").filter(Boolean);
	const files: ChangedFile[] = [];

	for (let i = 0; i < records.length; i++) {
		const record = records[i];
		const xy = record.slice(0, 2);
		const path = record.slice(3);
		let displayPath = path;
		if (xy[0] === "R" || xy[0] === "C") {
			const oldPath = records[++i];
			if (oldPath) displayPath = `${oldPath} -> ${path}`;
		}
		const staged = xy[0] !== " " && xy[0] !== "?";
		files.push({ path, displayPath, xy, staged, selected: staged });
	}

	// If nothing is already staged, default to committing all changed files.
	// Otherwise mirror the current index so checkboxes represent staged state.
	if (!files.some((file) => file.staged)) {
		for (const file of files) file.selected = true;
	}

	return files;
}

async function getWorkingDiff(pi: ExtensionAPI, cwd: string): Promise<string> {
	const result = await pi.exec("git", ["diff", "--", "."], { cwd, timeout: 15_000 });
	const staged = await pi.exec("git", ["diff", "--cached", "--", "."], { cwd, timeout: 15_000 });
	return `${result.stdout}\n${staged.stdout}`.slice(0, 80_000);
}

async function getFileDiffs(pi: ExtensionAPI, cwd: string, files: ChangedFile[]): Promise<Map<string, string>> {
	const diffs = new Map<string, string>();

	for (const file of files) {
		const parts: string[] = [];

		if (file.xy[0] !== " " && file.xy[0] !== "?") {
			const staged = await pi.exec("git", ["diff", "--cached", "--", file.path], { cwd, timeout: 15_000 });
			if (staged.stdout.trim()) parts.push(`# Staged changes\n${staged.stdout}`);
		}

		if (file.xy[1] !== " " && file.xy[1] !== "?") {
			const unstaged = await pi.exec("git", ["diff", "--", file.path], { cwd, timeout: 15_000 });
			if (unstaged.stdout.trim()) parts.push(`# Unstaged changes\n${unstaged.stdout}`);
		}

		if (file.xy === "??") {
			const untracked = await pi.exec("git", ["diff", "--no-index", "--", "/dev/null", file.path], {
				cwd,
				timeout: 15_000,
			});
			if (untracked.stdout.trim()) parts.push(untracked.stdout);
		}

		diffs.set(file.path, cleanUnifiedDiff(parts.join("\n")));
	}

	return diffs;
}

function cleanUnifiedDiff(diff: string): string {
	return diff
		.split("\n")
		.filter((line) => {
			if (line.startsWith("diff --git ")) return false;
			if (/^index [0-9a-f]+\.\./i.test(line)) return false;
			if (/^(new file mode|deleted file mode|old mode|new mode|similarity index|rename from|rename to)\b/.test(line))
				return false;
			return true;
		})
		.join("\n")
		.trimEnd();
}

async function commitPushAndCreatePr(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	selection: CommitWizardResult,
	currentBranch: string,
): Promise<CommitResult> {
	const remote = await getRemote(pi, ctx.cwd);
	await execOrThrow(pi, "gh", ["--version"], ctx.cwd, "GitHub CLI (gh) is required to open a draft PR");
	let branch = currentBranch;

	if (selection.pushMode === "new") {
		branch = selection.branchName;
		await execOrThrow(pi, "git", ["check-ref-format", "--branch", branch], ctx.cwd, `Invalid branch name: ${branch}`);
		await execOrThrow(pi, "git", ["switch", "-c", branch], ctx.cwd, `Failed to create branch ${branch}`);
	}

	await applyStaging(pi, ctx.cwd, selection.selectedFiles);

	const stagedDiff = await pi.exec("git", ["diff", "--cached", "--quiet", "--exit-code"], { cwd: ctx.cwd });
	if (stagedDiff.code === 0) throw new Error("No staged changes after applying file selection");

	const tempDir = await mkdtemp(join(tmpdir(), "pi-commit-pr-"));
	try {
		const commitMessageFile = join(tempDir, "commit-message.txt");
		await writeFile(commitMessageFile, ensureTrailingNewline(selection.commitMessage), "utf8");
		await execOrThrow(pi, "git", ["commit", "--file", commitMessageFile], ctx.cwd, "git commit failed");

		const commitHash = (await execOrThrow(pi, "git", ["rev-parse", "--short", "HEAD"], ctx.cwd)).trim();
		await execOrThrow(pi, "git", ["push", "-u", remote, branch], ctx.cwd, `Failed to push ${branch} to ${remote}`);

		const prBody = buildPullRequestBody(ctx.cwd, selection.commitMessage, branch, selection.selectedFiles);
		const prBodyFile = join(tempDir, "pull-request-body.md");
		await writeFile(prBodyFile, ensureTrailingNewline(prBody), "utf8");

		const pr = await pi.exec(
			"gh",
			[
				"pr",
				"create",
				"--draft",
				"--title",
				firstLine(selection.commitMessage),
				"--body-file",
				prBodyFile,
				"--head",
				branch,
			],
			{
				cwd: ctx.cwd,
				timeout: 60_000,
			},
		);

		let prUrl: string | undefined;
		if (pr.code === 0) {
			prUrl = extractUrl(pr.stdout) ?? extractUrl(pr.stderr);
			await maintainDraftPrLabels(pi, ctx.cwd, prUrl);
			await pi.exec("gh", ["pr", "view", "--web"], { cwd: ctx.cwd, timeout: 30_000 });
		} else {
			const existing = await pi.exec("gh", ["pr", "view", branch, "--json", "url", "--jq", ".url"], {
				cwd: ctx.cwd,
				timeout: 30_000,
			});
			if (existing.code === 0 && existing.stdout.trim()) {
				prUrl = existing.stdout.trim();
				await maintainDraftPrLabels(pi, ctx.cwd, prUrl);
				await pi.exec("gh", ["pr", "view", branch, "--web"], { cwd: ctx.cwd, timeout: 30_000 });
			} else {
				throw new Error(`gh pr create failed\n${pr.stderr || pr.stdout}`.trim());
			}
		}

		return { branch, commitHash, prUrl, prBodyPath: prBodyFile };
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
}

async function maintainDraftPrLabels(pi: ExtensionAPI, cwd: string, prUrl?: string): Promise<void> {
	const prNumber = prUrl ? extractPullRequestNumber(prUrl) : undefined;
	if (!prNumber) return;
	await pi.exec(
		"gh",
		[
			"issue",
			"edit",
			String(prNumber),
			"--add-label",
			PR_LABELS.workInProgress,
			"--remove-label",
			PR_LABELS.readyForReview,
		],
		{
			cwd,
			timeout: 30_000,
		},
	);
}

function extractPullRequestNumber(url: string): number | undefined {
	const match = url.match(/\/pull\/(\d+)/);
	return match ? Number(match[1]) : undefined;
}

async function applyStaging(pi: ExtensionAPI, cwd: string, selectedFiles: ChangedFile[]): Promise<void> {
	const selectedPaths = new Set(selectedFiles.map((file) => file.path));
	const allFiles = await getChangedFiles(pi, cwd);
	const pathsToStage = allFiles.filter((file) => selectedPaths.has(file.path)).map((file) => file.path);
	const pathsToUnstage = allFiles
		.filter((file) => !selectedPaths.has(file.path) && file.staged)
		.map((file) => file.path);

	if (pathsToUnstage.length > 0) {
		await execOrThrow(
			pi,
			"git",
			["restore", "--staged", "--", ...pathsToUnstage],
			cwd,
			"Failed to unstage deselected files",
		);
	}
	if (pathsToStage.length > 0) {
		await execOrThrow(pi, "git", ["add", "--", ...pathsToStage], cwd, "Failed to stage selected files");
	}
}

async function getRemote(pi: ExtensionAPI, cwd: string): Promise<string> {
	const remotes = (await execOrThrow(pi, "git", ["remote"], cwd, "No git remotes configured"))
		.split("\n")
		.map((r) => r.trim())
		.filter(Boolean);
	if (remotes.length === 0) throw new Error("No git remotes configured");
	return remotes.includes("origin") ? "origin" : remotes[0];
}

async function execOrThrow(
	pi: ExtensionAPI,
	command: string,
	args: string[],
	cwd: string,
	message?: string,
): Promise<string> {
	const result = await pi.exec(command, args, { cwd, timeout: 60_000 });
	if (result.code !== 0) {
		throw new Error(`${message ?? `${command} ${args.join(" ")} failed`}\n${result.stderr || result.stdout}`.trim());
	}
	return result.stdout;
}

function suggestCommitMetadata(files: ChangedFile[], diff: string): CommitMetadata {
	const paths = files.map((file) => file.path);
	const lowerPaths = paths.map((path) => path.toLowerCase());
	const lowerDiff = diff.toLowerCase();

	if (lowerPaths.some((path) => path.startsWith(".pi/extensions/"))) {
		return buildMetadata("feat", "pi", "add commit and PR workflow TUI");
	}
	if (
		lowerDiff.includes('"packagemanager": "pnpm@11') ||
		(lowerDiff.includes("allowbuilds:") && lowerDiff.includes("esbuild"))
	) {
		return buildMetadata("build", "pnpm", "pin pnpm 11 and approve esbuild builds");
	}
	if (
		lowerPaths.some(
			(path) =>
				path.includes("dockerfile") ||
				path.includes("docker-compose") ||
				path.endsWith("package.json") ||
				path.endsWith("pnpm-lock.yaml") ||
				path.endsWith("pnpm-workspace.yaml"),
		)
	) {
		return buildMetadata("build", inferScope(paths), "update project build configuration");
	}
	if (lowerPaths.every((path) => path.startsWith("docs/") || path.endsWith(".md"))) {
		return buildMetadata("docs", inferScope(paths), "update documentation");
	}
	if (lowerPaths.some((path) => path.includes("test") || path.includes("spec"))) {
		return buildMetadata("test", inferScope(paths), "update test coverage");
	}
	if (lowerPaths.some((path) => path.startsWith(".github/workflows/"))) {
		return buildMetadata("ci", "github", "update workflow automation");
	}
	if (lowerPaths.some((path) => path.startsWith("client/"))) {
		return buildMetadata("feat", "client", "update client behavior");
	}
	if (lowerPaths.some((path) => path.startsWith("server/"))) {
		return buildMetadata("feat", "server", "update server behavior");
	}

	return buildMetadata("chore", inferScope(paths), "update project changes");
}

function buildMetadata(type: string, scope: string | undefined, summary: string): CommitMetadata {
	const safeScope = scope
		?.replace(/[^a-z0-9._/-]/gi, "-")
		.replace(/-+/g, "-")
		.toLowerCase();
	const message = safeScope ? `${type}(${safeScope}): ${summary}` : `${type}: ${summary}`;
	return { type, scope: safeScope, summary, message };
}

function inferScope(paths: string[]): string | undefined {
	if (paths.length === 0) return undefined;
	const firstSegments = paths.map((path) => path.split("/")[0]).filter(Boolean);
	const unique = Array.from(new Set(firstSegments));
	if (unique.length === 1) return unique[0].replace(/^\.+/, "").toLowerCase() || undefined;
	if (paths.some((path) => path.includes("pnpm") || path.endsWith("package.json"))) return "deps";
	return "repo";
}

function suggestBranchName(commitMessage: string): string {
	const parsed = parseConventionalCommit(commitMessage);
	const type = parsed?.type ?? "chore";
	const scope = parsed?.scope ? `${slugify(parsed.scope)}-` : "";
	const summary = slugify(parsed?.summary ?? commitMessage)
		.slice(0, 72)
		.replace(/-+$/, "");
	return `${type}/${scope}${summary || "changes"}`;
}

function parseConventionalCommit(message: string): { type: string; scope?: string; summary: string } | undefined {
	const match = firstLine(message).match(/^([a-z]+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/i);
	if (!match) return undefined;
	return { type: match[1].toLowerCase(), scope: match[2], summary: match[4] };
}

function slugify(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-+/g, "-");
}

function buildPullRequestBody(cwd: string, commitMessage: string, branch: string, files: ChangedFile[]): string {
	const parsed = parseConventionalCommit(commitMessage);
	const summary = parsed?.summary ?? firstLine(commitMessage);
	const generated = [
		"## Summary",
		`- ${capitalize(summary)}`,
		`- Branch: \`${branch}\``,
		"",
		"## Changes",
		...files.map((file) => `- ${statusDescription(file.xy)} \`${file.displayPath}\``),
		"",
		"## Testing",
		"- Not run by commit-pr; update this before marking the PR ready for review if needed.",
	].join("\n");

	const template = findPullRequestTemplate(cwd);
	if (!template) return generated;

	let body = checkTemplateBoxes(template.content, parsed?.type);
	let filled = false;
	const summaryResult = insertUnderHeading(
		body,
		["summary", "description", "what changed", "what's changed"],
		[`- ${capitalize(summary)}`, `- Branch: \`${branch}\``].join("\n"),
	);
	body = summaryResult.body;
	filled = filled || summaryResult.changed;

	const changesResult = insertUnderHeading(
		body,
		["changes", "change list", "implementation"],
		files.map((file) => `- ${statusDescription(file.xy)} \`${file.displayPath}\``).join("\n"),
	);
	body = changesResult.body;
	filled = filled || changesResult.changed;

	const testingResult = insertUnderHeading(
		body,
		["testing", "test plan", "validation"],
		"- Not run by commit-pr; update this before marking the PR ready for review if needed.",
	);
	body = testingResult.body;
	filled = filled || testingResult.changed;

	if (!filled) {
		body = `${generated}\n\n---\n\n${body.trim()}`;
	}

	return `<!-- PR body generated from ${template.path} -->\n\n${body.trim()}`;
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

function insertUnderHeading(markdown: string, headings: string[], content: string): { body: string; changed: boolean } {
	const lines = markdown.split("\n");
	const normalizedHeadings = headings.map(normalizeHeading);
	for (let i = 0; i < lines.length; i++) {
		const match = lines[i].match(/^(#{1,6})\s+(.+?)\s*$/);
		if (!match) continue;
		const heading = normalizeHeading(match[2]);
		if (!normalizedHeadings.some((candidate) => heading.includes(candidate))) continue;
		lines.splice(i + 1, 0, "", content, "");
		return { body: lines.join("\n"), changed: true };
	}
	return { body: markdown, changed: false };
}

function checkTemplateBoxes(markdown: string, type?: string): string {
	if (!type) return markdown;
	const patterns: Record<string, RegExp[]> = {
		feat: [/feature/i, /enhancement/i],
		fix: [/bug/i, /fix/i],
		docs: [/doc/i],
		test: [/test/i],
		build: [/build/i, /dependenc/i],
		ci: [/ci/i, /workflow/i],
		chore: [/chore/i, /maintenance/i],
		refactor: [/refactor/i],
		perf: [/performance/i, /perf/i],
	};
	const matchers = patterns[type] ?? [];
	return markdown.replace(/^(\s*[-*]\s*)\[( |x|X)\](.*)$/gm, (line, prefix, _mark, rest) => {
		return matchers.some((regex) => regex.test(rest)) ? `${prefix}[x]${rest}` : line;
	});
}

function normalizeHeading(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

function statusDescription(xy: string): string {
	if (xy.includes("A") || xy.includes("?")) return "Added";
	if (xy.includes("D")) return "Deleted";
	if (xy.includes("R")) return "Renamed";
	if (xy.includes("C")) return "Copied";
	if (xy.includes("M")) return "Modified";
	return "Changed";
}

function firstLine(value: string): string {
	return value.split("\n")[0].trim();
}

function capitalize(value: string): string {
	return value ? value[0].toUpperCase() + value.slice(1) : value;
}

function ensureTrailingNewline(value: string): string {
	return value.endsWith("\n") ? value : `${value}\n`;
}

function extractUrl(output: string): string | undefined {
	return output.match(/https:\/\/\S+/)?.[0];
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
