# Jade File Finder

Internal tool for Jade Group staff to search company SharePoint files with short, loose
queries (e.g. `RT 1D pdf`). Two roles: **worker** (search + preview/download files) and
**admin** (same, plus dashboard / users / settings). Built with React 18, TypeScript,
Vite 5, Tailwind CSS v4, react-router-dom v6 and Supabase.

## Local development

```bash
npm install
cp .env.example .env   # then fill in your Supabase URL + anon key
npm run dev
```

The app runs against Supabase Auth + edge functions. All Microsoft Graph / SharePoint
calls happen server-side — no Microsoft credentials ever live in the frontend.

## Full setup

Provisioning Supabase (database, RLS, edge functions, Azure app registration and secrets)
is documented in **SETUP.md**.

## File drop

Choose **Share** (`/share`) to move files between a phone, laptop, or PC. Sign in
with the same Jade account on each device. Drag files onto the drop area or use
**Choose files**, then download them from the other device. Scan the QR code on
the Share page with your phone to open the permanent file-drop URL. Jade sign-in
returns you to the page you requested. The list refreshes
every 10 seconds while visible and when the window regains focus. Devices need
internet access, but can use different networks and need not be online together.

Files are private to the account, limited to 50 MB each, and remain until deleted.
Deleting from the drop removes the stored file on all devices; downloaded copies
are unaffected. Multiple files and repeated filenames are supported. Upload errors
are reported per file; successful files remain available if another upload fails.

The `20261016192243_file_drops.sql` migration creates a private Supabase Storage
bucket with owner-folder policies for active staff accounts. Apply it through the
normal Supabase migration process before serving the Share page in a new
environment. Uploads and downloads go directly to Storage using the user's session.
No service key, public file URL, or new backend secret is needed in the browser.

To verify: upload files on one device, download on another signed into the same
account, compare contents, and delete. Check duplicate names, accented filenames,
empty/oversized files, and partial batch failures. Another account or an unsigned
browser must not be able to list, download, upload into, or delete your files.

Run `node scripts/share-smoke.mjs` for the live Storage integration checks using
the CLI-linked Supabase project. It creates temporary staff accounts and small
files, verifies transfers and access policies, and removes the test data.

File transfers show actual byte progress, including a separate bar for each file
in an upload batch. File rows show the upload date and time in the viewing device's
timezone. After a download reaches the browser, its button reads **Downloaded**
and can be used to download again. This status is saved for the most recent 1,000
files in that browser, per account; it does not mark other devices as downloaded.

**Share text** stores private notes or links (up to 10,000 characters) that can be
copied or deleted from another device. The `20261016200650_share_text_and_presence.sql`
migration adds the protected text table and private Realtime room policies. Both
Share migrations are required when setting up a new environment.

Open Share on two devices with the same account to see **Devices connected**. The
QR code hides only after the latest file/text snapshots match on each connected
device; **Show QR code** lets you add another device. Tabs in the same browser
count as one device. Changes trigger a live refresh, with polling every 10 seconds
as a fallback. The QR returns if another device disconnects or falls out of sync.

Each active upload/download has **Cancel**; queued uploads can also be cancelled.
Failed or cancelled transfers offer **Retry upload** / **Retry download**. Retries
resume using saved progress. Uploads use Storage TUS sessions and resume from the
last confirmed 6 MB chunk (an unfinished chunk may be resent). Downloads retain
received bytes and request the remainder with HTTP Range. If storage ignores Range,
the download safely starts over; changed files are never appended to old bytes.
Upload sessions expire after 24 hours, after which a fresh upload is necessary.
Uploads retain the selected File while Share remains
open, so no picker is needed; leaving or reloading the page cancels active
transfers and clears the in-memory upload queue. Downloaded is recorded only after
an uncancelled download completes. A retry reuses the upload's object key and checks
for a previously committed object, preventing duplicates after a lost response.
