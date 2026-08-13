import test from "node:test";
import assert from "node:assert/strict";
import { createAgenticReviewGraph } from "../src/graph.ts";
import { PR_LABELS } from "../src/labels.ts";
import type { AgenticReviewConfig } from "../src/config.ts";
import type { BugAnalysis, Decision, Finding, PrContext } from "../src/types.ts";
import type { WorkflowTelemetryEvent } from "../src/telemetry.ts";

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
		ollama: { baseUrl: "http://localhost:11434/v1", apiKey: "ollama", contextWindow: 262_144 },
		llamaServer: { baseUrl: "http://localhost:8080/v1", apiKey: "local", contextWindow: 32_768 },
	},
	review: { maxDiffCharsPerChunk: 60_000, maxChunks: 20, postInlineComments: true },
	github: { triggerLabel: PR_LABELS.readyForReview, authorAllowlist: { users: [], organizations: [], teams: [] } },
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

async function run(findings: Finding[], analyses: BugAnalysis[] = [], linearFailure?: string, emitThinking = false) {
	let appliedDecision: Decision | undefined;
	let jsonCall = 0;
	const telemetry: WorkflowTelemetryEvent[] = [];
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
			completeText: async (
				_system: string,
				_user: string,
				_signal?: AbortSignal,
				onDelta?: (delta: { kind: "text" | "thinking" | "tool"; delta: string }) => void,
			) => {
				if (emitThinking) onDelta?.({ kind: "thinking", delta: "private reasoning" });
				onDelta?.({ kind: "text", delta: "Review" });
				return "Review complete";
			},
			completeJson: async <T>(
				_system: string,
				_user: string,
				_signal?: AbortSignal,
				onDelta?: (delta: { kind: "text" | "thinking" | "tool"; delta: string }) => void,
			) => {
				if (emitThinking) onDelta?.({ kind: "thinking", delta: "private reasoning" });
				onDelta?.({ kind: "text", delta: "JSON" });
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

test("a non-edge bug can approve when it does not directly block merge", async () => {
	const result = await run(
		[finding("bug")],
		[
			{
				findingId: "finding-1",
				impactsAcceptanceCriteria: false,
				isEdgeCase: false,
				directlyBlocksMerge: false,
				mergeImpact: "non-blocking",
				reasoning: "The bug is real but does not prevent a safe merge.",
			},
		],
	);
	assert.equal(result.appliedDecision?.event, "APPROVE");
	assert.deepEqual(result.state.decision?.blockingFindingIds, []);
	assert.equal(result.state.loggedTickets.length, 0);
	assert.ok(result.telemetry.some((event) => event.type === "stage_started" && event.stage === "review"));
	assert.ok(result.telemetry.some((event) => event.type === "model_delta" && event.stage === "review"));
	assert.ok(result.telemetry.some((event) => event.type === "model_delta" && event.stage === "classify"));
	assert.ok(result.telemetry.some((event) => event.type === "stage_completed" && event.stage === "apply"));
});

test("a directly merge-blocking bug requests changes", async () => {
	const result = await run(
		[finding("bug")],
		[
			{
				findingId: "finding-1",
				impactsAcceptanceCriteria: true,
				isEdgeCase: false,
				directlyBlocksMerge: true,
				mergeImpact: "blocking",
				reasoning: "Invalid orders are accepted, directly failing the acceptance criteria.",
			},
		],
	);
	assert.equal(result.appliedDecision?.event, "REQUEST_CHANGES");
	assert.deepEqual(result.state.decision?.blockingFindingIds, ["finding-1"]);
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
		directlyBlocksMerge: false,
		mergeImpact: "follow-up",
		reasoning: "Primary checkout behavior remains correct and the follow-up is bounded.",
	};
	const result = await run([finding("bug")], [analysis]);
	assert.equal(result.appliedDecision?.event, "APPROVE");
	assert.equal(result.state.loggedTickets[0]?.identifier, "ENG-99");
});

test("a follow-up bug still approves when Linear ticket creation fails", async () => {
	const result = await run(
		[finding("bug")],
		[
			{
				findingId: "finding-1",
				impactsAcceptanceCriteria: false,
				isEdgeCase: true,
				edgeCaseDefinition: "Only occurs for a replayed expired cart token.",
				directlyBlocksMerge: false,
				mergeImpact: "follow-up",
				reasoning: "Bounded, if tracked.",
			},
		],
		"Linear unavailable",
	);
	assert.equal(result.appliedDecision?.event, "APPROVE");
	assert.match(result.state.loggedTickets[0]?.error ?? "", /Linear unavailable/);
});

test("model thinking deltas are omitted from dashboard telemetry", async () => {
	const result = await run([], [], undefined, true);
	const modelDeltas = result.telemetry.filter((event) => event.type === "model_delta");
	assert.ok(modelDeltas.some((event) => event.data?.kind === "text"));
	assert.equal(
		modelDeltas.some((event) => event.data?.kind === "thinking"),
		false,
	);
	assert.ok(
		result.telemetry.some(
			(event) =>
				event.type === "stage_progress" && event.data?.kind === "thinking" && event.data?.streamPolicy === "omitted",
		),
	);
});
