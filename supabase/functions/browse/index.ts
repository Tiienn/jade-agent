// POST { buildingCode: string, subPath?: string[] }
// List the direct contents of a building's folder (click-through navigation).
// Resolve the building root + optional subPath, list children, sort + cap,
// return { building, subPath, entries }.

import { handleOptions, jsonResponse } from "../_shared/cors.ts";
import { HttpError, requireActiveUser, serviceClient } from "../_shared/auth.ts";
import { getDriveId, getFolderByPath, listChildren } from "../_shared/graph.ts";
import type { FileResult } from "../_shared/types.ts";

interface BuildingRow {
  code: string;
  name: string;
  root_path: string;
}

Deno.serve(async (req: Request) => {
  const pre = handleOptions(req);
  if (pre) return pre;

  try {
    if (req.method !== "POST") throw new HttpError(405, "Method not allowed");

    await requireActiveUser(req);

    const body = await req.json().catch(() => ({} as Record<string, unknown>));

    const buildingCode = typeof body.buildingCode === "string"
      ? body.buildingCode.trim()
      : "";
    if (!buildingCode) {
      throw new HttpError(400, "buildingCode is required.");
    }

    const subPath = normalizeSubPath(body.subPath);

    const svc = serviceClient();
    const { data: buildingData, error: bErr } = await svc
      .from("buildings")
      .select("code,name,root_path")
      .eq("code", buildingCode)
      .maybeSingle();
    if (bErr) throw new HttpError(500, "Could not load buildings");

    const building = buildingData as BuildingRow | null;
    if (!building) {
      return jsonResponse(
        { error: "That building doesn't exist.", code: "NO_BUILDING" },
        400,
      );
    }

    const driveId = await getDriveId();
    const fullPath = [building.root_path, ...subPath].join("/");
    const folder = await getFolderByPath(driveId, fullPath);
    if (!folder) {
      const shown = [building.name, ...subPath].join("/");
      return jsonResponse(
        {
          error:
            `Folder not found: ${shown}. It may have been moved or renamed.`,
        },
        400,
      );
    }

    let entries = await listChildren(driveId, folder.id as string);

    // Sort: folders first, then alphabetical by name (case-insensitive).
    entries.sort((a, b) => {
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });

    entries = entries.slice(0, 500);

    return jsonResponse({
      building: { code: building.code, name: building.name },
      subPath,
      entries,
    });
  } catch (e) {
    return errorResponse(e);
  }
});

/**
 * Validate and normalize subPath: must be absent or an array of non-empty
 * strings. Each segment is trimmed and must not contain '/', '\' or '..'
 * (prevents path traversal).
 */
function normalizeSubPath(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new HttpError(400, "subPath must be an array of folder names.");
  }
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") {
      throw new HttpError(400, "subPath must be an array of folder names.");
    }
    const seg = raw.trim();
    if (!seg) {
      throw new HttpError(400, "subPath segments must not be empty.");
    }
    if (seg.includes("/") || seg.includes("\\") || seg.includes("..")) {
      throw new HttpError(400, "Invalid folder name in subPath.");
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
