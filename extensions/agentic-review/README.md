# LangGraph Agentic Review

A pi extension that runs asynchronous, policy-gated pull request reviews when an open, non-draft PR carries the `👀 Ready for review` label.

## Workflow

The review is a real `@langchain/langgraph` state machine:

```text
gather PR context
  → agentic review (one pass per diff chunk)
  → classify findings
  → analyze bugs against acceptance criteria
  → create Linear tickets for non-blocking follow-ups
  → deterministic quality gate
  → post GitHub comments and review event
```

The agentic review node shares the exact reviewer instruction source used by the `/prs` extension. The model identifies and analyzes findings; TypeScript code enforces the final gate.

### Gate policy

| Findings                                                 | GitHub review                                                   |
| -------------------------------------------------------- | --------------------------------------------------------------- |
| Any critical finding                                     | Request changes                                                 |
| Bug analysis says the issue directly blocks a safe merge | Request changes                                                 |
| Non-blocking bug marked for follow-up                    | Approve with comments; create a Linear follow-up when available |
| Non-blocking bug that only needs review context          | Approve with comments                                           |
| Only nice-to-haves and/or nits                           | Approve with comments                                           |
| No findings                                              | Approve                                                         |

The extension does **not** create, remove, or update outcome labels. Repository auto-labelling workflows are expected to translate the submitted `APPROVE` or `REQUEST_CHANGES` review into labels such as `‼️ Merge with comments`, `✅ Ready to merge`, or `😭 Changes requested`.

A bug is not automatically merge-blocking. The deterministic gate only requests changes for critical findings or bugs whose bug-analysis pass sets `mergeImpact` to `blocking`; otherwise bugs are surfaced as comments and, when marked `follow-up`, tracked in Linear if possible.

## Commands

```text
/agentic-review 123
/agentic-review #123 --dry-run
/agentic-review 123 --force
/agentic-review                    # PR for current git branch

/agentic-review-watch on           # start poller and run immediately
/agentic-review-watch off
/agentic-review-watch run          # one polling pass
/agentic-review-watch status

/agentic-review-server             # start watcher + UI, poll now, open browser
/agentic-review-server start       # start watcher + UI without opening browser
/agentic-review-server stop
/agentic-review-server status
/agentic-review-ui                 # alias for /agentic-review-server

/agentic-review-model              # show resolved model
/agentic-review-model ollama/qwen3.6:latest
/agentic-review-model anthropic/claude-sonnet-4-5
/agentic-review-model openai/gpt-5
/agentic-review-model llama.server/qwen3-coder
/agentic-review-model current      # follow pi's selected model again

/agentic-review-config
```

Model changes made with `/agentic-review-model` last for the current pi process. Use a config file or environment variables for a persistent choice.

## Web UI observer

Run:

```text
/agentic-review-server
```

This single command starts the loopback HTTP server and the `👀 Ready for review` watcher, then opens the dashboard. The watcher stays idle until GitHub is authenticated and a repository has been selected in Settings. Once both are configured, it immediately polls that selected repository. All manual and watcher-triggered workflows report to the UI. `/agentic-review-ui` is an alias.

The server binds to `127.0.0.1:4317`. If that port is occupied, it tries the next nine ports. Set port `0` to request an ephemeral port.

The dashboard observes both manual and poller-driven reviews end to end:

- queued, running, succeeded, failed, and skipped runs;
- repository, PR, source, model, duration, and dry-run state;
- a selectable `gather → review → classify → analyze-bugs → log-deferrals → gate → apply` graph;
- sanitized input, output, status, and logs for each selected step invocation;
- bounded live LLM output streams for review, classification, and bug-analysis steps; reasoning/thinking deltas are intentionally omitted from retained dashboard telemetry;
- per-chunk model-review progress and truncated review output;
- finding counts and severity breakdowns;
- acceptance-criteria, merge-impact, and edge-case dispositions;
- Linear ticket identifiers, links, and failures;
- deterministic `APPROVE` or `REQUEST_CHANGES` decisions; and
- GitHub inline-comment and review-submission results.

Updates stream live through Server-Sent Events. Step I/O is intentionally bounded: raw diffs and credentials are excluded, review/classification output is truncated before entering telemetry, and model stream telemetry is capped so high-reasoning models cannot exhaust the pi process heap. The server binds only to loopback.

Observer endpoints are read-only:

