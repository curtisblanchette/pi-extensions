import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
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

interface RestPullRequestReview {
	body?: string | null;
	state?: string;
	submitted_at?: string | null;
	commit_id?: string;
	user?: { login?: string };
	html_url?: string;
}

export interface ReviewThreadSummary {
	path?: string;
	line?: number;
	author?: string;
	url?: string;
}

export interface PreviousAgenticReviewStatus {
	latestReview: {
		author?: string;
		submittedAt?: string;
		state?: string;
		headSha?: string;
		url?: string;
	};
	unresolvedThreadCount: number;
	unresolvedThreads: ReviewThreadSummary[];
}

export interface AuthorAllowlistResult {
	allowed: boolean;
	reason?: string;
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

	async checkAuthorAllowlist(
		author: string | undefined,
		allowlist: AgenticReviewConfig["github"]["authorAllowlist"],
	): Promise<AuthorAllowlistResult> {
		const users = allowlist.users.map((user) => user.toLowerCase());
		const organizations = allowlist.organizations;
		const teams = allowlist.teams;
		if (!users.length && !organizations.length && !teams.length) return { allowed: true };
		if (!author) return { allowed: false, reason: "PR author is unknown and cannot be checked against the author allowlist" };
		if (users.includes(author.toLowerCase())) return { allowed: true };

		for (const org of organizations) {
			if (await this.isOrganizationMember(org, author)) return { allowed: true };
		}
		for (const team of teams) {
			const parsed = parseTeamSpec(team, this.repo.owner);
			if (await this.isTeamMember(parsed.org, parsed.teamSlug, author)) return { allowed: true };
		}

		return {
			allowed: false,
			reason: `PR author @${author} is not in the allowed GitHub authors: ${describeAuthorAllowlist(allowlist, this.repo.owner)}`,
		};
	}

	async getPreviousAgenticReviewStatus(prNumber: number): Promise<PreviousAgenticReviewStatus | undefined> {
		const latestReview = await this.getLatestAgenticReview(prNumber);
		if (!latestReview) return undefined;
		const unresolvedThreads = await this.listUnresolvedReviewThreads(prNumber);
		return {
			latestReview: {
				author: latestReview.user?.login,
				submittedAt: latestReview.submitted_at ?? undefined,
				state: latestReview.state,
				headSha: latestReview.commit_id,
				url: latestReview.html_url,
			},
			unresolvedThreadCount: unresolvedThreads.length,
			unresolvedThreads: unresolvedThreads.slice(0, 10),
		};
	}

