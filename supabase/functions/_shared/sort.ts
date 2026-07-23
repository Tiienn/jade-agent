// Shared result ordering.

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

/** Folders first, then alphabetical by name (case-insensitive). */
export function sortFoldersFirstAlpha(entries: FileResult[]): FileResult[] {
  return entries.sort((a, b) => {
    if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

/**
 * Depth at which browsing switches from A–Z to newest-first. The top two
 * levels (the project root and each building) are navigation — an alphabetical
 * list is easier to scan. Deeper than that you're inside a working folder,
 * where the most recent file is what you want.
 */
export const NEWEST_FIRST_DEPTH = 2;

/** Pick the browse ordering for a folder at the given path depth. */
export function sortForDepth(
  entries: FileResult[],
  depth: number,
): FileResult[] {
  return depth >= NEWEST_FIRST_DEPTH
    ? sortNewestFirst(entries)
    : sortFoldersFirstAlpha(entries);
}
