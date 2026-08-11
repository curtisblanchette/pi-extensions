# pi-extension-rag

Project-local **turbovec RAG** over raw documents for the
[pi](https://github.com/earendil-works/pi-coding-agent) coding agent.

- **Embeddings:** Ollama (default model: `nomic-embed-text`, 768d)
- **Storage:** `better-sqlite3` metadata + `turbovec` IdMapIndex, project-local at `.pi/rag/`
- **Formats:** `.md` (header-aware chunking), `.txt`, `.pdf`, `.docx`
- **Incremental:** SHA-256 hash dedup — unchanged files skip embedding
- **Setup via TUI:** `/rag-setup` walks you through it; `/rag-config` edits any single field
- **Agent-callable:** the LLM can call the `rag_search` tool mid-conversation
- **MCP-compatible:** `src/mcp.ts` exposes the same RAG core to Claude Code and other MCP-capable agent harnesses

Installed globally at `~/.pi/agent/extensions/rag/`, so every project gets it.

---

## Prerequisites

1. **Ollama running locally.**
   ```bash
   brew install ollama
   ollama serve            # starts the daemon on http://localhost:11434
   ollama pull nomic-embed-text
   ```
2. **Python with pip.** turbovec currently ships Python/Rust APIs, so the TS extension uses a small Python bridge. The extension checks for `turbovec` on first vector operation and auto-installs it for the user with:
   ```bash
   python3 -m pip install --user turbovec
   ```
   Set `TURBOVEC_PYTHON=/path/to/python` to use a different interpreter, or `TURBOVEC_AUTO_INSTALL=0` to disable auto-install.
3. **Native build toolchain** (for `better-sqlite3`). On macOS, Xcode CLT is enough.

---

## Commands

| Command              | What it does                                                                          |
| -------------------- | ------------------------------------------------------------------------------------- |
| `/rag-setup`         | First-run wizard: folder, formats, exclude, Ollama URL, model, chunk size, dim probe. |
| `/rag-config`        | Settings menu — pick any single field to edit (folder, formats, exclude, URL, model, chunks, dim). |
| `/rag-index`         | Scan + (re)index the configured folder. Hash-based incremental.                       |
| `/rag-index --force` | Force re-embed every file regardless of hash.                                         |
| `/rag <query>`       | Top-k semantic search, printed inline.                                                |
| `/rag-status`        | Show config + index stats.                                                            |
| `/rag-reset`         | Delete `.pi/rag/rag.db` and `.pi/rag/rag.tvim` (keeps config).                        |

## Agent tool: `rag_search`

The LLM can call this directly to ground answers in the project's documents.

Parameters:
- `query: string` — natural-language query
- `k?: number` — top-k (default 8, max 30)
- `formats?: string[]` — restrict to extensions, e.g. `[".pdf", ".md"]`

Returns chunks with `path`, `chunk_index`, `header_path` (markdown only),
`page` (reserved for future PDF page tracking), `token_count`, `score`
(turbovec dot-product similarity over normalized embeddings, clamped to
`[-1, 1]`; higher is better), and full `text`.

## MCP server

For Claude Code or any MCP-capable harness, run the stdio server instead of the
pi extension entrypoint:

```bash
cd ~/.pi/agent/extensions/rag
npm run mcp
# or:
npx tsx ~/.pi/agent/extensions/rag/src/mcp.ts
```

Exposed MCP tools:

| Tool               | What it does                                                       |
| ------------------ | ------------------------------------------------------------------ |
| `rag_search`       | Semantic search over `.pi/rag/rag.tvim` with optional `root`.      |
| `rag_status`       | Show config path, DB path, and index stats.                        |
| `rag_index`        | Index/re-index the configured folder; detects `dim` if missing.    |
| `rag_reset`        | Delete DB files; requires `confirm: true`; keeps config.           |
| `rag_config_write` | Create/update `.pi/rag/config.json` without pi's interactive TUI.  |

Every MCP tool accepts an optional `root` because MCP servers may not start in
the current project directory. If omitted, the server tries
`CLAUDE_PROJECT_DIR`, `MCP_PROJECT_ROOT`, `PROJECT_ROOT`, then `process.cwd()`.

Claude Code registration:

```bash
cd ~/.pi/agent/extensions/rag
claude mcp add --scope user rag -- npx tsx ~/.pi/agent/extensions/rag/src/mcp.ts
```

---

## Workflow

```text
cd ~/Documents/my-project
pi
> /rag-setup           # one-time: pick folder (default: ./raw), confirm Ollama model
> /rag-index           # build the index
> /rag What is the privacy architecture?
```

After that the agent can call `rag_search` on its own when answering questions
about your project's documents.

To adjust a single setting later without re-running the whole wizard:

```text
> /rag-config          # menu — pick a field, edit it, settings persist immediately
```

The menu surfaces every editable field plus a read-only view of `provider` and
a **Reset to defaults** entry. Changing `model` clears `dim` (existing vectors
would be incompatible) and prompts you to `/rag-reset` + `/rag-index`.

---

## Files

- `~/.pi/agent/extensions/rag/`
  - `package.json` — deps (`better-sqlite3`, `pdf-parse`, `mammoth`); Python bridge expects `turbovec`
  - `src/index.ts` — pi commands + pi `rag_search` tool registration
  - `src/mcp.ts` — MCP stdio server for other agent harnesses
  - `src/setup.ts` — `/rag-setup` first-run wizard
  - `src/configMenu.ts` — `/rag-config` per-field settings menu
  - `src/pipeline.ts` — scan → diff → extract → chunk → embed → upsert
  - `src/chunk.ts` — markdown-header-aware + generic windowed chunking
  - `src/extract.ts` — md/txt/pdf/docx → plain text
  - `src/embed.ts` — Ollama `/api/embed` client (falls back to `/api/embeddings`)
  - `src/db.ts` — SQLite metadata, turbovec bridge calls, filtered search
  - `src/turbovec_bridge.py` — Python helper around `turbovec.IdMapIndex`
  - `src/config.ts` — `.pi/rag/config.json` load/save

Per-project state:

- `<project>/.pi/rag/config.json` — folder, formats, model, chunking
- `<project>/.pi/rag/rag.db` — SQLite metadata for files/chunks (gitignore this)
- `<project>/.pi/rag/rag.tvim` — turbovec `IdMapIndex` keyed by chunk row IDs (gitignore this)

---

## Configuration

`.pi/rag/config.json` is generated by `/rag-setup` and editable either via
`/rag-config` (TUI) or by hand:

```json
{
  "folder": "raw",
  "formats": [".md", ".txt", ".pdf", ".docx"],
  "provider": "ollama",
  "ollamaUrl": "http://localhost:11434",
  "model": "nomic-embed-text",
  "dim": 768,
  "bitWidth": 4,
  "chunkTokens": 800,
  "chunkOverlap": 100,
  "exclude": ["node_modules", ".git", ".obsidian", ".pi"]
}
```

Recommended `.gitignore` addition:

```gitignore
.pi/rag/
```

---

## Implementation notes

- **Embedding normalization.** Vectors are L2-normalized before insert, so
  turbovec's inner-product search is cosine-like. The returned `score` is
  clamped to `[-1, 1]`.
- **Stable vector IDs.** SQLite chunk row IDs are used as turbovec `IdMapIndex`
  external IDs, so deletes and re-indexes stay O(1) and metadata joins are
  straightforward.
- **Python bridge.** turbovec currently exposes Python/Rust APIs; `src/db.ts`
  checks/auto-installs `turbovec` and shells out to `src/turbovec_bridge.py`
  for batched add/remove/search/count.
- **Lazy native deps.** `better-sqlite3`, `pdf-parse`, `mammoth` are
  dynamic-imported only inside command/tool handlers, so pi startup stays fast
  and the extension loads cleanly even on machines where Ollama isn't installed
  yet.
- **Hash-based dedup.** Each indexed file stores a SHA-256 of its contents.
  `/rag-index` skips files whose hash hasn't changed. Use `--force` to rebuild.
- **Dimensionality.** Detected the first time the model is probed and stored in
  config + the DB's `meta` table. turbovec requires the dim to be a positive
  multiple of 8. Changing the model requires `/rag-reset`.
- **Migration from sqlite-vec.** If `.pi/rag/rag.tvim` is missing, `/rag-index`
  rebuilds vectors even when file hashes are unchanged.
- **Cancellation.** Long-running indexing currently completes once started; the
  agent's `signal` is plumbed through `rag_search` and the embed client so the
  LLM-callable path is abort-aware.

---

## Limitations (v1)

- No file watcher — re-run `/rag-index` after edits.
- PDF page metadata not yet captured (treated as flat text).
- Single embedding provider (Ollama). OpenAI/Voyage are straightforward
  follow-ups: add a new `embed*.ts` and a `provider` switch in `embed.ts`.
- No cross-encoder rerank pass.
