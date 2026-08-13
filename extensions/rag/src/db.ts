/**
 * SQLite metadata + turbovec vector-index wrapper.
 *
 * SQLite stores files/chunks and stable chunk row IDs. turbovec stores the dense
 * vectors in a companion IdMapIndex file keyed by those chunk IDs.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

import type { RagPaths } from "./config.js";
import { ensureRagDir } from "./config.js";

// Use loose type for the better-sqlite3 Database to avoid hard type dep at load time.
type Database = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface FileRow {
	id: number;
	path: string;
	hash: string;
	mtime: number;
	size: number;
	format: string;
	indexed_at: number;
}

export interface ChunkRow {
	id: number;
	file_id: number;
	chunk_index: number;
	text: string;
	header_path: string | null;
	page: number | null;
	token_count: number;
}

export interface SearchHit {
	path: string;
	score: number; // higher is better (cosine-ish dot product for normalized vectors)
	chunk_index: number;
	header_path: string | null;
	page: number | null;
	token_count: number;
	text: string;
	format: string;
}

export interface InsertChunkArgs {
	file_id: number;
	chunk_index: number;
	text: string;
	header_path: string | null;
	page: number | null;
	token_count: number;
	embedding: number[];
}

export interface RagDB {
	db: Database;
	dim: number;
	bitWidth: number;
	close(): void;
	upsertFile(args: { path: string; hash: string; mtime: number; size: number; format: string }): {
		id: number;
		existing: FileRow | null;
	};
	deleteChunksForFile(fileId: number): void;
	insertChunk(args: InsertChunkArgs): void;
	insertChunks(args: InsertChunkArgs[]): void;
	deleteFileByPath(path: string): void;
	listFiles(): FileRow[];
	search(queryEmbedding: number[], k: number, formatFilter?: string[]): SearchHit[];
	stats(): { fileCount: number; chunkCount: number; vectorCount: number | null };
}

interface TurboVecResult<T = unknown> {
	ok?: boolean;
	error?: string;
	results?: T;
	count?: number;
}

interface TurboVecSearchResult {
	id: number;
	score: number;
}

export async function openDb(paths: RagPaths, dim: number, bitWidth = 4): Promise<RagDB> {
	if (!Number.isInteger(dim) || dim <= 0 || dim % 8 !== 0) {
		throw new Error(`turbovec requires embedding dim to be a positive multiple of 8; got ${dim}`);
	}
	if (![2, 3, 4].includes(bitWidth)) {
		throw new Error(`turbovec bitWidth must be 2, 3, or 4; got ${bitWidth}`);
	}

	ensureRagDir(paths);

	// Dynamic import keeps extension load fast.
	const BetterSqlite3 = (await import("better-sqlite3")).default;

	const db = new BetterSqlite3(paths.dbFile);
	db.pragma("journal_mode = WAL");
	db.pragma("synchronous = NORMAL");
	db.pragma("foreign_keys = ON");

	db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY,
      path TEXT UNIQUE NOT NULL,
      hash TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL,
      format TEXT NOT NULL,
      indexed_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY,
      file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      text TEXT NOT NULL,
      header_path TEXT,
      page INTEGER,
      token_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_id);
  `);

	// Validate or set dim.
	const storedDim = db.prepare<[], { value: string }>("SELECT value FROM meta WHERE key = 'dim'").get() as
		{ value: string } | undefined;
	if (storedDim) {
		const existingDim = Number(storedDim.value);
		if (existingDim !== dim) {
			db.close();
			throw new Error(
				`Embedding dim mismatch: DB was built for dim=${existingDim} but model now reports dim=${dim}. Run /rag-reset to rebuild.`,
			);
		}
	} else {
		db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('dim', ?)").run(String(dim));
	}

	const storedBitWidth = db
		.prepare<[], { value: string }>("SELECT value FROM meta WHERE key = 'turbovec_bit_width'")
		.get() as { value: string } | undefined;
	if (storedBitWidth) {
		const existing = Number(storedBitWidth.value);
		if (existing !== bitWidth) {
			db.close();
			throw new Error(
				`turbovec bit width mismatch: index metadata says ${existing}-bit but config says ${bitWidth}-bit. Run /rag-reset to rebuild.`,
			);
		}
	} else {
		db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('turbovec_bit_width', ?)").run(String(bitWidth));
	}

	// Prepared statements.
	const stmts = {
		selectFile: db.prepare<[string], FileRow>("SELECT * FROM files WHERE path = ?"),
		upsertFile: db.prepare(
			`INSERT INTO files (path, hash, mtime, size, format, indexed_at)
       VALUES (@path, @hash, @mtime, @size, @format, @indexed_at)
       ON CONFLICT(path) DO UPDATE SET
         hash = excluded.hash,
         mtime = excluded.mtime,
         size = excluded.size,
         format = excluded.format,
         indexed_at = excluded.indexed_at`,
		),
		selectFileId: db.prepare<[string], { id: number }>("SELECT id FROM files WHERE path = ?"),
		selectChunkIdsForFile: db.prepare<[number], { id: number }>("SELECT id FROM chunks WHERE file_id = ?"),
		deleteFile: db.prepare("DELETE FROM files WHERE path = ?"),
		deleteChunksForFile: db.prepare("DELETE FROM chunks WHERE file_id = ?"),
		markFileDirty: db.prepare("UPDATE files SET hash = '__rag_incomplete__' WHERE id = ?"),
		insertChunk: db.prepare(
			`INSERT INTO chunks (file_id, chunk_index, text, header_path, page, token_count)
       VALUES (@file_id, @chunk_index, @text, @header_path, @page, @token_count)`,
		),
		listFiles: db.prepare<[], FileRow>("SELECT * FROM files ORDER BY path"),
		countFiles: db.prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM files"),
		countChunks: db.prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM chunks"),
	};

	const insertChunkRows = db.transaction((items: InsertChunkArgs[]): number[] => {
		const ids: number[] = [];
		for (const item of items) {
			const info = stmts.insertChunk.run({
				file_id: item.file_id,
				chunk_index: item.chunk_index,
				text: item.text,
				header_path: item.header_path,
				page: item.page,
				token_count: item.token_count,
			});
			ids.push(Number(info.lastInsertRowid));
		}
		return ids;
	});

	function chunkIdsForFile(fileId: number): number[] {
		return (stmts.selectChunkIdsForFile.all(fileId) as Array<{ id: number }>).map((r) => r.id);
	}

	function removeVectors(ids: number[]): void {
		if (ids.length === 0) return;
		turbovec<{ removed: number }>({ cmd: "remove", indexFile: paths.indexFile, ids });
	}

	function deleteChunkRowsByIds(ids: number[]): void {
		if (ids.length === 0) return;
		const placeholders = ids.map(() => "?").join(",");
		db.prepare(`DELETE FROM chunks WHERE id IN (${placeholders})`).run(...ids);
	}

	function addVectors(ids: number[], embeddings: number[][]): void {
		if (ids.length === 0) return;
		turbovec({
			cmd: "add",
			indexFile: paths.indexFile,
			dim,
			bitWidth,
			ids,
			vectors: embeddings,
		});
	}

	return {
		db,
		dim,
		bitWidth,
		close() {
			db.close();
		},

		upsertFile({ path, hash, mtime, size, format }) {
			const existing = stmts.selectFile.get(path) ?? null;
			const indexed_at = Date.now();
			stmts.upsertFile.run({ path, hash, mtime, size, format, indexed_at });
			const row = stmts.selectFileId.get(path)!;
			return { id: row.id, existing };
		},

		deleteChunksForFile(fileId) {
			const ids = chunkIdsForFile(fileId);
			// Keep the dense index and metadata in lockstep.
			removeVectors(ids);
			stmts.deleteChunksForFile.run(fileId);
		},

		insertChunk(args) {
			this.insertChunks([args]);
		},

		insertChunks(args) {
			if (args.length === 0) return;
			for (const item of args) {
				if (item.embedding.length !== dim) {
					throw new Error(`Embedding length ${item.embedding.length} != dim ${dim}`);
				}
			}

			const ids = insertChunkRows(args);
			try {
				addVectors(
					ids,
					args.map((a) => a.embedding),
				);
			} catch (err) {
				// Roll back the just-inserted metadata if turbovec rejected the batch,
				// and dirty the owning file(s) so the next incremental run retries.
				deleteChunkRowsByIds(ids);
				for (const fileId of new Set(args.map((a) => a.file_id))) {
					stmts.markFileDirty.run(fileId);
				}
				throw err;
			}
		},

		deleteFileByPath(path) {
			const row = stmts.selectFileId.get(path);
			if (!row) return;
			const ids = chunkIdsForFile(row.id);
			removeVectors(ids);
			stmts.deleteChunksForFile.run(row.id);
			stmts.deleteFile.run(path);
		},

		listFiles() {
			return stmts.listFiles.all();
		},

		search(queryEmbedding, k, formatFilter) {
			if (!fs.existsSync(paths.indexFile)) return [];

			let allowlist: number[] | undefined;
			if (formatFilter && formatFilter.length > 0) {
				const placeholders = formatFilter.map(() => "?").join(",");
				allowlist = (
					db
						.prepare(
							`SELECT c.id AS id
             FROM chunks c
             JOIN files f ON f.id = c.file_id
             WHERE f.format IN (${placeholders})`,
						)
						.all(...formatFilter) as Array<{ id: number }>
				).map((r) => r.id);
				if (allowlist.length === 0) return [];
			}

			const vectorHits =
				turbovec<TurboVecSearchResult[]>({
					cmd: "search",
					indexFile: paths.indexFile,
					dim,
					query: queryEmbedding,
					k,
					allowlist,
				}).results ?? [];
			if (vectorHits.length === 0) return [];

			const ids = vectorHits.map((h) => h.id);
			const placeholders = ids.map(() => "?").join(",");
			const rows = db
				.prepare(
					`SELECT
             c.id          AS id,
             c.chunk_index AS chunk_index,
             c.text        AS text,
             c.header_path AS header_path,
             c.page        AS page,
             c.token_count AS token_count,
             f.path        AS path,
             f.format      AS format
           FROM chunks c
           JOIN files f ON f.id = c.file_id
           WHERE c.id IN (${placeholders})`,
				)
				.all(...ids) as Array<{
				id: number;
				chunk_index: number;
				text: string;
				header_path: string | null;
				page: number | null;
				token_count: number;
				path: string;
				format: string;
			}>;

			const byId = new Map(rows.map((r) => [r.id, r]));
			return vectorHits.flatMap((h) => {
				const r = byId.get(h.id);
				if (!r) return [];
				return [
					{
						path: r.path,
						score: clampScore(h.score),
						chunk_index: r.chunk_index,
						header_path: r.header_path,
						page: r.page,
						token_count: r.token_count,
						text: r.text,
						format: r.format,
					},
				];
			});
		},

		stats() {
			const f = stmts.countFiles.get()!;
			const c = stmts.countChunks.get()!;
			let vectorCount: number | null = null;
			if (fs.existsSync(paths.indexFile)) {
				try {
					vectorCount =
						turbovec<{ count: number }>({
							cmd: "count",
							indexFile: paths.indexFile,
						}).count ?? null;
				} catch {
					vectorCount = null;
				}
			} else {
				vectorCount = 0;
			}
			return { fileCount: f.c, chunkCount: c.c, vectorCount };
		},
	};
}

let turbovecChecked = false;

function turbovec<T>(payload: Record<string, unknown>): TurboVecResult<T> {
	const python = process.env.TURBOVEC_PYTHON || "python3";
	ensureTurbovecInstalled(python);
	const helper = fileURLToPath(new URL("./turbovec_bridge.py", import.meta.url));
	const res = spawnSync(python, [helper], {
		input: JSON.stringify(payload),
		encoding: "utf8",
		maxBuffer: 10 * 1024 * 1024,
	});

	if (res.error) throw res.error;
	if (res.status !== 0) {
		const detail = (res.stdout || res.stderr || "").trim();
		throw new Error(detail || `turbovec bridge failed with exit code ${res.status}`);
	}

	let parsed: TurboVecResult<T>;
	try {
		parsed = JSON.parse(res.stdout || "{}");
	} catch (err) {
		throw new Error(`turbovec bridge returned invalid JSON: ${(err as Error).message}`);
	}
	if (parsed.ok === false) {
		throw new Error(parsed.error || "turbovec bridge failed");
	}
	return parsed;
}

export function ensureTurbovecInstalled(python = process.env.TURBOVEC_PYTHON || "python3"): void {
	if (turbovecChecked) return;

	const probe = spawnSync(python, ["-c", "import turbovec, numpy"], {
		encoding: "utf8",
		maxBuffer: 1024 * 1024,
	});
	if (probe.error) {
		throw new Error(`Could not run ${python} to check turbovec: ${probe.error.message}`);
	}
	if (probe.status === 0) {
		turbovecChecked = true;
		return;
	}

	if (process.env.TURBOVEC_AUTO_INSTALL === "0") {
		throw new Error(
			"Python package 'turbovec' (and numpy) is not installed. Install it with: python3 -m pip install --user turbovec",
		);
	}

	console.error("turbovec is not installed for the RAG extension; installing with pip...");
	const install = spawnSync(python, ["-m", "pip", "install", "--user", "turbovec"], {
		encoding: "utf8",
		maxBuffer: 50 * 1024 * 1024,
	});

	if (install.status !== 0 || install.error) {
		// Some virtualenvs reject --user because the user site is hidden. If the
		// caller explicitly pointed TURBOVEC_PYTHON at such an interpreter, install
		// into that environment instead of requiring sudo/global state.
		const fallback = spawnSync(python, ["-m", "pip", "install", "turbovec"], {
			encoding: "utf8",
			maxBuffer: 50 * 1024 * 1024,
		});
		if (fallback.status !== 0 || fallback.error) {
			const detail = [
				install.error?.message,
				install.stdout,
				install.stderr,
				fallback.error?.message,
				fallback.stdout,
				fallback.stderr,
			]
				.filter(Boolean)
				.join("\n")
				.trim();
			throw new Error(
				`Failed to auto-install Python package 'turbovec'. Try manually: ${python} -m pip install --user turbovec\n${detail}`,
			);
		}
	}

	const verify = spawnSync(python, ["-c", "import turbovec, numpy"], {
		encoding: "utf8",
		maxBuffer: 1024 * 1024,
	});
	if (verify.status !== 0 || verify.error) {
		throw new Error(
			`Installed turbovec, but ${python} still cannot import turbovec/numpy. Try setting TURBOVEC_PYTHON to the Python interpreter that has turbovec installed.`,
		);
	}

	turbovecChecked = true;
}

function clampScore(score: number): number {
	if (!Number.isFinite(score)) return 0;
	if (score > 1) return 1;
	if (score < -1) return -1;
	return score;
}
