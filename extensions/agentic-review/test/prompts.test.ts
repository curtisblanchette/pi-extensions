import test from "node:test";
import assert from "node:assert/strict";
import { buildReviewUserPrompt } from "../src/prompts.ts";
import type { PrContext } from "../src/types.ts";

const context: PrContext = {
	repo: { owner: "example", name: "repo", nameWithOwner: "example/repo", host: "github.com" },
	number: 42,
	title: "Add validation",
	url: "https://github.com/example/repo/pull/42",
	headRefName: "feature/validation",
	baseRefName: "main",
	headSha: "abc123",
	body: "",
	acceptanceCriteria: "Validate input",
	changedFiles: [{ path: "src/feature/file.ts", additions: 1, deletions: 0 }],
	diff: "",
	existingComments: [],
	reviewGuidance: [
		{ path: "AGENTS.md", content: "Use repository conventions." },
		{ path: "docs/adr/001.md", content: "Keep the API backward compatible." },
	],
};

test("review prompt includes PR-head guidance with the diff", () => {
	const prompt = buildReviewUserPrompt(context, "+new", 0, 1);
	assert.match(prompt, /Applicable repository guidance fetched from the PR head/);
	assert.match(prompt, /### AGENTS\.md\nUse repository conventions/);
	assert.match(prompt, /### docs\/adr\/001\.md\nKeep the API backward compatible/);
	assert.match(prompt, /Unified diff:\n\+new/);
});
