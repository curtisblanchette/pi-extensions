import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

interface StoredRuntimeSettings {
	version: 1;
	forceDryRun?: boolean;
}

export interface RuntimeSettingsStatus {
	forceDryRun: boolean;
}

/** Non-secret, user-controlled runtime settings from the Web UI. */
export class RuntimeSettingsStore {
	private stored: StoredRuntimeSettings;

	constructor(private path = resolve(homedir(), ".pi/agent/agentic-review-settings.json")) {
		this.stored = this.read();
	}

	status(): RuntimeSettingsStatus {
		return { forceDryRun: this.stored.forceDryRun === true };
	}

	setForceDryRun(forceDryRun: boolean): RuntimeSettingsStatus {
		this.stored.forceDryRun = forceDryRun;
		this.persist();
		return this.status();
	}

	private read(): StoredRuntimeSettings {
		if (!existsSync(this.path)) return { version: 1, forceDryRun: false };
		try {
			const parsed = JSON.parse(readFileSync(this.path, "utf8")) as StoredRuntimeSettings;
			return parsed.version === 1 ? { version: 1, forceDryRun: parsed.forceDryRun === true } : { version: 1, forceDryRun: false };
		} catch (error) {
			throw new Error(`Could not read agentic-review settings ${this.path}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private persist(): void {
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		writeFileSync(this.path, `${JSON.stringify(this.stored, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		chmodSync(this.path, 0o600);
	}
}
