// POST { driveId, itemId, mode: 'download' | 'preview' }
// Stream the file bytes through the backend so the SharePoint pre-authenticated
// URL never reaches the client. The body is piped through, never buffered.

import { corsHeaders, handleOptions, jsonResponse } from "../_shared/cors.ts";
import { HttpError, requireActiveUser } from "../_shared/auth.ts";
import { getDownloadInfo } from "../_shared/graph.ts";

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  heic: "image/heic",
  dwg: "application/acad",
  dxf: "image/vnd.dxf",
  txt: "text/plain; charset=utf-8",
};

function inferMime(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  return MIME_BY_EXT[name.slice(dot + 1).toLowerCase()] ?? null;
}

Deno.serve(async (req: Request) => {
  const pre = handleOptions(req);
  if (pre) return pre;

  try {
    if (req.method !== "POST") throw new HttpError(405, "Method not allowed");

    await requireActiveUser(req);

    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const driveId = body.driveId;
    const itemId = body.itemId;
    const mode = body.mode === "preview" ? "preview" : "download";

    if (typeof driveId !== "string" || !driveId) {
      throw new HttpError(400, "driveId is required");
    }
    if (typeof itemId !== "string" || !itemId) {
      throw new HttpError(400, "itemId is required");
    }

    const info = await getDownloadInfo(driveId, itemId);
    if (!info.downloadUrl) {
      throw new HttpError(404, "This file is not available for download.");
    }

    const upstream = await fetch(info.downloadUrl);
    if (!upstream.ok || !upstream.body) {
      throw new HttpError(
        502,
        `Could not fetch the file from SharePoint (${upstream.status}).`,
      );
    }

    const name = info.name || "file";
    const contentType = upstream.headers.get("Content-Type") ??
      info.mimeType ??
      inferMime(name) ??
      "application/octet-stream";

    const headers = new Headers(corsHeaders);
    headers.set("Content-Type", contentType);
    const len = upstream.headers.get("Content-Length");
    if (len) headers.set("Content-Length", len);
    const disposition = mode === "preview" ? "inline" : "attachment";
    headers.set(
      "Content-Disposition",
      `${disposition}; filename*=UTF-8''${encodeURIComponent(name)}`,
    );

    // Pipe the ReadableStream straight through — no buffering.
    return new Response(upstream.body, { status: 200, headers });
  } catch (e) {
    if (e instanceof HttpError) {
      const payload: Record<string, unknown> = { error: e.message };
      if (e.code) payload.code = e.code;
      return jsonResponse(payload, e.status);
    }
    const message = e instanceof Error ? e.message : "Server error";
    return jsonResponse({ error: message }, 500);
  }
});
