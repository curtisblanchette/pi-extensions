import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
	AppliedResult,
	Decision,
	ExistingReviewComment,
	GitHubRepo,
	InlineCandidate,
	PrContext,
	PullRequestSummary,
} from "./types.ts";
import type { AgenticReviewConfig } from "./config.ts";

interface RestPullRequest {
	number: number;
	title: string;
	draft?: boolean;
	node_id?: string;
	head?: { ref?: string; sha?: string };
	base?: { ref?: string };
	user?: { login?: string };
	html_url?: string;
	body?: string | null;
	state?: string;
	labels?: Array<{ name?: string }>;
}

interface RestPullRequestFile {
	filename?: string;
	additions?: number;
	deletions?: number;
}

interface RestReviewComment {
	path?: string;
	line?: number | null;
	start_line?: number | null;
	body?: string;
	user?: { login?: string };
}

export class GitHubClient {
	constructor(
		private pi: ExtensionAPI,
		readonly cwd: string,
		readonly repo: GitHubRepo,
		private accessToken?: string,
	) {}

	async ensureAvailable(): Promise<void> {
		await execOrThrow(this.pi, "gh", ["--version"], this.cwd, "GitHub CLI (gh) is required");
	}

	async listOpenPullRequests(): Promise<PullRequestSummary[]> {
		const output = await this.api([
			"--method",
			"GET",
			`repos/${this.repo.owner}/${this.repo.name}/pulls`,
			"-f",
			"state=open",
			"-f",
			"per_page=100",
			"--paginate",
			"--slurp",
		]);
		return parsePaginatedArray<RestPullRequest>(output).map(mapPullRequest);
	}

	async getPullRequest(prNumber: number): Promise<PullRequestSummary & { body: string }> {
		const output = await this.api([`repos/${this.repo.owner}/${this.repo.name}/pulls/${prNumber}`], `Failed to load PR #${prNumber}`);
		const pr = JSON.parse(output) as RestPullRequest;
		return { ...mapPullRequest(pr), body: pr.body ?? "" };
	}

