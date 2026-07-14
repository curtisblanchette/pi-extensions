import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

interface StoredGitHubAuth {
	version: 1;
	/** Legacy OAuth fields are intentionally ignored and removed on the next write. */
	clientId?: string;
	accessToken?: string;
	login?: string;
	avatarUrl?: string;
	repository?: string;
	connectedAt?: string;
}

export interface GitHubConnectionStatus {
	connected: boolean;
	authSource: "gh";
	login?: string;
	avatarUrl?: string;
	repository?: string;
	connectedAt?: string;
}

export interface GitHubRepositoryOption {
	fullName: string;
	private: boolean;
	owner: string;
	defaultBranch?: string;
	permissions?: { admin?: boolean; push?: boolean; pull?: boolean };
}

export interface DeviceFlowStart {
	sessionId: string;
	userCode: string;
	verificationUri: string;
	expiresAt: string;
	intervalSeconds: number;
}

export type DeviceFlowPoll =
	| { status: "pending"; intervalSeconds: number }
	| { status: "authorized"; connection: GitHubConnectionStatus }
	| { status: "expired" | "denied"; message: string };

export interface GitHubCliAuthProvider {
	authToken(): string | undefined;
}

const DEFAULT_GH_AUTH_PROVIDER: GitHubCliAuthProvider = {
	authToken(): string | undefined {
		const result = spawnSync("gh", ["auth", "token"], {
			encoding: "utf8",
			timeout: 10_000,
			stdio: ["ignore", "pipe", "ignore"],
		});
		if (result.status !== 0 || result.error) return undefined;
		const token = result.stdout.trim();
		return token || undefined;
	},
};

/** GitHub CLI auth + local repository selection. */
export class GitHubOAuthManager {
	private stored: StoredGitHubAuth;

	constructor(
		private authPath = resolve(homedir(), ".pi/agent/agentic-review-github.json"),
		private ghAuth: GitHubCliAuthProvider = DEFAULT_GH_AUTH_PROVIDER,
	) {
		this.stored = this.readStored();
	}

	async getConnectionStatus(): Promise<GitHubConnectionStatus> {
		const token = this.getAccessToken();
		if (!token) {
			return {
				connected: false,
				authSource: "gh",
				repository: this.stored.repository,
			};
		}

		try {
			const user = await githubFetch<{ login: string; avatar_url?: string }>(token, "/user");
			const connectedAt = this.stored.connectedAt ?? new Date().toISOString();
			const next: StoredGitHubAuth = {
				version: 1,
				login: user.login,
				avatarUrl: user.avatar_url,
				repository: this.stored.repository,
				connectedAt,
			};
			this.replaceStored(next);
			return {
				connected: true,
				authSource: "gh",
				login: user.login,
				avatarUrl: user.avatar_url,
				repository: this.stored.repository,
				connectedAt,
			};
		} catch {
			return {
				connected: false,
				authSource: "gh",
				repository: this.stored.repository,
			};
		}
	}

	getAccessToken(): string | undefined {
		return this.ghAuth.authToken();
	}

	getRepository(): string | undefined {
		return this.stored.repository;
	}

	async startDeviceFlow(_clientIdInput?: string): Promise<DeviceFlowStart> {
		throw new Error("GitHub OAuth Device Flow is disabled. Run `gh auth login --scopes repo,read:org` and refresh Settings.");
	}

	async pollDeviceFlow(_sessionId: string): Promise<DeviceFlowPoll> {
		throw new Error("GitHub OAuth Device Flow is disabled. Run `gh auth login --scopes repo,read:org` and refresh Settings.");
	}

	async listRepositories(): Promise<GitHubRepositoryOption[]> {
		const token = this.requireGhToken();
		const repositories: GitHubRepositoryOption[] = [];
		// Fetch the complete accessible set in 100-item pages. The high guard keeps
		// malformed pagination from looping forever while supporting large orgs.
		for (let page = 1; page <= 100; page++) {
			const batch = await githubFetch<
				Array<{
					full_name: string;
					private: boolean;
					owner: { login: string };
					default_branch?: string;
					permissions?: { admin?: boolean; push?: boolean; pull?: boolean };
				}>
			>(token, `/user/repos?visibility=all&affiliation=owner,collaborator,organization_member&sort=updated&per_page=100&page=${page}`);
			repositories.push(
				...batch.map((repo) => ({
					fullName: repo.full_name,
					private: repo.private,
					owner: repo.owner.login,
					defaultBranch: repo.default_branch,
					permissions: repo.permissions,
				})),
			);
			if (batch.length < 100) break;
		}
		return repositories.sort((a, b) => a.fullName.localeCompare(b.fullName));
	}

	async selectRepository(fullName: string): Promise<GitHubConnectionStatus> {
		const normalized = fullName.trim();
		if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized)) throw new Error("Repository must use owner/name format");
		const token = this.requireGhToken();
		await githubFetch(token, `/repos/${normalized}`);
		this.replaceStored({ ...this.sanitizedStored(), repository: normalized });
		return this.getConnectionStatus();
	}

	async disconnect(): Promise<GitHubConnectionStatus> {
		this.replaceStored({ version: 1 });
		return this.getConnectionStatus();
	}

	private requireGhToken(): string {
		const token = this.getAccessToken();
		if (!token) throw new Error("GitHub CLI authentication is required. Run `gh auth login --scopes repo,read:org` and refresh Settings.");
		return token;
	}

	private readStored(): StoredGitHubAuth {
		if (!existsSync(this.authPath)) return { version: 1 };
		try {
			const parsed = JSON.parse(readFileSync(this.authPath, "utf8")) as StoredGitHubAuth;
			if (parsed.version !== 1) return { version: 1 };
			return {
				version: 1,
				login: parsed.login,
				avatarUrl: parsed.avatarUrl,
				repository: parsed.repository,
				connectedAt: parsed.connectedAt,
			};
		} catch (error) {
			throw new Error(`Could not read GitHub settings ${this.authPath}: ${formatError(error)}`);
		}
	}

	private sanitizedStored(): StoredGitHubAuth {
		return {
			version: 1,
			login: this.stored.login,
			avatarUrl: this.stored.avatarUrl,
			repository: this.stored.repository,
			connectedAt: this.stored.connectedAt,
		};
	}

	private replaceStored(next: StoredGitHubAuth): void {
		this.stored = {
			version: 1,
			login: next.login,
			avatarUrl: next.avatarUrl,
			repository: next.repository,
			connectedAt: next.connectedAt,
		};
		this.persist();
	}

	private persist(): void {
		mkdirSync(dirname(this.authPath), { recursive: true, mode: 0o700 });
		writeFileSync(this.authPath, `${JSON.stringify(this.sanitizedStored(), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		chmodSync(this.authPath, 0o600);
	}
}

async function githubFetch<T = unknown>(token: string, path: string): Promise<T> {
	const response = await fetch(`https://api.github.com${path}`, {
		headers: {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${token}`,
			"X-GitHub-Api-Version": "2022-11-28",
			"User-Agent": "pi-agentic-review",
		},
	});
	if (!response.ok) {
		const text = await response.text();
		throw new Error(`GitHub API failed (${response.status}): ${text.slice(0, 500)}`);
	}
	return (await response.json()) as T;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
