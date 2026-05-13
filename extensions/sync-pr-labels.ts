import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

interface GitHubRepo {
	owner: string;
	name: string;
	host: string;
	nameWithOwner: string;
}

interface GitHubLabel {
	name: string;
	color: string;
	description: string;
}

const PR_LABELS: GitHubLabel[] = [
	{
		name: "‼️ Merge with comments",
		color: "c2e0c6",
		description: "PR is approved, but contains comments that must be addressed before merging.",
	},
	{
		name: "✅ Ready to merge",
		color: "0e8a16",
		description: "PR is approved and ready for the author to merge.",
	},
	{
		name: "👀 Ready for review",
		color: "1d76db",
		description: "PR is ready for review.",
	},
	{
		name: "😭 Changes requested",
		color: "5319e7",
		description: "PR is has been reviewed, and updates are required.",
	},
	{
		name: "🚫 Do not merge",
		color: "f9d0c4",
		description: "PR must not be merged, even if approved.",
	},
	{
		name: "🛠️ Work in progress",
		color: "fbca04",
		description: "PR is under construction.",
	},
	{
		name: "🧱 Blocked",
		color: "471d11",
		description: "PR cannot be finalized until blocking work is completed.",
	},
];

export default function syncPrLabelsExtension(pi: ExtensionAPI) {
	pi.registerCommand("sync-pr-labels", {
		description: "Replace repository labels with the approved PR workflow labels and colors",
		handler: async (args, ctx) => {
			try {
				await execOrThrow(pi, "gh", ["--version"], ctx.cwd, "GitHub CLI (gh) is required");
				const repo = await getActiveRepo(pi, ctx.cwd);
				const force = args.includes("--yes") || args.includes("-y");

				const existing = await listLabels(pi, ctx, repo);
				const desiredNames = new Set(PR_LABELS.map((label) => label.name));
				const toDelete = existing.filter((label) => !desiredNames.has(label.name));

				if (!force) {
					const plan = [
						`Repository: ${repo.nameWithOwner}`,
						"",
						"This will delete labels not in the approved PR workflow set:",
						...(toDelete.length ? toDelete.map((label) => `- ${label.name}`) : ["- (none)"]),
						"",
						"It will create/update these labels with source-of-truth colors:",
						...PR_LABELS.map((label) => `- ${label.name} #${label.color} — ${label.description}`),
						"",
						"Run /sync-pr-labels --yes to apply.",
					].join("\n");
					ctx.ui.notify(plan, "info");
					return;
				}

				for (const label of toDelete) {
					await deleteLabel(pi, ctx, repo, label.name);
				}
				for (const label of PR_LABELS) {
					await upsertLabel(pi, ctx, repo, label);
				}

				ctx.ui.notify(`Synced ${PR_LABELS.length} PR labels for ${repo.nameWithOwner}; removed ${toDelete.length} other labels.`, "info");
			} catch (error) {
				ctx.ui.notify(formatError(error), "error");
			}
		},
	});
}

async function listLabels(pi: ExtensionAPI, ctx: ExtensionCommandContext, repo: GitHubRepo): Promise<GitHubLabel[]> {
	const output = await ghApi(pi, ctx.cwd, repo, [`repos/${repo.owner}/${repo.name}/labels`, "--paginate", "--slurp"], "Failed to list labels");
	const parsed = JSON.parse(output);
	return (Array.isArray(parsed[0]) ? parsed.flat() : parsed) as GitHubLabel[];
}

async function upsertLabel(pi: ExtensionAPI, ctx: ExtensionCommandContext, repo: GitHubRepo, label: GitHubLabel): Promise<void> {
	const args = [
		"--method",
		"PATCH",
		`repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
		"-H",
		"Accept: application/vnd.github+json",
		"-f",
		`new_name=${label.name}`,
		"-f",
		`color=${label.color}`,
		"-f",
		`description=${label.description}`,
	];
	const result = await pi.exec("gh", ["api", ...ghHostArgs(repo), ...args], { cwd: ctx.cwd, timeout: 60_000 });
	if (result.code === 0) return;

	await ghApi(
		pi,
		ctx.cwd,
		repo,
		[
			"--method",
			"POST",
			`repos/${repo.owner}/${repo.name}/labels`,
			"-H",
			"Accept: application/vnd.github+json",
			"-f",
			`name=${label.name}`,
			"-f",
			`color=${label.color}`,
			"-f",
			`description=${label.description}`,
		],
		`Failed to create label ${label.name}`,
	);
}

async function deleteLabel(pi: ExtensionAPI, ctx: ExtensionCommandContext, repo: GitHubRepo, labelName: string): Promise<void> {
	await ghApi(
		pi,
		ctx.cwd,
		repo,
		["--method", "DELETE", `repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(labelName)}`, "-H", "Accept: application/vnd.github+json"],
		`Failed to delete label ${labelName}`,
	);
}

async function getActiveRepo(pi: ExtensionAPI, cwd: string): Promise<GitHubRepo> {
	const remotes = ["origin", ...(await getRemotes(pi, cwd))];
	for (const remote of Array.from(new Set(remotes))) {
		const result = await pi.exec("git", ["remote", "get-url", remote], { cwd, timeout: 10_000 });
		if (result.code !== 0) continue;
		const repo = parseGitHubRemote(result.stdout.trim());
		if (repo) return repo;
	}
	throw new Error("Could not resolve GitHub owner/repo from git remotes");
}

async function getRemotes(pi: ExtensionAPI, cwd: string): Promise<string[]> {
	const result = await pi.exec("git", ["remote"], { cwd, timeout: 10_000 });
	return result.code === 0 ? result.stdout.split("\n").map((remote) => remote.trim()).filter(Boolean) : [];
}

function parseGitHubRemote(url: string): GitHubRepo | undefined {
	const normalized = url.trim().replace(/\.git$/, "");
	const match =
		normalized.match(/^git@([^:]+):([^/]+)\/(.+)$/) ??
		normalized.match(/^ssh:\/\/git@([^/]+)\/([^/]+)\/(.+)$/) ??
		normalized.match(/^https?:\/\/([^/]+)\/([^/]+)\/(.+)$/);
	if (!match) return undefined;
	const [, host, owner, name] = match;
	if (!host.toLowerCase().includes("github")) return undefined;
	return { owner, name, host, nameWithOwner: `${owner}/${name}` };
}

async function ghApi(pi: ExtensionAPI, cwd: string, repo: GitHubRepo, args: string[], message?: string): Promise<string> {
	return execOrThrow(pi, "gh", ["api", ...ghHostArgs(repo), ...args], cwd, message);
}

function ghHostArgs(repo: GitHubRepo): string[] {
	return repo.host && repo.host !== "github.com" ? ["--hostname", repo.host] : [];
}

async function execOrThrow(pi: ExtensionAPI, command: string, args: string[], cwd: string, message?: string): Promise<string> {
	const result = await pi.exec(command, args, { cwd, timeout: 60_000 });
	if (result.code !== 0) throw new Error(`${message ?? `${command} ${args.join(" ")} failed`}\n${result.stderr || result.stdout}`.trim());
	return result.stdout;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
