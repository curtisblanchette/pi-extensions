import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Decision, GitHubRepo } from "./types.ts";

interface ReviewRecord {
	headSha: string;
	completedAt: string;
	event: string;
}

interface PersistedState {
	version: 1;
	reviews: Record<string, Record<string, ReviewRecord>>;
}

export class ReviewStateStore {
	constructor(private path: string) {}

	async hasProcessed(repo: GitHubRepo, prNumber: number, headSha: string): Promise<boolean> {
		const state = await this.read();
		return state.reviews[repoKey(repo)]?.[String(prNumber)]?.headSha === headSha;
	}

	async record(repo: GitHubRepo, prNumber: number, headSha: string, decision: Decision): Promise<void> {
		const state = await this.read();
		state.reviews[repoKey(repo)] ??= {};
		state.reviews[repoKey(repo)][String(prNumber)] = {
			headSha,
			completedAt: new Date().toISOString(),
			event: decision.event,
		};
		await mkdir(dirname(this.path), { recursive: true });
		const temp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
		await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
		await rename(temp, this.path);
	}

	private async read(): Promise<PersistedState> {
		if (!existsSync(this.path)) return { version: 1, reviews: {} };
		try {
			const parsed = JSON.parse(await readFile(this.path, "utf8")) as PersistedState;
			return parsed.version === 1 && parsed.reviews ? parsed : { version: 1, reviews: {} };
		} catch (error) {
			throw new Error(`Failed to read agentic-review state ${this.path}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

function repoKey(repo: GitHubRepo): string {
	return `${repo.host}/${repo.nameWithOwner}`;
}
