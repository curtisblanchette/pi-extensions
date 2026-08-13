import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";

test("project config is loaded only for trusted projects", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "agentic-review-config-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	await mkdir(join(cwd, ".pi"));
	const projectConfig = join(cwd, ".pi", "agentic-review.json");
	await writeFile(projectConfig, JSON.stringify({ github: { repository: "project/repo" } }));

	const untrusted = loadConfig(cwd, false);
	assert.equal(untrusted.paths.loaded.includes(projectConfig), false);

	const trusted = loadConfig(cwd, true);
	assert.equal(trusted.paths.loaded.includes(projectConfig), true);
	assert.equal(trusted.config.github.repository, "project/repo");
});

test("state files and Linear endpoints are constrained to safe destinations", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "agentic-review-config-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	await mkdir(join(cwd, ".pi"));
	const projectConfig = join(cwd, ".pi", "agentic-review.json");

	await writeFile(projectConfig, JSON.stringify({ stateFile: "../outside.json" }));
	assert.throws(() => loadConfig(cwd, true), /stateFile must stay/);

	await writeFile(projectConfig, JSON.stringify({ linear: { endpoint: "http://127.0.0.1:9999/graphql" } }));
	assert.throws(() => loadConfig(cwd, true), /linear\.endpoint/);
});
