import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgenticReviewConfig } from "./config.ts";
import { createAgenticReviewGraph } from "./graph.ts";
import { getActiveRepo, GitHubClient, type PreviousAgenticReviewStatus } from "./github.ts";
import { LinearClient } from "./linear.ts";
import { resolveReviewModel } from "./model.ts";
import { ReviewStateStore } from "./state.ts";
import type { WorkflowResult } from "./types.ts";
import type { WorkflowTelemetryEvent } from "./telemetry.ts";

export interface RunWorkflowOptions {
	force?: boolean;
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
	onTelemetry?: (event: WorkflowTelemetryEvent) => void;
}

export async function runReviewWorkflow(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	config: AgenticReviewConfig,
	prNumber: number,
	options: RunWorkflowOptions = {},
): Promise<WorkflowResult> {
	options.signal?.throwIfAborted?.();
	const repo = await getActiveRepo(pi, ctx.cwd, config.github.repository);
	const github = new GitHubClient(pi, ctx.cwd, repo, config.github.accessToken);
	await github.ensureAvailable();
	const pr = await github.getPullRequest(prNumber);
	options.signal?.throwIfAborted?.();
	if (pr.isDraft) throw new Error(`PR #${prNumber} is still a draft`);
	if (!pr.headSha) throw new Error(`Could not resolve head SHA for PR #${prNumber}`);
	const authorAllowlist = await github.checkAuthorAllowlist(pr.author, config.github.authorAllowlist);
	options.signal?.throwIfAborted?.();
	if (!authorAllowlist.allowed) {
		return skippedWorkflowResult(
			prNumber,
			pr.headSha,
			authorAllowlist.reason ?? `PR author @${pr.author ?? "unknown"} is not allowed`,
		);
	}

	const previousReview = config.dryRun ? undefined : await github.getPreviousAgenticReviewStatus(prNumber);
	if (previousReview?.unresolvedThreadCount) {
		return skippedWorkflowResult(prNumber, pr.headSha, formatPreviousReviewBlocker(previousReview));
	}
	if (!options.force && previousReview?.latestReview.headSha === pr.headSha) {
		return skippedWorkflowResult(prNumber, pr.headSha, `Commit ${pr.headSha} already has an agentic review on GitHub`);
	}

	const store = new ReviewStateStore(config.stateFile);
	if (!options.force && (await store.hasProcessed(repo, prNumber, pr.headSha))) {
		return skippedWorkflowResult(prNumber, pr.headSha, `Commit ${pr.headSha} was already reviewed`);
	}

	const model = await resolveReviewModel(pi, ctx, config);
	options.signal?.throwIfAborted?.();
	options.onTelemetry?.({
		type: "log",
		message: `Resolved model ${model.provider}/${model.id}`,
		data: { model: `${model.provider}/${model.id}`, dryRun: config.dryRun },
	});
	const linear = new LinearClient(config.linear);
	const graph = createAgenticReviewGraph({
		github,
		linear,
		model,
		config,
		signal: options.signal,
		onProgress: options.onProgress,
		onTelemetry: options.onTelemetry,
	});
	const state = await graph.invoke({ prNumber });
	options.signal?.throwIfAborted?.();
	const contextHeadSha = state.context?.headSha ?? pr.headSha;
	if (!state.decision) throw new Error("Agentic-review workflow completed without a quality-gate decision");
	if (!config.dryRun && state.applied?.reviewSubmitted) {
		options.signal?.throwIfAborted?.();
		await store.record(repo, prNumber, contextHeadSha, state.decision);
	}

	return {
		prNumber,
		headSha: contextHeadSha,
		decision: state.decision,
		findings: state.findings,
		bugAnalyses: state.bugAnalyses,
		deferrals: state.deferrals,
		loggedTickets: state.loggedTickets,
		applied: state.applied,
		logs: state.logs,
	};
}

function skippedWorkflowResult(prNumber: number, headSha: string, skipped: string): WorkflowResult {
	return {
		prNumber,
		headSha,
		decision: null,
		findings: [],
		bugAnalyses: [],
		deferrals: [],
		loggedTickets: [],
		applied: null,
		logs: [],
		skipped,
	};
}

function formatPreviousReviewBlocker(blocker: PreviousAgenticReviewStatus): string {
	const author = blocker.latestReview.author ? ` by @${blocker.latestReview.author}` : "";
	const submittedAt = blocker.latestReview.submittedAt ? ` on ${blocker.latestReview.submittedAt}` : "";
	const examples = blocker.unresolvedThreads
		.slice(0, 3)
		.map((thread) => {
			const location = thread.path ? `${thread.path}${thread.line ? `:${thread.line}` : ""}` : "review thread";
			return thread.url ? `${location} (${thread.url})` : location;
		})
		.join(", ");
	return [
		`Previous agentic review${author}${submittedAt} still has ${blocker.unresolvedThreadCount} unresolved review thread${blocker.unresolvedThreadCount === 1 ? "" : "s"}.`,
		"Resolve those review comments before requesting another automated review.",
		examples ? `Unresolved: ${examples}` : undefined,
	]
		.filter((line): line is string => Boolean(line))
		.join(" ");
}