```text
GET /api/health
GET /api/status
GET /api/runs
GET /api/runs/:id
GET /api/events       # SSE
```

Settings adds same-origin-only mutations for repository selection, provider keys, and runtime safety toggles. GitHub auth always comes from the local GitHub CLI (`gh auth token`) and tokens are never persisted or returned by an endpoint. Run history is in-memory and bounded by `webUi.maxRuns`; it disappears when the pi process exits. `/agentic-review-server stop` shuts down both the watcher and Web UI.

When `webUi.enabled` is `true`, both the server and watcher start automatically with the pi session. `openOnStart` controls whether a browser opens.

## Settings: GitHub and model credentials

Open **Settings** in the dashboard.

### GitHub CLI and repository

1. Authenticate the GitHub CLI with repository access:

   ```bash
   gh auth login --scopes repo,read:org
   ```

   If you are already logged in but private repositories are missing, refresh scopes:

   ```bash
   gh auth refresh -s repo -s read:org
   ```

2. Open Settings and select **Refresh GitHub CLI auth**.
3. Fuzzy-search the complete accessible repository list by owner/name, select a result, and save it.

Repository loading follows GitHub pagination across the complete accessible set. The Settings picker shows a searchable, scrollable result list. Leaving search empty displays every loaded repository; typing filters with subsequence, contiguous-character, path-boundary, and substring scoring. Match/total counts show how many repositories are loaded and visible.

The selected repository is required for the watcher and overrides local git-remote detection for polling. Selecting a new repository triggers an immediate poll when the watcher is running and GitHub CLI auth is available. Required GitHub CLI scopes are `repo read:org`.

Only repository selection metadata is stored at:

```text
~/.pi/agent/agentic-review-github.json
```

The file is mode `0600`. The GitHub token is read from `gh auth token` at runtime and is not written to this file. Clearing the saved repository does not log out of GitHub CLI; use `gh auth logout` if you need to revoke local CLI auth.

### Anthropic and OpenAI keys

Settings provides password inputs for Anthropic and OpenAI. Saved keys override pi's normal provider credential resolution for this review workflow only. The page receives only `configured`/`not configured` status.

Local Ollama models do not need a Settings key. Keep Ollama running locally and target the `ollama/<model>` provider in config or with `/agentic-review-model`.

Keys are stored at:

```text
~/.pi/agent/agentic-review-provider-keys.json
```

This file is also mode `0600`.

### Enforced dry-run mode

Settings includes **Enforce dry-run for all runs**. When enabled, it overrides project/user config and makes every manual or watcher-triggered run report findings only. GitHub review/comment submission and Linear ticket creation are skipped; the observer still shows findings, bug analysis, gate decisions, and candidate comments.

The toggle is stored locally at:

```text
~/.pi/agent/agentic-review-settings.json
```

The file is mode `0600`.

## Trigger

pi does not expose a GitHub webhook receiver, so the extension uses a cleanup-safe background poller. It selects PRs that are:

- open;
- not drafts; and
- labelled exactly `👀 Ready for review` (the label from `/sync-pr-labels`).

Polling is opt-in to avoid unexpected model spend and GitHub writes from a globally installed extension. Even when enabled, no GitHub polling command runs until GitHub CLI authentication is available and a repository is saved in Settings. Enable the watcher in one of three ways:

```text
/agentic-review-watch on
```

```bash
pi --agentic-review-watch
```

or set `polling.enabled` to `true` in config. The core `runReviewWorkflow()` is trigger-independent and can be called by a webhook adapter later.

The extension records successful reviews by repository, PR number, and head SHA in `.pi/agentic-review-state.json`. A new commit is reviewable; the same commit is skipped unless `--force` is used. This also prevents duplicate reviews while repository auto-labelling catches up. Before posting, the graph fetches the PR again and refuses to post a stale review if the head changed during processing.

If an agentic review has already been submitted, re-applying `👀 Ready for review` is not enough to trigger another posted review. Before spending model time or writing to GitHub, the workflow checks GitHub itself: it skips when the latest agentic review is already on the current head SHA, and it also skips while any previous review conversation is still unresolved. Resolve the review comments first, then push a new commit or rerun with `--force` if you intentionally want another review.

### Author allowlist

Set `github.authorAllowlist` to restrict automated reviews to trusted PR authors. Empty arrays mean all authors are allowed. To review only PRs authored by members of the `metalabdesign` GitHub organization:

