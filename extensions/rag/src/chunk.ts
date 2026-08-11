/**
 * Chunking strategies. Token counts are approximated as Math.ceil(chars / 4).
 */

export interface Chunk {
  text: string;
  header_path: string | null;
  page: number | null;
  token_count: number;
}

export interface ChunkOptions {
  chunkTokens: number;
  chunkOverlap: number;
}

const CHARS_PER_TOKEN = 4;

function approxTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}

/**
 * Split markdown by ATX headers, building a breadcrumb header path per section,
 * then window each section if it's too long.
 */
export function chunkMarkdown(text: string, opts: ChunkOptions): Chunk[] {
  const lines = text.split("\n");
  const sections: Array<{ headerPath: string; body: string }> = [];
  const headerStack: string[] = []; // index = level - 1
  let buf: string[] = [];
  let currentPath = "";

  const flush = () => {
    const body = buf.join("\n").trim();
    if (body.length > 0) {
      sections.push({ headerPath: currentPath, body });
    }
    buf = [];
  };

  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (m) {
      flush();
      const level = m[1].length;
      const title = m[2].trim();
      headerStack.length = level - 1; // pop deeper levels
      headerStack[level - 1] = title;
      currentPath = headerStack.filter(Boolean).join(" > ");
      // Include the header itself at the top of the next chunk for context.
      buf.push(line);
    } else {
      buf.push(line);
    }
  }
  flush();

  const chunks: Chunk[] = [];
  for (const sec of sections) {
    for (const piece of windowText(sec.body, opts)) {
      chunks.push({
        text: piece,
        header_path: sec.headerPath || null,
        page: null,
        token_count: approxTokens(piece),
      });
    }
  }
  return chunks;
}

/** Generic windowed splitter with sentence-ish boundaries and char overlap. */
export function chunkPlain(text: string, opts: ChunkOptions): Chunk[] {
  return windowText(text, opts).map((t) => ({
    text: t,
    header_path: null,
    page: null,
    token_count: approxTokens(t),
  }));
}

function windowText(text: string, opts: ChunkOptions): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const maxChars = opts.chunkTokens * CHARS_PER_TOKEN;
  const overlapChars = Math.max(0, opts.chunkOverlap) * CHARS_PER_TOKEN;

  if (trimmed.length <= maxChars) return [trimmed];

  // Soft-split on paragraph boundaries first, then sentences, then hard char window.
  const units = splitParagraphs(trimmed);

  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    if (current.trim().length > 0) chunks.push(current.trim());
  };

  for (const unit of units) {
    if (unit.length > maxChars) {
      // Hard-split a long paragraph.
      flush();
      current = "";
      for (let i = 0; i < unit.length; i += maxChars - overlapChars) {
        const slice = unit.slice(i, i + maxChars);
        chunks.push(slice.trim());
        if (i + maxChars >= unit.length) break;
      }
      continue;
    }

    if ((current + "\n\n" + unit).length > maxChars) {
      flush();
      // Carry overlap from tail of previous chunk.
      const tail = chunks.length > 0 ? tailChars(chunks[chunks.length - 1], overlapChars) : "";
      current = tail ? `${tail}\n\n${unit}` : unit;
    } else {
      current = current ? `${current}\n\n${unit}` : unit;
    }
  }
  flush();

  return chunks.filter((c) => c.length > 0);
}

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

function tailChars(s: string, n: number): string {
  if (n <= 0 || s.length <= n) return s;
  // Try to cut on a sentence boundary near the tail.
  const slice = s.slice(s.length - n);
  const m = slice.match(/[\.\?\!\n]\s+(.+)$/);
  return m ? m[1] : slice;
}
