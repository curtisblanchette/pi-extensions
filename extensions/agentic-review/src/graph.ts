import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { AgenticReviewConfig } from "./config.ts";
import { extractLinearIssueKeys, type GitHubClient } from "./github.ts";
import type { LinearClient } from "./linear.ts";
import type { ReviewModelClient, ReviewModelStreamDelta } from "./model.ts";
import {
	AGENTIC_REVIEW_SYSTEM_PROMPT,
	BUG_ANALYSIS_SYSTEM_PROMPT,
	buildBugAnalysisPrompt,
	buildQualityGatePrompt,
	buildReviewUserPrompt,
	QUALITY_GATE_SYSTEM_PROMPT,
} from "./prompts.ts";
import type {
	AppliedResult,
	BugAnalysis,
	Decision,
	Finding,
	InlineCandidate,
	LoggedTicket,
	PrContext,
} from "./types.ts";
import type { WorkflowStage, WorkflowTelemetryEvent } from "./telemetry.ts";

const ReviewState = Annotation.Root({
	prNumber: Annotation<number>(),
	context: Annotation<PrContext | null>({ reducer: (_left, right) => right, default: () => null }),
	reviewText: Annotation<string>({ reducer: (_left, right) => right, default: () => "" }),
	findings: Annotation<Finding[]>({ reducer: (_left, right) => right, default: () => [] }),
	bugAnalyses: Annotation<BugAnalysis[]>({ reducer: (_left, right) => right, default: () => [] }),
	deferrals: Annotation<Finding[]>({ reducer: (_left, right) => right, default: () => [] }),
	loggedTickets: Annotation<LoggedTicket[]>({ reducer: (_left, right) => right, default: () => [] }),
	decision: Annotation<Decision | null>({ reducer: (_left, right) => right, default: () => null }),
	applied: Annotation<AppliedResult | null>({ reducer: (_left, right) => right, default: () => null }),
	logs: Annotation<string[]>({ reducer: (left, right) => left.concat(right), default: () => [] }),
});

export type AgenticReviewGraphState = typeof ReviewState.State;

export interface GraphDependencies {
	github: GitHubClient;
	linear: LinearClient;
	model: ReviewModelClient;
	config: AgenticReviewConfig;
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
	onTelemetry?: (event: WorkflowTelemetryEvent) => void;
}

