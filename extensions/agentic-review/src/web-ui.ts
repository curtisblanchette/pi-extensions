import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { WorkflowDashboard } from "./dashboard.ts";
import type { GitHubOAuthManager } from "./github-oauth.ts";
import { parseConfigurableProvider, type ProviderKeyStore } from "./provider-keys.ts";
import { RuntimeSettingsStore } from "./runtime-settings.ts";

const HOST = "127.0.0.1";

export class AgenticReviewWebUi {
	private server?: Server;
	private clients = new Set<ServerResponse>();
	private unsubscribe?: () => void;
	private unsubscribeWatcher?: () => void;
	private heartbeat?: NodeJS.Timeout;
	private activePort?: number;
	private requestToken?: string;

	constructor(
		private dashboard: WorkflowDashboard,
		private githubOAuth: GitHubOAuthManager,
		private providerKeys: ProviderKeyStore,
		private runtimeSettings = new RuntimeSettingsStore(),
		private onRepositoryChanged?: (repository: string | undefined) => void,
	) {}

	get running(): boolean {
		return Boolean(this.server?.listening);
	}

	get url(): string | undefined {
		return this.activePort ? `http://${HOST}:${this.activePort}` : undefined;
	}

	async start(preferredPort: number): Promise<string> {
		if (this.running && this.url) return this.url;
		let lastError: unknown;
		for (let offset = 0; offset < 10; offset++) {
			const port = preferredPort === 0 ? 0 : preferredPort + offset;
			try {
				const server = createServer((request, response) => void this.handle(request, response));
				await listen(server, port);
				const address = server.address();
				if (!address || typeof address === "string") throw new Error("Could not resolve dashboard listen address");
				this.server = server;
				this.activePort = address.port;
				this.requestToken = randomBytes(32).toString("base64url");
				this.unsubscribe = this.dashboard.subscribe((run) => this.broadcast("run", run));
				this.unsubscribeWatcher = this.dashboard.subscribeWatcher((status) => this.broadcast("watcher", status));
				this.heartbeat = setInterval(() => this.broadcastComment("keepalive"), 15_000);
				this.heartbeat.unref?.();
				return this.url!;
			} catch (error) {
				lastError = error;
				if ((error as NodeJS.ErrnoException)?.code !== "EADDRINUSE" || preferredPort === 0) break;
			}
		}
		throw new Error(`Could not start agentic-review Web UI: ${formatError(lastError)}`);
	}

	async stop(): Promise<void> {
		if (this.heartbeat) clearInterval(this.heartbeat);
		this.heartbeat = undefined;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.unsubscribeWatcher?.();
		this.unsubscribeWatcher = undefined;
		for (const client of this.clients) client.end();
		this.clients.clear();
		const server = this.server;
		this.server = undefined;
		this.activePort = undefined;
		this.requestToken = undefined;
		if (!server) return;
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		try {
			if (!isRequestForThisServer(request, this.activePort)) {
				this.json(response, 421, { error: "Invalid Host header" });
				return;
			}
			const method = request.method ?? "GET";
			const url = new URL(request.url ?? "/", this.url ?? `http://${HOST}`);
			if (method === "GET") {
				if (url.pathname === "/") {
					this.html(
						response,
						DASHBOARD_HTML.replace("__AGENTIC_REVIEW_REQUEST_TOKEN__", JSON.stringify(this.requestToken)),
					);
					return;
				}
				if (url.pathname === "/api/health") {
					this.json(response, 200, {
						ok: true,
						service: "pi-agentic-review",
						now: new Date().toISOString(),
						watcher: this.dashboard.getWatcherStatus(),
					});
					return;
				}
				if (url.pathname === "/api/status") {
					this.json(response, 200, { watcher: this.dashboard.getWatcherStatus() });
					return;
				}
				if (url.pathname === "/api/runs") {
					this.json(response, 200, { runs: this.dashboard.list() });
					return;
				}
				if (url.pathname.startsWith("/api/runs/")) {
					const id = decodeURIComponent(url.pathname.slice("/api/runs/".length));
					const run = this.dashboard.get(id);
					this.json(response, run ? 200 : 404, run ?? { error: "Run not found" });
					return;
				}
				if (url.pathname === "/api/events") {
					await this.openEventStream(response);
					return;
				}
				if (url.pathname === "/api/settings/github") {
					this.json(response, 200, { connection: await this.githubOAuth.getConnectionStatus() });
					return;
				}
				if (url.pathname === "/api/settings/github/repos") {
					this.json(response, 200, { repositories: await this.githubOAuth.listRepositories() });
					return;
				}
				if (url.pathname === "/api/settings/providers") {
					this.json(response, 200, { providers: this.providerKeys.status() });
					return;
				}
				if (url.pathname === "/api/settings/runtime") {
					this.json(response, 200, { settings: this.runtimeSettings.status() });
					return;
				}
				this.json(response, 404, { error: "Not found" });
				return;
			}

			if (method === "POST") {
				if (!isAuthorizedMutation(request, this.url, this.requestToken)) {
					this.json(response, 403, { error: "Settings requests require a same-origin request token" });
					return;
				}
				const body = await readJsonBody(request);
				if (url.pathname === "/api/settings/github/oauth/start") {
					this.json(response, 200, await this.githubOAuth.startDeviceFlow(stringValue(body.clientId)));
					return;
				}
				if (url.pathname === "/api/settings/github/oauth/poll") {
					const sessionId = stringValue(body.sessionId);
					if (!sessionId) throw new Error("OAuth sessionId is required");
					const result = await this.githubOAuth.pollDeviceFlow(sessionId);
					if (result.status === "authorized") this.broadcast("github", result.connection);
					this.json(response, 200, result);
					return;
				}
				if (url.pathname === "/api/settings/github/repository") {
					const repository = stringValue(body.repository);
					if (!repository) throw new Error("Repository is required");
					const connection = await this.githubOAuth.selectRepository(repository);
					this.dashboard.setWatcherStatus({ repository: connection.repository, lastPollError: undefined });
					this.onRepositoryChanged?.(connection.repository);
					this.broadcast("github", connection);
					this.json(response, 200, { connection });
					return;
				}
				if (url.pathname === "/api/settings/github/disconnect") {
					const connection = await this.githubOAuth.disconnect();
					this.dashboard.setWatcherStatus({ repository: undefined });
					this.onRepositoryChanged?.(undefined);
					this.broadcast("github", connection);
					this.json(response, 200, { connection });
					return;
				}
				if (url.pathname === "/api/settings/providers/save") {
					const provider = parseConfigurableProvider(body.provider);
					const apiKey = stringValue(body.apiKey);
					if (!apiKey) throw new Error("API key is required");
					const providers = this.providerKeys.set(provider, apiKey);
					this.broadcast("providers", providers);
					this.json(response, 200, { providers });
					return;
				}
				if (url.pathname === "/api/settings/providers/remove") {
					const provider = parseConfigurableProvider(body.provider);
					const providers = this.providerKeys.remove(provider);
					this.broadcast("providers", providers);
					this.json(response, 200, { providers });
					return;
				}
				if (url.pathname === "/api/settings/runtime/dry-run") {
					const settings = this.runtimeSettings.setForceDryRun(booleanValue(body.forceDryRun));
					this.dashboard.setWatcherStatus({ lastPollError: undefined });
					this.broadcast("settings", settings);
					this.json(response, 200, { settings });
					return;
				}
				this.json(response, 404, { error: "Not found" });
				return;
			}

			this.json(response, 405, { error: "Method not allowed" });
		} catch (error) {
			this.json(response, 400, { error: formatError(error) });
		}
	}

