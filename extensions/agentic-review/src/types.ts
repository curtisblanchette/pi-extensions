/**
 * Shared types for the agentic-review LangGraph workflow.
 */

export type Provider = "anthropic" | "openai" | "llama-server";

/** Finding severity produced by the quality gate. */
export type Severity = "critical" | "bug" | "nice-to-have" | "nit";

/** Review submission event mapped onto the GitHub reviews API. */
export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

export interface GitHubRepo {
	owner: string;
	name: string;
	nameWithOwner: string;
	host: string;
}

export interface PullRequestSummary {
	number: number;
	title: string;
	isDraft: boolean;
	nodeId?: string;
	headRefName: string;
	headSha?: string;
	baseRefName: string;
	author?: string;
	url: string;
	labels: string[];
	state?: string;
}

/** A single review comment already present on the PR (used for idempotency). */
export interface ExistingReviewComment {
	path?: string;
	line?: number | null;
	startLine?: number | null;
	author?: string;
	body?: string;
}

/** Everything the review node needs about a PR. */
export interface PrContext {
	repo: GitHubRepo;
	number: number;
	title: string;
	url: string;
	headRefName: string;
	baseRefName: string;
	headSha: string;
	body: string;
	acceptanceCriteria: string;
	changedFiles: Array<{ path: string; additions?: number; deletions?: number }>;
	diff: string;
	existingComments: ExistingReviewComment[];
	linkedIssue?: LinkedIssue;
}

export interface LinkedIssue {
	source: "linear";
	key: string;
	title?: string;
	description?: string;
	url?: string;
}

/** An inline-comment candidate parsed from the review, or synthesized from a finding. */
export interface InlineCandidate {
	path: string;
	line: number;
	body: string;
}

export interface Finding {
	id: string;
	severity: Severity;
	title: string;
	path?: string;
	line?: number;
	rationale: string;
	/** Optional fenced ```suggestion block that replaces the offending line(s). */
	suggestion?: string;
}

export interface BugAnalysis {
	findingId: string;
	impactsAcceptanceCriteria: boolean;
	isEdgeCase: boolean;
	edgeCaseDefinition?: string;
	disposition: "critical" | "deferred";
	reasoning: string;
}

export interface LoggedTicket {
	findingId: string;
	identifier?: string;
	url?: string;
	title: string;
	error?: string;
}

export interface Decision {
	event: ReviewEvent;
	summary: string;
	reasons: string[];
	blockingFindingIds: string[];
}

export interface AppliedResult {
	postedComments: number;
	commentFailures: string[];
	reviewSubmitted: boolean;
	dryRun: boolean;
}

/** Result returned by runReviewWorkflow. */
export interface WorkflowResult {
	prNumber: number;
	headSha: string;
	decision: Decision | null;
	findings: Finding[];
	bugAnalyses: BugAnalysis[];
	deferrals: Finding[];
	loggedTickets: LoggedTicket[];
	applied: AppliedResult | null;
	logs: string[];
	skipped?: string;
}
