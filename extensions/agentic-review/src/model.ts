import { stream, type AssistantMessage, type Model, type UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgenticReviewConfig } from "./config.ts";

export interface ReviewModelStreamDelta {
	kind: "text" | "thinking" | "tool";
	delta: string;
}

export interface ReviewModelClient {
	provider: string;
	id: string;
	completeText(
		systemPrompt: string,
		userText: string,
		signal?: AbortSignal,
		onDelta?: (delta: ReviewModelStreamDelta) => void,
	): Promise<string>;
	completeJson<T>(
		systemPrompt: string,
		userText: string,
		signal?: AbortSignal,
		onDelta?: (delta: ReviewModelStreamDelta) => void,
	): Promise<T>;
}

export class InvalidJsonResponseError extends Error {
	constructor(
		readonly raw: string,
		readonly candidates: string[],
		readonly parseErrors: string[],
	) {
		super(formatInvalidJsonMessage(raw, parseErrors));
		this.name = "InvalidJsonResponseError";
	}
}

const AGENTIC_REVIEW_OLLAMA_PROVIDER = "agentic-review-ollama";
const AGENTIC_REVIEW_LLAMA_SERVER_PROVIDER = "agentic-review-llama-server";

const STRUCTURED_OUTPUT_REPAIR_SYSTEM_PROMPT = [
	"You repair invalid JSON returned for a structured-output request.",
	"Return valid JSON only. Do not include markdown fences, prose, or commentary.",
	"Preserve the meaning, fields, and values from the invalid output. Do not invent new findings or analyses.",
	"If the invalid output contains reasoning or prose, extract only the JSON object or array that matches the requested shape.",
].join("\n");

/** Register Ollama as a standard OpenAI-compatible pi provider. */
export function ensureOllamaProvider(pi: ExtensionAPI, config: AgenticReviewConfig): void {
	registerLocalOpenAiProvider(pi, {
		// Do not replace Pi's user-configured `ollama` provider. Provider
		// registration replaces its model list, which otherwise hides models in
		// ~/.pi/agent/models.json from /model.
		provider: AGENTIC_REVIEW_OLLAMA_PROVIDER,
		name: "Ollama",
		modelName: (id) => `Ollama (${id})`,
		baseUrl: config.model.ollama.baseUrl,
		apiKey: config.model.ollama.apiKey || "ollama",
		contextWindow: config.model.ollama.contextWindow,
		maxTokens: config.model.maxTokens,
		modelId: config.model.id || "local-model",
	});
}

/** Register llama.server as a standard OpenAI-compatible pi provider. */
export function ensureLlamaServerProvider(pi: ExtensionAPI, config: AgenticReviewConfig): void {
	registerLocalOpenAiProvider(pi, {
		provider: AGENTIC_REVIEW_LLAMA_SERVER_PROVIDER,
		name: "llama.server",
		modelName: (id) => `llama.server (${id})`,
		baseUrl: config.model.llamaServer.baseUrl,
		apiKey: config.model.llamaServer.apiKey || "local",
		contextWindow: config.model.llamaServer.contextWindow,
		maxTokens: config.model.maxTokens,
		modelId: config.model.id || "local-model",
	});
}

