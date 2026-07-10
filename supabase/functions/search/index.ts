// POST { query: string, category?: Category }
// Parse the query, resolve the building folder, search Graph, filter + sort,
// log to search_logs, return { parsed, count, results }.

import { handleOptions, jsonResponse } from "../_shared/cors.ts";
import { HttpError, requireActiveUser, serviceClient } from "../_shared/auth.ts";
import { type Category, parseQuery } from "../_shared/parser.ts";
import {
  getDriveId,
  getFolderByPath,
  listChildren,
  searchInFolder,
} from "../_shared/graph.ts";
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

    const { user, profile } = await requireActiveUser(req);

    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const rawQuery = typeof body.query === "string" ? body.query : "";
    const override = normalizeCategory(body.category);

    const svc = serviceClient();
    const { data: buildingsData, error: bErr } = await svc
      .from("buildings")
      .select("code,name,root_path");
    if (bErr) throw new HttpError(500, "Could not load buildings");
    const buildings = (buildingsData ?? []) as BuildingRow[];

    const parsed = parseQuery(
      rawQuery,
      buildings.map((b) => ({ code: b.code, name: b.name })),
      override,
    );

    if (!parsed.buildingCode) {
      return jsonResponse(
        {
          error:
            "Couldn't find a building in your search. Use a code like RT, AH, AC, FSB, JC, JH, M, W, PS — or the building name.",
          code: "NO_BUILDING",
        },
        400,
      );
    }
    if (parsed.keywordTokens.length === 0 && parsed.category === "all") {
      return jsonResponse(
        { error: "Add a unit or keyword, e.g. RT 1D", code: "NO_KEYWORD" },
        400,
      );
    }

    const building = buildings.find((b) => b.code === parsed.buildingCode)!;

    const driveId = await getDriveId();
    const rootFolder = await getFolderByPath(driveId, building.root_path);
    if (!rootFolder) {
      return jsonResponse(
        {
          error:
            `SharePoint folder not found for ${building.name} (looked for '${building.root_path}'). An admin can fix the path in Settings.`,
        },
        400,
      );
    }
    const rootId = rootFolder.id as string;

    let results: FileResult[] = [];
    let usedPics = false;
    if (parsed.picsMode) {
      const picsResults = await tryPicsMode(driveId, rootId, parsed.keywordTokens);
      if (picsResults && picsResults.length > 0) {
        results = picsResults;
        usedPics = true;
      }
    }
    if (!usedPics) {
      results = await normalSearch(driveId, rootId, parsed.keywordTokens, parsed.category);
    }

    // Sort: folders first, then most-recently-modified.
    results.sort((a, b) => {
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
      return (b.lastModified ?? "").localeCompare(a.lastModified ?? "");
    });

    const capped = results.slice(0, 100);

    // Audit log (service role — client inserts are blocked by RLS).
    await svc.from("search_logs").insert({
      user_id: user.id,
      username: profile.username,
      query: rawQuery,
      parsed,
      result_count: capped.length,
    });

    return jsonResponse({ parsed, count: capped.length, results: capped });
  } catch (e) {
    return errorResponse(e);
  }
});

function normalizeCategory(value: unknown): Category | undefined {
  if (
    value === "pdf" || value === "dwg" || value === "images" ||
    value === "plan" || value === "all"
  ) {
    return value;
  }
  return undefined;
}

/** Pics-folder navigation. Returns null to signal a fallback to normal search. */
async function tryPicsMode(
  driveId: string,
  rootId: string,
  keywordTokens: string[],
): Promise<FileResult[] | null> {
  const children = await listChildren(driveId, rootId);
  const picsFolder = children.find(
    (c) => c.isFolder && ["pics", "pictures", "photos"].includes(c.name.toLowerCase()),
  );
  if (!picsFolder) return null;

  let targetId = picsFolder.id;
  if (keywordTokens.length > 0) {
    const sub = await listChildren(driveId, picsFolder.id);
    const match = sub.find(
      (c) =>
        c.isFolder &&
        keywordTokens.every((t) => c.name.toLowerCase().includes(t)),
    );
    if (!match) return null;
    targetId = match.id;
  }

  const contents = await listChildren(driveId, targetId);
  const images = contents.filter((c) => !c.isFolder && c.previewType === "image");
  return images;
}

async function normalSearch(
  driveId: string,
  rootId: string,
  keywordTokens: string[],
  category: Category,
): Promise<FileResult[]> {
  const q = keywordTokens[0] ?? "";
  let items = await searchInFolder(driveId, rootId, q);

  // Name must contain every keyword token.
  items = items.filter((it) =>
    keywordTokens.every((t) => it.name.toLowerCase().includes(t))
  );

  // Category filter.
  items = items.filter((it) => {
    switch (category) {
      case "pdf":
        return it.extension === "pdf";
      case "dwg":
        return it.extension === "dwg" || it.extension === "dxf";
      case "images":
        return it.previewType === "image";
      case "plan":
        return (
          it.name.toLowerCase().includes("plan") ||
          it.path
            .split("/")
            .some((seg) => seg.trim().toLowerCase().startsWith("plan"))
        );
      default:
        return true; // 'all'
    }
  });

  return items;
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
