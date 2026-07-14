import test from "node:test";
import assert from "node:assert/strict";
import { createAgenticReviewGraph } from "../src/graph.ts";
import { PR_LABELS } from "../src/labels.ts";
import type { AgenticReviewConfig } from "../src/config.ts";
import type { BugAnalysis, Decision, Finding, PrContext } from "../src/types.ts";

const context: PrContext = {
	repo: { owner: "example", name: "repo", nameWithOwner: "example/repo", host: "github.com" },
	number: 42,
	title: "Implement checkout validation",
	url: "https://github.com/example/repo/pull/42",
	headRefName: "feature/checkout",
	baseRefName: "main",
	headSha: "abc123",
	body: "## Acceptance criteria\n- Invalid orders are rejected",
	acceptanceCriteria: "- Invalid orders are rejected",
	changedFiles: [{ path: "src/checkout.ts", additions: 3, deletions: 1 }],
	diff: "diff --git a/src/checkout.ts b/src/checkout.ts\n@@ -1 +1 @@\n-old\n+new",
	existingComments: [],
};

const config: AgenticReviewConfig = {
	polling: { enabled: false, intervalMs: 180_000 },
	webUi: { enabled: false, port: 4317, openOnStart: false, maxRuns: 100 },
	model: {
		provider: "openai",
		id: "test-model",
		temperature: 0,
		maxTokens: 4_000,
		apiKeys: {},
		llamaServer: { baseUrl: "http://localhost:8080/v1", apiKey: "local", contextWindow: 32_768 },
	},
	review: { maxDiffCharsPerChunk: 60_000, maxChunks: 20, postInlineComments: true },
	github: { triggerLabel: PR_LABELS.readyForReview },
	linear: { enabled: true, endpoint: "https://api.linear.app/graphql", apiKey: "test", team: "ENG", labelIds: [] },
	dryRun: false,
	stateFile: "/tmp/agentic-review-test-state.json",
};

function finding(severity: Finding["severity"]): Finding {
	return {
		id: "finding-1",
		severity,
		title: "Validation accepts an invalid order",
		path: "src/checkout.ts",
		line: 1,
		rationale: "The invalid order reaches payment.",
		suggestion: "return reject(order);",
	};
}

async function run(findings: Finding[], analyses: BugAnalysis[] = [], linearFailure?: string) {
	let appliedDecision: Decision | undefined;
	let jsonCall = 0;
	const telemetry: Array<{ type: string; stage?: string }> = [];
	const graph = createAgenticReviewGraph({
		github: {
			gatherContext: async () => structuredClone(context),
			getPullRequest: async () => ({ headSha: context.headSha }),
			applyReview: async (_context: PrContext, decision: Decision, comments: unknown[]) => {
				appliedDecision = decision;
				return {
					postedComments: comments.length,
					commentFailures: [],
					reviewSubmitted: true,
					dryRun: false,
				};
			},
		} as any,
		linear: {
			lookupIssue: async () => undefined,
			createDeferredTicket: async (_pr: PrContext, deferred: Finding) => {
				if (linearFailure) throw new Error(linearFailure);
				return {
					findingId: deferred.id,
					identifier: "ENG-99",
					url: "https://linear.app/example/issue/ENG-99",
					title: deferred.title,
				};
			},
		} as any,
		model: {
			provider: "openai",
			id: "test-model",
			completeText: async () => "Review complete",
			completeJson: async <T>() => {
				jsonCall++;
				return (jsonCall === 1 ? { findings } : { analyses }) as T;
			},
		},
		config,
		onTelemetry: (event) => telemetry.push(event),
	});
	const state = await graph.invoke({ prNumber: 42 });
	return { state, appliedDecision, telemetry };
}

test("a non-edge bug requests changes even when the model tries to defer it", async () => {
	const result = await run([finding("bug")], [
		{
			findingId: "finding-1",
			impactsAcceptanceCriteria: false,
			isEdgeCase: false,
			disposition: "deferred",
			reasoning: "Model attempted to defer a normal-path bug.",
		},
	]);
	assert.equal(result.appliedDecision?.event, "REQUEST_CHANGES");
	assert.deepEqual(result.state.decision?.blockingFindingIds, ["finding-1"]);
	assert.ok(result.telemetry.some((event) => event.type === "stage_started" && event.stage === "review"));
	assert.ok(result.telemetry.some((event) => event.type === "stage_completed" && event.stage === "apply"));
});

test("nice-to-have and nit findings approve with comments", async () => {
	const result = await run([
		{ ...finding("nice-to-have"), id: "finding-1" },
		{ ...finding("nit"), id: "finding-2", title: "Rename local variable" },
	]);
	assert.equal(result.appliedDecision?.event, "APPROVE");
	assert.deepEqual(result.state.decision?.blockingFindingIds, []);
});

test("a bounded edge-case bug is tracked in Linear before approval", async () => {
	const analysis: BugAnalysis = {
		findingId: "finding-1",
		impactsAcceptanceCriteria: false,
		isEdgeCase: true,
		edgeCaseDefinition: "Only occurs when an already-expired cart token is replayed after checkout completes.",
		disposition: "deferred",
		reasoning: "Primary checkout behavior remains correct and the follow-up is bounded.",
	};
	const result = await run([finding("bug")], [analysis]);
	assert.equal(result.appliedDecision?.event, "APPROVE");
	assert.equal(result.state.loggedTickets[0]?.identifier, "ENG-99");
});

test("a deferred bug fails closed when Linear ticket creation fails", async () => {
	const result = await run(
		[finding("bug")],
		[
			{
				findingId: "finding-1",
				impactsAcceptanceCriteria: false,
				isEdgeCase: true,
				edgeCaseDefinition: "Only occurs for a replayed expired cart token.",
				disposition: "deferred",
				reasoning: "Bounded, if tracked.",
			},
		],
		"Linear unavailable",
	);
	assert.equal(result.appliedDecision?.event, "REQUEST_CHANGES");
	assert.match(result.state.loggedTickets[0]?.error ?? "", /Linear unavailable/);
});
