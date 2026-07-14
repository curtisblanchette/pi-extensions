import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { Provider } from "./types.ts";
import { PR_LABELS } from "./labels.ts";

export interface AgenticReviewConfig {
	polling: {
		enabled: boolean;
		intervalMs: number;
	};
	webUi: {
		enabled: boolean;
		port: number;
		openOnStart: boolean;
		maxRuns: number;
	};
	model: {
		/** Omit provider/id to use pi's currently selected model. */
		provider?: Provider;
		id?: string;
		temperature: number;
		maxTokens: number;
		apiKeys: {
			anthropic?: string;
			openai?: string;
		};
		ollama: {
			baseUrl: string;
			apiKey: string;
			contextWindow: number;
		};
		llamaServer: {
			baseUrl: string;
			apiKey: string;
			contextWindow: number;
		};
	};
	review: {
		maxDiffCharsPerChunk: number;
		maxChunks: number;
		postInlineComments: boolean;
	};
	github: {
		triggerLabel: string;
		/** Optional repository selected in Settings, in owner/name form. */
		repository?: string;
		/** Runtime-only token read from GitHub CLI auth; always redacted from displayed configuration. */
		accessToken?: string;
	};
	linear: {
		enabled: boolean;
		endpoint: string;
		apiKey?: string;
		/** Linear team UUID, key, or exact name. */
		team?: string;
		/** Optional Linear project UUID for deferred tickets. */
		projectId?: string;
		/** Optional Linear issue-label UUIDs for deferred tickets. */
		labelIds: string[];
	};
	dryRun: boolean;
	stateFile: string;
}

export interface LoadedConfig {
	config: AgenticReviewConfig;
	paths: {
		user: string;
		project: string;
		loaded: string[];
	};
}

const DEFAULT_CONFIG: AgenticReviewConfig = {
	polling: {
		// Opt-in because enabling this performs model calls and GitHub writes in the
		// background for every repository opened in pi.
		enabled: false,
		intervalMs: 180_000,
	},
	webUi: {
		enabled: false,
		port: 4317,
		openOnStart: false,
		maxRuns: 100,
	},
	model: {
		temperature: 0.1,
		maxTokens: 8_192,
		apiKeys: {},
		ollama: {
			baseUrl: "http://127.0.0.1:11434/v1",
			apiKey: "ollama",
			contextWindow: 262_144,
		},
		llamaServer: {
			baseUrl: "http://127.0.0.1:8080/v1",
			apiKey: "local",
			contextWindow: 32_768,
		},
	},
	review: {
		maxDiffCharsPerChunk: 60_000,
		maxChunks: 20,
		postInlineComments: true,
	},
	github: {
		triggerLabel: PR_LABELS.readyForReview,
	},
	linear: {
		enabled: true,
		endpoint: "https://api.linear.app/graphql",
		labelIds: [],
	},
	dryRun: false,
	stateFile: ".pi/agentic-review-state.json",
};

export function loadConfig(cwd: string): LoadedConfig {
	const userPath = resolve(homedir(), ".pi/agent/agentic-review.json");
	const projectPath = resolve(cwd, ".pi/agentic-review.json");
	const loaded: string[] = [];
	let merged: unknown = structuredClone(DEFAULT_CONFIG);

	for (const path of [userPath, projectPath]) {
		if (!existsSync(path)) continue;
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		merged = deepMerge(merged, parsed);
		loaded.push(path);
	}

	merged = deepMerge(merged, envOverrides());
	const config = normalizeConfig(merged as Partial<AgenticReviewConfig>, cwd);
	return { config, paths: { user: userPath, project: projectPath, loaded } };
}

export function withModelOverride(config: AgenticReviewConfig, value: string | undefined): AgenticReviewConfig {
	if (!value?.trim()) return config;
	const parsed = parseModelSpec(value);
	return {
		...config,
		model: {
			...config.model,
			provider: parsed.provider,
			id: parsed.id,
		},
	};
}

