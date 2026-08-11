/**
 * Project-local RAG config. Stored at <cwd>/.pi/rag/config.json.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface RagConfig {
  /** Folder (relative to project root) to index. */
  folder: string;
  /** File extensions to include (lowercased, with leading dot). */
  formats: string[];
  /** Embedding provider — only "ollama" supported in v1. */
  provider: "ollama";
  /** Ollama base URL. */
  ollamaUrl: string;
  /** Embedding model name. */
  model: string;
  /** Detected embedding dimensionality. Set at first index. */
  dim: number | null;
  /** turbovec quantization bit width. 4 is highest recall; 2 is most compact. */
  bitWidth: 2 | 3 | 4;
  /** Approx target chunk size in tokens (1 token ≈ 4 chars heuristic). */
  chunkTokens: number;
  /** Token overlap between adjacent chunks. */
  chunkOverlap: number;
  /** Glob-ish exclude patterns (substring match against relative path). */
  exclude: string[];
}

export const DEFAULT_CONFIG: RagConfig = {
  folder: "raw",
  formats: [".md", ".txt", ".pdf", ".docx"],
  provider: "ollama",
  ollamaUrl: "http://localhost:11434",
  model: "nomic-embed-text",
  dim: null,
  bitWidth: 4,
  chunkTokens: 800,
  chunkOverlap: 100,
  exclude: ["node_modules", ".git", ".obsidian", ".pi", "Icon\r"],
};

export interface RagPaths {
  root: string;
  ragDir: string;
  configFile: string;
  dbFile: string;
  indexFile: string;
}

export function ragPaths(cwd: string): RagPaths {
  const ragDir = path.join(cwd, ".pi", "rag");
  return {
    root: cwd,
    ragDir,
    configFile: path.join(ragDir, "config.json"),
    dbFile: path.join(ragDir, "rag.db"),
    indexFile: path.join(ragDir, "rag.tvim"),
  };
}

export function ensureRagDir(paths: RagPaths): void {
  fs.mkdirSync(paths.ragDir, { recursive: true });
}

export function loadConfig(paths: RagPaths): RagConfig | null {
  try {
    const raw = fs.readFileSync(paths.configFile, "utf8");
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return null;
  }
}

export function saveConfig(paths: RagPaths, cfg: RagConfig): void {
  ensureRagDir(paths);
  fs.writeFileSync(paths.configFile, JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

export function configExists(paths: RagPaths): boolean {
  return fs.existsSync(paths.configFile);
}
