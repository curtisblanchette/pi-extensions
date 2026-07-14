import test from "node:test";
import assert from "node:assert/strict";
import type { Model } from "@earendil-works/pi-ai";
import { supportsTemperature } from "../src/model.ts";

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
