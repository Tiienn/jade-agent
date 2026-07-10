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
        return await createAccount(svc, username, displayName, password, "worker");
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

      case "delete": {
        const userId = requireUserId(body.userId);
        const { data: target } = await svc
          .from("profiles")
          .select("role")
          .eq("id", userId)
          .maybeSingle();
        if (target?.role === "admin") {
          throw new HttpError(403, "Admin accounts can't be deleted.");
        }
        // FK cascade removes the profile row + logs.
        const { error } = await svc.auth.admin.deleteUser(userId);
        if (error) throw new HttpError(500, error.message);
        return jsonResponse({ ok: true });
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

  return jsonResponse({
    ok: true,
    user: { id: uid, username, displayName, role, active: true },
  });
}
