import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import agenticReviewExtension from "../index.ts";

test("/agentic-review-server starts and stops the watcher and Web UI together", async () => {
	const previousPort = process.env.AGENTIC_REVIEW_UI_PORT;
	const previousHome = process.env.HOME;
	const isolatedHome = await mkdtemp(join(tmpdir(), "agentic-review-home-"));
	process.env.AGENTIC_REVIEW_UI_PORT = "0";
	process.env.HOME = isolatedHome;
	const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
	const notifications: string[] = [];
	const execCalls: string[] = [];
	const pi = {
		registerFlag: () => undefined,
		registerCommand: (name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) =>
			commands.set(name, options.handler),
		on: () => undefined,
		getFlag: () => false,
		registerProvider: () => undefined,
		exec: async (command: string, args: string[]) => {
			execCalls.push(`${command} ${args.join(" ")}`);
			if (command === "git" && args.join(" ") === "remote") return { code: 0, stdout: "origin\n", stderr: "" };
			if (command === "git" && args.slice(0, 3).join(" ") === "remote get-url origin") {
				return { code: 0, stdout: "git@github.com:example/repo.git\n", stderr: "" };
			}
			if (command === "gh" && args[0] === "--version") return { code: 0, stdout: "gh version test", stderr: "" };
			if (command === "gh" && args[0] === "api") return { code: 0, stdout: "[]", stderr: "" };
			return { code: 1, stdout: "", stderr: `Unexpected command: ${command} ${args.join(" ")}` };
		},
	};
	agenticReviewExtension(pi as any);
	const handler = commands.get("agentic-review-server");
	assert.ok(handler);
	const ctx = {
		cwd: "/tmp",
		isIdle: () => true,
		ui: {
			notify: (message: string) => notifications.push(message),
			setStatus: () => undefined,
		},
	};

	try {
		await handler("start", ctx);
		const started = notifications.find((message) => message.includes("server started"));
		assert.ok(started);
		assert.match(started, /waiting: authenticate GitHub CLI/);
		const url = started.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
		assert.ok(url);
		await new Promise((resolve) => setTimeout(resolve, 25));
		const status = (await fetch(`${url}/api/status`).then((response) => response.json())) as {
			watcher: { running: boolean; polling: boolean; repository?: string; waitingFor?: string };
		};
		assert.equal(status.watcher.running, true);
		assert.equal(status.watcher.polling, false);
		assert.equal(status.watcher.repository, undefined);
		assert.equal(status.watcher.waitingFor, "authenticate GitHub CLI with `gh auth login --scopes repo,read:org`");
		assert.deepEqual(execCalls, []);

		await handler("stop", ctx);
		assert.ok(notifications.some((message) => message.includes("server and watcher stopped")));
		await assert.rejects(fetch(`${url}/api/health`));
	} finally {
		await handler("stop", ctx).catch(() => undefined);
		if (previousPort === undefined) delete process.env.AGENTIC_REVIEW_UI_PORT;
		else process.env.AGENTIC_REVIEW_UI_PORT = previousPort;
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		await rm(isolatedHome, { recursive: true, force: true });
	}
});
