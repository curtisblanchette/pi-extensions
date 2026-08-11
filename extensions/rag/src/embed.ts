/**
 * Ollama embedding client. Uses the modern /api/embed batch endpoint with a
 * graceful fallback to the older single-input /api/embeddings endpoint.
 */
import type { RagConfig } from "./config.js";

export class EmbedError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "EmbedError";
  }
}

interface OllamaTagsResponse {
  models?: Array<{ name: string; model?: string }>;
}

export async function listModels(cfg: RagConfig, signal?: AbortSignal): Promise<string[]> {
  const url = `${cfg.ollamaUrl.replace(/\/$/, "")}/api/tags`;
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new EmbedError(`Ollama ${res.status} at ${url}`);
    const data = (await res.json()) as OllamaTagsResponse;
    return (data.models ?? []).map((m) => m.name ?? m.model ?? "").filter(Boolean);
  } catch (err) {
    if ((err as { name?: string }).name === "AbortError") throw err;
    throw new EmbedError(
      `Cannot reach Ollama at ${cfg.ollamaUrl}. Is it running? Try: ollama serve`,
      err,
    );
  }
}

export async function pingModel(cfg: RagConfig, signal?: AbortSignal): Promise<void> {
  const models = await listModels(cfg, signal);
  const has = models.some((m) => m === cfg.model || m.startsWith(`${cfg.model}:`));
  if (!has) {
    throw new EmbedError(
      `Model "${cfg.model}" is not installed in Ollama. Install it with:\n  ollama pull ${cfg.model}`,
    );
  }
}

/** L2-normalize in place, so cosine == dot product == euclidean-on-unit-sphere. */
export function normalize(v: number[]): number[] {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s) || 1;
  for (let i = 0; i < v.length; i++) v[i] = v[i] / n;
  return v;
}

interface EmbedBatchResponse {
  embeddings?: number[][];
  embedding?: number[];
}

/** Embed a batch of strings. Returns a normalized array of vectors. */
export async function embedBatch(
  cfg: RagConfig,
  inputs: string[],
  signal?: AbortSignal,
): Promise<number[][]> {
  if (inputs.length === 0) return [];

  const base = cfg.ollamaUrl.replace(/\/$/, "");

  // Try modern batch endpoint first.
  const modernRes = await fetch(`${base}/api/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: cfg.model, input: inputs }),
    signal,
  }).catch((err) => {
    if ((err as { name?: string }).name === "AbortError") throw err;
    throw new EmbedError(`Failed to call Ollama at ${base}/api/embed`, err);
  });

  if (modernRes.ok) {
    const data = (await modernRes.json()) as EmbedBatchResponse;
    if (Array.isArray(data.embeddings) && data.embeddings.length === inputs.length) {
      return data.embeddings.map((v) => normalize([...v]));
    }
  }

  // Fallback: legacy single-input endpoint, called sequentially.
  const out: number[][] = [];
  for (const input of inputs) {
    const res = await fetch(`${base}/api/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: cfg.model, prompt: input }),
      signal,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new EmbedError(`Ollama embed failed (${res.status}): ${txt.slice(0, 200)}`);
    }
    const data = (await res.json()) as EmbedBatchResponse;
    if (!data.embedding) throw new EmbedError(`Ollama returned no embedding for input`);
    out.push(normalize([...data.embedding]));
  }
  return out;
}

/** Probe the model with a single short string to detect dimensionality. */
export async function detectDim(cfg: RagConfig, signal?: AbortSignal): Promise<number> {
  const [vec] = await embedBatch(cfg, ["dimension probe"], signal);
  if (!vec || vec.length === 0) throw new EmbedError("Embedding probe returned empty vector");
  return vec.length;
}
