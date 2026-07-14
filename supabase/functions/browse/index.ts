// POST { path?: string[] }
// List the direct contents of a folder under the project root (click-through
// navigation of the whole Marketing/Project tree). Resolve project-root + path,
// list children, sort + cap, return { path, entries }.

import { handleOptions, jsonResponse } from "../_shared/cors.ts";
import { HttpError, requireActiveUser } from "../_shared/auth.ts";
import {
  getDriveId,
  getFolderByPath,
  getItemBrowsePath,
  getProjectRoot,
  listChildren,
} from "../_shared/graph.ts";
import type { FileResult } from "../_shared/types.ts";

Deno.serve(async (req: Request) => {
  const pre = handleOptions(req);
  if (pre) return pre;

  try {
    if (req.method !== "POST") throw new HttpError(405, "Method not allowed");

    await requireActiveUser(req);

    const body = await req.json().catch(() => ({} as Record<string, unknown>));

    // Item mode: open a folder by its id (e.g. a search result). Resolve its
    // path relative to the project root; optionally list its children.
    if (typeof body.itemId === "string" && typeof body.driveId === "string") {
      const segs = await getItemBrowsePath(body.driveId, body.itemId);
      if (!segs) {
        return jsonResponse(
          { error: "That folder is outside the project library." },
          400,
        );
      }
      const entries = body.resolveOnly === true
        ? []
        : sortEntries(await listChildren(body.driveId, body.itemId));
      return jsonResponse({ path: segs, entries: entries.slice(0, 500) });
    }

    const path = normalizePath(body.path);

    const root = getProjectRoot();
    const driveId = await getDriveId();
    const fullPath = [root, ...path].join("/");
    const folder = await getFolderByPath(driveId, fullPath);
    if (!folder) {
      const shown = ["Project", ...path].join("/");
      return jsonResponse(
        {
          error: `Folder not found: ${shown}. It may have been moved or renamed.`,
        },
        400,
      );
    }

    const entries = sortEntries(await listChildren(driveId, folder.id as string));

    return jsonResponse({ path, entries: entries.slice(0, 500) });
  } catch (e) {
    return errorResponse(e);
  }
});

/** Folders first, then alphabetical by name (case-insensitive). */
function sortEntries(entries: FileResult[]): FileResult[] {
  return entries.sort((a, b) => {
    if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

/**
 * Validate and normalize path: must be absent or an array of non-empty strings.
 * Each segment is trimmed and must not contain '/', '\' or '..' (prevents path
 * traversal outside the project root).
 */
function normalizePath(value: unknown): string[] {
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

function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) {
    const payload: Record<string, unknown> = { error: e.message };
    if (e.code) payload.code = e.code;
    return jsonResponse(payload, e.status);
  }
  const message = e instanceof Error ? e.message : "Server error";
  return jsonResponse({ error: message }, 500);
}
