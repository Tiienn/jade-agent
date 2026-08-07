// Signed `state` for the mailbox OAuth round-trip.
//
// mail-callback is a public GET endpoint — it is the browser's redirect target,
// so it cannot require an Authorization header, and anyone can call it with
// whatever query string they like. The only thing telling it WHICH user just
// consented is `state`, which travelled through Microsoft and back.
//
// So state must be unforgeable. We HMAC the user id with the service role key
// (a secret that never leaves the edge runtime) and include a timestamp. Both
// halves matter: without the signature an attacker could bind their own
// Microsoft mailbox to someone else's Jade account by editing the URL; without
// the freshness window a single captured callback URL would stay replayable
// forever.
//
// Lives in _shared because mail-connect mints these and mail-callback verifies
// them — the two sides must agree on the format exactly.

import { HttpError } from "./auth.ts";

/** How long a consent round-trip may take. Generous for a sign-in, short
 * enough that a leaked URL is worthless by the time it is found. */
const MAX_AGE_MS = 10 * 60 * 1000;

function secret(): string {
  const v = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!v) {
    throw new HttpError(
      500,
      "Server misconfigured: missing SUPABASE_SERVICE_ROLE_KEY",
    );
  }
  return v;
}

async function hmacKey(): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/** URL-safe base64 (state rides in a query string). */
function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sign(payload: string): Promise<string> {
  const sig = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(),
    new TextEncoder().encode(payload),
  );
  return b64url(new Uint8Array(sig));
}

/** Constant-time compare, so a wrong signature leaks nothing by timing. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Mint `<userId>.<issuedAtMs>.<signature>` for the authorize URL. */
export async function signState(userId: string): Promise<string> {
  const payload = `${userId}.${Date.now()}`;
  return `${payload}.${await sign(payload)}`;
}

/**
 * Verify a state string and return the user id it was minted for.
 * Throws HttpError(400) on a malformed, forged, or stale value — the caller
 * turns that into a redirect with a short error code, never a detailed message.
 */
export async function verifyState(state: string): Promise<string> {
  const parts = (state ?? "").split(".");
  if (parts.length !== 3) throw new HttpError(400, "Invalid state");
  const [userId, issuedAt, signature] = parts;

  const expected = await sign(`${userId}.${issuedAt}`);
  if (!timingSafeEqual(signature, expected)) {
    throw new HttpError(400, "Invalid state");
  }

  const ts = Number(issuedAt);
  if (!Number.isFinite(ts) || Date.now() - ts > MAX_AGE_MS || ts > Date.now()) {
    throw new HttpError(400, "State expired");
  }

  if (!userId) throw new HttpError(400, "Invalid state");
  return userId;
}
