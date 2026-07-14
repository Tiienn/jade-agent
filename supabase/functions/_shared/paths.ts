// Shared folder-path validation used by browse (path) and search (scopePath).

import { HttpError } from "./auth.ts";

/**
 * Validate and normalize a folder path: must be absent or an array of non-empty
 * strings. Each segment is trimmed and must not contain '/', '\' or '..'
 * (prevents path traversal outside the project root).
 */
export function normalizePath(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new HttpError(400, "path must be an array of folder names.");
  }
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") {
      throw new HttpError(400, "path must be an array of folder names.");
    }
    const seg = raw.trim();
    if (!seg) throw new HttpError(400, "path segments must not be empty.");
    if (seg.includes("/") || seg.includes("\\") || seg.includes("..")) {
      throw new HttpError(400, "Invalid folder name in path.");
    }
    out.push(seg);
  }
  return out;
}