	private async openEventStream(response: ServerResponse): Promise<void> {
		response.writeHead(200, {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		});
		response.write("retry: 2000\n\n");
		response.write(
			`event: snapshot\ndata: ${JSON.stringify({
				runs: this.dashboard.list(),
				watcher: this.dashboard.getWatcherStatus(),
				github: await this.githubOAuth.getConnectionStatus(),
				providers: this.providerKeys.status(),
				settings: this.runtimeSettings.status(),
			})}\n\n`,
		);
		this.clients.add(response);
		const remove = () => this.clients.delete(response);
		response.on("close", remove);
		response.on("error", remove);
	}

	private broadcast(event: string, value: unknown): void {
		const payload = `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
		for (const client of this.clients) client.write(payload);
	}

	private broadcastComment(value: string): void {
		for (const client of this.clients) client.write(`: ${value}\n\n`);
	}

	private html(response: ServerResponse, body: string): void {
		response.writeHead(200, {
			"Content-Type": "text/html; charset=utf-8",
			"Content-Length": Buffer.byteLength(body),
			"Cache-Control": "no-store",
			"Content-Security-Policy":
				"default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
			"X-Content-Type-Options": "nosniff",
			"X-Frame-Options": "DENY",
			"Referrer-Policy": "no-referrer",
		});
		response.end(body);
	}

	private json(response: ServerResponse, status: number, body: unknown): void {
		const payload = JSON.stringify(body);
		response.writeHead(status, {
			"Content-Type": "application/json; charset=utf-8",
			"Content-Length": Buffer.byteLength(payload),
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
		});
		response.end(payload);
	}
}

function isRequestForThisServer(request: IncomingMessage, port: number | undefined): boolean {
	return Boolean(port) && request.headers.host === `${HOST}:${port}`;
}

function isAuthorizedMutation(
	request: IncomingMessage,
	origin: string | undefined,
	token: string | undefined,
): boolean {
	return (
		Boolean(origin && token) && request.headers.origin === origin && request.headers["x-agentic-review-token"] === token
	);
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	const contentType = request.headers["content-type"] ?? "";
	if (!contentType.toLowerCase().startsWith("application/json"))
		throw new Error("Settings requests require application/json");
	let body = "";
	for await (const chunk of request) {
		body += chunk.toString();
		if (body.length > 32_768) throw new Error("Settings request body is too large");
	}
	if (!body.trim()) return {};
	const parsed = JSON.parse(body);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		throw new Error("Settings request body must be a JSON object");
	return parsed as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanValue(value: unknown): boolean {
	if (typeof value === "boolean") return value;
	throw new Error("Value must be a boolean");
}

function listen(server: Server, port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const onError = (error: Error) => {
			server.off("listening", onListening);
			reject(error);
		};
		const onListening = () => {
			server.off("error", onError);
			resolve();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(port, HOST);
	});
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agentic Review Observer</title>
<style>
:root{color-scheme:dark;--bg:#090b10;--panel:#11141c;--panel2:#171b25;--line:#252b39;--text:#eef1f7;--muted:#929bad;--accent:#79a8ff;--cyan:#5eead4;--green:#60d394;--red:#ff6b7a;--amber:#f7c66a;--purple:#b9a2ff;--shadow:0 18px 50px rgba(0,0,0,.34)}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 15% -10%,#172441 0,transparent 30%),radial-gradient(circle at 95% 0,#172c2b 0,transparent 23%),var(--bg);color:var(--text);font:14px/1.45 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100vh}button{font:inherit;color:inherit}.shell{max-width:1500px;margin:auto;padding:26px}.top{display:flex;gap:22px;align-items:flex-end;justify-content:space-between;margin-bottom:20px}.eyebrow{text-transform:uppercase;letter-spacing:.16em;font-size:11px;color:var(--cyan);font-weight:800}.title{font-size:31px;line-height:1.05;font-weight:760;margin:5px 0}.subtitle{color:var(--muted);max-width:680px}.connection{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:12px}.dot{width:9px;height:9px;border-radius:50%;background:var(--amber);box-shadow:0 0 14px currentColor}.connection.live .dot{background:var(--green)}.metrics{display:grid;grid-template-columns:repeat(5,minmax(110px,1fr));gap:10px;margin-bottom:16px}.metric{background:rgba(17,20,28,.82);border:1px solid var(--line);padding:13px 15px;border-radius:13px;box-shadow:var(--shadow)}.metric span{display:block;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.1em}.metric strong{font-size:22px}.layout{display:grid;grid-template-columns:390px minmax(0,1fr);gap:15px;min-height:680px}.panel{background:rgba(17,20,28,.9);border:1px solid var(--line);border-radius:15px;box-shadow:var(--shadow);overflow:hidden}.panel-head{display:flex;justify-content:space-between;align-items:center;padding:15px 17px;border-bottom:1px solid var(--line)}.panel-head h2{font-size:13px;text-transform:uppercase;letter-spacing:.11em;margin:0;color:#c7cfdd}.count{color:var(--muted);font-size:12px}.runs{max-height:790px;overflow:auto;padding:8px}.run{width:100%;text-align:left;border:1px solid transparent;background:transparent;padding:12px;border-radius:11px;cursor:pointer;margin-bottom:4px;transition:.15s}.run:hover{background:var(--panel2)}.run.active{background:#182033;border-color:#304669}.run-top{display:flex;align-items:center;justify-content:space-between;gap:9px}.run-pr{font-weight:750}.run-repo{color:var(--muted);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:4px}.run-meta{display:flex;gap:9px;color:var(--muted);font-size:11px;margin-top:8px}.badge{display:inline-flex;align-items:center;padding:3px 7px;border-radius:999px;text-transform:uppercase;letter-spacing:.06em;font-size:9px;font-weight:800;background:#252b38;color:#c4cad6}.badge.running,.badge.queued{background:#1c3152;color:#9fc2ff}.badge.succeeded{background:#15352c;color:#82e3b8}.badge.failed{background:#3c1d27;color:#ff9cab}.badge.skipped{background:#3d3420;color:#f7d687}.detail{height:100%;overflow:auto}.empty{display:grid;place-items:center;min-height:570px;text-align:center;color:var(--muted);padding:40px}.detail-content{padding:19px}.detail-title{display:flex;align-items:flex-start;justify-content:space-between;gap:15px}.detail-title h2{font-size:23px;margin:0 0 5px}.detail-sub{color:var(--muted);font-size:12px}.stagebar{display:grid;grid-template-columns:repeat(7,1fr);gap:6px;margin:22px 0}.stage{min-width:0;border:1px solid var(--line);border-radius:9px;background:#151923;padding:8px 6px;cursor:pointer;text-align:left;color:var(--muted)}.stage:hover,.stage.selected{border-color:#466898;background:#19243a}.stage.done{box-shadow:inset 0 3px 0 var(--green)}.stage.live{box-shadow:inset 0 3px 0 var(--accent),0 0 14px rgba(121,168,255,.18)}.stage.skip{box-shadow:inset 0 3px 0 #666}.stage strong{display:block;overflow:hidden;text-overflow:ellipsis;font-size:10px;color:#d6dce7}.stage small{font-size:8px;text-transform:uppercase;letter-spacing:.06em}.step-inspector{border:1px solid #30415f;background:#101621;border-radius:12px;padding:14px}.io-grid{display:grid;grid-template-columns:1fr 1fr;gap:9px}.io-panel{min-width:0;background:#0c0f15;border:1px solid var(--line);border-radius:9px;padding:10px}.io-panel h4{margin:0 0 7px;color:#aeb8c8;font-size:10px;text-transform:uppercase;letter-spacing:.1em}.io-panel pre{margin:0;max-height:280px;overflow:auto;white-space:pre-wrap;word-break:break-word;color:#b8c4d8;font:10px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}.step-logs{margin-top:9px}.step-log{display:grid;grid-template-columns:75px minmax(0,1fr);gap:8px;border-top:1px solid var(--line);padding:7px 0;font-size:11px}.step-log time{color:var(--muted);font:9px ui-monospace,monospace}.model-stream{max-height:360px;overflow:auto;white-space:pre-wrap;word-break:break-word;background:#070a0f;border:1px solid var(--line);border-radius:9px;padding:10px;color:#d6e3ff;font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}.stream-thinking{color:#b9a2ff}.stream-tool{color:#f7c66a}.section{margin:22px 0}.section h3{font-size:12px;color:#bac3d2;text-transform:uppercase;letter-spacing:.11em;margin:0 0 10px}.decision{border:1px solid var(--line);background:var(--panel2);padding:15px;border-radius:12px}.decision.request{border-color:#713543;background:#28151d}.decision.approve{border-color:#285b49;background:#10251f}.decision strong{font-size:17px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.card{border:1px solid var(--line);background:#121722;padding:12px;border-radius:10px}.card-title{display:flex;justify-content:space-between;gap:10px;font-weight:700}.sev{font-size:9px;text-transform:uppercase;letter-spacing:.08em;padding:3px 6px;border-radius:999px;background:#2c3240;white-space:nowrap}.sev.critical,.sev.bug{color:#ff9cab;background:#3b1d27}.sev.nice-to-have{color:#9fc2ff;background:#1c3152}.sev.nit{color:#d9c7ff;background:#2e2645}.path{font:11px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--cyan);margin:7px 0}.rationale{color:#c3cad6;font-size:12px}.timeline{position:relative;margin-left:5px}.event{display:grid;grid-template-columns:12px 100px minmax(0,1fr);gap:9px;padding:8px 0;border-bottom:1px solid rgba(37,43,57,.62)}.event-dot{width:8px;height:8px;border-radius:50%;background:#556174;margin-top:5px}.event.stage_started .event-dot{background:var(--accent)}.event.stage_completed .event-dot{background:var(--green)}.event.stage_skipped .event-dot{background:#777}.event-time{color:var(--muted);font:10px ui-monospace,monospace;margin-top:2px}.event-msg{font-size:12px}.event-stage{color:var(--purple);font-weight:700;margin-right:6px}.event details{margin-top:5px}.event pre{white-space:pre-wrap;word-break:break-word;color:#aeb8c8;background:#0c0f15;padding:9px;border-radius:7px;max-height:260px;overflow:auto;font:10px/1.45 ui-monospace,monospace}.error{border:1px solid #713543;background:#28151d;color:#ffc0c9;padding:14px;border-radius:10px;white-space:pre-wrap}.ticket a{color:var(--accent);text-decoration:none}.ticket a:hover{text-decoration:underline}.footer{color:#606979;font-size:10px;margin-top:17px}.nav{display:flex;gap:7px;margin-top:11px;justify-content:flex-end}.nav-btn,.action-btn{border:1px solid var(--line);background:var(--panel2);border-radius:8px;padding:7px 11px;cursor:pointer}.nav-btn:hover,.action-btn:hover{border-color:#45618c}.nav-btn.active{background:#1c3152;border-color:#3e6194;color:#b7d1ff}.action-btn.primary{background:#285cb2;border-color:#3971cf;color:white}.action-btn.danger{background:#3c1d27;border-color:#713543;color:#ffb1bd}.hidden{display:none!important}.settings-view{max-width:920px;margin:0 auto}.settings-grid{display:grid;grid-template-columns:1fr 1fr;gap:15px}.settings-card{background:rgba(17,20,28,.9);border:1px solid var(--line);border-radius:15px;padding:20px;box-shadow:var(--shadow)}.settings-card h2{margin:0 0 6px;font-size:19px}.settings-card h3{margin:20px 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:.1em;color:#bac3d2}.settings-note{color:var(--muted);font-size:12px}.field{margin:13px 0}.field label{display:block;color:#bac3d2;font-size:11px;text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px}.field input,.field select{width:100%;background:#0c0f15;border:1px solid var(--line);border-radius:8px;padding:10px;color:var(--text);font:12px ui-monospace,SFMono-Regular,Menlo,monospace}.repo-results{max-height:360px;overflow:auto;border:1px solid var(--line);border-radius:10px;background:#0c0f15;padding:6px}.repo-results.disabled{opacity:.58}.repo-option{display:flex;width:100%;align-items:center;justify-content:space-between;gap:10px;border:1px solid transparent;background:transparent;color:var(--text);border-radius:8px;padding:9px 10px;cursor:pointer;text-align:left;font:12px ui-monospace,SFMono-Regular,Menlo,monospace}.repo-option:hover{background:#151c2b;border-color:#33445f}.repo-option.selected{background:#1c3152;border-color:#3e6194;color:#c7dcff}.repo-option small{color:var(--muted);font:10px ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.repo-empty{padding:18px;color:var(--muted);font-size:12px;text-align:center}.selected-repo{margin-top:8px;color:#b7d1ff;font-size:12px}.button-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.github-profile{display:flex;align-items:center;gap:11px;padding:12px;background:#101722;border:1px solid var(--line);border-radius:10px;margin:13px 0}.github-profile img{width:38px;height:38px;border-radius:50%}.device-code{font:700 28px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.13em;color:var(--cyan);padding:14px;background:#0c0f15;border:1px dashed #355a5a;border-radius:9px;text-align:center;margin:12px 0}.settings-status{min-height:18px;margin-top:10px;font-size:12px;color:var(--muted)}.settings-status.error{color:var(--red)}.settings-status.ok{color:var(--green)}.pulse{animation:pulse 1.4s ease-in-out infinite}@keyframes pulse{50%{opacity:.35}}@media(max-width:900px){.shell{padding:15px}.top{align-items:flex-start;flex-direction:column}.nav{justify-content:flex-start}.metrics{grid-template-columns:repeat(2,1fr)}.layout,.settings-grid,.io-grid{grid-template-columns:1fr}.runs{max-height:340px}.stagebar{grid-template-columns:repeat(2,1fr)}.grid{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="shell">
  <header class="top"><div><div class="eyebrow">pi · LangGraph</div><div class="title">Agentic Review Observer</div><div class="subtitle">Live, end-to-end visibility into pull request context gathering, model review, quality gating, bug analysis, Linear deferrals, and GitHub review submission.</div></div><div><div id="connection" class="connection"><span class="dot"></span><span>connecting</span></div><nav class="nav"><button id="nav-observer" class="nav-btn active">Observer</button><button id="nav-settings" class="nav-btn">Settings</button></nav></div></header>
  <div id="observer-view"><section class="metrics"><div class="metric"><span>Watcher</span><strong id="m-watcher">off</strong></div><div class="metric"><span>Total runs</span><strong id="m-total">0</strong></div><div class="metric"><span>Active</span><strong id="m-active">0</strong></div><div class="metric"><span>Approved</span><strong id="m-approved">0</strong></div><div class="metric"><span>Request changes</span><strong id="m-changes">0</strong></div></section>
  <main class="layout"><aside class="panel"><div class="panel-head"><h2>Workflow runs</h2><span id="run-count" class="count">0</span></div><div id="runs" class="runs"></div></aside><section class="panel detail"><div id="detail" class="empty"><div><strong>No workflow selected</strong><br>Start a review to watch LangGraph progress here.</div></div></section></main></div>
  <section id="settings-view" class="settings-view hidden"><div class="settings-grid"><div class="settings-card"><div class="eyebrow">GitHub CLI</div><h2>GitHub authentication</h2><p class="settings-note">Agentic Review now always uses your local GitHub CLI authentication. Run <code>gh auth login --scopes repo,read:org</code> in a terminal, then refresh this panel.</p><div id="github-profile"></div><div class="button-row"><button id="github-refresh-auth" class="action-btn primary">Refresh GitHub CLI auth</button><a class="settings-note" href="https://cli.github.com/manual/gh_auth_login" target="_blank" rel="noreferrer">gh auth login docs ↗</a></div><div id="github-status" class="settings-status"></div></div><div class="settings-card"><div class="eyebrow">Repository</div><h2>Review target</h2><p class="settings-note">Choose the repository watched for the <code>👀 Ready for review</code> label. This overrides the current git remote for this extension.</p><div id="repo-controls"><div class="field"><label for="repo-search">Search repositories</label><input id="repo-search" autocomplete="off" placeholder="Type to fuzzy search all accessible repositories…"><div class="settings-note" style="margin-top:6px">Results below update as you type. Leave search empty to browse the full loaded list.</div></div><div class="field"><label>Accessible repositories</label><input id="github-repository" type="hidden"><div id="repo-results" class="repo-results" role="listbox" aria-label="Accessible repositories"></div><div id="repo-selected" class="selected-repo"></div><div id="repo-match-count" class="settings-note" style="margin-top:6px"></div></div><div class="button-row"><button id="repo-save" class="action-btn primary">Save selected repository</button><button id="repo-refresh" class="action-btn">Refresh repositories</button><button id="repo-search-clear" class="action-btn">Clear search</button><button id="github-disconnect" class="action-btn danger">Clear saved repository</button></div></div><div id="repo-status" class="settings-status"></div><h3>GitHub CLI requirements</h3><p class="settings-note">The <code>gh</code> token must have repository access. If private repositories are missing, rerun <code>gh auth login --scopes repo,read:org</code> or refresh scopes with <code>gh auth refresh -s repo -s read:org</code>.</p></div><div class="settings-card"><div class="eyebrow">Model credentials</div><h2>Provider API keys</h2><p class="settings-note">These keys are used only by the agentic-review workflow and stored in a local mode-0600 file. Saved values are never returned to the browser.</p><div class="field"><label for="anthropic-key">Anthropic API key</label><input id="anthropic-key" type="password" autocomplete="new-password" placeholder="sk-ant-…"></div><div class="button-row"><button id="anthropic-save" class="action-btn primary">Save Anthropic key</button><button id="anthropic-remove" class="action-btn">Remove</button><span id="anthropic-key-status" class="settings-note"></span></div><div class="field"><label for="openai-key">OpenAI API key</label><input id="openai-key" type="password" autocomplete="new-password" placeholder="sk-…"></div><div class="button-row"><button id="openai-save" class="action-btn primary">Save OpenAI key</button><button id="openai-remove" class="action-btn">Remove</button><span id="openai-key-status" class="settings-note"></span></div><div id="provider-status" class="settings-status"></div></div><div class="settings-card"><div class="eyebrow">Safety</div><h2>Dry-run mode</h2><p class="settings-note">Force every agentic-review run to report findings only. GitHub review/comment writes and Linear ticket creation are skipped.</p><div class="field"><label><input id="force-dry-run" type="checkbox" style="width:auto;margin-right:8px"> Enforce dry-run for all runs</label></div><div id="runtime-status" class="settings-status"></div></div></div></section>
</div>
<script>
const stages=['gather','review','classify','analyze-bugs','log-deferrals','gate','apply'];
let runs=[], selectedId=null, selectedSteps={}, watcher={running:false,polling:false}, github={connected:false}, providers={anthropic:false,openai:false}, settings={forceDryRun:false}, repositories=[];
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtTime=v=>v?new Date(v).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'}):'—';
const duration=r=>{const a=new Date(r.startedAt).getTime(),b=r.completedAt?new Date(r.completedAt).getTime():Date.now();const s=Math.max(0,Math.round((b-a)/1000));return s<60?s+'s':Math.floor(s/60)+'m '+s%60+'s'};
const safeUrl=v=>{try{const u=new URL(v);return ['http:','https:'].includes(u.protocol)?u.href:'#'}catch{return '#'}};
function upsert(run){const i=runs.findIndex(r=>r.id===run.id);if(i>=0)runs[i]=run;else runs.unshift(run);runs.sort((a,b)=>b.startedAt.localeCompare(a.startedAt));if(!selectedId)selectedId=run.id;render()}
function statusBadge(r){return '<span class="badge '+esc(r.status)+'">'+esc(r.status)+'</span>'}
function render(){
 document.getElementById('m-watcher').textContent=watcher.polling?'polling':watcher.waitingFor?'waiting':watcher.running?'on':'off';
 document.getElementById('m-total').textContent=runs.length;
 document.getElementById('m-active').textContent=runs.filter(r=>['queued','running'].includes(r.status)).length;
 document.getElementById('m-approved').textContent=runs.filter(r=>r.result?.decision?.event==='APPROVE').length;
 document.getElementById('m-changes').textContent=runs.filter(r=>r.result?.decision?.event==='REQUEST_CHANGES').length;
 document.getElementById('run-count').textContent=runs.length+' retained';
 document.getElementById('runs').innerHTML=runs.length?runs.map(r=>'<button class="run '+(r.id===selectedId?'active':'')+'" data-id="'+esc(r.id)+'"><div class="run-top"><span class="run-pr">PR #'+r.prNumber+'</span>'+statusBadge(r)+'</div><div class="run-repo">'+esc(r.repository||r.cwd)+'</div><div class="run-meta"><span>'+esc(r.source)+'</span><span>'+fmtTime(r.startedAt)+'</span><span>'+duration(r)+'</span></div></button>').join(''):'<div class="empty" style="min-height:300px">No review runs yet.</div>';
 document.querySelectorAll('.run').forEach(el=>el.onclick=()=>{selectedId=el.dataset.id;render()});
 renderDetail(runs.find(r=>r.id===selectedId));
}
function stageClass(run,stage){const events=run.events||[];if(events.some(e=>e.stage===stage&&e.type==='stage_skipped'))return'skip';if(events.some(e=>e.stage===stage&&e.type==='stage_completed'))return'done';if(run.currentStage===stage)return'live pulse';return''}
function stageState(run,stage){const cls=stageClass(run,stage);return cls.includes('live')?'running':cls==='done'?'complete':cls==='skip'?'skipped':'waiting'}
function renderDetail(r){const el=document.getElementById('detail');if(!r){el.className='empty';el.innerHTML='<div><strong>No workflow selected</strong><br>Start a review to watch LangGraph progress here.</div>';return}el.className='detail-content';const d=r.result?.decision;const findings=r.result?.findings||[];const analyses=r.result?.bugAnalyses||[];const tickets=r.result?.loggedTickets||[];const selected=selectedSteps[r.id]||r.currentStage||(r.events||[]).find(e=>e.stage)?.stage||'gather';selectedSteps[r.id]=selected;el.innerHTML='<div class="detail-title"><div><h2>PR #'+r.prNumber+'</h2><div class="detail-sub">'+esc(r.repository||r.cwd)+' · '+esc(r.source)+' · '+esc(r.model||'model resolving')+(r.dryRun?' · dry run':'')+'</div></div>'+statusBadge(r)+'</div><div class="stagebar">'+stages.map((s,i)=>'<button class="stage '+stageClass(r,s)+(selected===s?' selected':'')+'" data-step="'+esc(s)+'"><small>'+(i+1)+' · '+esc(stageState(r,s))+'</small><strong>'+esc(s)+'</strong></button>').join('')+'</div>'+renderStepInspector(r,selected)+(r.error?'<div class="error">'+esc(r.error)+'</div>':'')+(d?'<section class="section"><h3>Quality gate</h3><div class="decision '+(d.event==='APPROVE'?'approve':'request')+'"><strong>'+esc(d.event.replace('_',' '))+'</strong><div class="rationale">'+d.blockingFindingIds.length+' blocking · '+findings.length+' total findings</div>'+(d.reasons?.length?'<div class="rationale" style="margin-top:8px">'+d.reasons.map(esc).join('<br>')+'</div>':'')+'</div></section>':'')+renderFindings(findings)+renderAnalyses(analyses)+renderTickets(tickets)+renderTimeline(r.events||[])+'<div class="footer">Run '+esc(r.id)+' · '+fmtTime(r.startedAt)+' · '+duration(r)+'</div>';el.querySelectorAll('[data-step]').forEach(button=>button.onclick=()=>{selectedSteps[r.id]=button.dataset.step;renderDetail(r)});const stream=el.querySelector('.model-stream');if(stream)stream.scrollTop=stream.scrollHeight}
function renderStepInspector(run,stage){const events=(run.events||[]).filter(e=>e.stage===stage),started=events.find(e=>e.type==='stage_started'),completed=[...events].reverse().find(e=>e.type==='stage_completed'),skipped=events.find(e=>e.type==='stage_skipped'),input=started?.data||{},output=completed?.data||(skipped?{skipped:skipped.message}:{}),streamEvents=events.filter(e=>e.type==='model_delta'),nonStreamEvents=events.filter(e=>e.type!=='model_delta');const streamText=streamEvents.map(e=>{const kind=e.data?.kind||'text',source=e.data?.source||'';const delta=e.data?.delta||'';const prefix=kind==='thinking'?'[thinking '+source+'] ':kind==='tool'?'[tool '+source+'] ':'';return prefix+delta}).join('');const streamPanel=streamEvents.length?'<div class="step-logs"><h4>LLM stream · bounded output tokens</h4><pre class="model-stream">'+esc(streamText)+'</pre></div>':'';const logs=nonStreamEvents.map(e=>'<div class="step-log"><time>'+fmtTime(e.timestamp)+'</time><div><strong>'+esc(e.type.replace('stage_',''))+'</strong> · '+esc(e.message)+(e.type==='stage_progress'&&e.data?'<details><summary>progress data</summary><pre>'+esc(JSON.stringify(e.data,null,2))+'</pre></details>':'')+'</div></div>').join('');return'<section class="section step-inspector"><h3>Step analysis · '+esc(stage)+'</h3><div class="io-grid"><div class="io-panel"><h4>Input</h4><pre>'+esc(JSON.stringify(input,null,2))+'</pre></div><div class="io-panel"><h4>Output</h4><pre>'+esc(JSON.stringify(output,null,2))+'</pre></div></div>'+streamPanel+'<div class="step-logs"><h4>Logs</h4>'+(logs||'<div class="settings-note">This step has not run.</div>')+'</div></section>'}
function renderFindings(items){if(!items.length)return'';return'<section class="section"><h3>Findings</h3><div class="grid">'+items.map(f=>'<div class="card"><div class="card-title"><span>'+esc(f.title)+'</span><span class="sev '+esc(f.severity)+'">'+esc(f.severity)+'</span></div>'+(f.path?'<div class="path">'+esc(f.path)+(f.line?':'+f.line:'')+'</div>':'')+'<div class="rationale">'+esc(f.rationale)+'</div></div>').join('')+'</div></section>'}
function renderAnalyses(items){if(!items.length)return'';return'<section class="section"><h3>Bug analysis</h3><div class="grid">'+items.map(a=>{const impact=a.mergeImpact||a.disposition||'unknown';return'<div class="card"><div class="card-title"><span>'+esc(a.findingId)+'</span><span class="sev '+(impact==='blocking'||impact==='critical'?'bug':'nice-to-have')+'">'+esc(impact)+'</span></div><div class="rationale">'+(a.isEdgeCase?'Edge case':'Normal path')+' · '+(a.impactsAcceptanceCriteria?'impacts acceptance criteria':'outside acceptance criteria')+' · '+(a.directlyBlocksMerge?'directly blocks merge':'does not directly block merge')+'</div>'+(a.edgeCaseDefinition?'<div class="rationale" style="margin-top:7px">'+esc(a.edgeCaseDefinition)+'</div>':'')+'<div class="rationale" style="margin-top:7px">'+esc(a.reasoning)+'</div></div>'}).join('')+'</div></section>'}
function renderTickets(items){if(!items.length)return'';return'<section class="section"><h3>Linear deferrals</h3><div class="grid">'+items.map(t=>'<div class="card ticket"><div class="card-title">'+(t.url?'<a href="'+esc(safeUrl(t.url))+'" target="_blank" rel="noreferrer">'+esc(t.identifier||t.title)+'</a>':esc(t.identifier||t.title))+'</div>'+(t.error?'<div class="rationale" style="color:var(--red)">'+esc(t.error)+'</div>':'')+'</div>').join('')+'</div></section>'}
function renderTimeline(events){const visible=events.filter(e=>e.type!=='model_delta');return'<section class="section"><h3>Timeline</h3><div class="timeline">'+visible.map(e=>'<div class="event '+esc(e.type)+'"><span class="event-dot"></span><span class="event-time">'+fmtTime(e.timestamp)+'</span><div><div class="event-msg">'+(e.stage?'<span class="event-stage">'+esc(e.stage)+'</span>':'')+esc(e.message)+'</div>'+(e.data&&Object.keys(e.data).length?'<details><summary>data</summary><pre>'+esc(JSON.stringify(e.data,null,2))+'</pre></details>':'')+'</div></div>').join('')+'</div></section>'}
function showView(view){const isSettings=view==='settings';document.getElementById('observer-view').classList.toggle('hidden',isSettings);document.getElementById('settings-view').classList.toggle('hidden',!isSettings);document.getElementById('nav-observer').classList.toggle('active',!isSettings);document.getElementById('nav-settings').classList.toggle('active',isSettings);if(isSettings){loadGitHubSettings();loadProviderSettings();loadRuntimeSettings()}}
function setSettingsStatus(id,message,kind=''){const el=document.getElementById(id);el.textContent=message;el.className='settings-status '+kind}
const REQUEST_TOKEN=__AGENTIC_REVIEW_REQUEST_TOKEN__;
async function apiPost(path,body={}){const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-Agentic-Review-Token':REQUEST_TOKEN},body:JSON.stringify(body)});const payload=await response.json();if(!response.ok||payload.error)throw new Error(payload.error||'Request failed');return payload}
function setRepositoryControlsEnabled(enabled){['repo-search','repo-save','repo-refresh','repo-search-clear','github-disconnect'].forEach(id=>{const el=document.getElementById(id);if(el)el.disabled=!enabled});document.getElementById('repo-results').classList.toggle('disabled',!enabled)}
function renderSettings(){const profile=document.getElementById('github-profile'),selected=document.getElementById('github-repository'),results=document.getElementById('repo-results'),count=document.getElementById('repo-match-count'),selectedLabel=document.getElementById('repo-selected');if(github.connected){profile.innerHTML='<div class="github-profile">'+(github.avatarUrl?'<img src="'+esc(safeUrl(github.avatarUrl))+'" alt="">':'')+'<div><strong>@'+esc(github.login||'connected')+'</strong><div class="settings-note">GitHub CLI auth · '+esc(github.repository||'Choose a repository')+'</div></div></div>';setRepositoryControlsEnabled(true);setSettingsStatus('github-status','Using GitHub CLI authentication','ok')}else{profile.innerHTML='';repositories=[];document.getElementById('repo-search').value='';selected.value='';results.innerHTML='<div class="repo-empty">Run gh auth login, then refresh GitHub CLI auth.</div>';count.textContent='GitHub CLI authentication required';selectedLabel.textContent='';setRepositoryControlsEnabled(false);setSettingsStatus('github-status','Not authenticated with GitHub CLI');setSettingsStatus('repo-status','Run gh auth login --scopes repo,read:org to enable repository search')}}
function renderProviderSettings(){document.getElementById('anthropic-key-status').textContent=providers.anthropic?'configured':'not configured';document.getElementById('openai-key-status').textContent=providers.openai?'configured':'not configured'}
function renderRuntimeSettings(){document.getElementById('force-dry-run').checked=settings.forceDryRun===true;setSettingsStatus('runtime-status',settings.forceDryRun?'Dry-run enforced: reviews will report findings without writes':'Dry-run not enforced')}
async function loadRuntimeSettings(){try{const data=await fetch('/api/settings/runtime').then(r=>r.json());settings=data.settings||settings;renderRuntimeSettings()}catch(e){setSettingsStatus('runtime-status',e.message,'error')}}
async function saveRuntimeSettings(){try{const data=await apiPost('/api/settings/runtime/dry-run',{forceDryRun:document.getElementById('force-dry-run').checked});settings=data.settings;renderRuntimeSettings();setSettingsStatus('runtime-status',settings.forceDryRun?'Dry-run enforcement enabled':'Dry-run enforcement disabled','ok')}catch(e){setSettingsStatus('runtime-status',e.message,'error');renderRuntimeSettings()}}
async function loadProviderSettings(){try{const data=await fetch('/api/settings/providers').then(r=>r.json());providers=data.providers||providers;renderProviderSettings()}catch(e){setSettingsStatus('provider-status',e.message,'error')}}
async function saveProviderKey(provider){try{const input=document.getElementById(provider+'-key'),apiKey=input.value.trim();const data=await apiPost('/api/settings/providers/save',{provider,apiKey});providers=data.providers;input.value='';renderProviderSettings();setSettingsStatus('provider-status',provider+' key saved','ok')}catch(e){setSettingsStatus('provider-status',e.message,'error')}}
async function removeProviderKey(provider){if(!confirm('Remove the locally stored '+provider+' API key?'))return;try{const data=await apiPost('/api/settings/providers/remove',{provider});providers=data.providers;renderProviderSettings();setSettingsStatus('provider-status',provider+' key removed','ok')}catch(e){setSettingsStatus('provider-status',e.message,'error')}}
async function loadGitHubSettings(){try{const data=await fetch('/api/settings/github').then(r=>r.json());github=data.connection||github;renderSettings();if(github.connected)await loadRepositories()}catch(e){setSettingsStatus('github-status',e.message,'error')}}
function fuzzyTerm(value,term){let score=0,last=-1,streak=0;for(const char of term){const index=value.indexOf(char,last+1);if(index<0)return-Infinity;const contiguous=index===last+1;streak=contiguous?streak+1:0;score+=12-index*.02+(contiguous?8+streak*2:0);if(index===0||'/_-'.includes(value[index-1]||''))score+=14;last=index}return score}
function repositoryScore(fullName,query){const value=fullName.toLowerCase(),terms=query.toLowerCase().trim().split(/\s+/).filter(Boolean);if(!terms.length)return 0;let score=0;for(const term of terms){const termScore=fuzzyTerm(value,term);if(!Number.isFinite(termScore))return-Infinity;score+=termScore;if(value.includes(term))score+=120-term.length}if(value.startsWith(terms.join('')))score+=80;return score}
function selectRepositoryOption(repository){document.getElementById('github-repository').value=repository;document.getElementById('repo-selected').textContent='Selected: '+repository;renderRepositoryOptions()}
function renderRepositoryOptions(){const input=document.getElementById('repo-search'),selected=document.getElementById('github-repository'),results=document.getElementById('repo-results'),count=document.getElementById('repo-match-count'),selectedLabel=document.getElementById('repo-selected'),query=input.value.trim(),previous=selected.value||github.repository;const matched=repositories.map(repo=>({repo,score:repositoryScore(repo.fullName,query)})).filter(item=>Number.isFinite(item.score)).sort((a,b)=>b.score-a.score||a.repo.fullName.localeCompare(b.repo.fullName));if(previous&&matched.some(item=>item.repo.fullName===previous))selected.value=previous;else if(github.repository&&matched.some(item=>item.repo.fullName===github.repository))selected.value=github.repository;if(selected.value)selectedLabel.textContent='Selected: '+selected.value;else selectedLabel.textContent='No repository selected yet';results.innerHTML=matched.length?matched.map(({repo})=>'<button type="button" class="repo-option '+(repo.fullName===selected.value?'selected':'')+'" role="option" aria-selected="'+(repo.fullName===selected.value?'true':'false')+'" data-repo="'+esc(repo.fullName)+'"><span>'+esc(repo.fullName)+'</span><small>'+(repo.private?'private':'public')+'</small></button>').join(''):'<div class="repo-empty">No repositories match “'+esc(query)+'”.</div>';results.querySelectorAll('.repo-option').forEach(button=>button.onclick=()=>selectRepositoryOption(button.dataset.repo));count.textContent=(query?matched.length+' fuzzy matches of ':matched.length+' of ')+repositories.length+' repositories loaded';setSettingsStatus('repo-status',matched.length?'Search the full list, click a repository, then save it':'No repositories match “'+query+'”',matched.length?'':'error')}
async function loadRepositories(){try{setSettingsStatus('repo-status','Loading every accessible repository from GitHub…');const data=await fetch('/api/settings/github/repos').then(async r=>{const p=await r.json();if(!r.ok)throw new Error(p.error||'Could not list repositories');return p});repositories=data.repositories||[];renderRepositoryOptions()}catch(e){setSettingsStatus('repo-status',e.message,'error')}}
async function refreshGitHubAuth(){try{await loadGitHubSettings()}catch(e){setSettingsStatus('github-status',e.message,'error')}}
async function saveRepository(){try{const repository=document.getElementById('github-repository').value;const data=await apiPost('/api/settings/github/repository',{repository});github=data.connection;renderSettings();setSettingsStatus('repo-status','Watcher target saved: '+repository,'ok')}catch(e){setSettingsStatus('repo-status',e.message,'error')}}
async function disconnectGitHub(){if(!confirm('Clear the locally saved repository selection? This does not log out of GitHub CLI.'))return;try{const data=await apiPost('/api/settings/github/disconnect');github=data.connection;repositories=[];document.getElementById('repo-search').value='';document.getElementById('github-repository').value='';document.getElementById('repo-results').innerHTML='';renderSettings();if(github.connected)await loadRepositories()}catch(e){setSettingsStatus('github-status',e.message,'error')}}
async function bootstrap(){try{const [runData,statusData,githubData,providerData,runtimeData]=await Promise.all([fetch('/api/runs').then(r=>r.json()),fetch('/api/status').then(r=>r.json()),fetch('/api/settings/github').then(r=>r.json()),fetch('/api/settings/providers').then(r=>r.json()),fetch('/api/settings/runtime').then(r=>r.json())]);runs=runData.runs||[];watcher=statusData.watcher||watcher;github=githubData.connection||github;providers=providerData.providers||providers;settings=runtimeData.settings||settings;if(runs[0])selectedId=runs[0].id;render();renderSettings();renderProviderSettings();renderRuntimeSettings()}catch(e){console.error(e)}connect()}
function connect(){const c=document.getElementById('connection'),label=c.querySelector('span:last-child'),es=new EventSource('/api/events');const setLabel=()=>label.textContent='live · watcher '+(watcher.polling?'polling':watcher.waitingFor?'waiting: '+watcher.waitingFor:watcher.running?'on':'off');es.onopen=()=>{c.classList.add('live');setLabel()};es.onerror=()=>{c.classList.remove('live');label.textContent='reconnecting'};es.addEventListener('snapshot',e=>{const d=JSON.parse(e.data);runs=d.runs||runs;watcher=d.watcher||watcher;github=d.github||github;providers=d.providers||providers;settings=d.settings||settings;if(!selectedId&&runs[0])selectedId=runs[0].id;setLabel();render();renderSettings();renderProviderSettings();renderRuntimeSettings()});es.addEventListener('run',e=>upsert(JSON.parse(e.data)));es.addEventListener('watcher',e=>{watcher=JSON.parse(e.data);setLabel();render()});es.addEventListener('github',e=>{github=JSON.parse(e.data);renderSettings();if(github.connected)loadRepositories()});es.addEventListener('providers',e=>{providers=JSON.parse(e.data);renderProviderSettings()});es.addEventListener('settings',e=>{settings=JSON.parse(e.data);renderRuntimeSettings()})}
document.getElementById('nav-observer').onclick=()=>showView('observer');document.getElementById('nav-settings').onclick=()=>showView('settings');document.getElementById('github-refresh-auth').onclick=refreshGitHubAuth;document.getElementById('repo-search').oninput=renderRepositoryOptions;document.getElementById('repo-search-clear').onclick=()=>{document.getElementById('repo-search').value='';renderRepositoryOptions();document.getElementById('repo-search').focus()};document.getElementById('repo-refresh').onclick=loadRepositories;document.getElementById('repo-save').onclick=saveRepository;document.getElementById('github-disconnect').onclick=disconnectGitHub;document.getElementById('anthropic-save').onclick=()=>saveProviderKey('anthropic');document.getElementById('anthropic-remove').onclick=()=>removeProviderKey('anthropic');document.getElementById('openai-save').onclick=()=>saveProviderKey('openai');document.getElementById('openai-remove').onclick=()=>removeProviderKey('openai');document.getElementById('force-dry-run').onchange=saveRuntimeSettings;
bootstrap();setInterval(()=>{if(runs.some(r=>['queued','running'].includes(r.status)))render()},1000);
</script>
</body>
</html>`;
