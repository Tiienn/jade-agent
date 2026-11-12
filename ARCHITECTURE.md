# Jade File Finder — Architecture

Internal tool for Jade Group staff: search company SharePoint files with short, loose queries.

## Stack
- **Frontend:** React 18 + TypeScript + Vite + Tailwind CSS v4 + react-router-dom v6, deployed on Vercel (SPA).
- **Backend:** Supabase — Auth, Postgres (RLS), Deno edge functions, Vault, and pg_cron. All Microsoft Graph calls happen server-side.
- **Secrets (edge functions only, never in frontend):** `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `SHAREPOINT_SITE_ID`.

## Accounts
- Workers/admins log in with **username + password**. Under the hood each account is a Supabase Auth user with a synthetic email: `<username>@workers.jadegroup.app`. Workers never see an email.
- Roles live in `profiles.role` (`admin` | `worker`). Accounts are deactivated (`profiles.active = false`), not deleted, to preserve the audit trail.
- First launch: `admin-users` function exposes a `bootstrap` action that only works while zero admins exist; the frontend shows a one-time "Create admin" screen at `/setup`.

## Database
- `profiles(id → auth.users, username unique, display_name, role, active, created_at)`
- `buildings(id, code unique, name, root_path, created_at)` — seeded with RT, AH, AC, FSB, JC, JH, M, W, PS; `root_path` defaults to `Marketing/Project/<Building Name>`; admin-editable in Settings.
- `search_logs(id, user_id, username, query, parsed jsonb, result_count, created_at)` — written by the `search` function with the service role.
- `lexpress_monitor_config` + `lexpress_leads` — backend-only monitor state and deduplicated property enquiries; portal credentials live separately in Supabase Vault.
- RLS: users read their own profile/logs; `is_admin()` (security-definer) unlocks everything for admins; `buildings` readable by all authenticated users, writable by admins; `search_logs` insert is service-role only.

## Edge functions (all verify the Supabase JWT in-function; `verify_jwt = false` in config)
1. **`search`** — `POST {query, category?}` → parses the query (building + unit keyword + category, any order, forgiving of dashes/filler words), resolves the building's folder under the site's Documents drive, calls Graph `/drives/{id}/items/{folderId}/search(q=…)`, filters by name-contains + category, logs to `search_logs`, returns `{parsed, count, results}`.
   - Category `images` first tries **Pics-folder navigation**: building root → folder named Pics/Pictures/Photos → subfolder containing the unit → its image children; falls back to a normal search filtered to image extensions.
   - Category `plan` matches filename containing "plan" OR items inside a Plans folder.
2. **`file`** — `POST {driveId, itemId, mode: 'download'|'preview'}` → streams the file bytes through the backend (attachment vs inline). The frontend saves the blob directly; no SharePoint URLs ever reach the user.
3. **`admin-users`** — admin-only account management: `list`, `create`, `setActive`, `resetPassword`, `delete`, plus unauthenticated `bootstrapStatus`/`bootstrap` (guarded: only while no admin exists).
4. **`lexpress-monitor`** — admin-configured and pg_cron-invoked L'Express Property CSV checker. The first successful configuration baselines existing rows; later unseen leads are sent as an escaped, fixed-recipient digest to Charles. Each notification is created with an immutable Microsoft message id, sent, then queried in Sent Items before Jade reports confirmed delivery.
5. **`invoice-draft`** — authenticated multipart endpoint for up to four small PDF invoices. `analyse` sends ephemeral PDF inputs to OpenAI with `store: false`, adds the current user's recent private before/after writing examples, and returns structured client/invoice details plus a proposed email. `createDraft` revalidates the files, writes a new Outlook draft with the PDFs attached, and records a new style example only when the user changed the proposed message. It exposes no send operation.

Graph auth: client-credentials token (`https://graph.microsoft.com/.default`), cached in-module until expiry. Required Azure app permissions: `Sites.Read.All`, `Files.Read.All` (Application), admin-consented — see SETUP.md.

## Frontend routes
- `/login`, `/setup` (first-run admin creation)
- `/` — worker search: big search bar, category filter buttons, recent searches, results grid (name, type icon, folder path, modified, size), inline preview modal (PDF iframe / image / DWG placeholder), download button.
- `/admin` (activity dashboard: filter by worker/date, zero-result searches highlighted), `/admin/users`, `/admin/settings` — admin role required. Admins can also use search.
- `/invoices` — upload up to four invoice PDFs, review Jade's extracted details and proposed wording, then create a fully attached Outlook draft.

## Design
Neutral professional, jade/teal accent (#0F766E), mobile-first (workers on phones on site), no decorative emojis — lucide-react / inline SVG icons only.
