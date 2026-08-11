/**
 * Indexing pipeline: scan → diff (hash) → extract → chunk → embed → upsert.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import type { RagConfig, RagPaths } from "./config.js";
import { chunkMarkdown, chunkPlain, type Chunk } from "./chunk.js";
import { openDb } from "./db.js";
import { embedBatch } from "./embed.js";
import { extract } from "./extract.js";

export interface IndexProgress {
  scanned: number;
  total: number;
  added: number;
  updated: number;
  unchanged: number;
  deleted: number;
  chunks: number;
  currentFile?: string;
}

export interface IndexOptions {
  signal?: AbortSignal;
  onProgress?: (p: IndexProgress) => void;
  /** If true, ignore hashes and re-index everything. */
  force?: boolean;
}

export interface IndexResult {
  added: number;
  updated: number;
  unchanged: number;
  deleted: number;
  chunks: number;
  files: number;
  errors: Array<{ path: string; error: string }>;
}

const EMBED_BATCH_SIZE = 32;

export async function runIndex(
  cfg: RagConfig,
  paths: RagPaths,
  opts: IndexOptions = {},
): Promise<IndexResult> {
  if (!cfg.dim) {
    throw new Error("Config is missing embedding dim — run /rag-setup first.");
  }

  const folderAbs = path.resolve(paths.root, cfg.folder);
  if (!fs.existsSync(folderAbs)) {
    throw new Error(`Source folder does not exist: ${folderAbs}`);
  }

  const files = await scanFolder(folderAbs, cfg);
  const db = await openDb(paths, cfg.dim, cfg.bitWidth);
  const errors: IndexResult["errors"] = [];
  // Migrating from sqlite-vec or recovering a missing turbovec file: existing
  // chunk metadata alone is not enough, so rebuild vectors even if hashes match.
  const forceVectors = opts.force || !fs.existsSync(paths.indexFile);
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  let chunkTotal = 0;

  const progress: IndexProgress = {
    scanned: 0,
    total: files.length,
    added: 0,
    updated: 0,
    unchanged: 0,
    deleted: 0,
    chunks: 0,
  };

  try {
    // Build set of relative paths that exist on disk now, to detect deletions.
    const liveRel = new Set(files.map((f) => relPath(paths.root, f.abs)));

    for (const existing of db.listFiles()) {
      if (!liveRel.has(existing.path)) {
        db.deleteFileByPath(existing.path);
        progress.deleted++;
      }
    }

    for (const f of files) {
      opts.signal?.throwIfAborted?.();
      progress.scanned++;
      progress.currentFile = f.rel;
      opts.onProgress?.(progress);

      try {
        const hash = await hashFile(f.abs);
        const existingRow = db.listFiles().find((r) => r.path === f.rel);

        if (!forceVectors && existingRow && existingRow.hash === hash) {
          unchanged++;
          progress.unchanged = unchanged;
          continue;
        }

        const doc = await extract(f.abs);
        if (!doc) {
          continue;
        }
        const chunks = doc.isMarkdown
          ? chunkMarkdown(doc.text, { chunkTokens: cfg.chunkTokens, chunkOverlap: cfg.chunkOverlap })
          : chunkPlain(doc.text, { chunkTokens: cfg.chunkTokens, chunkOverlap: cfg.chunkOverlap });

        if (chunks.length === 0) continue;

        // Generate embeddings before changing metadata or deleting existing
        // vectors. A model/network failure must leave the prior hash and index
        // intact so the next incremental run retries this file.
        const embeddings = await embedChunks(cfg, chunks, opts.signal);
        const stat = await fsp.stat(f.abs);
        const upsert = db.upsertFile({
          path: f.rel,
          hash,
          mtime: stat.mtimeMs,
          size: stat.size,
          format: path.extname(f.rel).toLowerCase(),
        });

        // Clear old chunks only after embeddings are ready for insertion.
        db.deleteChunksForFile(upsert.id);

        db.insertChunks(chunks.map((c, i) => ({
          file_id: upsert.id,
          chunk_index: i,
          text: c.text,
          header_path: c.header_path,
          page: c.page,
          token_count: c.token_count,
          embedding: embeddings[i],
        })));

        chunkTotal += chunks.length;
        if (upsert.existing) {
          updated++;
          progress.updated = updated;
        } else {
          added++;
          progress.added = added;
        }
        progress.chunks = chunkTotal;
        opts.onProgress?.(progress);
      } catch (err) {
        if ((err as { name?: string }).name === "AbortError") throw err;
        errors.push({ path: f.rel, error: String((err as Error).message ?? err) });
      }
    }
  } finally {
    db.close();
  }

  return {
    added,
    updated,
    unchanged,
    deleted: progress.deleted,
    chunks: chunkTotal,
    files: files.length,
    errors,
  };
}

async function embedChunks(
  cfg: RagConfig,
  chunks: Chunk[],
  signal?: AbortSignal,
): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
    const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
    const inputs = batch.map((c) => c.text);
    const embeddings = await embedBatch(cfg, inputs, signal);
    if (embeddings.length !== batch.length) {
      throw new Error(`Embedding count mismatch: ${embeddings.length} vs ${batch.length}`);
    }
    out.push(...embeddings);
  }
  return out;
}

interface ScannedFile {
  abs: string;
  rel: string;
}

async function scanFolder(folder: string, cfg: RagConfig): Promise<ScannedFile[]> {
  const out: ScannedFile[] = [];
  const allowed = new Set(cfg.formats.map((f) => f.toLowerCase()));

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(folder, abs);
      if (shouldExclude(rel, cfg)) continue;
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (allowed.has(ext)) out.push({ abs, rel: path.join(cfg.folder, rel) });
      }
    }
  }

  await walk(folder);
  return out;
}

function shouldExclude(relInsideFolder: string, cfg: RagConfig): boolean {
  for (const ex of cfg.exclude) {
    if (!ex) continue;
    if (relInsideFolder.includes(ex)) return true;
  }
  // Ignore dotfiles by default (but allow .md etc. — only directories starting with ".")
  const parts = relInsideFolder.split(path.sep);
  if (parts.some((p) => p.startsWith(".") && p !== "." && p !== "..")) return true;
  return false;
}

function relPath(root: string, abs: string): string {
  return path.relative(root, abs);
}

async function hashFile(filePath: string): Promise<string> {
  const buf = await fsp.readFile(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}