	async getPreviousAgenticReviewBlocker(prNumber: number): Promise<PreviousAgenticReviewStatus | undefined> {
		const status = await this.getPreviousAgenticReviewStatus(prNumber);
		return status && status.unresolvedThreadCount > 0 ? status : undefined;
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

	async getReviewGuidance(changedFiles: PrContext["changedFiles"], ref: string): Promise<Array<{ path: string; content: string }>> {
		const candidates = policyCandidatePaths(changedFiles.map((file) => file.path));
		const guidance: Array<{ path: string; content: string }> = [];
		for (const path of candidates) {
			const content = await this.getTextFileAtRef(path, ref);
			if (!content) continue;
			guidance.push({ path, content: truncate(content, 12_000) });
		}

		// AGENTS.md may link to repository-specific ADRs or coding conventions.
		// Resolve only repository-relative Markdown references and cap the total
		// context so a malicious or unusually large file cannot swamp the review.
		for (const agent of guidance.filter((entry) => posix.basename(entry.path).toLowerCase() === "agents.md")) {
			for (const path of referencedPolicyPaths(agent.path, agent.content)) {
				if (guidance.length >= 20 || guidance.some((entry) => entry.path === path)) continue;
				const content = await this.getTextFileAtRef(path, ref);
				if (content) guidance.push({ path, content: truncate(content, 12_000) });
			}
		}
		return guidance;
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

	private async getTextFileAtRef(path: string, ref: string): Promise<string | undefined> {
		const encodedPath = path.split("/").map(encodeURIComponent).join("/");
		try {
			return await this.api(
				["-H", "Accept: application/vnd.github.raw+json", `repos/${this.repo.owner}/${this.repo.name}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`],
				`Failed to load review guidance ${path}`,
			);
		} catch {
			// Most candidate locations do not exist in a repository. Treat a failed
			// optional policy lookup as absent; primary PR retrieval still fails hard.
			return undefined;
		}
	}

	private async isOrganizationMember(org: string, username: string): Promise<boolean> {
		try {
			await this.api(
				["--method", "GET", `orgs/${org}/members/${username}`],
				`Failed to check GitHub organization membership for @${username} in ${org}`,
			);
			return true;
		} catch {
			return false;
		}
	}

	private async isTeamMember(org: string, teamSlug: string, username: string): Promise<boolean> {
		try {
			const output = await this.api(
				["--method", "GET", `orgs/${org}/teams/${teamSlug}/memberships/${username}`],
				`Failed to check GitHub team membership for @${username} in ${org}/${teamSlug}`,
			);
			const membership = JSON.parse(output || "{}") as { state?: string };
			return membership.state === "active" || membership.state === undefined;
		} catch {
			return false;
		}
	}

	private async getLatestAgenticReview(prNumber: number): Promise<RestPullRequestReview | undefined> {
		const output = await this.api(
			[
				"--method",
				"GET",
				`repos/${this.repo.owner}/${this.repo.name}/pulls/${prNumber}/reviews`,
				"-f",
				"per_page=100",
				"--paginate",
				"--slurp",
			],
			`Failed to load PR #${prNumber} reviews`,
		);
		return parsePaginatedArray<RestPullRequestReview>(output)
			.filter((review) => isAgenticReviewBody(review.body))
			.sort((left, right) => timestampMs(right.submitted_at) - timestampMs(left.submitted_at))[0];
	}

	private async listUnresolvedReviewThreads(prNumber: number): Promise<ReviewThreadSummary[]> {
		const unresolved: ReviewThreadSummary[] = [];
		let after: string | undefined;
		do {
			const args = [
				"graphql",
				"-f",
				`query=${REVIEW_THREADS_QUERY}`,
				"-F",
				`owner=${this.repo.owner}`,
				"-F",
				`name=${this.repo.name}`,
				"-F",
				`number=${prNumber}`,
			];
			if (after) args.push("-F", `after=${after}`);
			const output = await this.api(args, `Failed to load PR #${prNumber} review threads`);
			const page = parseReviewThreadPage(output);
			for (const thread of page.nodes) {
				if (thread.isResolved) continue;
				const firstComment = thread.comments.nodes[0];
				unresolved.push({
					path: thread.path,
					line: thread.line ?? undefined,
					author: firstComment?.author?.login,
					url: firstComment?.url,
				});
			}
			after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : undefined;
		} while (after);
		return unresolved;
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

function policyCandidatePaths(changedFiles: string[]): string[] {
	const paths = new Set<string>(["AGENTS.md"]);
	for (const changedPath of changedFiles) {
		let directory = posix.dirname(changedPath.replace(/\\/g, "/"));
		while (directory && directory !== ".") {
			paths.add(posix.join(directory, "AGENTS.md"));
			directory = posix.dirname(directory);
		}
	}
	return [...paths].slice(0, 20);
}

function referencedPolicyPaths(agentPath: string, content: string): string[] {
	const base = posix.dirname(agentPath);
	const references = [...content.matchAll(/(?:\]\(|`)([^`)#?\s]+\.md)(?:\)|`)/gi)].map((match) => match[1]);
	return [...new Set(references)]
		.filter((reference): reference is string => Boolean(reference) && !reference.includes("://"))
		.map((reference) => posix.normalize(posix.join(base, reference)))
		.filter((reference) => reference !== ".." && !reference.startsWith("../"));
}

function parseTeamSpec(value: string, defaultOrg: string): { org: string; teamSlug: string } {
	const [orgOrTeam, team] = value.split("/");
	return team ? { org: orgOrTeam, teamSlug: team } : { org: defaultOrg, teamSlug: orgOrTeam };
}

function describeAuthorAllowlist(allowlist: AgenticReviewConfig["github"]["authorAllowlist"], defaultOrg: string): string {
	return [
		...allowlist.users.map((user) => `@${user}`),
		...allowlist.organizations.map((org) => `org:${org}`),
		...allowlist.teams.map((team) => {
			const parsed = parseTeamSpec(team, defaultOrg);
			return `team:${parsed.org}/${parsed.teamSlug}`;
		}),
	].join(", ");
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

const AGENTIC_REVIEW_BODY_MARKERS = [
	"Generated by the pi LangGraph agentic-review workflow",
	"Automated agentic review found no actionable issues",
];

const REVIEW_THREADS_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          isResolved
          path
          line
          comments(first: 20) {
            nodes {
              author { login }
              url
            }
          }
        }
      }
    }
  }
}`;

interface GraphQlReviewThreadPage {
	pageInfo: { hasNextPage: boolean; endCursor?: string | null };
	nodes: Array<{
		isResolved: boolean;
		path?: string;
		line?: number | null;
		comments: { nodes: Array<{ author?: { login?: string }; url?: string }> };
	}>;
}

function parsePaginatedArray<T>(output: string): T[] {
	const parsed = JSON.parse(output);
	if (!Array.isArray(parsed)) return [];
	return Array.isArray(parsed[0]) ? parsed.flat() : parsed;
}

function parseReviewThreadPage(output: string): GraphQlReviewThreadPage {
	const parsed = JSON.parse(output) as {
		data?: { repository?: { pullRequest?: { reviewThreads?: GraphQlReviewThreadPage } } };
	};
	const page = parsed.data?.repository?.pullRequest?.reviewThreads;
	if (!page) throw new Error("GitHub GraphQL response did not include pull request review threads");
	return page;
}

function isAgenticReviewBody(body: string | null | undefined): boolean {
	return AGENTIC_REVIEW_BODY_MARKERS.some((marker) => body?.includes(marker));
}

function timestampMs(value: string | null | undefined): number {
	const parsed = value ? Date.parse(value) : 0;
	return Number.isFinite(parsed) ? parsed : 0;
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