	async findPullRequestForCurrentBranch(): Promise<PullRequestSummary | undefined> {
		const result = await this.pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: this.cwd, timeout: 10_000 });
		if (result.code !== 0) return undefined;
		const branch = result.stdout.trim();
		if (!branch || branch === "HEAD") return undefined;
		return (await this.listOpenPullRequests()).find((pr) => pr.headRefName === branch);
	}

	async gatherContext(prNumber: number): Promise<PrContext> {
		const endpoint = `repos/${this.repo.owner}/${this.repo.name}/pulls/${prNumber}`;
		const [prOutput, filesOutput, commentsOutput, diff] = await Promise.all([
			this.api([endpoint], `Failed to load PR #${prNumber}`),
			this.api([`${endpoint}/files`, "--paginate", "--slurp"], `Failed to load PR #${prNumber} files`),
			this.api([`${endpoint}/comments`, "--paginate", "--slurp"], `Failed to load PR #${prNumber} comments`),
			this.api(["-H", "Accept: application/vnd.github.v3.patch", endpoint], `Failed to load PR #${prNumber} diff`),
		]);
		const pr = JSON.parse(prOutput) as RestPullRequest;
		const summary = mapPullRequest(pr);
		if (!summary.headSha) throw new Error(`Could not resolve head SHA for PR #${prNumber}`);
		const body = pr.body ?? "";
		return {
			repo: this.repo,
			number: prNumber,
			title: summary.title,
			url: summary.url,
			headRefName: summary.headRefName,
			baseRefName: summary.baseRefName,
			headSha: summary.headSha,
			body,
			acceptanceCriteria: extractAcceptanceCriteria(body),
			changedFiles: parsePaginatedArray<RestPullRequestFile>(filesOutput)
				.filter((file): file is RestPullRequestFile & { filename: string } => Boolean(file.filename))
				.map((file) => ({ path: file.filename, additions: file.additions, deletions: file.deletions })),
			diff,
			existingComments: parsePaginatedArray<RestReviewComment>(commentsOutput).map((comment) => ({
				path: comment.path,
				line: comment.line,
				startLine: comment.start_line,
				author: comment.user?.login,
				body: comment.body,
			})),
		};
	}

	async applyReview(
		pr: PrContext,
		decision: Decision,
		comments: InlineCandidate[],
		config: AgenticReviewConfig,
	): Promise<AppliedResult> {
		if (config.dryRun) {
			return {
				postedComments: 0,
				commentFailures: [],
				reviewSubmitted: false,
				dryRun: true,
			};
		}

		const commentResult = config.review.postInlineComments
			? await this.postInlineComments(pr, dedupeCandidates(comments, pr.existingComments))
			: { posted: 0, failures: [] as string[] };

		await this.submitReview(pr.number, decision);
		return {
			postedComments: commentResult.posted,
			commentFailures: commentResult.failures,
			reviewSubmitted: true,
			dryRun: false,
		};
	}

	private async postInlineComments(pr: PrContext, comments: InlineCandidate[]): Promise<{ posted: number; failures: string[] }> {
		let posted = 0;
		const failures: string[] = [];
		for (const comment of comments) {
			const dir = await mkdtemp(join(tmpdir(), "pi-agentic-review-comment-"));
			try {
				const payload = join(dir, "comment.json");
				await writeFile(
					payload,
					JSON.stringify(
						{
							commit_id: pr.headSha,
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
				await this.api(
					[
						"--method",
						"POST",
						`repos/${this.repo.owner}/${this.repo.name}/pulls/${pr.number}/comments`,
						"-H",
						"Accept: application/vnd.github+json",
						"--input",
						payload,
					],
					`Failed to post ${comment.path}:${comment.line}`,
				);
				posted++;
			} catch (error) {
				failures.push(`${comment.path}:${comment.line} — ${firstLine(formatError(error))}`);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		}
		return { posted, failures };
	}

	private async submitReview(prNumber: number, decision: Decision): Promise<void> {
		await this.api(
			[
				"--method",
				"POST",
				`repos/${this.repo.owner}/${this.repo.name}/pulls/${prNumber}/reviews`,
				"-H",
				"Accept: application/vnd.github+json",
				"-f",
				`event=${decision.event}`,
				"-f",
				`body=${truncate(decision.summary, 60_000)}`,
			],
			`Failed to submit ${decision.event} review for PR #${prNumber}`,
		);
	}


	private api(args: string[], message?: string): Promise<string> {
		return execGitHubApi(this.pi, ["api", ...hostArgs(this.repo), ...args], this.cwd, message, this.accessToken);
	}
}

export async function getActiveRepo(pi: ExtensionAPI, cwd: string, configuredRepository?: string): Promise<GitHubRepo> {
	if (configuredRepository) {
		const [owner, name] = configuredRepository.split("/");
		if (!owner || !name) throw new Error(`Invalid configured GitHub repository: ${configuredRepository}`);
		return { owner, name, host: "github.com", nameWithOwner: `${owner}/${name}` };
	}
	const remoteResult = await pi.exec("git", ["remote"], { cwd, timeout: 10_000 });
	const remotes = ["origin", ...(remoteResult.code === 0 ? remoteResult.stdout.split("\n") : [])]
		.map((remote) => remote.trim())
		.filter(Boolean);
	for (const remote of [...new Set(remotes)]) {
		const result = await pi.exec("git", ["remote", "get-url", remote], { cwd, timeout: 10_000 });
		if (result.code !== 0) continue;
		const parsed = parseGitHubRemote(result.stdout.trim());
		if (parsed) return parsed;
	}
	throw new Error("Could not resolve GitHub owner/repo from git remotes");
}

export function formatExistingComments(comments: ExistingReviewComment[]): string {
	if (!comments.length) return "(none)";
	return comments
		.map((comment) => {
			const location = `${comment.path ?? "unknown"}:${comment.line ?? comment.startLine ?? "?"}`;
			const author = comment.author ? ` @${comment.author}` : "";
			return `- ${location}${author}: ${truncate((comment.body ?? "").replace(/\s+/g, " ").trim(), 500)}`;
		})
		.join("\n");
}

export function extractLinearIssueKeys(...values: string[]): string[] {
	const matches = values.join("\n").match(/\b[A-Z][A-Z0-9]{1,9}-\d+\b/g) ?? [];
	return [...new Set(matches)];
}

function extractAcceptanceCriteria(body: string): string {
	if (!body.trim()) return "No acceptance criteria were included in the PR description.";
	const heading = /^(#{1,6})\s*(acceptance criteria|requirements|definition of done|success criteria)\s*$/gim;
	const match = heading.exec(body);
	if (!match) return "No explicit acceptance-criteria section was included. Infer intended behavior conservatively from the PR description.";
	const start = heading.lastIndex;
	const rest = body.slice(start);
	const nextHeading = rest.search(/^#{1,6}\s+.+$/m);
	const section = (nextHeading >= 0 ? rest.slice(0, nextHeading) : rest).trim();
	return section || "Acceptance-criteria heading was present but empty.";
}

function dedupeCandidates(candidates: InlineCandidate[], existing: ExistingReviewComment[]): InlineCandidate[] {
	const seen = new Set<string>();
	for (const comment of existing) {
		seen.add(`${comment.path ?? ""}:${comment.line ?? comment.startLine ?? ""}`);
	}
	return candidates.filter((candidate) => {
		const key = `${candidate.path}:${candidate.line}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function mapPullRequest(pr: RestPullRequest): PullRequestSummary {
	return {
		number: pr.number,
		title: pr.title,
		isDraft: pr.draft === true,
		nodeId: pr.node_id,
		headRefName: pr.head?.ref ?? "unknown",
		headSha: pr.head?.sha,
		baseRefName: pr.base?.ref ?? "unknown",
		author: pr.user?.login,
		url: pr.html_url ?? "",
		labels: pr.labels?.map((label) => label.name).filter((name): name is string => Boolean(name)) ?? [],
		state: pr.state,
	};
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

function parsePaginatedArray<T>(output: string): T[] {
	const parsed = JSON.parse(output);
	if (!Array.isArray(parsed)) return [];
	return Array.isArray(parsed[0]) ? parsed.flat() : parsed;
}

function hostArgs(repo: GitHubRepo): string[] {
	return repo.host && repo.host !== "github.com" ? ["--hostname", repo.host] : [];
}

async function execGitHubApi(
	pi: ExtensionAPI,
	args: string[],
	cwd: string,
	message: string | undefined,
	accessToken: string | undefined,
): Promise<string> {
	if (!accessToken) return execOrThrow(pi, "gh", args, cwd, message);
	return new Promise((resolve, reject) => {
		const child = spawn("gh", args, {
			cwd,
			env: { ...process.env, GH_TOKEN: accessToken },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		const timeout = setTimeout(() => child.kill("SIGTERM"), 120_000);
		child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
		child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
		child.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timeout);
			if (code === 0) resolve(stdout);
			else reject(new Error(`${message ?? `gh ${args.join(" ")} failed`}\n${stderr || stdout}`.trim()));
		});
	});
}

async function execOrThrow(
	pi: ExtensionAPI,
	command: string,
	args: string[],
	cwd: string,
	message?: string,
): Promise<string> {
	const result = await pi.exec(command, args, { cwd, timeout: 120_000 });
	if (result.code !== 0) {
		throw new Error(`${message ?? `${command} ${args.join(" ")} failed`}\n${result.stderr || result.stdout}`.trim());
	}
	return result.stdout;
}

function truncate(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max)}\n… [truncated ${value.length - max} chars]`;
}

function firstLine(value: string): string {
	return value.split("\n")[0].trim();
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
