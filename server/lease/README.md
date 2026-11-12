# Browser lease pilot

Project/unit lease plans run through the existing Jade Agent login. No loopback helper,
connection code or CAD installation is used by the web page.

## Execution and storage

`api/lease.mjs` verifies the Supabase user and active staff profile, creates an
owner-scoped job, and uses Vercel `waitUntil` to continue after the HTTP
response. Once accepted, closing the browser does not stop normal processing.
A job is created `processing`; `uploading` remains in the status constraint for
rows written before the source moved server-side, but nothing sets it now.

The source drawing is read server-side. The API calls the existing `file`
function with the caller's own token, and that function fetches the DWG from
SharePoint with the app-only Graph credentials after checking the account is
active. The browser neither downloads nor uploads the drawing, and no copy of it
is stored: it is held in memory for the length of the job and written straight
into the sandbox. Because the bytes are fetched by `driveId` and `itemId`, the
drawing a job runs on is the one SharePoint holds for that item rather than
whatever a client chose to send, and the name Microsoft reports is checked
against the name the request was validated against. The browser still rechecks
that no newer revision exists before submitting, and a 24 MB ceiling applies to
the declared length, the fetched bytes and every generated file.

Each job creates a separate, nonpersistent Vercel Sandbox with a four-minute
lifetime. A fixed SHA-256-verified CADCraft 0.7.0 Linux release is downloaded, then
network access is disabled before the private DWG is supplied. No database,
Microsoft, or Vercel credentials are passed into the sandbox. Only fixed Python
entrypoints run. The existing drawing/roundtrip validators are reused.

Validated DWG, PDF and editor scene are saved in the private `lease-plans` bucket.
The server publishes `ready` only after all three uploads succeed. Owner checks
precede short-lived download URLs. Clients cannot write job status or result
objects. A signed download already issued remains valid for up to 120 seconds.
One active job per account and 60 new jobs per rolling day limit pilot usage.

Jobs interrupted by a platform failure are not silently retried: after ten
minutes the API marks them failed and releases the account's processing slot.
The user can prepare a new review. This is bounded background execution, not a
persistent queue with automatic retry. Output copies never overwrite SharePoint.

## Where a finished plan lives

A finished plan is a company record, not a personal one. Every active member of
staff can list and download any plan whose status is `ready` (`/api/lease`
action `library`); drafts, failures and in-flight jobs stay with their owner,
and the editor scene is owner-only because an edit of someone else's plan is
refused anyway.

Reviewed plans are filed back into SharePoint by the `lease-publish` Supabase
function, which is where the Microsoft credentials live. It writes the DWG and
PDF into `LEASE_OUTPUT_ROOT` (default `<project root>/Lease Plans`) under
`<project>/<unit>`, asking Graph to rename on conflict, and records the
destination on the job only after Microsoft confirms both files. The source
drawing is never read or written by it. Filing is idempotent: a second request
returns the first filing instead of uploading a duplicate. It needs the
`Files.ReadWrite.All` application permission (SETUP.md step 2d) — without that
consent, generation and download are unaffected and only filing fails.

Deploy order for this part: migration, then `supabase functions deploy
lease-publish`, then the website. The job list selects the new `published`
columns, so the page reports cloud processing as unavailable until the migration
has run.

## Deployment

- Existing Vercel Vite project, with `/api/lease` Node function (300-second limit).
- Existing Supabase project; migration `20261017090000_lease_browser_jobs.sql`.
- Server-only `LEASE_SERVICE_ROLE_KEY` secret; never a VITE-prefixed variable.
- Existing `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` public configuration.
- Vercel Sandbox uses the deployment's OIDC identity; no saved PAT in production.
- `npm run build` prepares runtime Python and browser editor assets from the
  shared desktop sources, then builds the website. Do not edit generated files
  under `server/lease/runtime` or `public/lease-editor` directly.
- CADCraft MIT/Apache-2.0 and dependency notices remain under the Studio packaging
  directory. REA is a development tool and is not required by browser users.

## Validation

`node scripts/lease_plans/fetch-source-test.mjs` checks the server-side source
fetch offline -- a missing SharePoint location, an upstream refusal reported
without its body, the size ceiling, and a drawing renamed since the request --
with no accounts, sandbox or Microsoft call, so it costs nothing to run.

`node scripts/lease_plans/cloud-smoke.mjs` needs CLI access and an explicit
`STUDIO_TEST_DWG` environment path. It creates two temporary staff accounts,
runs real Linux generation and edit jobs, verifies privacy and disabled-account
rules, and removes test users and private artifacts. It incurs sandbox usage.
Python drawing tests remain under `scripts/lease_plans` and Studio `tests`.

Project and unit selection is unrestricted within the project library. Supported
templates must have metric millimetre geometry, an identifiable lease title, date,
scale and closed highlighted boundary around the requested unit(s). Combined
labels such as F4.5 / F4/5 are recognized. Conflicting file names and drawing
contents, ambiguous title blocks, and unsupported roundtrips stop for manual
review. The existing OLE2FRAME roundtrip refusal is deliberately retained.