export function createAgenticReviewGraph(deps: GraphDependencies) {
	const emit = (event: WorkflowTelemetryEvent): void => {
		deps.onTelemetry?.({ ...event, timestamp: event.timestamp ?? new Date().toISOString() });
	};
	const stageStarted = (stage: WorkflowStage, message: string, data?: Record<string, unknown>): void =>
		emit({ type: "stage_started", stage, message, data });
	const stageProgress = (stage: WorkflowStage, message: string, data?: Record<string, unknown>): void =>
		emit({ type: "stage_progress", stage, message, data });
	const stageCompleted = (stage: WorkflowStage, message: string, data?: Record<string, unknown>): void =>
		emit({ type: "stage_completed", stage, message, data });
	const progress = (message: string): string[] => {
		deps.onProgress?.(message);
		return [message];
	};
	const streamModelDelta = (stage: WorkflowStage, source: string) =>
		createModelDeltaEmitter(
			(delta) => {
				emit({
					type: "model_delta",
					stage,
					message: `${source} ${delta.kind} stream`,
					data: { source, kind: delta.kind, delta: delta.delta },
				});
			},
			(kind, policy, limit) => {
				const message =
					policy === "omitted"
						? `${source} ${kind} stream omitted from dashboard telemetry`
						: `${source} ${kind} stream truncated in dashboard telemetry after ${limit} characters`;
				emit({
					type: "stage_progress",
					stage,
					message,
					data: { source, kind, streamPolicy: policy, limit },
				});
			},
		);

	const gather = async (state: AgenticReviewGraphState) => {
		stageStarted("gather", `Loading GitHub context for PR #${state.prNumber}`, {
			prNumber: state.prNumber,
			repository: deps.github.repo?.nameWithOwner ?? "resolving",
		});
		const context = await deps.github.gatherContext(state.prNumber);
		const getReviewGuidance = (deps.github as Partial<GitHubClient>).getReviewGuidance;
		if (getReviewGuidance)
			context.reviewGuidance = await getReviewGuidance.call(deps.github, context.changedFiles, context.headSha);
		for (const key of extractLinearIssueKeys(context.headRefName, context.title, context.body)) {
			const issue = await deps.linear.lookupIssue(key);
			if (!issue) continue;
			context.linkedIssue = issue;
			context.acceptanceCriteria = [
				context.acceptanceCriteria,
				`Linked Linear issue ${issue.key}: ${issue.title ?? ""}`,
				issue.description ?? "",
			]
				.filter(Boolean)
				.join("\n\n");
			break;
		}
		stageCompleted("gather", `Gathered PR #${context.number} at ${context.headSha}`, {
			repository: context.repo.nameWithOwner,
			headSha: context.headSha,
			changedFiles: context.changedFiles.length,
			diffCharacters: context.diff.length,
			existingComments: context.existingComments.length,
			guidanceFiles: context.reviewGuidance?.map((entry) => entry.path) ?? [],
			linkedIssue: context.linkedIssue?.key,
			acceptanceCriteria: context.acceptanceCriteria,
			files: context.changedFiles.map((file) => file.path),
		});
		return { context, logs: progress(`Gathered PR #${context.number} at ${context.headSha}`) };
	};

	const review = async (state: AgenticReviewGraphState) => {
		const context = requireContext(state);
		const chunks = chunkUnifiedDiff(context.diff, deps.config.review.maxDiffCharsPerChunk);
		stageStarted(
			"review",
			`Starting agentic review across ${chunks.length} diff chunk${chunks.length === 1 ? "" : "s"}`,
			{
				chunks: chunks.length,
				model: `${deps.model.provider}/${deps.model.id}`,
				diffCharacters: context.diff.length,
				files: context.changedFiles.map((file) => file.path),
				existingComments: context.existingComments.length,
			},
		);
		if (chunks.length > deps.config.review.maxChunks) {
			throw new Error(
				`PR diff requires ${chunks.length} review chunks, exceeding review.maxChunks=${deps.config.review.maxChunks}. Increase the limit rather than approving an incomplete review.`,
			);
		}
		const responses: string[] = [];
		for (let index = 0; index < chunks.length; index++) {
			const message = `Reviewing PR #${context.number} diff chunk ${index + 1}/${chunks.length} with ${deps.model.provider}/${deps.model.id}`;
			deps.onProgress?.(message);
			stageProgress("review", message, {
				chunk: index + 1,
				totalChunks: chunks.length,
				characters: chunks[index].length,
			});
			const onDelta = streamModelDelta("review", `review chunk ${index + 1}/${chunks.length}`);
			responses.push(
				await deps.model
					.completeText(
						AGENTIC_REVIEW_SYSTEM_PROMPT,
						buildReviewUserPrompt(context, chunks[index], index, chunks.length),
						deps.signal,
						onDelta,
					)
					.finally(() => onDelta.flush()),
			);
		}
		const reviewText = responses.map((text, index) => `## Diff chunk ${index + 1}\n\n${text}`).join("\n\n");
		stageCompleted("review", `Completed ${chunks.length} agentic review pass${chunks.length === 1 ? "" : "es"}`, {
			chunks: chunks.length,
			responseCharacters: reviewText.length,
			reviewOutput: truncateTelemetry(reviewText, 8_000),
		});
		return {
			reviewText,
			logs: progress(`Completed ${chunks.length} agentic review pass${chunks.length === 1 ? "" : "es"}`),
		};
	};

	const classify = async (state: AgenticReviewGraphState) => {
		const context = requireContext(state);
		stageStarted("classify", "Classifying review findings through the quality gate", {
			reviewCharacters: state.reviewText.length,
			reviewInput: truncateTelemetry(state.reviewText, 8_000),
		});
		const onDelta = streamModelDelta("classify", "quality gate");
		const raw = await deps.model
			.completeJson<{ findings?: unknown[] }>(
				QUALITY_GATE_SYSTEM_PROMPT,
				buildQualityGatePrompt(context, state.reviewText),
				deps.signal,
				onDelta,
			)
			.finally(() => onDelta.flush());
		const findings = validateFindings(raw.findings ?? []);
		const severityCounts = Object.fromEntries(
			["critical", "bug", "nice-to-have", "nit"].map((severity) => [
				severity,
				findings.filter((finding) => finding.severity === severity).length,
			]),
		);
		stageCompleted("classify", `Classified ${findings.length} finding${findings.length === 1 ? "" : "s"}`, {
			severityCounts,
			findings: findings.map((finding) => ({
				id: finding.id,
				severity: finding.severity,
				title: finding.title,
				path: finding.path,
				line: finding.line,
				rationale: finding.rationale,
				hasSuggestion: Boolean(finding.suggestion),
			})),
		});
		if (!findings.some((finding) => finding.severity === "bug")) {
			emit({ type: "stage_skipped", stage: "analyze-bugs", message: "No bugs require merge-impact analysis" });
			emit({ type: "stage_skipped", stage: "log-deferrals", message: "No bug follow-ups require Linear tracking" });
		}
		return {
			findings,
			logs: progress(`Quality gate classified ${findings.length} finding${findings.length === 1 ? "" : "s"}`),
		};
	};

	const analyzeBugs = async (state: AgenticReviewGraphState) => {
		const context = requireContext(state);
		const bugs = state.findings.filter((finding) => finding.severity === "bug");
		stageStarted("analyze-bugs", `Analyzing ${bugs.length} bug${bugs.length === 1 ? "" : "s"} for merge impact`, {
			acceptanceCriteria: context.acceptanceCriteria,
			bugs,
		});
		const onDelta = streamModelDelta("analyze-bugs", "bug analysis");
		const raw = await deps.model
			.completeJson<{ analyses?: unknown[] }>(
				BUG_ANALYSIS_SYSTEM_PROMPT,
				buildBugAnalysisPrompt(context, bugs),
				deps.signal,
				onDelta,
			)
			.finally(() => onDelta.flush());
		const analyses = validateBugAnalyses(raw.analyses ?? [], bugs);
		const followUpIds = new Set(
			analyses.filter((analysis) => analysis.mergeImpact === "follow-up").map((analysis) => analysis.findingId),
		);
		stageCompleted("analyze-bugs", `Analyzed ${bugs.length} bug${bugs.length === 1 ? "" : "s"}`, {
			blocking: analyses.filter((analysis) => analysis.mergeImpact === "blocking").length,
			nonBlocking: analyses.filter((analysis) => analysis.mergeImpact === "non-blocking").length,
			followUp: followUpIds.size,
			analyses: analyses.map((analysis) => ({
				findingId: analysis.findingId,
				impactsAcceptanceCriteria: analysis.impactsAcceptanceCriteria,
				isEdgeCase: analysis.isEdgeCase,
				directlyBlocksMerge: analysis.directlyBlocksMerge,
				mergeImpact: analysis.mergeImpact,
				edgeCaseDefinition: analysis.edgeCaseDefinition,
			})),
		});
		return {
			bugAnalyses: analyses,
			deferrals: bugs.filter((finding) => followUpIds.has(finding.id)),
			logs: progress(
				`Analyzed ${bugs.length} bug${bugs.length === 1 ? "" : "s"}: ${followUpIds.size} follow-up${followUpIds.size === 1 ? "" : "s"} to track`,
			),
		};
	};

	const logDeferrals = async (state: AgenticReviewGraphState) => {
		const context = requireContext(state);
		stageStarted(
			"log-deferrals",
			`Preparing ${state.deferrals.length} Linear follow-up${state.deferrals.length === 1 ? "" : "s"}`,
			{
				deferrals: state.deferrals,
				linearAvailable: deps.linear.available,
				dryRun: deps.config.dryRun,
			},
		);
		if (state.deferrals.length && !deps.config.dryRun) {
			const latest = await deps.github.getPullRequest(context.number);
			if (latest.headSha !== context.headSha) {
				throw new Error(
					`PR #${context.number} changed during review (${context.headSha} -> ${latest.headSha ?? "unknown"}). No Linear follow-ups or GitHub review were posted.`,
				);
			}
		}
		const loggedTickets: LoggedTicket[] = [];
		for (const finding of state.deferrals) {
			const analysis = state.bugAnalyses.find((candidate) => candidate.findingId === finding.id);
			if (!analysis) {
				loggedTickets.push({ findingId: finding.id, title: finding.title, error: "Missing bug analysis" });
				continue;
			}
			if (deps.config.dryRun) {
				loggedTickets.push({ findingId: finding.id, identifier: "DRY-RUN", title: finding.title });
				continue;
			}
			try {
				const ticket = await deps.linear.createDeferredTicket(context, finding, analysis);
				loggedTickets.push(ticket);
				stageProgress("log-deferrals", `Tracked ${finding.id} as ${ticket.identifier ?? ticket.title}`, {
					findingId: finding.id,
					identifier: ticket.identifier,
					url: ticket.url,
				});
			} catch (error) {
				loggedTickets.push({ findingId: finding.id, title: finding.title, error: formatError(error) });
			}
		}
		stageCompleted("log-deferrals", `Completed Linear follow-up tracking`, {
			requested: state.deferrals.length,
			logged: loggedTickets.filter((ticket) => !ticket.error).length,
			failed: loggedTickets.filter((ticket) => ticket.error).length,
			tickets: loggedTickets.map((ticket) => ({
				findingId: ticket.findingId,
				identifier: ticket.identifier,
				url: ticket.url,
				error: ticket.error,
			})),
		});
		return {
			loggedTickets,
			logs: progress(
				state.deferrals.length
					? `Logged ${loggedTickets.filter((ticket) => !ticket.error).length}/${state.deferrals.length} non-blocking follow-up${state.deferrals.length === 1 ? "" : "s"} in Linear`
					: "No non-blocking follow-ups to log",
			),
		};
	};

	const gate = async (state: AgenticReviewGraphState) => {
		stageStarted("gate", "Applying deterministic review policy", {
			findings: state.findings,
			bugAnalyses: state.bugAnalyses,
			loggedTickets: state.loggedTickets,
		});
		const blocking = new Set<string>();
		const reasons: string[] = [];
		for (const finding of state.findings) {
			if (finding.severity === "critical") {
				blocking.add(finding.id);
				reasons.push(`Critical: ${finding.title}`);
				continue;
			}
			if (finding.severity !== "bug") continue;
			const analysis = state.bugAnalyses.find((candidate) => candidate.findingId === finding.id);
			if (!analysis) {
				blocking.add(finding.id);
				reasons.push(`Bug missing merge-impact analysis: ${finding.title}`);
				continue;
			}
			if (analysis.mergeImpact === "blocking") {
				blocking.add(finding.id);
				reasons.push(`Blocking bug: ${finding.title}`);
			}
		}

		const decision = buildDecision(state, [...blocking], reasons);
		stageCompleted("gate", `${decision.event} selected by deterministic quality gate`, {
			event: decision.event,
			blockingFindingIds: decision.blockingFindingIds,
			reasons: decision.reasons,
		});
		return {
			decision,
			logs: progress(`${decision.event} selected by deterministic quality gate`),
		};
	};

	const apply = async (state: AgenticReviewGraphState) => {
		const context = requireContext(state);
		if (!state.decision) throw new Error("Quality gate did not produce a decision");
		stageStarted(
			"apply",
			deps.config.dryRun ? "Simulating GitHub review submission" : "Submitting GitHub review and inline comments",
			{
				event: state.decision.event,
				dryRun: deps.config.dryRun,
				findings: state.findings.map((finding) => ({
					id: finding.id,
					severity: finding.severity,
					path: finding.path,
					line: finding.line,
					hasInlineSuggestion: Boolean(finding.suggestion),
				})),
			},
		);
		if (!deps.config.dryRun) {
			const latest = await deps.github.getPullRequest(context.number);
			if (latest.headSha !== context.headSha) {
				throw new Error(
					`PR #${context.number} changed during review (${context.headSha} -> ${latest.headSha ?? "unknown"}). The stale review was not posted; rerun it against the new head.`,
				);
			}
		}
		const comments = state.findings
			.map(toInlineCandidate)
			.filter((candidate): candidate is InlineCandidate => Boolean(candidate));
		const applied = await deps.github.applyReview(context, state.decision, comments, deps.config);
		stageCompleted("apply", applied.dryRun ? "Dry-run GitHub application completed" : "GitHub review submitted", {
			event: state.decision.event,
			candidateComments: comments.length,
			postedComments: applied.postedComments,
			commentFailures: applied.commentFailures,
			reviewSubmitted: applied.reviewSubmitted,
			dryRun: applied.dryRun,
		});
		return {
			applied,
			logs: progress(
				applied.dryRun
					? `Dry run complete for PR #${context.number}; no GitHub or Linear writes were made`
					: `Applied review to PR #${context.number}; posted ${applied.postedComments} inline comment${applied.postedComments === 1 ? "" : "s"}`,
			),
		};
	};

	return new StateGraph(ReviewState)
		.addNode("gather", gather)
		.addNode("review", review)
		.addNode("classify", classify)
		.addNode("analyzeBugs", analyzeBugs)
		.addNode("logDeferrals", logDeferrals)
		.addNode("gate", gate)
		.addNode("apply", apply)
		.addEdge(START, "gather")
		.addEdge("gather", "review")
		.addEdge("review", "classify")
		.addConditionalEdges(
			"classify",
			(state) => (state.findings.some((finding) => finding.severity === "bug") ? "bugs" : "clean"),
			{
				bugs: "analyzeBugs",
				clean: "gate",
			},
		)
		.addEdge("analyzeBugs", "logDeferrals")
		.addEdge("logDeferrals", "gate")
		.addEdge("gate", "apply")
		.addEdge("apply", END)
		.compile();
}

