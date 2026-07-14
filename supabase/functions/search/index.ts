// POST { query: string, category?: Category }
// Parse the query, resolve the building folder, search Graph, filter + sort,
// log to search_logs, return { parsed, count, results }.

import { handleOptions, jsonResponse } from "../_shared/cors.ts";
import { HttpError, requireActiveUser, serviceClient } from "../_shared/auth.ts";
import { type Category, parseQuery } from "../_shared/parser.ts";
import {
  getDriveId,
  getFolderByPath,
  getProjectRoot,
  listChildren,
  searchInFolder,
} from "../_shared/graph.ts";
import { normalizePath } from "../_shared/paths.ts";
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

    // Scoped search: search within the folder the user is currently browsing.
    // A present array (even empty = project root) triggers this mode.
    if (Array.isArray(body.scopePath)) {
      return await scopedSearch({
        rawQuery,
        override,
        scopePath: normalizePath(body.scopePath),
        userId: user.id,
        username: profile.username,
      });
    }

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

    // A keyword is always required: scoped searches allow "RT pdf" (category
    // only), but an unscoped whole-project search needs a term to be useful.
    const needsKeyword = !parsed.buildingCode ||
      parsed.category === "all";
    if (parsed.keywordTokens.length === 0 && needsKeyword) {
      return jsonResponse(
        { error: "Add a unit or keyword, e.g. RT 1D", code: "NO_KEYWORD" },
        400,
      );
    }

    const driveId = await getDriveId();

    // Scope: a matched building narrows to its folder; otherwise search the
    // whole project tree (Marketing/Project by default).
    const building = parsed.buildingCode
      ? buildings.find((b) => b.code === parsed.buildingCode)!
      : null;
    const rootPath = building ? building.root_path : getProjectRoot();

    const rootFolder = await getFolderByPath(driveId, rootPath);
    if (!rootFolder) {
      const where = building
        ? `${building.name} (looked for '${building.root_path}')`
        : `the project folder (looked for '${rootPath}')`;
      return jsonResponse(
        {
          error:
            `SharePoint folder not found for ${where}. An admin can fix the path in Settings.`,
        },
        400,
      );
    }
    const rootId = rootFolder.id as string;

    let results: FileResult[] = [];
    let usedPics = false;
    // Pics-folder navigation only applies within a single building.
    if (parsed.picsMode && building) {
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

    const capped = results.slice(0, 250);

    // Zero-result fallback: if a building narrowed the search and nothing turned
    // up, retry across the whole project so a mis-scoped building name doesn't
    // hide matches that live elsewhere (e.g. "jade logo" scoped to a building
    // when the logo lives at the project root).
    if (building && capped.length === 0) {
      const projectFolder = await getFolderByPath(driveId, getProjectRoot());
      if (projectFolder) {
        const fbResults = await normalSearch(
          driveId,
          projectFolder.id as string,
          parsed.keywordTokens,
          parsed.category,
        );
        fbResults.sort((a, b) => {
          if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
          return (b.lastModified ?? "").localeCompare(a.lastModified ?? "");
        });
        const fbCapped = fbResults.slice(0, 250);
        if (fbCapped.length > 0) {
          await svc.from("search_logs").insert({
            user_id: user.id,
            username: profile.username,
            query: rawQuery,
            parsed: { ...parsed, fallbackFrom: building.name },
            result_count: fbCapped.length,
          });
          return jsonResponse({
            parsed,
            count: fbCapped.length,
            results: fbCapped,
            fallbackFrom: building.name,
          });
        }
      }
    }

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

interface ScopedSearchArgs {
  rawQuery: string;
  override: Category | undefined;
  scopePath: string[];
  userId: string;
  username: string;
}

/**
 * Search within the folder the user is currently browsing. No building
 * matching (empty buildings list) and no picsMode — the whole input minus
 * filler/category words is the keyword, scoped to project-root/scopePath.
 */
async function scopedSearch(args: ScopedSearchArgs): Promise<Response> {
  const { rawQuery, override, scopePath, userId, username } = args;

  // No building matching: the query minus filler/category is the keyword.
  const parsed = parseQuery(rawQuery, [], override);

  if (parsed.keywordTokens.length === 0) {
    return jsonResponse(
      { error: "Type something to search for.", code: "NO_KEYWORD" },
      400,
    );
  }

  const driveId = await getDriveId();
  const fullPath = [getProjectRoot(), ...scopePath].join("/");
  const folder = await getFolderByPath(driveId, fullPath);
  if (!folder) {
    return jsonResponse(
      {
        error:
          `Folder not found: ${["Project", ...scopePath].join("/")}. It may ` +
          `have been moved or renamed.`,
      },
      400,
    );
  }

  const results = await normalSearch(
    driveId,
    folder.id as string,
    parsed.keywordTokens,
    parsed.category,
  );

  // Sort: folders first, then most-recently-modified.
  results.sort((a, b) => {
    if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
    return (b.lastModified ?? "").localeCompare(a.lastModified ?? "");
  });

  const capped = results.slice(0, 250);

  // Audit log (service role — client inserts are blocked by RLS). Record the
  // browsed scope alongside the parsed query.
  const svc = serviceClient();
  await svc.from("search_logs").insert({
    user_id: userId,
    username,
    query: rawQuery,
    parsed: { ...parsed, scopePath },
    result_count: capped.length,
  });

  return jsonResponse({ parsed, count: capped.length, results: capped });
}

function normalizeCategory(value: unknown): Category | undefined {
  if (
    value === "pdf" || value === "dwg" || value === "images" ||
    value === "plan" || value === "word" || value === "excel" ||
    value === "psd" || value === "all"
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
      case "word":
        return (
          it.extension === "doc" || it.extension === "docx" ||
          it.extension === "rtf"
        );
      case "excel":
        return (
          it.extension === "xls" || it.extension === "xlsx" ||
          it.extension === "xlsm" || it.extension === "csv"
        );
      case "psd":
        return it.extension === "psd" || it.extension === "psb";
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
