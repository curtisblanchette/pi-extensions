import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubOAuthManager, type GitHubCliAuthProvider } from "../src/github-oauth.ts";

test("GitHub auth uses the GitHub CLI token and stores only repository selection", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "agentic-review-gh-auth-"));
	const authPath = join(dir, "github.json");
	const originalFetch = globalThis.fetch;
	const ghAuth: GitHubCliAuthProvider = { authToken: () => "gho_test_token" };
	t.after(async () => {
		globalThis.fetch = originalFetch;
		await rm(dir, { recursive: true, force: true });
	});

	globalThis.fetch = (async (input: string | URL | Request) => {
		const url = String(input);
		if (url === "https://api.github.com/user") {
			return json({ login: "octocat", avatar_url: "https://avatars.githubusercontent.com/u/1" });
		}
		if (url.includes("https://api.github.com/user/repos?")) {
			return json([
				{
					full_name: "example/private-repo",
					private: true,
					owner: { login: "example" },
					default_branch: "main",
					permissions: { admin: true, push: true, pull: true },
				},
			]);
		}
		if (url === "https://api.github.com/repos/example/private-repo") return json({ id: 1 });
		return json({ message: `Unexpected URL: ${url}` }, 404);
	}) as typeof fetch;

	const manager = new GitHubOAuthManager(authPath, ghAuth);
	const status = await manager.getConnectionStatus();
	assert.equal(status.connected, true);
	assert.equal(status.authSource, "gh");
	assert.equal(status.login, "octocat");
	assert.equal(manager.getAccessToken(), "gho_test_token");

	const repositories = await manager.listRepositories();
	assert.deepEqual(repositories.map((repo) => repo.fullName), ["example/private-repo"]);
	const selected = await manager.selectRepository("example/private-repo");
	assert.equal(selected.repository, "example/private-repo");
	assert.equal(manager.getRepository(), "example/private-repo");

	const fileText = await readFile(authPath, "utf8");
	const file = JSON.parse(fileText);
	assert.equal(file.accessToken, undefined);
	assert.equal(file.clientId, undefined);
	assert.equal(file.repository, "example/private-repo");
	assert.equal((await stat(authPath)).mode & 0o777, 0o600);
	assert.doesNotMatch(fileText, /gho_test_token/);

	const disconnected = await manager.disconnect();
	assert.equal(disconnected.connected, true);
	assert.equal(disconnected.repository, undefined);
	assert.equal(manager.getRepository(), undefined);
});

test("GitHub auth reports missing GitHub CLI authentication", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "agentic-review-gh-auth-missing-"));
	const authPath = join(dir, "github.json");
	t.after(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	const manager = new GitHubOAuthManager(authPath, { authToken: () => undefined });
	const status = await manager.getConnectionStatus();
	assert.equal(status.connected, false);
	assert.equal(status.authSource, "gh");
	await assert.rejects(() => manager.listRepositories(), /gh auth login/);
});

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}
