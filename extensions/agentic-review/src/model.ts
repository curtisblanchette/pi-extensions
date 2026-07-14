import { complete, type Model, type UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgenticReviewConfig } from "./config.ts";

export interface ReviewModelClient {
	provider: string;
	id: string;
	completeText(systemPrompt: string, userText: string, signal?: AbortSignal): Promise<string>;
	completeJson<T>(systemPrompt: string, userText: string, signal?: AbortSignal): Promise<T>;
}

/** Register llama.server as a standard OpenAI-compatible pi provider. */
export function ensureLlamaServerProvider(pi: ExtensionAPI, config: AgenticReviewConfig): void {
	const id = config.model.id || "local-model";
	pi.registerProvider("llama-server", {
		name: "llama.server",
		baseUrl: stripTrailingSlash(config.model.llamaServer.baseUrl),
		apiKey: config.model.llamaServer.apiKey || "local",
		api: "openai-completions",
		authHeader: false,
		models: [
			{
				id,
				name: `llama.server (${id})`,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: config.model.llamaServer.contextWindow,
				maxTokens: config.model.maxTokens,
				compat: {
					supportsStore: false,
					supportsDeveloperRole: false,
					supportsReasoningEffort: false,
					supportsUsageInStreaming: false,
					maxTokensField: "max_tokens",
				},
			},
		],
	});
}

export async function resolveReviewModel(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	config: AgenticReviewConfig,
): Promise<ReviewModelClient> {
	if (config.model.provider === "llama-server") ensureLlamaServerProvider(pi, config);

	const model = resolveModel(ctx, config);
	const configuredKey =
		model.provider === "anthropic"
			? config.model.apiKeys.anthropic
			: model.provider === "openai"
				? config.model.apiKeys.openai
				: undefined;
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok && !configuredKey) {
		throw new Error("error" in auth ? auth.error : "Failed to resolve model authentication");
	}
	const apiKey = configuredKey ?? (auth.ok ? auth.apiKey : undefined);
	const headers = auth.ok ? auth.headers : undefined;
	if (!apiKey && model.provider !== "llama-server") {
		throw new Error(`No API key configured for ${model.provider}/${model.id}`);
	}

	const completeText = async (systemPrompt: string, userText: string, signal?: AbortSignal): Promise<string> => {
		const message: UserMessage = {
			role: "user",
			content: [{ type: "text", text: userText }],
			timestamp: Date.now(),
		};
		const response = await complete(
			model,
			{ systemPrompt, messages: [message] },
			{
				apiKey,
				headers,
				...(supportsTemperature(model) ? { temperature: config.model.temperature } : {}),
				maxTokens: config.model.maxTokens,
				signal,
			},
		);
		if (response.stopReason === "aborted") throw new Error("Agentic-review model call aborted");
		if (response.stopReason === "error") throw new Error(response.errorMessage || "Agentic-review model call failed");
		const text = response.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n")
			.trim();
		if (!text) throw new Error(`${model.provider}/${model.id} returned an empty response`);
		return text;
	};

	return {
		provider: model.provider,
		id: model.id,
		completeText,
		completeJson: async <T>(systemPrompt: string, userText: string, signal?: AbortSignal): Promise<T> => {
			const text = await completeText(systemPrompt, userText, signal);
			return parseJsonResponse<T>(text);
		},
	};
}

export function supportsTemperature(model: Model<any>): boolean {
	return model.api !== "openai-codex-responses" && model.provider !== "openai-codex";
}

function resolveModel(ctx: ExtensionContext, config: AgenticReviewConfig): Model<any> {
	if (config.model.provider && config.model.id) {
		const configured = ctx.modelRegistry.find(config.model.provider, config.model.id);
		if (!configured) {
			const available = ctx.modelRegistry
				.getAll()
				.filter((model) => model.provider === config.model.provider)
				.map((model) => model.id)
				.slice(0, 12);
			throw new Error(
				`Unknown model ${config.model.provider}/${config.model.id}.` +
					(available.length ? ` Available ${config.model.provider} models: ${available.join(", ")}` : ""),
			);
		}
		return configured;
	}
	if (!ctx.model) {
		throw new Error("No model selected. Configure model.provider/model.id or select a pi model before reviewing.");
	}
	return ctx.model;
}

export function parseJsonResponse<T>(text: string): T {
	const stripped = text
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/, "")
		.trim();
	const candidates = [stripped];
	const firstArray = stripped.indexOf("[");
	const lastArray = stripped.lastIndexOf("]");
	if (firstArray >= 0 && lastArray > firstArray) candidates.push(stripped.slice(firstArray, lastArray + 1));
	const firstObject = stripped.indexOf("{");
	const lastObject = stripped.lastIndexOf("}");
	if (firstObject >= 0 && lastObject > firstObject) candidates.push(stripped.slice(firstObject, lastObject + 1));

	for (const candidate of candidates) {
		try {
			return JSON.parse(candidate) as T;
		} catch {
			// Try the next extracted JSON candidate.
		}
	}
	throw new Error(`Model returned invalid JSON: ${stripped.slice(0, 500)}`);
}

function stripTrailingSlash(value: string): string {
	return value.replace(/\/+$/, "");
}
