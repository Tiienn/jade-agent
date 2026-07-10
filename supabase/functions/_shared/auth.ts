// Auth helpers. Platform verify_jwt is disabled — we verify the Supabase JWT
// in-function using the anon client bound to the request's Authorization header,
// then load the profile with the service role.

import { createClient, type SupabaseClient, type User } from "jsr:@supabase/supabase-js@2";

/** Error carrying an HTTP status (+ optional machine code) for handlers to map. */
export class HttpError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

export interface Profile {
  id: string;
  username: string;
  display_name: string;
  role: "admin" | "worker";
  active: boolean;
  created_at: string;
}

function requiredEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new HttpError(500, `Server misconfigured: missing ${name}`);
  return v;
}

/** Service-role client (bypasses RLS). Never expose to the browser. */
export function serviceClient(): SupabaseClient {
  return createClient(
    requiredEnv("SUPABASE_URL"),
    requiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

/** Anon client carrying the caller's Authorization header (for auth.getUser). */
function anonClientFromReq(req: Request): SupabaseClient {
  const authHeader = req.headers.get("Authorization") ?? "";
  return createClient(
    requiredEnv("SUPABASE_URL"),
    requiredEnv("SUPABASE_ANON_KEY"),
    {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );
}

/** Verified auth user, or null if the JWT is missing/invalid. */
export async function getUser(req: Request): Promise<User | null> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return null;
  const supa = anonClientFromReq(req);
  const { data, error } = await supa.auth.getUser();
  if (error || !data?.user) return null;
  return data.user;
}

/** Load a profile row with the service role. */
export async function getProfile(userId: string): Promise<Profile | null> {
  const svc = serviceClient();
  const { data, error } = await svc
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw new HttpError(500, "Could not load profile");
  return (data as Profile | null) ?? null;
}

/** 401 if not signed in, 403 if the account is disabled. */
export async function requireActiveUser(
  req: Request,
): Promise<{ user: User; profile: Profile }> {
  const user = await getUser(req);
  if (!user) throw new HttpError(401, "Not signed in");
  const profile = await getProfile(user.id);
  if (!profile) throw new HttpError(401, "Not signed in");
  if (!profile.active) throw new HttpError(403, "Account disabled");
  return { user, profile };
}

/** requireActiveUser + must be an admin. */
export async function requireAdmin(
  req: Request,
): Promise<{ user: User; profile: Profile }> {
  const { user, profile } = await requireActiveUser(req);
  if (profile.role !== "admin") {
    throw new HttpError(403, "Admin access required");
  }
  return { user, profile };
}