function requireContext(state: AgenticReviewGraphState): PrContext {
	if (!state.context) throw new Error("PR context is not available");
	return state.context;
}

const MODEL_DELTA_CHUNK_CHARS = 2_000;
const MODEL_STREAM_CHAR_LIMITS: Record<ReviewModelStreamDelta["kind"], number> = {
	// Final answer text is useful for live observability but still bounded so a
	// verbose model cannot make dashboard snapshots grow without limit.
	text: 24_000,
	// Reasoning/thinking streams can dwarf the final answer on high-reasoning
	// models. The workflow still consumes the full model response internally; the
	// dashboard intentionally does not retain private/huge reasoning tokens.
	thinking: 0,
	tool: 4_000,
};

type StreamTelemetryPolicy = "omitted" | "truncated";
type ModelDeltaEmitter = ((delta: ReviewModelStreamDelta) => void) & { flush: () => void };

function createModelDeltaEmitter(
	emit: (delta: ReviewModelStreamDelta) => void,
	onPolicyApplied?: (kind: ReviewModelStreamDelta["kind"], policy: StreamTelemetryPolicy, limit: number) => void,
): ModelDeltaEmitter {
	const emittedChars: Record<ReviewModelStreamDelta["kind"], number> = { text: 0, thinking: 0, tool: 0 };
	const buffers: Record<ReviewModelStreamDelta["kind"], string> = { text: "", thinking: "", tool: "" };
	const policyNotifications = new Set<string>();
	const notifyPolicy = (kind: ReviewModelStreamDelta["kind"], policy: StreamTelemetryPolicy, limit: number) => {
		const key = `${kind}:${policy}`;
		if (policyNotifications.has(key)) return;
		policyNotifications.add(key);
		onPolicyApplied?.(kind, policy, limit);
	};
	const flushKind = (kind: ReviewModelStreamDelta["kind"]): void => {
		const buffered = buffers[kind];
		if (!buffered) return;
		buffers[kind] = "";
		for (let offset = 0; offset < buffered.length; offset += MODEL_DELTA_CHUNK_CHARS) {
			emit({ kind, delta: buffered.slice(offset, offset + MODEL_DELTA_CHUNK_CHARS) });
		}
	};

	const onDelta = ((delta: ReviewModelStreamDelta) => {
		if (!delta.delta) return;
		const limit = MODEL_STREAM_CHAR_LIMITS[delta.kind];
		if (limit <= 0) {
			notifyPolicy(delta.kind, "omitted", limit);
			return;
		}

		const remaining = limit - emittedChars[delta.kind];
		if (remaining <= 0) {
			notifyPolicy(delta.kind, "truncated", limit);
			return;
		}

		const retained = delta.delta.length > remaining ? delta.delta.slice(0, remaining) : delta.delta;
		emittedChars[delta.kind] += retained.length;
		buffers[delta.kind] += retained;
		while (buffers[delta.kind].length >= MODEL_DELTA_CHUNK_CHARS) {
			emit({ ...delta, delta: buffers[delta.kind].slice(0, MODEL_DELTA_CHUNK_CHARS) });
			buffers[delta.kind] = buffers[delta.kind].slice(MODEL_DELTA_CHUNK_CHARS);
		}
		if (retained.length < delta.delta.length) {
			notifyPolicy(delta.kind, "truncated", limit);
		}
	}) as ModelDeltaEmitter;
	onDelta.flush = () => {
		flushKind("text");
		flushKind("tool");
		flushKind("thinking");
	};
	return onDelta;
}

