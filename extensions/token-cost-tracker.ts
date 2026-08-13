import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DatabaseSync } from "node:sqlite";

/**
 * token-cost-tracker
 *
 * On every LLM call (each finalized assistant message) this extension:
 *   1. Appends a `token-cost` custom entry into the session's .jsonl file
 *      (via pi.appendEntry) capturing token usage + cost for that call.
 *   2. Mirrors the same record into a per-session SQLite database that lives
 *      next to the .jsonl file (<session>.costs.db).
 *
 * Custom entries do NOT participate in the LLM context, so this adds no
 * token overhead to the conversation itself.
 *
 * Commands:
 *   /token-cost   Show running totals for the current session.
 */

const CUSTOM_TYPE = "token-cost";

interface UsageLike {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	cost?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		total?: number;
	};
}

interface CostRecord {
	sessionId: string | undefined;
	entryId: string | null;
	timestamp: string;
	provider: string;
	model: string;
	api: string;
	stopReason: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

export default function (pi: ExtensionAPI) {
	// Session-scoped resources. Created on session_start, torn down on
	// session_shutdown so /new, /resume, /fork rebind cleanly.
	let db: DatabaseSync | null = null;
	let insertStmt: ReturnType<DatabaseSync["prepare"]> | null = null;

	function num(v: unknown): number {
		return typeof v === "number" && Number.isFinite(v) ? v : 0;
	}

	function dbPathFor(ctx: ExtensionContext): string | null {
		const file = ctx.sessionManager.getSessionFile();
		if (!file) return null; // in-memory / ephemeral session
		return file.replace(/\.jsonl$/i, "") + ".costs.db";
	}

	function openDb(ctx: ExtensionContext) {
		const path = dbPathFor(ctx);
		// Use the on-disk DB when the session is persisted, otherwise an
		// in-memory DB so the extension still works for ephemeral sessions.
		db = new DatabaseSync(path ?? ":memory:");
		db.exec(`
      CREATE TABLE IF NOT EXISTS session_meta (
        session_id   TEXT PRIMARY KEY,
        session_file TEXT,
        cwd          TEXT,
        created_at   TEXT
      );
      CREATE TABLE IF NOT EXISTS llm_calls (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id    TEXT,
        entry_id      TEXT,
        timestamp     TEXT,
        provider      TEXT,
        model         TEXT,
        api           TEXT,
        stop_reason   TEXT,
        input_tokens  INTEGER,
        output_tokens INTEGER,
        cache_read    INTEGER,
        cache_write   INTEGER,
        total_tokens  INTEGER,
        cost_input        REAL,
        cost_output       REAL,
        cost_cache_read   REAL,
        cost_cache_write  REAL,
        cost_total        REAL
      );
      CREATE INDEX IF NOT EXISTS idx_llm_calls_session ON llm_calls(session_id);
    `);

		const sessionId = ctx.sessionManager.getSessionId();
		db.prepare(
			`INSERT INTO session_meta (session_id, session_file, cwd, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         session_file = excluded.session_file,
         cwd          = excluded.cwd`,
		).run(
			sessionId ?? "ephemeral",
			ctx.sessionManager.getSessionFile() ?? "",
			ctx.sessionManager.getCwd() ?? "",
			new Date().toISOString(),
		);

		insertStmt = db.prepare(
			`INSERT INTO llm_calls (
         session_id, entry_id, timestamp, provider, model, api, stop_reason,
         input_tokens, output_tokens, cache_read, cache_write, total_tokens,
         cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
	}

	function closeDb() {
		try {
			insertStmt = null;
			db?.close();
		} catch {
			// ignore
		}
		db = null;
	}

	pi.on("session_start", async (_event, ctx) => {
		try {
			openDb(ctx);
		} catch (err) {
			ctx.ui.notify(`token-cost-tracker: failed to open DB: ${(err as Error).message}`, "error");
		}
	});

	pi.on("session_shutdown", async () => {
		closeDb();
	});

	// Capture cost on every finalized assistant message (= one LLM call).
	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;

		const msg = event.message as {
			usage?: UsageLike;
			provider?: string;
			model?: string;
			api?: string;
			stopReason?: string;
		};
		const usage = msg.usage;
		if (!usage) return;

		const record: CostRecord = {
			sessionId: ctx.sessionManager.getSessionId(),
			entryId: ctx.sessionManager.getLeafId(),
			timestamp: new Date().toISOString(),
			provider: msg.provider ?? "unknown",
			model: msg.model ?? "unknown",
			api: msg.api ?? "unknown",
			stopReason: msg.stopReason ?? "unknown",
			input: num(usage.input),
			output: num(usage.output),
			cacheRead: num(usage.cacheRead),
			cacheWrite: num(usage.cacheWrite),
			totalTokens: num(usage.totalTokens),
			cost: {
				input: num(usage.cost?.input),
				output: num(usage.cost?.output),
				cacheRead: num(usage.cost?.cacheRead),
				cacheWrite: num(usage.cost?.cacheWrite),
				total: num(usage.cost?.total),
			},
		};

		// 1. Persist into the session .jsonl as a non-context custom entry.
		try {
			pi.appendEntry(CUSTOM_TYPE, record);
		} catch (err) {
			ctx.ui.notify(`token-cost-tracker: appendEntry failed: ${(err as Error).message}`, "error");
		}

		// 2. Mirror into the per-session SQLite DB.
		try {
			insertStmt?.run(
				record.sessionId ?? "ephemeral",
				record.entryId,
				record.timestamp,
				record.provider,
				record.model,
				record.api,
				record.stopReason,
				record.input,
				record.output,
				record.cacheRead,
				record.cacheWrite,
				record.totalTokens,
				record.cost.input,
				record.cost.output,
				record.cost.cacheRead,
				record.cost.cacheWrite,
				record.cost.total,
			);
		} catch (err) {
			ctx.ui.notify(`token-cost-tracker: DB insert failed: ${(err as Error).message}`, "error");
		}
	});

	pi.registerCommand("token-cost", {
		description: "Show token usage and cost totals for the current session",
		handler: async (_args, ctx) => {
			if (!db) {
				ctx.ui.notify("token-cost-tracker: no database open", "warning");
				return;
			}
			const sessionId = ctx.sessionManager.getSessionId() ?? "ephemeral";
			const row = db
				.prepare(
					`SELECT
             COUNT(*)            AS calls,
             SUM(input_tokens)   AS input,
             SUM(output_tokens)  AS output,
             SUM(cache_read)     AS cache_read,
             SUM(cache_write)    AS cache_write,
             SUM(total_tokens)   AS tokens,
             SUM(cost_total)     AS cost
           FROM llm_calls WHERE session_id = ?`,
				)
				.get(sessionId) as Record<string, number | null> | undefined;

			const calls = Number(row?.calls ?? 0);
			const tokens = Number(row?.tokens ?? 0);
			const cost = Number(row?.cost ?? 0);
			const input = Number(row?.input ?? 0);
			const output = Number(row?.output ?? 0);
			const dbPath = dbPathFor(ctx) ?? ":memory:";

			ctx.ui.notify(
				`token-cost: ${calls} call(s), ${tokens.toLocaleString()} tokens ` +
					`(in ${input.toLocaleString()} / out ${output.toLocaleString()}), ` +
					`$${cost.toFixed(6)} total\nDB: ${dbPath}`,
				"info",
			);
		},
	});
}
