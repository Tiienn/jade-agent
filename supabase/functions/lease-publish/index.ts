// POST { jobId } — file a reviewed lease plan's DWG and PDF into SharePoint.
//
// Why this lives here and not in /api/lease, which owns everything else about a
// lease job: the Microsoft credentials are Supabase function secrets and every
// Graph call in this project goes through _shared/graph.ts. The Vercel function
// holds the sandbox, the job rows and the private bucket; this one holds the
// single thing it cannot reach.
//
// Nothing in SharePoint is replaced. The copies are written into their own
// output folder (LEASE_OUTPUT_ROOT, default "<project root>/Lease Plans") under
// <project>/<unit>, with Graph asked to RENAME on conflict. The source drawing
// is not touched -- it is not even read here.
//
// ORDER: upload first, record second. If the recording update fails, the files
// are in SharePoint while the job still reads unpublished, so a retry files a
// renamed second copy: visible, and recoverable by deleting one. The other
// order fails the unrecoverable way -- a plan marked filed that nobody can
// find. For the same reason the bytes are fetched from storage BEFORE any
// folder is created, so a missing artifact cannot leave empty folders behind.
//
// This needs the Files.ReadWrite.All application permission (SETUP.md step 2d).
// Until that consent is granted, Graph answers 403 and the message below tells
// the user exactly that rather than a generic failure.

import { handleOptions, jsonResponse } from "../_shared/cors.ts";
import { HttpError, requireActiveUser, serviceClient } from "../_shared/auth.ts";
import {
  ensureFolderPath,
  getDriveId,
  getProjectRoot,
  uploadFile,
  type UploadedItem,
} from "../_shared/graph.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BUCKET = "lease-plans";
const MAX_BYTES = 24 * 1024 * 1024;

interface JobRow {
  id: string;
  user_id: string;
  status: string;
  review: Record<string, unknown> | null;
  published: unknown;
  published_at: string | null;
}

Deno.serve(async (req: Request) => {
  const pre = handleOptions(req);
  if (pre) return pre;

  try {
    if (req.method !== "POST") throw new HttpError(405, "Method not allowed");

    const { user, profile } = await requireActiveUser(req);
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const jobId = typeof body.jobId === "string" ? body.jobId.trim() : "";
    if (!UUID.test(jobId)) throw new HttpError(400, "A valid jobId is required.");

    const svc = serviceClient();
    const job = await loadJob(svc, jobId);

    // Preparing a plan is the act that puts your name on it, so filing it is
    // yours to do. An admin can file on behalf of someone who has left or is
    // away -- which is half the reason this feature exists.
    if (job.user_id !== user.id && profile.role !== "admin") {
      throw new HttpError(
        403,
        "Only the person who prepared this plan, or an admin, can file it to SharePoint.",
        "not_owner",
      );
    }
    if (job.status !== "ready") {
      throw new HttpError(
        409,
        "This plan is not finished yet. Wait for the review to be ready.",
      );
    }

    // Idempotent: a second click, or a second tab, means what the first meant.
    // Never re-upload, which would file a renamed duplicate.
    if (job.published_at) {
      return jsonResponse({
        published: job.published,
        publishedAt: job.published_at,
        alreadyPublished: true,
      });
    }

    const review = job.review ?? {};
    const project = safeSegment(review.project, "Unsorted");
    const unit = safeSegment(review.unit, "Unit");

    // Bytes first (see the header): a plan whose artifacts have gone missing
    // must not create folders in the library on its way to failing.
    const dwg = await artifact(svc, job, "result.dwg");
    const pdf = await artifact(svc, job, "result.pdf");

    const driveId = await getDriveId();
    const root = (Deno.env.get("LEASE_OUTPUT_ROOT") ||
      `${getProjectRoot()}/Lease Plans`).replace(/^\/+|\/+$/g, "");
    const folderPath = `${root}/${project}/${unit}`;
    const folder = await ensureFolderPath(driveId, folderPath);

    const items: UploadedItem[] = [];
    items.push(
      await uploadFile(
        driveId,
        folder.id,
        safeFileName(review.pdf, "pdf"),
        pdf,
        "application/pdf",
      ),
    );
    items.push(
      await uploadFile(
        driveId,
        folder.id,
        safeFileName(review.dwg, "dwg"),
        dwg,
        "application/acad",
      ),
    );

    const published = { driveId, folder: folderPath, items };
    const publishedAt = new Date().toISOString();
    const { error } = await svc
      .from("lease_jobs")
      .update({
        published,
        published_at: publishedAt,
        published_by: user.id,
        updated_at: publishedAt,
      })
      .eq("id", job.id);
    if (error) {
      // The files ARE filed. Say so, and say what is wrong, so nobody files a
      // second copy believing the first never landed.
      throw new HttpError(
        500,
        `The plan was filed to ${folderPath} in SharePoint, but Jade Agent could not record it. Check the folder before filing again.`,
        "recorded_failed",
      );
    }

    return jsonResponse({ published, publishedAt, alreadyPublished: false });
  } catch (e) {
    return errorResponse(e);
  }
});

// ---------------------------------------------------------------------------

async function loadJob(svc: SupabaseClient, jobId: string): Promise<JobRow> {
  const { data, error } = await svc
    .from("lease_jobs")
    .select("id,user_id,status,review,published,published_at")
    .eq("id", jobId)
    .maybeSingle();
  if (error) throw new HttpError(500, "Could not load the lease plan.");
  if (!data) throw new HttpError(404, "That lease plan no longer exists.");
  return data as unknown as JobRow;
}

/** One generated artifact from the private bucket, as bytes. */
async function artifact(
  svc: SupabaseClient,
  job: JobRow,
  file: string,
): Promise<Uint8Array> {
  const { data, error } = await svc.storage
    .from(BUCKET)
    .download(`${job.user_id}/${job.id}/${file}`);
  if (error || !data) {
    throw new HttpError(
      404,
      "This review's files are no longer in storage. Prepare the plan again.",
    );
  }
  const bytes = new Uint8Array(await data.arrayBuffer());
  if (!bytes.byteLength || bytes.byteLength > MAX_BYTES) {
    throw new HttpError(422, "This review's files cannot be filed.");
  }
  return bytes;
}

/**
 * A folder or file name SharePoint will accept: no path separators, no
 * characters it reserves, no trailing dot, and never empty.
 */
function clean(value: unknown, limit: number): string {
  return String(value ?? "")
    .replace(/[\u0000-\u001f"*:<>?/\\|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit)
    .replace(/[.\s]+$/, "")
    .trim();
}

function safeSegment(value: unknown, fallback: string): string {
  return clean(value, 80) || fallback;
}

function safeFileName(value: unknown, extension: "dwg" | "pdf"): string {
  const raw = String(value ?? "");
  const stem = raw.toLowerCase().endsWith(`.${extension}`)
    ? raw.slice(0, -(extension.length + 1))
    : raw;
  return `${clean(stem, 120) || "Lease plan"}.${extension}`;
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