function validateFindings(values: unknown[]): Finding[] {
	const findings: Finding[] = [];
	const usedIds = new Set<string>();
	for (let index = 0; index < values.length; index++) {
		const value = asRecord(values[index]);
		const severity = stringValue(value.severity);
		if (!severity || !["critical", "bug", "nice-to-have", "nit"].includes(severity)) {
			throw new Error(`Quality gate returned invalid severity for finding ${index + 1}: ${severity ?? "missing"}`);
		}
		const title = stringValue(value.title);
		const rationale = stringValue(value.rationale);
		if (!title || !rationale) throw new Error(`Quality gate finding ${index + 1} is missing title or rationale`);
		let id = stringValue(value.id) || `finding-${index + 1}`;
		if (usedIds.has(id)) id = `${id}-${index + 1}`;
		usedIds.add(id);
		const line = numberValue(value.line);
		findings.push({
			id,
			severity: severity as Finding["severity"],
			title,
			path: stringValue(value.path),
			line: line && line > 0 ? Math.floor(line) : undefined,
			rationale,
			suggestion: normalizeSuggestion(stringValue(value.suggestion)),
		});
	}
	return findings;
}

function validateBugAnalyses(values: unknown[], bugs: Finding[]): BugAnalysis[] {
	const byFinding = new Map<string, BugAnalysis>();
	for (const item of values) {
		const value = asRecord(item);
		const findingId = stringValue(value.findingId);
		if (!findingId || !bugs.some((bug) => bug.id === findingId)) continue;
		const impactsAcceptanceCriteria = Boolean(value.impactsAcceptanceCriteria);
		const isEdgeCase = Boolean(value.isEdgeCase);
		const directlyBlocksMerge = Boolean(value.directlyBlocksMerge);
		const legacyDisposition = stringValue(value.disposition);
		let mergeImpact = normalizeMergeImpact(stringValue(value.mergeImpact));
		if (!mergeImpact && legacyDisposition) mergeImpact = legacyDisposition === "deferred" ? "follow-up" : "blocking";
		if (!mergeImpact) mergeImpact = "blocking";
		if (directlyBlocksMerge) mergeImpact = "blocking";
		byFinding.set(findingId, {
			findingId,
			impactsAcceptanceCriteria,
			isEdgeCase,
			edgeCaseDefinition: isEdgeCase
				? stringValue(value.edgeCaseDefinition) || "Edge condition not adequately defined"
				: undefined,
			directlyBlocksMerge: directlyBlocksMerge || mergeImpact === "blocking",
			mergeImpact,
			disposition: mergeImpact === "blocking" ? "critical" : "deferred",
			reasoning: stringValue(value.reasoning) || "No reasoning supplied; treated conservatively as blocking.",
		});
	}
	return bugs.map(
		(bug) =>
			byFinding.get(bug.id) ?? {
				findingId: bug.id,
				impactsAcceptanceCriteria: true,
				isEdgeCase: false,
				directlyBlocksMerge: true,
				mergeImpact: "blocking",
				disposition: "critical",
				reasoning: "The bug analysis was missing, so the workflow treated it as blocking.",
			},
	);
}

