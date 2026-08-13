<p align="center">
  <a href="https://pi.dev">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://pi.dev/logo.svg">
      <source media="(prefers-color-scheme: light)" srcset="https://huggingface.co/buckets/julien-c/my-training-bucket/resolve/pi-logo-dark.svg">
      <img alt="pi logo" src="https://pi.dev/logo.svg" width="128">
    </picture>
  </a>
</p>

<h1 align="center">pi-extensions</h1>

Curtis Blanchette's personal [pi](https://github.com/earendil-works/pi) extensions, packaged so users can install them directly from GitHub without cloning this repository into their own pi setup.

```bash
pi install git:github.com/curtisblanchette/pi-extensions
```

> Screenshots below are illustrative terminal captures of the current extension UIs.

## Requirements

- `pi` installed and configured.
- `git` available in the repositories where commands run.
- GitHub CLI (`gh`) installed and authenticated for GitHub-backed workflows:
  ```bash
  gh auth login
  ```
- A configured pi model/API key for AI-assisted `/prs` actions such as PR description generation and review comments.

## Extensions at a glance

| Extension                                                     | Commands                                                                                                                                      | Best for                                                                                                                                 |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| [`commit-pr.ts`](./extensions/commit-pr.ts)                   | `/commit`, `/commit-pr`                                                                                                                       | Stage files, write a Conventional Commit, push a branch, and open a draft PR from one TUI.                                               |
| [`planning-agent/`](./extensions/planning-agent/)             | `/implementation-plan`, `/planning-agent`, `/save-plan`                                                                                       | Run a read-only planner that produces engineering-ready implementation plans.                                                            |
| [`technical-researcher/`](./extensions/technical-researcher/) | `/research`, `/technical-research`, `/save-research`                                                                                          | Run a separate read-only researcher that produces knowledgebase-ready technical research briefs.                                         |
| [`prs.ts`](./extensions/prs.ts)                               | `/prs`                                                                                                                                        | Browse open PRs, inspect CI state, checkout branches, update descriptions, run review workflows, and explain failures.                   |
| [`agentic-review/`](./extensions/agentic-review/)             | `/agentic-review`, `/agentic-review-server`, `/agentic-review-watch`, `/agentic-review-ui`, `/agentic-review-model`, `/agentic-review-config` | Run and observe asynchronous LangGraph PR reviews with deterministic quality gates, configurable models, and Linear edge-case deferrals. |
| [`sync-pr-labels.ts`](./extensions/sync-pr-labels.ts)         | `/sync-pr-labels`                                                                                                                             | Normalize a repository's PR workflow labels to the approved label set.                                                                   |

## Install

Install globally for all pi sessions:

```bash
pi install git:github.com/curtisblanchette/pi-extensions
```

Try it for one run without saving it to settings:

```bash
pi -e git:github.com/curtisblanchette/pi-extensions
```

Update after installing:

```bash
pi update git:github.com/curtisblanchette/pi-extensions
```

Remove later if needed:

```bash
pi remove git:github.com/curtisblanchette/pi-extensions
```

## Extension highlights

### `/commit` and `/commit-pr` — Commit, push, and draft PR wizard

![Commit PR wizard screenshot](./assets/screenshots/commit-pr.svg)

An interactive git workflow for turning local changes into a pushed branch and draft pull request.

**What it does**

- Detects changed, staged, unstaged, renamed, and untracked files.
- Lets you select exactly which files should be committed.
- Shows an inline per-file diff while selecting files.
- Suggests a Conventional Commit message from changed paths/diffs.
- Lets you push to the current branch or create a new branch.
- Runs `git add`/`restore --staged`, `git commit`, `git push -u`, and `gh pr create --draft`.
- Builds a PR body from the repository PR template when one exists.
- Opens the PR in the browser and applies the `🛠️ Work in progress` label to draft PRs when possible.

**Use cases**

- You have a mixed working tree and want to safely commit only the intended files.
- You are on `main`, `master`, `develop`, or `trunk` and want a guided new-branch flow.
- You want consistent Conventional Commits without manually crafting the first draft.
- You want to reduce context switching between pi, git, and GitHub when creating PRs.

**Run**

```text
/commit
# or
/commit-pr
```

---

### `/prs` — Pull request command center

