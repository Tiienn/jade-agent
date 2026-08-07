// POST {} — start the mailbox connection.
// Returns { authUrl } for the browser to send the user to Microsoft, where they
// sign in and consent. Microsoft then redirects to mail-callback, which does
// the token exchange.
//
// Nothing is stored here. This function only builds a URL; the connection does
// not exist until the user has actually consented.

import { handleOptions, jsonResponse } from "../_shared/cors.ts";
import { HttpError, requireActiveUser } from "../_shared/auth.ts";
import { mailRedirectUri, MAIL_SCOPES } from "../_shared/graphMail.ts";
import { signState } from "../_shared/oauthState.ts";

function reqEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) {
    throw new HttpError(
      500,
      `Mailbox access not configured — see EMAIL-SETUP.md (missing ${name})`,
    );
  }
  return v;
}

Deno.serve(async (req: Request) => {
  const pre = handleOptions(req);
  if (pre) return pre;

  try {
    if (req.method !== "POST") throw new HttpError(405, "Method not allowed");

    const { user } = await requireActiveUser(req);

    const params = new URLSearchParams({
      client_id: reqEnv("MS_CLIENT_ID"),
      response_type: "code",
      redirect_uri: mailRedirectUri(),
      response_mode: "query",
      scope: MAIL_SCOPES,
      // Signed with the service role key so the public callback endpoint can
      // trust which Jade account consented. See _shared/oauthState.ts.
      state: await signState(user.id),
    });

    const authUrl = `https://login.microsoftonline.com/${
      reqEnv("MS_TENANT_ID")
    }/oauth2/v2.0/authorize?${params.toString()}`;

    return jsonResponse({ authUrl });
  } catch (e) {
    return errorResponse(e);
  }
});

function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) {
    const payload: Record<string, unknown> = { error: e.message };
    if (e.code) payload.code = e.code;
    return jsonResponse(payload, e.status);
  }
  const message = e instanceof Error ? e.message : "Server error";
  return jsonResponse({ error: message }, 500);
}