function buildDecision(state: AgenticReviewGraphState, blockingFindingIds: string[], reasons: string[]): Decision {
	const tickets = state.loggedTickets.filter((ticket) => !ticket.error);
	const ticketFailures = state.loggedTickets.filter((ticket) => ticket.error);
	if (blockingFindingIds.length) {
		return {
			event: "REQUEST_CHANGES",
			blockingFindingIds,
			reasons,
			summary: formatReviewSummary("Changes requested", state, reasons, tickets, ticketFailures),
		};
	}
	if (state.findings.length || tickets.length || ticketFailures.length) {
		const nonBlockingReasons = state.findings.map((finding) => {
			const analysis =
				finding.severity === "bug"
					? state.bugAnalyses.find((candidate) => candidate.findingId === finding.id)
					: undefined;
			return analysis
				? `${finding.severity} (${analysis.mergeImpact}): ${finding.title}`
				: `${finding.severity}: ${finding.title}`;
		});
		return {
			event: "APPROVE",
			blockingFindingIds: [],
			reasons: nonBlockingReasons,
			summary: formatReviewSummary("Approved with comments", state, nonBlockingReasons, tickets, ticketFailures),
		};
	}
	return {
		event: "APPROVE",
		blockingFindingIds: [],
		reasons: [],
		summary: [
			"Automated agentic review found no actionable issues. Ready to merge.",
			"",
			"_Generated by the pi LangGraph agentic-review workflow._",
		].join("\n"),
	};
}

