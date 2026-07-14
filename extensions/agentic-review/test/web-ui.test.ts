import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import { WorkflowDashboard } from "../src/dashboard.ts";
import { AgenticReviewWebUi } from "../src/web-ui.ts";
import { GitHubOAuthManager } from "../src/github-oauth.ts";
import { ProviderKeyStore } from "../src/provider-keys.ts";
import type { WorkflowResult } from "../src/types.ts";

test("Web UI exposes live run snapshots over loopback-only read APIs", async (t) => {
	const dashboard = new WorkflowDashboard(20);
	const suffix = `${process.pid}-${Date.now()}`;
	const githubPath = `/tmp/agentic-review-github-${suffix}.json`;
	const providerPath = `/tmp/agentic-review-providers-${suffix}.json`;
	const ui = new AgenticReviewWebUi(
		dashboard,
		new GitHubOAuthManager(githubPath, { authToken: () => undefined }),
		new ProviderKeyStore(providerPath),
	);
	const url = await ui.start(0);
	t.after(async () => {
		await ui.stop();
		await Promise.all([rm(githubPath, { force: true }), rm(providerPath, { force: true })]);
	});

	assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
	dashboard.setWatcherStatus({
		running: true,
		polling: true,
		intervalMs: 180_000,
		triggerLabel: "👀 Ready for review",
	});
	const run = dashboard.begin({
		source: "manual",
		prNumber: 42,
		repository: "example/repo",
		cwd: "/tmp/example",
		dryRun: true,
	});
	dashboard.record(run.id, {
		type: "stage_started",
		stage: "gather",
		message: "Loading GitHub context",
	});
	dashboard.record(run.id, {
		type: "stage_completed",
		stage: "gather",
		message: "GitHub context loaded",
		data: { changedFiles: 3 },
	});
	const result: WorkflowResult = {
		prNumber: 42,
		headSha: "abc123",
		decision: {
			event: "APPROVE",
			summary: "Approved",
			reasons: [],
			blockingFindingIds: [],
		},
		findings: [],
		bugAnalyses: [],
		deferrals: [],
		loggedTickets: [],
		applied: {
			postedComments: 0,
			commentFailures: [],
			reviewSubmitted: false,
			dryRun: true,
		},
		logs: [],
	};
	dashboard.complete(run.id, result);

	const health = (await fetch(`${url}/api/health`).then((response) => response.json())) as {
		ok: boolean;
		watcher: { running: boolean; polling: boolean };
	};
	assert.equal(health.ok, true);
	assert.equal(health.watcher.running, true);
	assert.equal(health.watcher.polling, true);

	const payload = (await fetch(`${url}/api/runs`).then((response) => response.json())) as {
		runs: Array<{ id: string; status: string; events: Array<{ stage?: string }> }>;
	};
	assert.equal(payload.runs[0]?.id, run.id);
	assert.equal(payload.runs[0]?.status, "succeeded");
	assert.equal(payload.runs[0]?.events[0]?.stage, "gather");

	const settings = (await fetch(`${url}/api/settings/github`).then((response) => response.json())) as {
		connection: { connected: boolean };
	};
	assert.equal(settings.connection.connected, false);
	const rejected = await fetch(`${url}/api/settings/github/disconnect`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
		body: "{}",
	});
	assert.equal(rejected.status, 403);
	const savedProvider = await fetch(`${url}/api/settings/providers/save`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: url },
		body: JSON.stringify({ provider: "anthropic", apiKey: "sk-ant-test-key-123456" }),
	});
	const savedPayload = (await savedProvider.json()) as { providers: { anthropic: boolean } };
	assert.equal(savedPayload.providers.anthropic, true);
	assert.doesNotMatch(JSON.stringify(savedPayload), /sk-ant-test-key/);
	assert.equal((await stat(providerPath)).mode & 0o777, 0o600);
	assert.match(await readFile(providerPath, "utf8"), /sk-ant-test-key-123456/);

	const page = await fetch(url);
	assert.match(page.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
	const html = await page.text();
	assert.match(html, /Agentic Review Observer/);
	assert.match(html, /GitHub CLI/);
	assert.match(html, /Type to fuzzy search all accessible repositories/);
	assert.match(html, /repo-results/);
});
