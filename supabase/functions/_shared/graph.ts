// Microsoft Graph client. All SharePoint access is server-side, using an
// app-only (client-credentials) token cached in-module until expiry.

import { HttpError } from "./auth.ts";
import type { DownloadInfo, FileResult, PreviewType } from "./types.ts";

const GRAPH = "https://graph.microsoft.com/v1.0";
const SELECT = "id,name,size,lastModifiedDateTime,file,folder,parentReference";

function reqEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) {
    throw new HttpError(
      500,
      `Microsoft credentials not configured — see SETUP.md (missing ${name})`,
    );
  }
  return v;
}

// ---------------------------------------------------------------------------
// Token cache
// ---------------------------------------------------------------------------

let tokenCache: { token: string; exp: number } | null = null;

export async function getGraphToken(): Promise<string> {
  const now = Date.now();
  if (tokenCache && tokenCache.exp > now) return tokenCache.token;

  const tenant = reqEnv("MS_TENANT_ID");
  const clientId = reqEnv("MS_CLIENT_ID");
  const clientSecret = reqEnv("MS_CLIENT_SECRET");

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "client_credentials",
    scope: "https://graph.microsoft.com/.default",
  });

  const res = await fetch(
    `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    },
  );

  if (!res.ok) {
    const detail = await safeText(res);
    throw new HttpError(
      502,
      `Microsoft sign-in failed (${res.status}). Check MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET and admin consent (SETUP.md). ${detail}`,
    );
  }

  const json = await res.json();
  const expiresIn = Number(json.expires_in ?? 3600);
  tokenCache = {
    token: json.access_token,
    exp: now + Math.max(0, expiresIn - 60) * 1000, // refresh 60s early
  };
  return tokenCache.token;
}

// ---------------------------------------------------------------------------
// Low-level fetch helpers
// ---------------------------------------------------------------------------

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 400);
  } catch {
    return "";
  }
}

async function throwGraph(res: Response): Promise<never> {
  const detail = await safeText(res);
  if (res.status === 401 || res.status === 403) {
    throw new HttpError(
      502,
      `Microsoft Graph denied the request (${res.status}). Check Microsoft credentials / admin consent (SETUP.md). ${detail}`,
    );
  }
  throw new HttpError(502, `Microsoft Graph error (${res.status}). ${detail}`);
}

async function graphGet(path: string): Promise<any> {
  const token = await getGraphToken();
  const res = await fetch(`${GRAPH}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) await throwGraph(res);
  return res.json();
}

// ---------------------------------------------------------------------------
// Drive / folder resolution
// ---------------------------------------------------------------------------

let driveIdCache: string | null = null;

export async function getDriveId(): Promise<string> {
  if (driveIdCache) return driveIdCache;
  const site = reqEnv("SHAREPOINT_SITE_ID");
  const json = await graphGet(`/sites/${site}/drive`);
  driveIdCache = json.id as string;
  return driveIdCache;
}

/** Resolve a folder by drive-relative path. Returns null on 404. */
export async function getFolderByPath(
  driveId: string,
  path: string,
): Promise<any | null> {
  const token = await getGraphToken();
  const encoded = path
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  const res = await fetch(`${GRAPH}/drives/${driveId}/root:/${encoded}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) await throwGraph(res);
  return res.json();
}

// ---------------------------------------------------------------------------
// Search / listing
// ---------------------------------------------------------------------------

export async function searchInFolder(
  driveId: string,
  folderId: string,
  q: string,
): Promise<FileResult[]> {
  const token = await getGraphToken();
  const escaped = q.replace(/'/g, "''"); // OData: double single-quotes
  let url =
    `${GRAPH}/drives/${driveId}/items/${folderId}/search(q='${encodeURIComponent(escaped)}')?$top=50&$select=${SELECT}`;

  const items: any[] = [];
  let pages = 0;
  while (url && pages < 4) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) await throwGraph(res);
    const json = await res.json();
    for (const it of json.value ?? []) items.push(it);
    url = json["@odata.nextLink"] ?? "";
    pages += 1;
  }
  return items.map(mapItem);
}

export async function listChildren(
  driveId: string,
  folderId: string,
): Promise<FileResult[]> {
  const json = await graphGet(
    `/drives/${driveId}/items/${folderId}/children?$top=200&$select=${SELECT}`,
  );
  return (json.value ?? []).map(mapItem);
}

export async function getDownloadInfo(
  driveId: string,
  itemId: string,
): Promise<DownloadInfo> {
  const token = await getGraphToken();
  // No $select here: @microsoft.graph.downloadUrl is a computed property that
  // Graph omits from the response whenever $select is used, even if the field
  // is explicitly listed. Fetching the full item is the only way to get it.
  const res = await fetch(
    `${GRAPH}/drives/${driveId}/items/${itemId}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) await throwGraph(res);
  const json = await res.json();
  return {
    name: json.name ?? "file",
    size: json.size ?? 0,
    downloadUrl: json["@microsoft.graph.downloadUrl"] ?? null,
    mimeType: json.file?.mimeType,
  };
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function extensionOf(name: string, isFolder: boolean): string {
  if (isFolder) return "";
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

function previewTypeOf(ext: string, isFolder: boolean): PreviewType {
  if (isFolder) return "other";
  if (ext === "pdf") return "pdf";
  if (["jpg", "jpeg", "png", "gif", "webp", "bmp", "heic"].includes(ext)) {
    return "image";
  }
  if (["dwg", "dxf"].includes(ext)) return "dwg";
  return "other";
}

/** parentReference.path -> human-readable path (strip "/drive/root:" prefix). */
function humanPath(refPath: string | undefined): string {
  if (!refPath) return "";
  const marker = "root:";
  const idx = refPath.indexOf(marker);
  let rest = idx >= 0 ? refPath.slice(idx + marker.length) : refPath;
  try {
    rest = decodeURIComponent(rest);
  } catch {
    // leave as-is if malformed
  }
  return rest;
}

function mapItem(it: any): FileResult {
  const isFolder = !!it.folder;
  const name: string = it.name ?? "";
  const ext = extensionOf(name, isFolder);
  return {
    id: it.id,
    driveId: it.parentReference?.driveId ?? "",
    name,
    extension: ext,
    path: humanPath(it.parentReference?.path),
    size: it.size ?? 0,
    lastModified: it.lastModifiedDateTime ?? null,
    isFolder,
    previewType: previewTypeOf(ext, isFolder),
  };
}