function formatReviewSummary(
	title: string,
	state: AgenticReviewGraphState,
	reasons: string[],
	tickets: LoggedTicket[],
	ticketFailures: LoggedTicket[] = [],
): string {
	return [
		`## ${title}`,
		"",
		...reasons.map((reason) => `- ${reason}`),
		tickets.length ? "" : undefined,
		tickets.length ? "### Tracked follow-ups" : undefined,
		...tickets.map(
			(ticket) =>
				`- ${ticket.url ? `[${ticket.identifier ?? ticket.title}](${ticket.url})` : (ticket.identifier ?? ticket.title)}`,
		),
		ticketFailures.length ? "" : undefined,
		ticketFailures.length ? "### Follow-up tracking failures" : undefined,
		...ticketFailures.map((ticket) => `- ${ticket.title}: ${ticket.error}`),
		"",
		"_Generated by the pi LangGraph agentic-review workflow._",
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");
}

function toInlineCandidate(finding: Finding): InlineCandidate | undefined {
	if (!finding.path || !finding.line || !finding.suggestion) return undefined;
	return {
		path: finding.path,
		line: finding.line,
		body: [
			`**${finding.severity} — ${finding.title}**`,
			"",
			finding.rationale,
			"",
			"```suggestion",
			finding.suggestion,
			"```",
		].join("\n"),
	};
}

function chunkUnifiedDiff(diff: string, maxChars: number): string[] {
	if (!diff.trim()) return ["(empty diff)"];
	const sections = diff.split(/\n(?=diff --git )/g);
	const chunks: string[] = [];
	let current = "";
	for (const section of sections) {
		if (section.length > maxChars) {
			if (current) {
				chunks.push(current);
				current = "";
			}
			for (let offset = 0; offset < section.length; offset += maxChars)
				chunks.push(section.slice(offset, offset + maxChars));
			continue;
		}
		const next = current ? `${current}\n${section}` : section;
		if (next.length > maxChars) {
			chunks.push(current);
			current = section;
		} else {
			current = next;
		}
	}
	if (current) chunks.push(current);
	return chunks;
}

function normalizeMergeImpact(value: string | undefined): BugAnalysis["mergeImpact"] | undefined {
	if (value === "blocking" || value === "non-blocking" || value === "follow-up") return value;
	return undefined;
}

function normalizeSuggestion(value: string | undefined): string | undefined {
	if (!value) return undefined;
	return value
		.replace(/^```suggestion\s*\n?/i, "")
		.replace(/\n?```$/, "")
		.trim();
}

function asRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	return Number.isFinite(parsed) ? parsed : undefined;
}

function truncateTelemetry(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max)}\n… [truncated ${value.length - max} characters]`;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
