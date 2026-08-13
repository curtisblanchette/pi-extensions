import test from "node:test";
import assert from "node:assert/strict";
import { parseSyncOptions } from "../sync-pr-labels.ts";

test("label sync requires explicit, tokenized destructive options", () => {
	assert.deepEqual(parseSyncOptions(""), { apply: false, prune: false, invalid: false });
	assert.deepEqual(parseSyncOptions("--yes"), { apply: true, prune: false, invalid: false });
	assert.deepEqual(parseSyncOptions("--prune"), { apply: false, prune: true, invalid: true });
	assert.deepEqual(parseSyncOptions("--prune --yes"), { apply: true, prune: true, invalid: false });
	assert.equal(parseSyncOptions("--yes-and-more").invalid, true);
});