export async function resolveReviewModel(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	config: AgenticReviewConfig,
): Promise<ReviewModelClient> {
	const fallbackProvider = configuredLocalFallbackProvider(pi, ctx, config);
	const model = resolveModel(ctx, config, fallbackProvider);
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
	if (!apiKey && !isKeylessLocalProvider(model.provider)) {
		throw new Error(`No API key configured for ${model.provider}/${model.id}`);
	}

	const completeText = async (
		systemPrompt: string,
		userText: string,
		signal?: AbortSignal,
		onDelta?: (delta: ReviewModelStreamDelta) => void,
	): Promise<string> => {
		const message: UserMessage = {
			role: "user",
			content: [{ type: "text", text: userText }],
			timestamp: Date.now(),
		};
		const events = stream(
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
		let final: AssistantMessage | undefined;
		for await (const event of events) {
			if (event.type === "text_delta") onDelta?.({ kind: "text", delta: event.delta });
			else if (event.type === "thinking_delta") onDelta?.({ kind: "thinking", delta: event.delta });
			else if (event.type === "toolcall_delta") onDelta?.({ kind: "tool", delta: event.delta });
			else if (event.type === "done") final = event.message;
			else if (event.type === "error") final = event.error;
		}
		const response = final ?? (await events.result());
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
		completeJson: async <T>(
			systemPrompt: string,
			userText: string,
			signal?: AbortSignal,
			onDelta?: (delta: ReviewModelStreamDelta) => void,
		): Promise<T> => {
			const text = await completeText(systemPrompt, userText, signal, onDelta);
			try {
				return parseJsonResponse<T>(text);
			} catch (error) {
				if (!(error instanceof InvalidJsonResponseError)) throw error;
				onDelta?.({
					kind: "text",
					delta: "\n\n[structured-output repair: invalid JSON received; retrying JSON-only repair]\n",
				});
				const repaired = await completeText(
					STRUCTURED_OUTPUT_REPAIR_SYSTEM_PROMPT,
					buildJsonRepairPrompt(userText, text, error),
					signal,
					onDelta,
				);
				try {
					return parseJsonResponse<T>(repaired);
				} catch (repairError) {
					if (repairError instanceof InvalidJsonResponseError) {
						throw new InvalidJsonRepairError(text, repaired, error, repairError);
					}
					throw repairError;
				}
			}
		},
	};
}

export function supportsTemperature(model: Model<any>): boolean {
	return model.api !== "openai-codex-responses" && model.provider !== "openai-codex";
}

function configuredLocalFallbackProvider(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	config: AgenticReviewConfig,
): string | undefined {
	if (!config.model.provider || !config.model.id || ctx.modelRegistry.find(config.model.provider, config.model.id))
		return undefined;
	if (config.model.provider === "ollama") {
		ensureOllamaProvider(pi, config);
		return AGENTIC_REVIEW_OLLAMA_PROVIDER;
	}
	if (config.model.provider === "llama-server") {
		ensureLlamaServerProvider(pi, config);
		return AGENTIC_REVIEW_LLAMA_SERVER_PROVIDER;
	}
	return undefined;
}

function resolveModel(ctx: ExtensionContext, config: AgenticReviewConfig, providerOverride?: string): Model<any> {
	if (config.model.provider && config.model.id) {
		const provider = providerOverride ?? config.model.provider;
		const configured = ctx.modelRegistry.find(provider, config.model.id);
		if (!configured) {
			const available = ctx.modelRegistry
				.getAll()
				.filter((model) => model.provider === provider)
				.map((model) => model.id)
				.slice(0, 12);
			throw new Error(
				`Unknown model ${provider}/${config.model.id}.` +
					(available.length ? ` Available ${provider} models: ${available.join(", ")}` : ""),
			);
		}
		return configured;
	}
	if (!ctx.model) {
		throw new Error("No model selected. Configure model.provider/model.id or select a pi model before reviewing.");
	}
	return ctx.model;
}

export class InvalidJsonRepairError extends Error {
	constructor(
		readonly originalRaw: string,
		readonly repairRaw: string,
		readonly originalError: InvalidJsonResponseError,
		readonly repairError: InvalidJsonResponseError,
	) {
		super(
			[
				"Model returned invalid JSON, and the JSON-only repair attempt also failed.",
				`Original parse: ${originalError.message}`,
				`Repair parse: ${repairError.message}`,
				`Original snippet: ${snippet(originalRaw, 700)}`,
				`Repair snippet: ${snippet(repairRaw, 700)}`,
			].join("\n"),
		);
		this.name = "InvalidJsonRepairError";
	}
}

export function parseJsonResponse<T>(text: string): T {
	const normalized = normalizeJsonResponseText(text);
	const candidates = collectJsonCandidates(normalized);
	const parseErrors: string[] = [];

	for (const candidate of candidates) {
		for (const variant of jsonVariants(candidate)) {
			try {
				return JSON.parse(variant.value) as T;
			} catch (error) {
				parseErrors.push(`${variant.label}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
	throw new InvalidJsonResponseError(normalized, candidates, [...new Set(parseErrors)].slice(-8));
}

function buildJsonRepairPrompt(
	originalRequest: string,
	invalidOutput: string,
	error: InvalidJsonResponseError,
): string {
	return [
		"The previous response did not parse as JSON for this structured-output request.",
		"Return one valid JSON value that satisfies the requested shape. No markdown. No prose.",
		"",
		"Parse error summary:",
		...error.parseErrors.slice(-5).map((item) => `- ${item}`),
		"",
		"Requested shape/instructions (truncated):",
		snippet(originalRequest, 6_000),
		"",
		"Invalid model output to repair:",
		snippet(invalidOutput, 12_000),
	].join("\n");
}

function normalizeJsonResponseText(text: string): string {
	return text
		.replace(/^\uFEFF/, "")
		.replace(/<think>[\s\S]*?<\/think>/gi, "")
		.trim()
		.replace(/^```(?:json|javascript|js)?\s*/i, "")
		.replace(/\s*```$/i, "")
		.trim();
}

function collectJsonCandidates(text: string): string[] {
	const candidates: string[] = [];
	const add = (value: string | undefined) => {
		const trimmed = value?.trim();
		if (trimmed && !candidates.includes(trimmed)) candidates.push(trimmed);
	};
	add(text);

	for (const match of text.matchAll(/```(?:json|javascript|js)?\s*([\s\S]*?)```/gi)) add(match[1]);
	for (let index = 0; index < text.length; index++) {
		if (text[index] !== "{" && text[index] !== "[") continue;
		add(readBalancedJsonCandidate(text, index));
	}
	return candidates;
}

function readBalancedJsonCandidate(text: string, start: number): string | undefined {
	const stack: string[] = [];
	let inString = false;
	let escaped = false;
	for (let index = start; index < text.length; index++) {
		const char = text[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') {
			inString = true;
			continue;
		}
		if (char === "{") stack.push("}");
		else if (char === "[") stack.push("]");
		else if (char === "}" || char === "]") {
			if (stack.at(-1) !== char) return undefined;
			stack.pop();
			if (!stack.length) return text.slice(start, index + 1);
		}
	}
	return undefined;
}

function jsonVariants(candidate: string): Array<{ label: string; value: string }> {
	const variants: Array<{ label: string; value: string }> = [];
	const add = (label: string, value: string) => {
		const trimmed = value.trim();
		if (trimmed && !variants.some((variant) => variant.value === trimmed)) variants.push({ label, value: trimmed });
	};
	add("raw", candidate);
	add("without-comments", removeJsonComments(candidate));
	add("without-trailing-commas", removeTrailingJsonCommas(candidate));
	add("without-comments-and-trailing-commas", removeTrailingJsonCommas(removeJsonComments(candidate)));
	return variants;
}

function removeJsonComments(input: string): string {
	let output = "";
	let inString = false;
	let escaped = false;
	for (let index = 0; index < input.length; index++) {
		const char = input[index];
		const next = input[index + 1];
		if (inString) {
			output += char;
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') {
			inString = true;
			output += char;
			continue;
		}
		if (char === "/" && next === "/") {
			while (index < input.length && input[index] !== "\n") index++;
			output += "\n";
			continue;
		}
		if (char === "/" && next === "*") {
			index += 2;
			while (index < input.length && !(input[index] === "*" && input[index + 1] === "/")) index++;
			index++;
			continue;
		}
		output += char;
	}
	return output;
}

function removeTrailingJsonCommas(input: string): string {
	let output = "";
	let inString = false;
	let escaped = false;
	for (let index = 0; index < input.length; index++) {
		const char = input[index];
		if (inString) {
			output += char;
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') {
			inString = true;
			output += char;
			continue;
		}
		if (char === ",") {
			let lookahead = index + 1;
			while (/\s/.test(input[lookahead] ?? "")) lookahead++;
			if (input[lookahead] === "}" || input[lookahead] === "]") continue;
		}
		output += char;
	}
	return output;
}

function formatInvalidJsonMessage(raw: string, parseErrors: string[]): string {
	return [
		"Model returned invalid JSON for a structured-output request.",
		parseErrors.length ? `Parse attempts: ${parseErrors.join("; ")}` : undefined,
		`Response snippet: ${snippet(raw, 700)}`,
	]
		.filter((line): line is string => Boolean(line))
		.join("\n");
}

function snippet(value: string, max: number): string {
	const normalized = value.replace(/\s+$/g, "");
	return normalized.length <= max
		? normalized
		: `${normalized.slice(0, max)}… [truncated ${normalized.length - max} chars]`;
}

function registerLocalOpenAiProvider(
	pi: ExtensionAPI,
	options: {
		provider: string;
		name: string;
		modelName: (id: string) => string;
		baseUrl: string;
		apiKey: string;
		contextWindow: number;
		maxTokens: number;
		modelId: string;
	},
): void {
	pi.registerProvider(options.provider, {
		name: options.name,
		baseUrl: stripTrailingSlash(options.baseUrl),
		apiKey: options.apiKey,
		api: "openai-completions",
		authHeader: false,
		models: [
			{
				id: options.modelId,
				name: options.modelName(options.modelId),
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: options.contextWindow,
				maxTokens: options.maxTokens,
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

function isKeylessLocalProvider(provider: string): boolean {
	return provider === "ollama" || provider === "llama-server";
}

function stripTrailingSlash(value: string): string {
	return value.replace(/\/+$/, "");
}
