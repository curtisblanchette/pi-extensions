import type {
	BeginRunInput,
	WatcherStatus,
	WorkflowRunSnapshot,
	WorkflowTelemetryEvent,
} from "./telemetry.ts";
import type { WorkflowResult } from "./types.ts";

type DashboardSubscriber = (run: WorkflowRunSnapshot) => void;
type WatcherSubscriber = (status: WatcherStatus) => void;

const MAX_MODEL_DELTA_CHARS_PER_EVENT = 2_000;
const MAX_MODEL_DELTA_CHARS_PER_RUN = 120_000;
const MAX_EVENTS_PER_RUN = 1_200;

/** In-memory, bounded run history shared by the pi extension and local Web UI. */
export class WorkflowDashboard {
	private runs = new Map<string, WorkflowRunSnapshot>();
	private subscribers = new Set<DashboardSubscriber>();
	private watcherSubscribers = new Set<WatcherSubscriber>();
	private watcherStatus: WatcherStatus = { running: false, polling: false };
	private modelDeltaCharsByRun = new Map<string, number>();
	private modelDeltaCapNotified = new Set<string>();
	private sequence = 0;

	constructor(private maxRuns = 100) {}

	setMaxRuns(maxRuns: number): void {
		this.maxRuns = Math.max(10, Math.floor(maxRuns));
		this.prune();
	}

	begin(input: BeginRunInput): WorkflowRunSnapshot {
		const now = new Date().toISOString();
		const id = `${Date.now().toString(36)}-${input.prNumber}-${Math.random().toString(36).slice(2, 8)}`;
		const run: WorkflowRunSnapshot = {
			id,
			source: input.source,
			status: "queued",
			prNumber: input.prNumber,
			repository: input.repository,
			cwd: input.cwd,
			startedAt: now,
			dryRun: input.dryRun,
			events: [],
		};
		this.runs.set(id, run);
		this.prune();
		this.publish(run);
		return clone(run);
	}

	updateMetadata(id: string, metadata: { repository?: string; model?: string; dryRun?: boolean }): void {
		const run = this.runs.get(id);
		if (!run) return;
		if (metadata.repository !== undefined) run.repository = metadata.repository;
		if (metadata.model !== undefined) run.model = metadata.model;
		if (metadata.dryRun !== undefined) run.dryRun = metadata.dryRun;
		this.publish(run);
	}

	record(id: string, event: WorkflowTelemetryEvent): void {
		const run = this.runs.get(id);
		if (!run) return;
		const timestamp = event.timestamp ?? new Date().toISOString();
		const prepared = this.prepareEvent(id, event);
		if (!prepared) return;
		run.events.push({ ...prepared, timestamp, sequence: ++this.sequence });
		if (typeof prepared.data?.model === "string") run.model = prepared.data.model;
		if (typeof prepared.data?.dryRun === "boolean") run.dryRun = prepared.data.dryRun;
		if (prepared.type === "stage_started") {
			run.status = "running";
			run.currentStage = prepared.stage;
		}
		this.enforceEventLimit(run);
		this.publish(run);
	}

	complete(id: string, result: WorkflowResult): void {
		const run = this.runs.get(id);
		if (!run) return;
		this.modelDeltaCharsByRun.delete(id);
		this.modelDeltaCapNotified.delete(id);
		run.status = result.skipped ? "skipped" : "succeeded";
		run.completedAt = new Date().toISOString();
		run.currentStage = undefined;
		run.result = result;
		run.events.push({
			type: "log",
			message: result.skipped ? result.skipped : `Workflow completed with ${result.decision?.event ?? "no decision"}`,
			timestamp: run.completedAt,
			sequence: ++this.sequence,
		});
		this.publish(run);
	}

