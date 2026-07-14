import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, parseModelSpec, redactConfig, withModelOverride, type AgenticReviewConfig } from "./src/config.ts";
import { getActiveRepo, GitHubClient } from "./src/github.ts";
import { ensureLlamaServerProvider, ensureOllamaProvider, resolveReviewModel } from "./src/model.ts";
import { runReviewWorkflow } from "./src/workflow.ts";
import type { WorkflowResult } from "./src/types.ts";
import { WorkflowDashboard } from "./src/dashboard.ts";
import { AgenticReviewWebUi } from "./src/web-ui.ts";
import { GitHubOAuthManager } from "./src/github-oauth.ts";
import { ProviderKeyStore } from "./src/provider-keys.ts";

const STATUS_KEY = "agentic-review";

export default function agenticReviewExtension(pi: ExtensionAPI): void {
	const dashboard = new WorkflowDashboard();
	const githubOAuth = new GitHubOAuthManager();
	const providerKeys = new ProviderKeyStore();
	let activeContext: ExtensionContext | undefined;
	const webUi = new AgenticReviewWebUi(dashboard, githubOAuth, providerKeys, () => {
		if (activeContext && polling) void pollOnce(activeContext);
	});
	let pollTimer: NodeJS.Timeout | undefined;
	let polling = false;
	let pollInFlight = false;
	let modelOverride: string | undefined;
	const reviewsInFlight = new Set<number>();

	pi.registerFlag("agentic-review-watch", {
		description: "Poll GitHub for open PRs labelled Ready for review",
		type: "boolean",
		default: false,
	});

	function resolveConfig(cwd: string, overrides: { dryRun?: boolean } = {}): AgenticReviewConfig {
		let config = loadConfig(cwd).config;
		config = withModelOverride(config, modelOverride);
		config = {
			...config,
			model: {
				...config.model,
				apiKeys: {
					...config.model.apiKeys,
					anthropic: providerKeys.get("anthropic") ?? config.model.apiKeys.anthropic,
					openai: providerKeys.get("openai") ?? config.model.apiKeys.openai,
				},
			},
			github: {
				...config.github,
				repository: githubOAuth.getRepository() ?? config.github.repository,
				accessToken: githubOAuth.getAccessToken(),
			},
		};
		if (overrides.dryRun !== undefined) config = { ...config, dryRun: overrides.dryRun };
		if (config.model.provider === "ollama") ensureOllamaProvider(pi, config);
		if (config.model.provider === "llama-server") ensureLlamaServerProvider(pi, config);
		dashboard.setMaxRuns(config.webUi.maxRuns);
		return config;
	}

	function updateStatus(ctx: ExtensionContext, text?: string): void {
		if (text) {
			ctx.ui.setStatus(STATUS_KEY, text);
			return;
		}
		ctx.ui.setStatus(STATUS_KEY, polling ? "review watch" : undefined);
	}

	function stopPoller(ctx?: ExtensionContext): void {
		if (pollTimer) clearInterval(pollTimer);
		pollTimer = undefined;
		polling = false;
		dashboard.setWatcherStatus({ running: false, polling: false });
		if (ctx) updateStatus(ctx);
	}

	function startPoller(ctx: ExtensionContext): void {
		stopPoller();
		const config = resolveConfig(ctx.cwd);
		const readiness = pollingReadiness(config);
		polling = true;
		pollTimer = setInterval(() => void pollOnce(ctx), config.polling.intervalMs);
		pollTimer.unref?.();
		dashboard.setWatcherStatus({
			running: true,
			polling: false,
			intervalMs: config.polling.intervalMs,
			triggerLabel: config.github.triggerLabel,
			repository: config.github.repository,
			lastPollError: undefined,
			waitingFor: readiness.ready ? undefined : readiness.message,
		});
		updateStatus(ctx);
	}

	async function startWebUi(ctx: ExtensionContext): Promise<string> {
		activeContext = ctx;
		const config = resolveConfig(ctx.cwd);
		return webUi.start(config.webUi.port);
	}

	async function pollOnce(ctx: ExtensionContext): Promise<void> {
		const config = resolveConfig(ctx.cwd);
		const readiness = pollingReadiness(config);
		if (!readiness.ready) {
			dashboard.setWatcherStatus({
				polling: false,
				repository: config.github.repository,
				candidateCount: undefined,
				lastPollError: undefined,
				waitingFor: readiness.message,
				lastPollCompletedAt: new Date().toISOString(),
			});
			updateStatus(ctx, "review watch waiting");
			return;
		}
		if (pollInFlight) return;
		if (ctx.isIdle && !ctx.isIdle()) return;
		pollInFlight = true;
		dashboard.setWatcherStatus({ polling: true, lastPollStartedAt: new Date().toISOString(), lastPollError: undefined, waitingFor: undefined });
		try {
			const repo = await getActiveRepo(pi, ctx.cwd, config.github.repository);
			const github = new GitHubClient(pi, ctx.cwd, repo, config.github.accessToken);
			await github.ensureAvailable();
			const candidates = (await github.listOpenPullRequests()).filter(
				(pr) => !pr.isDraft && pr.labels.includes(config.github.triggerLabel),
			);
			dashboard.setWatcherStatus({ repository: repo.nameWithOwner, candidateCount: candidates.length, waitingFor: undefined });
			for (const pr of candidates) {
				if (reviewsInFlight.has(pr.number)) continue;
				const run = dashboard.begin({
					source: "poller",
					prNumber: pr.number,
					repository: repo.nameWithOwner,
					cwd: ctx.cwd,
					dryRun: config.dryRun,
				});
				try {
					reviewsInFlight.add(pr.number);
					const result = await runReviewWorkflow(pi, ctx, config, pr.number, {
						onProgress: (message) => updateStatus(ctx, truncateStatus(message)),
						onTelemetry: (event) => dashboard.record(run.id, event),
					});
					dashboard.complete(run.id, result);
					if (!result.skipped) notifyResult(ctx, result);
				} catch (error) {
					dashboard.fail(run.id, error);
					ctx.ui.notify(`Agentic review failed for ${repo.nameWithOwner}#${pr.number}: ${formatError(error)}`, "error");
				} finally {
					reviewsInFlight.delete(pr.number);
					updateStatus(ctx);
				}
			}
		} catch (error) {
			dashboard.setWatcherStatus({ lastPollError: formatError(error) });
			ctx.ui.notify(`Agentic-review polling failed: ${formatError(error)}`, "error");
		} finally {
			pollInFlight = false;
			dashboard.setWatcherStatus({ polling: false, lastPollCompletedAt: new Date().toISOString() });
			updateStatus(ctx);
		}
	}

	pi.registerCommand("agentic-review", {
		description: "Run the LangGraph review workflow for a PR number (or the current branch PR)",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const dryRun = tokens.includes("--dry-run");
			const force = tokens.includes("--force");
			const numberToken = tokens.find((token) => /^#?\d+$/.test(token));
			let activePrNumber: number | undefined;
			let claimedReview = false;
			let dashboardRunId: string | undefined;
			try {
				const config = resolveConfig(ctx.cwd, dryRun ? { dryRun: true } : {});
				const prNumber = numberToken
					? Number(numberToken.replace(/^#/, ""))
					: await currentBranchPrNumber(pi, ctx, config.github.repository, config.github.accessToken);
				activePrNumber = prNumber;
				if (reviewsInFlight.has(prNumber)) throw new Error(`PR #${prNumber} is already being reviewed`);
				reviewsInFlight.add(prNumber);
				claimedReview = true;
				const repo = await getActiveRepo(pi, ctx.cwd, config.github.repository);
				const run = dashboard.begin({
					source: "manual",
					prNumber,
					repository: repo.nameWithOwner,
					cwd: ctx.cwd,
					dryRun: config.dryRun,
				});
				dashboardRunId = run.id;
				updateStatus(ctx, `reviewing #${prNumber}`);
				const result = await runReviewWorkflow(pi, ctx, config, prNumber, {
					force,
					onProgress: (message) => updateStatus(ctx, truncateStatus(message)),
					onTelemetry: (event) => dashboard.record(run.id, event),
				});
				dashboard.complete(run.id, result);
				if (result.skipped) ctx.ui.notify(`PR #${prNumber} skipped: ${result.skipped}. Use --force to rerun.`, "info");
				else notifyResult(ctx, result);
			} catch (error) {
				if (dashboardRunId) dashboard.fail(dashboardRunId, error);
				ctx.ui.notify(formatError(error), "error");
			} finally {
				if (claimedReview && activePrNumber !== undefined) reviewsInFlight.delete(activePrNumber);
				updateStatus(ctx);
			}
		},
	});

	pi.registerCommand("agentic-review-watch", {
		description: "Control the Ready-for-review GitHub poller: on, off, run, or status",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase() || "status";
			if (action === "on") {
				startPoller(ctx);
				const config = resolveConfig(ctx.cwd);
				const readiness = pollingReadiness(config);
				ctx.ui.notify(
					readiness.ready
						? `Agentic-review polling enabled every ${config.polling.intervalMs}ms`
						: `Agentic-review watcher enabled, waiting: ${readiness.message}`,
					"info",
				);
				void pollOnce(ctx);
				return;
			}
			if (action === "off") {
				stopPoller(ctx);
				ctx.ui.notify("Agentic-review polling disabled", "info");
				return;
			}
			if (action === "run") {
				await pollOnce(ctx);
				return;
			}
			if (action !== "status") {
				ctx.ui.notify("Usage: /agentic-review-watch on|off|run|status", "warning");
				return;
			}
			const config = resolveConfig(ctx.cwd);
			ctx.ui.notify(
				[
					`Poller: ${polling ? "running" : "stopped"}`,
					`Configured default: ${config.polling.enabled ? "enabled" : "disabled"}`,
					`Interval: ${config.polling.intervalMs}ms`,
					`Trigger: ${config.github.triggerLabel}`,
					pollingReadiness(config).ready ? undefined : `Waiting: ${pollingReadiness(config).message}`,
					`In flight: ${reviewsInFlight.size}`,
				].join("\n"),
				"info",
			);
		},
	});

	const serverHandler = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
		const action = args.trim().toLowerCase() || "open";
		try {
			if (action === "stop") {
				stopPoller(ctx);
				await webUi.stop();
				ctx.ui.notify("Agentic-review server and watcher stopped", "info");
				return;
			}
			if (action === "status") {
				const watcher = dashboard.getWatcherStatus();
				ctx.ui.notify(
					[
						`Web UI: ${webUi.running ? webUi.url : "stopped"}`,
						`Watcher: ${watcher.running ? (watcher.polling ? "polling" : "running") : "stopped"}`,
						watcher.repository ? `Repository: ${watcher.repository}` : undefined,
						watcher.waitingFor ? `Waiting: ${watcher.waitingFor}` : undefined,
						watcher.lastPollCompletedAt ? `Last poll: ${watcher.lastPollCompletedAt}` : undefined,
						watcher.lastPollError ? `Last error: ${watcher.lastPollError}` : undefined,
					]
						.filter(Boolean)
						.join("\n"),
					"info",
				);
				return;
			}
			if (action !== "start" && action !== "open") {
				ctx.ui.notify("Usage: /agentic-review-server open|start|stop|status", "warning");
				return;
			}
			const url = await startWebUi(ctx);
			startPoller(ctx);
			const readiness = pollingReadiness(resolveConfig(ctx.cwd));
			ctx.ui.notify(
				readiness.ready
					? `Agentic-review server and watcher started: ${url}`
					: `Agentic-review server started: ${url}\nWatcher is waiting: ${readiness.message}`,
				"info",
			);
			void pollOnce(ctx);
			if (action === "open") {
				try {
					await openBrowser(pi, ctx.cwd, url);
				} catch (error) {
					ctx.ui.notify(`${formatError(error)}\nThe watcher and Web UI are still running at ${url}.`, "warning");
				}
			}
		} catch (error) {
			ctx.ui.notify(formatError(error), "error");
		}
	};

	pi.registerCommand("agentic-review-server", {
		description: "Start the Web UI and Ready-for-review watcher together",
		handler: serverHandler,
	});

	pi.registerCommand("agentic-review-ui", {
		description: "Alias for /agentic-review-server",
		handler: serverHandler,
	});

	pi.registerCommand("agentic-review-model", {
		description: "Show or override the review model for this session (provider/model or current)",
		handler: async (args, ctx) => {
			const value = args.trim();
			try {
				if (!value) {
					const config = resolveConfig(ctx.cwd);
					const model = await resolveReviewModel(pi, ctx, config);
					ctx.ui.notify(`Agentic-review model: ${model.provider}/${model.id}${modelOverride ? " (session override)" : ""}`, "info");
					return;
				}
				if (value.toLowerCase() === "current") {
					modelOverride = undefined;
					const model = await resolveReviewModel(pi, ctx, resolveConfig(ctx.cwd));
					ctx.ui.notify(`Agentic-review model now follows pi: ${model.provider}/${model.id}`, "info");
					return;
				}
				const parsed = parseModelSpec(value);
				modelOverride = `${parsed.provider}/${parsed.id}`;
				const model = await resolveReviewModel(pi, ctx, resolveConfig(ctx.cwd));
				ctx.ui.notify(`Agentic-review model set for this session: ${model.provider}/${model.id}`, "info");
			} catch (error) {
				ctx.ui.notify(formatError(error), "error");
			}
		},
	});

	pi.registerCommand("agentic-review-config", {
		description: "Show resolved agentic-review configuration and config file locations",
		handler: async (_args, ctx) => {
			try {
				const loaded = loadConfig(ctx.cwd);
				const config = withModelOverride(loaded.config, modelOverride);
				ctx.ui.notify(
					[
						`Loaded: ${loaded.paths.loaded.length ? loaded.paths.loaded.join(", ") : "defaults + environment"}`,
						`Project config: ${loaded.paths.project}`,
						`User config: ${loaded.paths.user}`,
						"",
						JSON.stringify(redactConfig(config), null, 2),
					].join("\n"),
					"info",
				);
			} catch (error) {
				ctx.ui.notify(formatError(error), "error");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		activeContext = ctx;
		try {
			const config = resolveConfig(ctx.cwd);
			const enabledByFlag = pi.getFlag("agentic-review-watch") === true;
			if (enabledByFlag || config.polling.enabled || config.webUi.enabled) {
				startPoller(ctx);
				void pollOnce(ctx);
			} else {
				updateStatus(ctx);
			}
			if (config.webUi.enabled) {
				const url = await webUi.start(config.webUi.port);
				if (config.webUi.openOnStart) await openBrowser(pi, ctx.cwd, url);
				ctx.ui.notify(`Agentic-review Web UI: ${url}`, "info");
			}
		} catch (error) {
			ctx.ui.notify(`Failed to initialize agentic-review: ${formatError(error)}`, "error");
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopPoller(ctx);
		activeContext = undefined;
		await webUi.stop();
	});
}

async function openBrowser(pi: ExtensionAPI, cwd: string, url: string): Promise<void> {
	const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
	const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
	const result = await pi.exec(command, args, { cwd, timeout: 10_000 });
	if (result.code !== 0) throw new Error(`Could not open browser. Open ${url} manually.\n${result.stderr || result.stdout}`.trim());
}

async function currentBranchPrNumber(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	repository?: string,
	accessToken?: string,
): Promise<number> {
	const repo = await getActiveRepo(pi, ctx.cwd, repository);
	const github = new GitHubClient(pi, ctx.cwd, repo, accessToken);
	const pr = await github.findPullRequestForCurrentBranch();
	if (!pr) throw new Error("No open PR found for the current git branch; pass a PR number explicitly");
	return pr.number;
}

function notifyResult(ctx: ExtensionContext, result: WorkflowResult): void {
	if (!result.decision) return;
	const ticketSummary = result.loggedTickets.length
		? `\nLinear deferrals: ${result.loggedTickets.map((ticket) => ticket.identifier ?? ticket.error ?? ticket.title).join(", ")}`
		: "";
	ctx.ui.notify(
		[
			`PR #${result.prNumber}: ${result.decision.event}`,
			`Findings: ${result.findings.length} (${result.decision.blockingFindingIds.length} blocking)`,
			`Inline comments: ${result.applied?.postedComments ?? 0}`,
			result.applied?.dryRun ? "Dry run: no writes made" : undefined,
			ticketSummary || undefined,
		]
			.filter(Boolean)
			.join("\n"),
		"info",
	);
}

function truncateStatus(value: string): string {
	return value.length <= 48 ? value : `${value.slice(0, 47)}…`;
}

function pollingReadiness(config: AgenticReviewConfig): { ready: boolean; message?: string } {
	if (!config.github.accessToken) return { ready: false, message: "authenticate GitHub CLI with `gh auth login --scopes repo,read:org`" };
	if (!config.github.repository) return { ready: false, message: "select a GitHub repository in Settings" };
	return { ready: true };
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
