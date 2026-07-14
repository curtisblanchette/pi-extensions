import type { WorkflowResult } from "./types.ts";

export type WorkflowStage = "gather" | "review" | "classify" | "analyze-bugs" | "log-deferrals" | "gate" | "apply";
export type WorkflowEventType = "stage_started" | "stage_progress" | "stage_completed" | "stage_skipped" | "log";

export interface WorkflowTelemetryEvent {
	type: WorkflowEventType;
	stage?: WorkflowStage;
	message: string;
	data?: Record<string, unknown>;
	timestamp?: string;
}

export interface RunEvent extends WorkflowTelemetryEvent {
	sequence: number;
	timestamp: string;
}

export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "skipped";
export type RunSource = "manual" | "poller";

export interface WorkflowRunSnapshot {
	id: string;
	source: RunSource;
	status: RunStatus;
	prNumber: number;
	repository?: string;
	cwd: string;
	startedAt: string;
	completedAt?: string;
	currentStage?: WorkflowStage;
	model?: string;
	dryRun?: boolean;
	events: RunEvent[];
	result?: WorkflowResult;
	error?: string;
}

export interface BeginRunInput {
	source: RunSource;
	prNumber: number;
	repository?: string;
	cwd: string;
	dryRun?: boolean;
}

export interface WatcherStatus {
	running: boolean;
	polling: boolean;
	intervalMs?: number;
	triggerLabel?: string;
	repository?: string;
	lastPollStartedAt?: string;
	lastPollCompletedAt?: string;
	lastPollError?: string;
	waitingFor?: string;
	candidateCount?: number;
}