	fail(id: string, error: unknown): void {
		const run = this.runs.get(id);
		if (!run) return;
		this.modelDeltaCharsByRun.delete(id);
		this.modelDeltaCapNotified.delete(id);
		run.status = "failed";
		run.completedAt = new Date().toISOString();
		run.currentStage = undefined;
		run.error = error instanceof Error ? error.message : String(error);
		run.events.push({
			type: "log",
			message: run.error,
			data: { level: "error" },
			timestamp: run.completedAt,
			sequence: ++this.sequence,
		});
		this.publish(run);
	}

	list(): WorkflowRunSnapshot[] {
		return [...this.runs.values()]
			.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
			.map(clone);
	}

	get(id: string): WorkflowRunSnapshot | undefined {
		const run = this.runs.get(id);
		return run ? clone(run) : undefined;
	}

	getWatcherStatus(): WatcherStatus {
		return clone(this.watcherStatus);
	}

	setWatcherStatus(update: Partial<WatcherStatus>): void {
		this.watcherStatus = { ...this.watcherStatus, ...update };
		const snapshot = clone(this.watcherStatus);
		for (const subscriber of this.watcherSubscribers) subscriber(snapshot);
	}

	subscribe(subscriber: DashboardSubscriber): () => void {
		this.subscribers.add(subscriber);
		return () => this.subscribers.delete(subscriber);
	}

	subscribeWatcher(subscriber: WatcherSubscriber): () => void {
		this.watcherSubscribers.add(subscriber);
		return () => this.watcherSubscribers.delete(subscriber);
	}

	private prepareEvent(id: string, event: WorkflowTelemetryEvent): WorkflowTelemetryEvent | undefined {
		if (event.type !== "model_delta") return event;
		const data = event.data ?? {};
		const delta = typeof data.delta === "string" ? data.delta : "";
		if (!delta) return event;

		const used = this.modelDeltaCharsByRun.get(id) ?? 0;
		const remaining = MAX_MODEL_DELTA_CHARS_PER_RUN - used;
		if (remaining <= 0) {
			if (this.modelDeltaCapNotified.has(id)) return undefined;
			this.modelDeltaCapNotified.add(id);
			return {
				type: "log",
				stage: event.stage,
				message: `Model stream telemetry capped at ${MAX_MODEL_DELTA_CHARS_PER_RUN} characters; later deltas are not retained`,
				data: { level: "warning", maxModelStreamChars: MAX_MODEL_DELTA_CHARS_PER_RUN },
			};
		}

		const maxChars = Math.min(MAX_MODEL_DELTA_CHARS_PER_EVENT, remaining);
		const retained = delta.length > maxChars ? delta.slice(0, maxChars) : delta;
		this.modelDeltaCharsByRun.set(id, used + retained.length);
		return {
			...event,
			data: {
				...data,
				delta: retained,
				truncated: data.truncated === true || retained.length < delta.length,
			},
		};
	}

	private enforceEventLimit(run: WorkflowRunSnapshot): void {
		if (run.events.length <= MAX_EVENTS_PER_RUN) return;
		let overflow = run.events.length - MAX_EVENTS_PER_RUN;
		const kept: typeof run.events = [];
		for (const event of run.events) {
			if (overflow > 0 && event.type === "model_delta") {
				overflow--;
				continue;
			}
			kept.push(event);
		}
		if (overflow > 0) kept.splice(0, overflow);
		run.events = kept;
	}

	private publish(run: WorkflowRunSnapshot): void {
		const snapshot = clone(run);
		for (const subscriber of this.subscribers) subscriber(snapshot);
	}

	private prune(): void {
		if (this.runs.size <= this.maxRuns) return;
		const oldest = [...this.runs.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
		for (const run of oldest.slice(0, this.runs.size - this.maxRuns)) {
			this.runs.delete(run.id);
			this.modelDeltaCharsByRun.delete(run.id);
			this.modelDeltaCapNotified.delete(run.id);
		}
	}
}

function clone<T>(value: T): T {
	return structuredClone(value);
}