![PR browser screenshot](./assets/screenshots/prs.svg)

A terminal PR browser and action launcher inside pi.

**What it does**

- Lists open and draft PRs for the active GitHub repository.
- Shows PR branch, author, updated time, URL, and CI/check status.
- Keeps workflow labels fresh based on draft/review state where possible.
- Checks out a selected PR branch locally.
- Addresses unresolved review threads by pulling the PR branch, having the agent implement requested fixes and missing documentation, then replying with the pushed commit details and resolving each addressed thread.
- Generates and lets you edit an AI-written PR description before updating GitHub.
- Marks draft PRs ready for review.
- Runs agentic review flows that let you deselect and confirm inline comments before posting, then submit either **Request Changes** or **Approve**; approvals can optionally add the `‼️ Merge with comments` label.
- Explains failing GitHub Actions/check runs using the active pi model, with a fallback summary when model auth is unavailable, then—after explicit approval—checks out the PR branch for the agent to fix, verify, commit, and push.

**Use cases**

- You review several PRs per day and want a keyboard-first selector in pi.
- You need to jump from a PR list to the branch locally without remembering `gh pr checkout` syntax.
- Review comments need code or documentation updates and you want the agent to implement, verify, commit, push, and close the loop on GitHub.
- A PR description is stale or empty and you want a diff/template-aware draft.
- CI is red and you want a plain-English failure summary, then an approved fix-and-push workflow on the affected PR branch.
- You want AI-suggested inline review comments but still approve every comment before posting.

**Run**

```text
/prs
```

---

### `/agentic-review` — Asynchronous LangGraph review workflow

A configurable PR-review state machine that watches open PRs carrying `👀 Ready for review`, reuses the `/prs` reviewer prompt, classifies findings as critical/bug/nice-to-have/nit, analyzes bugs against acceptance criteria, logs safe edge-case deferrals in Linear, and deterministically submits either **Approve** or **Request changes**. Its Web UI includes GitHub Device Flow/repository settings, Anthropic/OpenAI key inputs, and selectable per-step I/O/log visualization. It does not mutate outcome labels; repository auto-labelling workflows remain responsible for those transitions.

```text
/agentic-review 123 --dry-run
/agentic-review-server
/agentic-review-model anthropic/claude-sonnet-4-5
/agentic-review-model openai/gpt-5
/agentic-review-model llama.server/qwen3-coder
```

See [`extensions/agentic-review/README.md`](./extensions/agentic-review/README.md) for model, polling, and Linear configuration.

---

### `/sync-pr-labels` — Repository PR label source of truth

![Sync PR labels screenshot](./assets/screenshots/sync-pr-labels.svg)

A label normalization command for the PR workflow labels used by these extensions.

**What it does**

- Detects the active GitHub repository from git remotes.
- Fetches existing labels through `gh api`.
- Dry-runs by default and shows labels that would be deleted.
- Creates or updates the approved workflow labels with canonical names, colors, and descriptions.
- Deletes labels outside the approved set only when run with `--yes`/`-y`.

**Approved workflow labels**

| Label                    | Meaning                                                                      |
| ------------------------ | ---------------------------------------------------------------------------- |
| `‼️ Merge with comments` | PR is approved, but contains comments that must be addressed before merging. |
| `✅ Ready to merge`      | PR is approved and ready for the author to merge.                            |
| `👀 Ready for review`    | PR is ready for review.                                                      |
| `😭 Changes requested`   | PR has been reviewed and updates are required.                               |
| `🚫 Do not merge`        | PR must not be merged, even if approved.                                     |
| `🛠️ Work in progress`    | PR is under construction.                                                    |
| `🧱 Blocked`             | PR cannot be finalized until blocking work is completed.                     |

**Use cases**

- You are setting up a new repository and want consistent review labels.
- Existing labels have drifted and need to be reset to the workflow source of truth.
- You want `/commit-pr` and `/prs` label automation to work predictably.

**Run**

```text
/sync-pr-labels        # dry run, shows the plan
/sync-pr-labels --yes  # apply changes
```

## Development

```bash
corepack enable
pnpm install
pnpm check
pnpm test
pnpm format:check
```

This package declares pi resources in `package.json`:

```json
{
	"pi": {
		"extensions": ["./extensions"]
	}
}
```
