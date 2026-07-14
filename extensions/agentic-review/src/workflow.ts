import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgenticReviewConfig } from "./config.ts";
import { createAgenticReviewGraph } from "./graph.ts";
import { getActiveRepo, GitHubClient } from "./github.ts";
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
	const repo = await getActiveRepo(pi, ctx.cwd, config.github.repository);
	const github = new GitHubClient(pi, ctx.cwd, repo, config.github.accessToken);
	await github.ensureAvailable();
	const pr = await github.getPullRequest(prNumber);
	if (pr.isDraft) throw new Error(`PR #${prNumber} is still a draft`);
	if (!pr.headSha) throw new Error(`Could not resolve head SHA for PR #${prNumber}`);

	const store = new ReviewStateStore(config.stateFile);
	if (!options.force && (await store.hasProcessed(repo, prNumber, pr.headSha))) {
		return {
			prNumber,
			headSha: pr.headSha,
			decision: null,
			findings: [],
			bugAnalyses: [],
			deferrals: [],
			loggedTickets: [],
			applied: null,
			logs: [],
			skipped: `Commit ${pr.headSha} was already reviewed`,
		};
	}

	const model = await resolveReviewModel(pi, ctx, config);
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
	const contextHeadSha = state.context?.headSha ?? pr.headSha;
	if (!state.decision) throw new Error("Agentic-review workflow completed without a quality-gate decision");
	if (!config.dryRun && state.applied?.reviewSubmitted) {
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
