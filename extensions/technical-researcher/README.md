# Technical Researcher Extension

Global pi extension for read-only technical research and durable reference-document generation.

This extension is intentionally researcher-only. Planning Agent is a separate extension at `extensions/planning-agent/` with its own commands, state, prompt, output artifact, and save flow.

## Commands

- `/research <context>` — start Technical Researcher mode.
- `/technical-research <context>` — alias.
- `/researcher <context>` — alias.
- `/research-off` — disable Technical Researcher mode and restore default tools.
- `/research-status` — show active state and captured artifact metadata.
- `/save-research [path]` — save the last captured research artifact into a knowledgebase path. If no path is given and the current directory is ambiguous, the extension prompts for the target project/vault/path.

## Prompt

Research instructions live at:

- `prompts/technical-researcher.md`

## Behavior

- Read-only while active.
- Allowed tools: read/search/retrieval tools, vector retrieval (`rag_search`), web search/fetch tools (including MCP gateway web-search calls), graphify-rs retrieval MCP aliases, and safe read-only shell commands.
- Blocked actions: edits/writes, installs, destructive shell commands, git mutations, Docker mutations, deploys, and write-like external API calls.
- Output goal: a knowledgebase-ready Markdown reference document headed `# Technical Research Brief: <topic>`.

## Invocation

```text
/research document the authentication architecture, data flow, trust boundaries, and open requirements for this repo
```

Use `/save-research [path]` after a research artifact has been captured.
