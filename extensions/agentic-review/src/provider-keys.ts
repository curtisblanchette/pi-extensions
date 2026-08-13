import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

export type ConfigurableProvider = "anthropic" | "openai";

interface StoredProviderKeys {
	version: 1;
	anthropic?: string;
	openai?: string;
}

export interface ProviderKeyStatus {
	anthropic: boolean;
	openai: boolean;
}

/** Review-specific provider keys, stored separately from displayable config. */
export class ProviderKeyStore {
	private stored: StoredProviderKeys;

	constructor(private path = resolve(homedir(), ".pi/agent/agentic-review-provider-keys.json")) {
		this.stored = this.read();
	}

	get(provider: ConfigurableProvider): string | undefined {
		return this.stored[provider];
	}

	status(): ProviderKeyStatus {
		return { anthropic: Boolean(this.stored.anthropic), openai: Boolean(this.stored.openai) };
	}

	set(provider: ConfigurableProvider, apiKey: string): ProviderKeyStatus {
		const normalized = apiKey.trim();
		if (normalized.length < 10 || /\s/.test(normalized)) throw new Error(`${provider} API key format is invalid`);
		this.stored[provider] = normalized;
		this.persist();
		return this.status();
	}

	remove(provider: ConfigurableProvider): ProviderKeyStatus {
		delete this.stored[provider];
		this.persist();
		return this.status();
	}

	private read(): StoredProviderKeys {
		if (!existsSync(this.path)) return { version: 1 };
		try {
			const parsed = JSON.parse(readFileSync(this.path, "utf8")) as StoredProviderKeys;
			return parsed.version === 1 ? parsed : { version: 1 };
		} catch (error) {
			throw new Error(
				`Could not read provider keys ${this.path}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private persist(): void {
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		writeFileSync(this.path, `${JSON.stringify(this.stored, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		chmodSync(this.path, 0o600);
	}
}

export function parseConfigurableProvider(value: unknown): ConfigurableProvider {
	if (value === "anthropic" || value === "openai") return value;
	throw new Error("Provider must be anthropic or openai");
}
