/**
 * File → plain text. Lazy-loads heavy parsers.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface ExtractedDoc {
  format: string;           // extension, e.g. ".md"
  text: string;             // plain text
  /** Markdown-only: structural metadata is preserved in `text` (raw md). */
  isMarkdown: boolean;
}

export async function extract(filePath: string): Promise<ExtractedDoc | null> {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".md":
    case ".markdown": {
      const text = await fs.readFile(filePath, "utf8");
      return { format: ext, text, isMarkdown: true };
    }
    case ".txt": {
      const text = await fs.readFile(filePath, "utf8");
      return { format: ext, text, isMarkdown: false };
    }
    case ".pdf": {
      const buf = await fs.readFile(filePath);
      // Import the inner module to bypass pdf-parse/index.js's debug auto-run.
      const pdfParseMod = await import("pdf-parse/lib/pdf-parse.js");
      const pdfParse = (pdfParseMod as { default?: unknown }).default ?? pdfParseMod;
      const result = await (pdfParse as (b: Buffer) => Promise<{ text: string }>)(buf);
      return { format: ext, text: normalizeWhitespace(result.text), isMarkdown: false };
    }
    case ".docx": {
      const buf = await fs.readFile(filePath);
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({ buffer: buf });
      return { format: ext, text: normalizeWhitespace(result.value), isMarkdown: false };
    }
    default:
      return null;
  }
}

function normalizeWhitespace(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
