import { AGENTIC_REVIEW_SYSTEM_PROMPT } from "../../shared/agentic-review-prompt.ts";
import { formatExistingComments } from "./github.ts";
import type { Finding, PrContext } from "./types.ts";

export { AGENTIC_REVIEW_SYSTEM_PROMPT };

export function buildReviewUserPrompt(
	pr: PrContext,
	diffChunk: string,
	chunkIndex: number,
	totalChunks: number,
): string {
	return [
		`Agentic review PR #${pr.number}: ${pr.title}`,
		"",
		`Repository: ${pr.repo.nameWithOwner}`,
		`URL: ${pr.url}`,
		`Branch: ${pr.headRefName} -> ${pr.baseRefName}`,
		`Head SHA: ${pr.headSha}`,
		`Diff chunk: ${chunkIndex + 1}/${totalChunks}`,
		"",
		"PR description:",
		pr.body || "(none)",
		"",
		"Acceptance criteria:",
		pr.acceptanceCriteria,
		"",
		"Existing PR review comments already posted (append-only/idempotency source of truth; do not duplicate these findings or rephrase them as new comments):",
		formatExistingComments(pr.existingComments),
		"",
		"Changed files:",
		pr.changedFiles.map((file) => `- ${file.path} (+${file.additions ?? 0}/-${file.deletions ?? 0})`).join("\n") ||
			"(none)",
		"",
		"Applicable repository guidance fetched from the PR head:",
		pr.reviewGuidance?.length
			? pr.reviewGuidance.map((entry) => `### ${entry.path}\n${entry.content}`).join("\n\n")
			: "(No applicable AGENTS.md or referenced Markdown policy documents were found.)",
		"",
		"Review only the unified-diff chunk below. Other chunks are reviewed independently.",
		"Use new/right-side line numbers for inline candidates.",
		"",
		"Unified diff:",
		diffChunk,
	].join("\n");
}

export const QUALITY_GATE_SYSTEM_PROMPT = [
	"You are the quality gate for a GitHub pull request review.",
	"Convert the review into strict JSON without adding new findings.",
	"Every finding must receive exactly one classification:",
	'- "critical": exploit, security/privacy breach, data loss/corruption, outage, severe regression, or direct failure of a core acceptance criterion.',
	'- "bug": concrete incorrect behavior, correctness defect, broken error handling, or regression that is not already critical.',
	'- "nice-to-have": worthwhile maintainability, test coverage, observability, performance, or design improvement that does not make current behavior incorrect.',
	'- "nit": cosmetic, naming, formatting, comment, or very small readability issue.',
	"Do not downgrade a concrete correctness defect to nice-to-have or nit.",
	"Deduplicate findings that share the same root cause.",
	"Preserve directly applicable replacement code from a ```suggestion block as the suggestion field without the fence.",
	"Return JSON only. No markdown and no prose outside the JSON object.",
].join("\n");

export function buildQualityGatePrompt(pr: PrContext, reviewText: string): string {
	return [
		`PR: #${pr.number} ${pr.title}`,
		`Acceptance criteria: ${pr.acceptanceCriteria}`,
		"",
		"Return this exact shape:",
		JSON.stringify(
			{
				findings: [
					{
						id: "finding-1",
						severity: "critical|bug|nice-to-have|nit",
						title: "short title",
						path: "relative/path.ts or omit",
						line: "new-side integer or omit",
						rationale: "concrete impact",
						suggestion: "exact replacement lines or omit",
					},
				],
			},
			null,
			2,
		),
		"",
		'If the review found no actionable issues, return {"findings":[]}.',
		"",
		"Review to classify:",
		reviewText,
	].join("\n");
}

export const BUG_ANALYSIS_SYSTEM_PROMPT = [
	"You analyze confirmed pull request bugs against acceptance criteria and decide merge impact.",
	"Return strict JSON only.",
	"Default to non-blocking unless there is concrete evidence the PR cannot safely merge.",
	"A concrete bug is not automatically merge-blocking.",
	"For every bug:",
	"- Determine whether it affects an explicit or reasonably inferred acceptance criterion.",
	"- Determine whether the failure requires an unusual boundary, rare environment, invalid input, race, scale threshold, or other clearly defined edge condition.",
	"- Set mergeImpact=blocking only when the issue directly blocks safe merge: happy-path feature is unusable, explicit acceptance criterion clearly fails, build/type/tests fail, security/privacy/data loss/outage risk, or API/contract breakage without migration.",
	"- Set mergeImpact=follow-up when the bug is real and worth durable tracking, but it does not directly block safe merge.",
	"- Set mergeImpact=non-blocking when an inline review comment is enough and no durable follow-up is required.",
	"- Never mark blocking merely because a fix is inconvenient or because the behavior is imperfect.",
].join("\n");

export function buildBugAnalysisPrompt(pr: PrContext, bugs: Finding[]): string {
	return [
		`PR: #${pr.number} ${pr.title}`,
		"",
		"Acceptance criteria:",
		pr.acceptanceCriteria,
		"",
		pr.linkedIssue
			? `Linked Linear issue ${pr.linkedIssue.key}:\n${pr.linkedIssue.title ?? ""}\n${pr.linkedIssue.description ?? ""}`
			: "No linked Linear issue context was available.",
		"",
		"Return this exact shape:",
		JSON.stringify(
			{
				analyses: [
					{
						findingId: "finding-1",
						impactsAcceptanceCriteria: true,
						isEdgeCase: false,
						edgeCaseDefinition: "omit unless isEdgeCase=true",
						directlyBlocksMerge: false,
						mergeImpact: "blocking|non-blocking|follow-up",
						reasoning: "why this is or is not directly merge-blocking",
					},
				],
			},
			null,
			2,
		),
		"",
		"Bugs:",
		JSON.stringify(bugs, null, 2),
	].join("\n");
}
