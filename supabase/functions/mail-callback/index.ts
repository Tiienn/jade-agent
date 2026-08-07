// GET — Microsoft's OAuth redirect target. Not called by our own code.
//
// The browser lands here after the user consents. We verify the signed `state`
// (this endpoint is public, so state is the only thing proving which Jade
// account consented — see _shared/oauthState.ts), exchange the code for tokens,
// store the refresh token, and bounce the user back to the app.
//
// Two rules this file exists to keep:
//   1. Never render a token, echo one into a redirect URL, or log one. The
//      response body is a bare redirect; the query string carries a flag and at
//      most a short error code.
//   2. Never report WHY verification failed to the browser. A forged state and
//      an expired one look identical from outside. The detail stays server-side.

import { corsHeaders } from "../_shared/cors.ts";
import { serviceClient } from "../_shared/auth.ts";
import {
  exchangeCodeForTokens,
  mailRedirectUri,
} from "../_shared/graphMail.ts";
import { verifyState } from "../_shared/oauthState.ts";

/** Where the browser goes afterwards. Overridable for preview deployments. */
function appUrl(): string {
  return (Deno.env.get("APP_URL") || "https://jade-agent.vercel.app").replace(
    /\/+$/,
    "",
  );
}

/**
 * Short, non-revealing failure codes for the app to map to a message.
 * Deliberately coarse — see rule 2 above.
 */
type ErrorCode =
  | "denied" // the user declined at Microsoft, or Microsoft returned an error
  | "state" // missing, forged, or expired state
  | "code" // no authorization code in the callback
  | "exchange" // the token exchange failed
  | "store"; // tokens obtained but could not be saved

function redirect(query: string): Response {
  return new Response(null, {
    status: 302,
    headers: { ...corsHeaders, Location: `${appUrl()}/email?${query}` },
  });
}

function fail(code: ErrorCode): Response {
  return redirect(`error=${code}`);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (req.method !== "GET") return fail("denied");

    const url = new URL(req.url);

    // Microsoft reports a refused or failed consent as query params, not as a
    // non-200 — there is no code to exchange in that case.
    if (url.searchParams.get("error")) return fail("denied");

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!state) return fail("state");
    if (!code) return fail("code");

    let userId: string;
    try {
      userId = await verifyState(state);
    } catch {
      return fail("state");
    }

    let connected;
    try {
      connected = await exchangeCodeForTokens(code, mailRedirectUri());
    } catch {
      return fail("exchange");
    }

    // Upsert: reconnecting replaces the stored token and clears any stale
    // failure from the previous connection, rather than erroring on the PK.
    const svc = serviceClient();
    const { error } = await svc.from("mail_accounts").upsert({
      user_id: userId,
      ms_email: connected.email,
      refresh_token: connected.refreshToken,
      connected_at: new Date().toISOString(),
      last_sync_error: null,
    }, { onConflict: "user_id" });
    if (error) return fail("store");

    return redirect("connected=1");
  } catch {
    // Any unexpected failure still has to land the user back in the app, and
    // still must not describe itself in the URL.
    return fail("exchange");
  }
});
