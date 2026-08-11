import test from "node:test";
import assert from "node:assert/strict";
import type { Model } from "@earendil-works/pi-ai";
import { InvalidJsonResponseError, parseJsonResponse, supportsTemperature } from "../src/model.ts";

const baseModel = {
	id: "test-model",
	name: "Test Model",
	baseUrl: "https://example.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 8_192,
} satisfies Partial<Model<any>>;

test("omits temperature for ChatGPT Codex response models", () => {
	assert.equal(
		supportsTemperature({
			...baseModel,
			api: "openai-codex-responses",
			provider: "openai-codex",
		} as Model<any>),
		false,
	);
});

test("keeps temperature for providers that accept it", () => {
	assert.equal(
		supportsTemperature({
			...baseModel,
			api: "anthropic-messages",
			provider: "anthropic",
		} as Model<any>),
		true,
	);
});

test("parses structured JSON wrapped in reasoning and markdown", () => {
	assert.deepEqual(
		parseJsonResponse<{ findings: unknown[] }>(`<think>thinking that should not be parsed</think>\n\n\`\`\`json\n{"findings":[]}\n\`\`\``),
		{ findings: [] },
	);
});

test("repairs common JSON formatting issues before failing", () => {
	assert.deepEqual(
		parseJsonResponse<{ findings: Array<{ id: string }> }>(`Here is the JSON:\n{\n  // comment\n  "findings": [{ "id": "finding-1", }],\n}`),
		{ findings: [{ id: "finding-1" }] },
	);
});

test("throws a structured invalid JSON error with parse context", () => {
	assert.throws(() => parseJsonResponse("not json at all"), InvalidJsonResponseError);
});
