# Planning Agent Extension

Global pi extension for technical implementation planning, with an explicit handoff mode for approved Linear/Notion writes.

This extension is intentionally planner-only. Technical Researcher is a separate extension at `extensions/technical-researcher/` with its own commands, state, prompt, output artifact, and save flow.

## Commands

- `/implementation-plan <context>` — start Planning Agent mode with the provided request/context.
- `/plan-agent <context>` — alias.
- `/planning-agent <context>` — alias.
- `/planning-agent-off` — disable Planning Agent mode and restore default tools.
- `/planning-agent-status` — show active state, handoff state, targets, and captured plan metadata.
- `/planning-agent-handoff [context or Notion target URL]` — after user confirmation, enable guarded Linear/Notion handoff tools.
- `/planning-agent-handoff-off` — disable handoff mode and return to read-only planning.
- `/save-plan [path]` — save the last captured `# Technical Implementation Plan`. Defaults to `.pi/plans/<timestamp>-implementation-plan.md`.

## Prompt

Planning instructions live at:

- `prompts/technical-planning-agent.md`

## Behavior

### Read-only planning mode

- Allowed tools: read/search/retrieval tools, vector retrieval (`rag_search`), read-only MCP calls (direct tools or the MCP gateway), web search/fetch tools, graphify-rs retrieval MCP aliases, and safe read-only shell commands.
- Blocked actions: edits/writes, installs, destructive shell commands, git mutations, Docker mutations, deploys, and write-like external API calls.
- Output goal: an engineering-ready Markdown implementation plan headed `# Technical Implementation Plan`.

### Approved handoff mode

`/planning-agent-handoff` keeps planning mode active but adds guarded external handoff tools.

Allowed after approval:

- Existing read-only planning tools.
- Linear read tools.
- Linear handoff writes through `linear_save_issue`, `linear_save_comment`, and `linear_save_document` only.
- Notion setup/read tools.
- Notion create/update/append/save/post-style writes only when scoped to the approved Notion target.

Guardrails:

- Linear handoff supports all Linear teams, projects, and issues; there is no project allowlist.
- Linear issue creation must include a `team`, unless `PLANNING_AGENT_LINEAR_TEAM` is set as a convenience default.
- `PLANNING_AGENT_LINEAR_PROJECT` can set a convenience default project, but does not restrict writes to that project.
- `PLANNING_AGENT_LINEAR_REQUIRED_LABELS` can inject comma-separated labels when a team/project wants standardized handoff labels; by default no labels are injected.
- Linear comments/documents must target an explicit issue or project, unless a default project is configured.
- Linear deletes, project/milestone/initiative/status mutations, attachments, and label creation are blocked.
- Notion writes require an approved target via:
  - a Notion URL passed to `/planning-agent-handoff`, or
  - `PLANNING_AGENT_NOTION_TARGET_URL`, or
  - `PLANNING_AGENT_NOTION_TARGET_ID`.
- Every Linear/Notion write call shows a confirmation dialog before execution.
- Linear issues use the required concise Markdown format: Goal, Context, Scope, optional Constraints, Acceptance criteria, and optional Open questions. The agent preserves source facts and does not infer missing details.
- File writes remain blocked except `/save-plan`.
- MCP gateway calls are allowed only for discovery and read-only tool calls (`get`/`list`/`search`/`query`/`read`/`fetch`/similar); gateway mutations and bypass paths remain blocked by the normal planning tool gate.

## Invocation

```text
/implementation-plan build the new billing webhook flow from docs/billing.md and src/webhooks
```

```text
/planning-agent-handoff Create Linear handoff issues from the captured plan and post the summary to https://www.notion.so/...
```

Use `/save-plan [path]` after a plan has been captured.
