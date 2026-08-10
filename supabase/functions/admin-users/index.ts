// POST { action, ... } — account management via the service role + auth.admin.
// Usernames map to synthetic emails: <username>@workers.jadegroup.app.
// admin accounts are never created/mutated here except via bootstrap.

import { handleOptions, jsonResponse } from "../_shared/cors.ts";
import { HttpError, requireAdmin, serviceClient } from "../_shared/auth.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,29}$/i;
const USERNAME_HELP =
  "Username must be 3–30 characters: letters, numbers, dot, dash or underscore, starting with a letter or number.";

function normUsername(u: string): string {
  return u.trim().toLowerCase();
}

function emailFor(username: string): string {
  return `${normUsername(username)}@workers.jadegroup.app`;
}

function requireValidUsername(u: unknown): string {
  if (typeof u !== "string" || !USERNAME_RE.test(u.trim())) {
    throw new HttpError(400, USERNAME_HELP);
  }
  return normUsername(u);
}

function requireValidPassword(p: unknown): string {
  if (typeof p !== "string" || p.length < 8) {
    throw new HttpError(400, "Password must be at least 8 characters.");
  }
  return p;
}

Deno.serve(async (req: Request) => {
  const pre = handleOptions(req);
  if (pre) return pre;

  try {
    if (req.method !== "POST") throw new HttpError(405, "Method not allowed");

    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const action = body.action;
    const svc = serviceClient();

    // ---- Unauthenticated actions -----------------------------------------
    if (action === "bootstrapStatus") {
      const needsBootstrap = !(await adminExists(svc));
      return jsonResponse({ needsBootstrap });
    }

    if (action === "bootstrap") {
      if (await adminExists(svc)) {
        throw new HttpError(403, "An admin already exists.");
      }
      const username = requireValidUsername(body.username);
      const password = requireValidPassword(body.password);
      const displayName = resolveDisplayName(body.displayName, username);
      return await createAccount(svc, username, displayName, password, "admin");
    }

    // ---- Admin-only actions ----------------------------------------------
    const { user: adminUser } = await requireAdmin(req);

    switch (action) {
      case "list": {
        const { data, error } = await svc
          .from("profiles")
          .select("id,username,display_name,role,active,created_at")
          .order("created_at", { ascending: true });
        if (error) throw new HttpError(500, "Could not list users");
        return jsonResponse({
          users: (data ?? []).map((p) => ({
            id: p.id,
            username: p.username,
            displayName: p.display_name,
            role: p.role,
            active: p.active,
            createdAt: p.created_at,
          })),
        });
      }

      case "create": {
        const username = requireValidUsername(body.username);
        const password = requireValidPassword(body.password);
        const displayName = resolveDisplayName(body.displayName, username);
        // Optional: link the new login to a roster person in the same step.
        // Onboarding 15 staff one screen at a time is the difference between
        // this feature being used and being abandoned, and an account created
        // now and linked "later" is an account that can read the board but
        // cannot file its own leave.
        const staffId = body.staffId == null ? null : String(body.staffId);
        return await createAccount(
          svc,
          username,
          displayName,
          password,
          "worker",
          staffId,
        );
      }

      case "setActive": {
        const userId = requireUserId(body.userId);
        if (typeof body.active !== "boolean") {
          throw new HttpError(400, "active must be true or false.");
        }
        if (userId === adminUser.id && body.active === false) {
          throw new HttpError(400, "You can't deactivate your own account.");
        }
        const { error } = await svc
          .from("profiles")
          .update({ active: body.active })
          .eq("id", userId);
        if (error) throw new HttpError(500, "Could not update the account.");
        return jsonResponse({ ok: true });
      }

      case "resetPassword": {
        const userId = requireUserId(body.userId);
        const password = requireValidPassword(body.password);
        const { error } = await svc.auth.admin.updateUserById(userId, {
          password,
        });
        if (error) throw new HttpError(500, error.message);
        return jsonResponse({ ok: true });
      }

      // Kept under the name "delete" so existing callers keep working, but it
      // DEACTIVATES. Since 0010, leave_requests references profiles with
      // `on delete restrict` on submitted_by_profile_id and
      // decided_by_profile_id, so once an account has filed or decided any
      // leave, auth.admin.deleteUser fails with a raw foreign-key error that
      // means nothing to whoever clicked the button.
      //
      // That constraint is deliberate rather than an obstacle: "who approved
      // this absence" has to survive the approver leaving the company, or the
      // audit trail is only as durable as the staff list. Deactivation is
      // already how the rest of this schema retires people (profiles.active,
      // staff_directory.active, presence_announcers.active), so this now
      // matches its neighbours instead of being the one path that destroys
      // history.
      //
      // The account keeps its roster link. Unlinking is a separate, explicit
      // act — a deactivated login still identifies a real person on the board.
      case "delete":
      case "deactivate": {
        const userId = requireUserId(body.userId);
        const { data: target } = await svc
          .from("profiles")
          .select("role")
          .eq("id", userId)
          .maybeSingle();
        if (!target) throw new HttpError(404, "No such user.");
        if (target.role === "admin") {
          throw new HttpError(403, "Admin accounts can't be deactivated.");
        }
        const { error } = await svc
          .from("profiles")
          .update({ active: false })
          .eq("id", userId);
        if (error) throw new HttpError(500, error.message);
        return jsonResponse({ ok: true, deactivated: true });
      }

      // Attach a login to a roster person, or detach it. Sending a null
      // staffId unlinks whatever this profile is currently attached to.
      //
      // This is what makes leave requests work at all: leave-submit finds the
      // caller through staff_directory.profile_id, so an unlinked account can
      // read the board but cannot file for itself. With 3 logins against 18
      // staff, most people start unlinked.
      case "linkStaff": {
        const userId = requireUserId(body.userId);
        const staffId = body.staffId == null ? null : String(body.staffId);

        // Clear any previous holder first. profile_id is UNIQUE, so without
        // this a re-link fails on the constraint rather than moving the login.
        const { error: clearError } = await svc
          .from("staff_directory")
          .update({ profile_id: null })
          .eq("profile_id", userId);
        if (clearError) throw new HttpError(500, clearError.message);

        if (staffId === null) return jsonResponse({ ok: true, staffId: null });

        const { data: holder } = await svc
          .from("staff_directory")
          .select("id,profile_id,known_as")
          .eq("id", staffId)
          .maybeSingle();
        if (!holder) throw new HttpError(404, "No such staff member.");
        if (holder.profile_id && holder.profile_id !== userId) {
          // A plain unique-violation here would surface as "duplicate key
          // value violates unique constraint", which tells the admin nothing
          // about what to do next.
          throw new HttpError(
            409,
            `${holder.known_as} is already linked to another login. Unlink that one first.`,
          );
        }

        const { error } = await svc
          .from("staff_directory")
          .update({ profile_id: userId })
          .eq("id", staffId);
        if (error) throw new HttpError(500, error.message);
        return jsonResponse({ ok: true, staffId });
      }

      default:
        throw new HttpError(400, `Unknown action: ${String(action)}`);
    }
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

async function adminExists(svc: SupabaseClient): Promise<boolean> {
  const { count, error } = await svc
    .from("profiles")
    .select("id", { count: "exact", head: true })
    .eq("role", "admin");
  if (error) throw new HttpError(500, "Could not check admin status.");
  return (count ?? 0) > 0;
}

function requireUserId(v: unknown): string {
  if (typeof v !== "string" || !v) throw new HttpError(400, "userId is required.");
  return v;
}

function resolveDisplayName(v: unknown, username: string): string {
  if (typeof v === "string" && v.trim()) return v.trim();
  return username;
}

async function createAccount(
  svc: SupabaseClient,
  username: string,
  displayName: string,
  password: string,
  role: "admin" | "worker",
  staffId: string | null = null,
): Promise<Response> {
  // Friendly duplicate check before touching auth.
  const { data: existing } = await svc
    .from("profiles")
    .select("id")
    .eq("username", username)
    .maybeSingle();
  if (existing) {
    throw new HttpError(409, `The username "${username}" is already taken.`);
  }

  const { data: created, error: cErr } = await svc.auth.admin.createUser({
    email: emailFor(username),
    password,
    email_confirm: true,
  });
  if (cErr || !created?.user) {
    if (cErr && /already/i.test(cErr.message)) {
      throw new HttpError(409, `The username "${username}" is already taken.`);
    }
    throw new HttpError(500, cErr?.message ?? "Could not create the account.");
  }

  const uid = created.user.id;
  const { error: pErr } = await svc.from("profiles").insert({
    id: uid,
    username,
    display_name: displayName,
    role,
    active: true,
  });
  if (pErr) {
    // Roll back the auth user so we never leave an orphan.
    await svc.auth.admin.deleteUser(uid);
    if (/duplicate|unique/i.test(pErr.message)) {
      throw new HttpError(409, `The username "${username}" is already taken.`);
    }
    throw new HttpError(500, "Could not create the account profile.");
  }

  // Linking is attempted AFTER the account exists and is reported separately.
  // A roster row that someone else already claimed must not destroy a
  // perfectly good new login — the admin can link it afterwards, but they
  // cannot un-create an account they were told failed. So a link failure is
  // returned as a warning on a successful response, not thrown.
  let linkWarning: string | null = null;
  if (staffId) {
    const { data: holder } = await svc
      .from("staff_directory")
      .select("id,profile_id,known_as")
      .eq("id", staffId)
      .maybeSingle();

    if (!holder) {
      linkWarning = "The account was created, but that staff member no longer exists.";
    } else if (holder.profile_id) {
      linkWarning =
        `The account was created, but ${holder.known_as} is already linked to another login.`;
    } else {
      const { error: lErr } = await svc
        .from("staff_directory")
        .update({ profile_id: uid })
        .eq("id", staffId);
      if (lErr) {
        linkWarning = "The account was created, but linking it to the staff member failed.";
      }
    }
  }

  return jsonResponse({
    ok: true,
    user: { id: uid, username, displayName, role, active: true },
    staffId: linkWarning ? null : staffId,
    linkWarning,
  });
}