```json
{
	"github": {
		"authorAllowlist": {
			"users": [],
			"organizations": ["metalabdesign"],
			"teams": []
		}
	}
}
```

For a specific GitHub team, use a team slug. Bare team slugs resolve under the repository owner; use `org/team-slug` to be explicit:

```json
{
	"github": {
		"authorAllowlist": {
			"users": [],
			"organizations": [],
			"teams": ["metalabdesign/engineering"]
		}
	}
}
```

Membership checks use GitHub CLI auth and require `read:org` for private organization/team membership.

## Configuration

Configuration is merged in this order:

1. defaults;
2. `~/.pi/agent/agentic-review.json`;
3. `<repo>/.pi/agentic-review.json`;
4. environment variables;
5. current-session `/agentic-review-model` override.

Example project config:

```json
{
	"polling": {
		"enabled": true,
		"intervalMs": 180000
	},
	"webUi": {
		"enabled": true,
		"port": 4317,
		"openOnStart": false,
		"maxRuns": 100
	},
	"model": {
		"provider": "ollama",
		"id": "qwen3.6:latest",
		"temperature": 0.1,
		"maxTokens": 8192,
		"ollama": {
			"baseUrl": "http://127.0.0.1:11434/v1",
			"apiKey": "ollama",
			"contextWindow": 262144
		}
	},
	"review": {
		"maxDiffCharsPerChunk": 60000,
		"maxChunks": 20,
		"postInlineComments": true
	},
	"github": {
		"triggerLabel": "👀 Ready for review",
		"repository": "optional-owner/repository",
		"authorAllowlist": {
			"users": [],
			"organizations": ["metalabdesign"],
			"teams": []
		}
	},
	"linear": {
		"enabled": true,
		"team": "ENG",
		"projectId": "optional-linear-project-uuid",
		"labelIds": []
	},
	"dryRun": false,
	"stateFile": ".pi/agentic-review-state.json"
}
```

Omit `model.provider` and `model.id` to use the model currently selected in pi.

### Ollama local model

Install Ollama and pull the local review model:

```bash
brew install ollama
ollama pull qwen3.6
```

If the Ollama app is not already running, start the API server:

```bash
ollama serve
```

Verify the OpenAI-compatible endpoint sees the model:

```bash
curl http://127.0.0.1:11434/v1/models
```

Persistently target the local Qwen 3.6 model with `~/.pi/agent/agentic-review.json` or `<repo>/.pi/agentic-review.json`:

```json
{
	"model": {
		"provider": "ollama",
		"id": "qwen3.6:latest",
		"maxTokens": 8192,
		"ollama": {
			"baseUrl": "http://127.0.0.1:11434/v1",
			"apiKey": "ollama",
			"contextWindow": 262144
		}
	}
}
```

For a session-only switch, run:

```text
/agentic-review-model ollama/qwen3.6:latest
```

`ollama` is registered as an OpenAI-compatible local provider by the extension. The `apiKey` is a placeholder because Ollama ignores it.

### Anthropic

Use any Anthropic model present in pi's model registry:

```json
{
	"model": {
		"provider": "anthropic",
		"id": "claude-sonnet-4-5"
	}
}
```

Authentication comes from the review-specific Settings key, then pi (`~/.pi/agent/auth.json`) or `ANTHROPIC_API_KEY`.

### OpenAI

```json
{
	"model": {
		"provider": "openai",
		"id": "gpt-5"
	}
}
```

Authentication comes from the review-specific Settings key, then pi or `OPENAI_API_KEY`.

### Other OpenAI-compatible local servers

For llama.cpp `llama-server`, LM Studio, vLLM, or another OpenAI-compatible local runtime, use the `llama-server` provider and point it at that server:

```json
{
	"model": {
		"provider": "llama-server",
		"id": "qwen3-coder",
		"maxTokens": 8192,
		"llamaServer": {
			"baseUrl": "http://127.0.0.1:8080/v1",
			"apiKey": "local",
			"contextWindow": 131072
		}
	}
}
```

`llama.server`, `llama_server`, and `llama-server` are accepted in `/agentic-review-model` and environment configuration; the canonical provider name is `llama-server`.

### Linear

Set:

```bash
export LINEAR_API_KEY=lin_api_...
export AGENTIC_REVIEW_LINEAR_TEAM=ENG
```