export function parseModelSpec(value: string): { provider: Provider; id: string } {
	const [rawProvider, ...idParts] = value.trim().split("/");
	const provider = normalizeProvider(rawProvider);
	const id = idParts.join("/").trim();
	if (!provider || !id) {
		throw new Error("Model must use provider/model format: anthropic/<id>, openai/<id>, ollama/<id>, or llama.server/<id>");
	}
	return { provider, id };
}

export function redactConfig(config: AgenticReviewConfig): unknown {
	return {
		...config,
		model: {
			...config.model,
			apiKeys: {
				anthropic: config.model.apiKeys.anthropic ? "[configured]" : "[not configured]",
				openai: config.model.apiKeys.openai ? "[configured]" : "[not configured]",
			},
			ollama: {
				...config.model.ollama,
				apiKey: config.model.ollama.apiKey ? "[configured]" : "[not configured]",
			},
			llamaServer: {
				...config.model.llamaServer,
				apiKey: config.model.llamaServer.apiKey ? "[configured]" : "[not configured]",
			},
		},
		github: {
			...config.github,
			accessToken: config.github.accessToken ? "[configured]" : "[not configured]",
		},
		linear: {
			...config.linear,
			apiKey: config.linear.apiKey ? "[configured]" : "[not configured]",
		},
	};
}

function normalizeConfig(input: Partial<AgenticReviewConfig>, cwd: string): AgenticReviewConfig {
	const merged = input as AgenticReviewConfig;
	if (merged.model.provider) {
		const provider = normalizeProvider(merged.model.provider);
		if (!provider) throw new Error(`Unsupported agentic-review provider: ${merged.model.provider}`);
		merged.model.provider = provider;
	}
	if (merged.model.provider && !merged.model.id) {
		throw new Error(`agentic-review model.id is required when model.provider is ${merged.model.provider}`);
	}
	if (!Number.isFinite(merged.polling.intervalMs) || merged.polling.intervalMs < 15_000) {
		throw new Error("agentic-review polling.intervalMs must be at least 15000");
	}
	if (!Number.isInteger(merged.webUi.port) || merged.webUi.port < 0 || merged.webUi.port > 65_535) {
		throw new Error("agentic-review webUi.port must be an integer from 0 to 65535");
	}
	if (!Number.isInteger(merged.webUi.maxRuns) || merged.webUi.maxRuns < 10 || merged.webUi.maxRuns > 1_000) {
		throw new Error("agentic-review webUi.maxRuns must be an integer from 10 to 1000");
	}
	if (!Number.isFinite(merged.review.maxDiffCharsPerChunk) || merged.review.maxDiffCharsPerChunk < 4_000) {
		throw new Error("agentic-review review.maxDiffCharsPerChunk must be at least 4000");
	}
	if (!Number.isInteger(merged.review.maxChunks) || merged.review.maxChunks < 1) {
		throw new Error("agentic-review review.maxChunks must be a positive integer");
	}
	if (merged.github.repository && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(merged.github.repository)) {
		throw new Error("agentic-review github.repository must use owner/name format");
	}
	merged.stateFile = resolve(cwd, merged.stateFile);
	return merged;
}

