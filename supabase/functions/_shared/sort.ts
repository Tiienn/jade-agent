// Shared result ordering: most recently modified first.

import type { FileResult } from "./types.ts";

/**
 * Sort newest-first by last modified date, folders and files intermixed, so
 * the most recently touched item is always at the top. Items with no date
 * (rare) fall to the end; ties break alphabetically for a stable order.
 */
export function sortNewestFirst(entries: FileResult[]): FileResult[] {
  return entries.sort((a, b) => {
    const da = a.lastModified ?? "";
    const db = b.lastModified ?? "";
    if (da !== db) return db.localeCompare(da);
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}