`linear.team` may be a team UUID, key, or exact name. If omitted, the extension tries the prefix of a linked Linear issue (for example `ENG` from `ENG-123`), then uses the only visible team when exactly one exists. It fails closed when the team is ambiguous.

A follow-up ticket contains:

- source repository, PR URL/number, branch, and reviewed SHA;
- file/line source context;
- finding rationale;
- merge-impact and edge-case context;
- acceptance-criteria impact;
- linked Linear issue context when available; and
- a regression-test follow-up.

If a bug is marked as a non-blocking `follow-up`, the workflow attempts to create a durable Linear ticket. Linear failures are reported in the review summary and observer UI, but they do not by themselves convert the review to **Request changes**.

## Environment variables

| Variable                                              | Purpose                                                                                         |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `AGENTIC_REVIEW_ENABLED`                              | Enable/disable polling                                                                          |
| `AGENTIC_REVIEW_POLL_INTERVAL_MS`                     | Poll interval (minimum 15000)                                                                   |
| `AGENTIC_REVIEW_UI_ENABLED`                           | Start the observer with the pi session                                                          |
| `AGENTIC_REVIEW_UI_PORT`                              | Preferred loopback port (`0` for ephemeral)                                                     |
| `AGENTIC_REVIEW_UI_OPEN_ON_START`                     | Open a browser after automatic startup                                                          |
| `AGENTIC_REVIEW_UI_MAX_RUNS`                          | In-memory run retention (10–1000)                                                               |
| `AGENTIC_REVIEW_GITHUB_REPOSITORY`                    | Repository override in `owner/name` format                                                      |
| `AGENTIC_REVIEW_ALLOWED_AUTHOR_USERS`                 | Comma-separated GitHub usernames allowed to trigger reviews                                     |
| `AGENTIC_REVIEW_ALLOWED_AUTHOR_ORGS`                  | Comma-separated GitHub orgs whose members may trigger reviews                                   |
| `AGENTIC_REVIEW_ALLOWED_AUTHOR_TEAMS`                 | Comma-separated GitHub teams (`team-slug` or `org/team-slug`) whose members may trigger reviews |
| `AGENTIC_REVIEW_MODEL`                                | `provider/model`                                                                                |
| `AGENTIC_REVIEW_PROVIDER` / `AGENTIC_REVIEW_MODEL_ID` | Separate model selector                                                                         |
| `AGENTIC_REVIEW_TEMPERATURE`                          | Model temperature                                                                               |
| `AGENTIC_REVIEW_MAX_TOKENS`                           | Completion limit                                                                                |
| `OLLAMA_BASE_URL` / `OLLAMA_URL`                      | Ollama OpenAI-compatible base URL                                                               |
| `OLLAMA_API_KEY`                                      | Optional Ollama placeholder key                                                                 |
| `OLLAMA_CONTEXT_WINDOW`                               | Registered Ollama model context size                                                            |
| `AGENTIC_REVIEW_DIFF_CHUNK_CHARS`                     | Maximum characters per review pass                                                              |
| `AGENTIC_REVIEW_MAX_DIFF_CHUNKS`                      | Fail-closed chunk limit                                                                         |
| `AGENTIC_REVIEW_POST_INLINE_COMMENTS`                 | Enable inline suggestion comments                                                               |
| `AGENTIC_REVIEW_DRY_RUN`                              | Run graph without GitHub/Linear writes                                                          |
| `LLAMA_SERVER_URL`                                    | OpenAI-compatible base URL                                                                      |
| `LLAMA_SERVER_API_KEY`                                | Optional local-server key                                                                       |
| `LLAMA_SERVER_CONTEXT_WINDOW`                         | Registered local model context size                                                             |
| `LINEAR_API_KEY`                                      | Linear personal/API key                                                                         |
| `AGENTIC_REVIEW_LINEAR_ENABLED`                       | Enable/disable Linear integration                                                               |
| `AGENTIC_REVIEW_LINEAR_TEAM`                          | Team UUID/key/name                                                                              |
| `AGENTIC_REVIEW_LINEAR_PROJECT_ID`                    | Project UUID for follow-ups                                                                     |
| `AGENTIC_REVIEW_LINEAR_LABEL_IDS`                     | Comma-separated label UUIDs                                                                     |

## Development

From the repository root:

```bash
corepack enable
pnpm install
pnpm check
pnpm test:agentic-review
```