function envOverrides(): unknown {
	const modelSpec = process.env.AGENTIC_REVIEW_MODEL?.trim();
	const modelProvider = process.env.AGENTIC_REVIEW_PROVIDER?.trim();
	const modelId = process.env.AGENTIC_REVIEW_MODEL_ID?.trim();
	const parsedModel = modelSpec ? parseModelSpec(modelSpec) : undefined;
	const provider = parsedModel?.provider ?? (modelProvider ? normalizeProvider(modelProvider) : undefined);

	return compactObject({
		polling: compactObject({
			enabled: parseBoolean(process.env.AGENTIC_REVIEW_ENABLED),
			intervalMs: parseNumber(process.env.AGENTIC_REVIEW_POLL_INTERVAL_MS),
		}),
		webUi: compactObject({
			enabled: parseBoolean(process.env.AGENTIC_REVIEW_UI_ENABLED),
			port: parseNumber(process.env.AGENTIC_REVIEW_UI_PORT),
			openOnStart: parseBoolean(process.env.AGENTIC_REVIEW_UI_OPEN_ON_START),
			maxRuns: parseNumber(process.env.AGENTIC_REVIEW_UI_MAX_RUNS),
		}),
		model: compactObject({
			provider,
			id: parsedModel?.id ?? modelId,
			temperature: parseNumber(process.env.AGENTIC_REVIEW_TEMPERATURE),
			maxTokens: parseNumber(process.env.AGENTIC_REVIEW_MAX_TOKENS),
			ollama: compactObject({
				baseUrl: (process.env.OLLAMA_BASE_URL ?? process.env.OLLAMA_URL)?.trim(),
				apiKey: process.env.OLLAMA_API_KEY?.trim(),
				contextWindow: parseNumber(process.env.OLLAMA_CONTEXT_WINDOW),
			}),
			llamaServer: compactObject({
				baseUrl: process.env.LLAMA_SERVER_URL?.trim(),
				apiKey: process.env.LLAMA_SERVER_API_KEY?.trim(),
				contextWindow: parseNumber(process.env.LLAMA_SERVER_CONTEXT_WINDOW),
			}),
		}),
		review: compactObject({
			maxDiffCharsPerChunk: parseNumber(process.env.AGENTIC_REVIEW_DIFF_CHUNK_CHARS),
			maxChunks: parseNumber(process.env.AGENTIC_REVIEW_MAX_DIFF_CHUNKS),
			postInlineComments: parseBoolean(process.env.AGENTIC_REVIEW_POST_INLINE_COMMENTS),
		}),
		github: compactObject({
			repository: process.env.AGENTIC_REVIEW_GITHUB_REPOSITORY?.trim(),
		}),
		linear: compactObject({
			enabled: parseBoolean(process.env.AGENTIC_REVIEW_LINEAR_ENABLED),
			endpoint: process.env.AGENTIC_REVIEW_LINEAR_ENDPOINT?.trim(),
			apiKey: process.env.LINEAR_API_KEY?.trim(),
			team: process.env.AGENTIC_REVIEW_LINEAR_TEAM?.trim(),
			projectId: process.env.AGENTIC_REVIEW_LINEAR_PROJECT_ID?.trim(),
			labelIds: parseList(process.env.AGENTIC_REVIEW_LINEAR_LABEL_IDS),
		}),
		dryRun: parseBoolean(process.env.AGENTIC_REVIEW_DRY_RUN),
		stateFile: process.env.AGENTIC_REVIEW_STATE_FILE?.trim(),
	});
}

function normalizeProvider(value: unknown): Provider | undefined {
	const normalized = String(value ?? "")
		.toLowerCase()
		.trim()
		.replace(/[._]/g, "-");
	if (normalized === "anthropic" || normalized === "openai" || normalized === "ollama") return normalized;
	if (normalized === "llama-server" || normalized === "llamaserver" || normalized === "llama") return "llama-server";
	return undefined;
}

function parseBoolean(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	if (/^(1|true|yes|on)$/i.test(value.trim())) return true;
	if (/^(0|false|no|off)$/i.test(value.trim())) return false;
	throw new Error(`Invalid boolean environment value: ${value}`);
}

function parseNumber(value: string | undefined): number | undefined {
	if (!value?.trim()) return undefined;
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) throw new Error(`Invalid number environment value: ${value}`);
	return parsed;
}

function parseList(value: string | undefined): string[] | undefined {
	if (value === undefined) return undefined;
	return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function compactObject(input: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(input)
			.filter(([, value]) => value !== undefined)
			.map(([key, value]) => [key, isPlainObject(value) ? compactObject(value as Record<string, unknown>) : value]),
	);
}

function deepMerge(base: unknown, override: unknown): unknown {
	if (!isPlainObject(base) || !isPlainObject(override)) return override === undefined ? base : override;
	const merged: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
		merged[key] = isPlainObject(value) && isPlainObject(merged[key]) ? deepMerge(merged[key], value) : value;
	}
	return merged;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
