// L'Express Property lead monitor.
//
// Admin mode configures/tests the professional-portal credentials and can run
// a check immediately. Cron mode checks hourly during Mauritius business hours.
// The portal's own CSV export is used instead of scraping presentation markup.

import { handleOptions, jsonResponse } from "../_shared/cors.ts";
import { HttpError, requireAdmin, serviceClient } from "../_shared/auth.ts";
import {
  accessTokenFromRefresh,
} from "../_shared/graphMail.ts";
import {
  LEXPRESS_RECIPIENT,
  sendLexpressDigest,
} from "../_shared/graphNotification.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

const LOGIN_URL = "https://pro.lexpressproperty.com/login";
const CSV_URL =
  "https://pro.lexpressproperty.com/profile/messages/adverts?exportall=1&format=csv";
const USER_AGENT =
  "Mozilla/5.0 (compatible; JadeAgent/1.0; +https://jade-agent.vercel.app)";
const MAX_LEADS_PER_EMAIL = 20;

interface Lead {
  fingerprint: string;
  lead_at: string;
  civility: string;
  last_name: string;
  first_name: string;
  email: string;
  phone: string;
  advert_id: string;
  reference: string;
  transaction: string;
  property_type: string;
  price: string;
  currency: string;
  city: string;
  region: string;
  agent: string;
  message: string;
}

interface MonitorConfig {
  enabled: boolean;
  sender_user_id: string | null;
  baseline_at: string | null;
  last_checked_at: string | null;
  last_success_at: string | null;
  last_sent_at: string | null;
  last_delivery_status: "accepted" | "confirmed" | null;
  last_message_id: string | null;
  last_sent_web_link: string | null;
  last_error: string | null;
}

Deno.serve(async (req: Request) => {
  const pre = handleOptions(req);
  if (pre) return pre;

  try {
    if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
    const svc = serviceClient();
    const cron = await isCronRequest(req, svc);
    const body = await req.json().catch(() => ({} as Record<string, unknown>));

    if (cron) {
      const config = await loadConfig(svc);
      if (!config.enabled) return jsonResponse({ skipped: true, reason: "disabled" });
      return jsonResponse(await runMonitor(svc, config));
    }

    const { user } = await requireAdmin(req);
    const action = typeof body.action === "string" ? body.action : "status";

    if (action === "status") return jsonResponse(await status(svc));

    if (action === "configure") {
      const email = clean(body.email);
      const password = typeof body.password === "string" ? body.password : "";
      if (!/^\S+@\S+\.\S+$/.test(email)) {
        throw new HttpError(400, "Enter the L'Express login email.");
      }
      if (!password) throw new HttpError(400, "Enter the L'Express password.");

      // Validate before replacing the previously working Vault values.
      const leads = await fetchLeads(email, password);
      const { error: secretError } = await svc.rpc("set_lexpress_credentials", {
        p_email: email,
        p_password: password,
      });
      if (secretError) throw new HttpError(500, "Could not store the portal credentials.");

      await storeLeads(svc, leads, true);
      const now = new Date().toISOString();
      const { error: saveError } = await svc.from("lexpress_monitor_config").upsert({
        id: true,
        enabled: true,
        sender_user_id: user.id,
        baseline_at: now,
        last_checked_at: now,
        last_success_at: now,
        last_error: null,
        updated_at: now,
      }, { onConflict: "id" });
      if (saveError) throw new HttpError(500, "Could not enable the monitor.");

      return jsonResponse({
        configured: true,
        enabled: true,
        baselined: leads.length,
        recipient: LEXPRESS_RECIPIENT,
      });
    }

    if (action === "setEnabled") {
      if (typeof body.enabled !== "boolean") {
        throw new HttpError(400, "enabled must be true or false.");
      }
      const { error } = await svc.from("lexpress_monitor_config").update({
        enabled: body.enabled,
        sender_user_id: user.id,
        updated_at: new Date().toISOString(),
      }).eq("id", true);
      if (error) throw new HttpError(500, "Could not update the monitor.");
      return jsonResponse({ enabled: body.enabled });
    }

    if (action === "run") {
      const config = await loadConfig(svc);
      return jsonResponse(await runMonitor(svc, config));
    }

    throw new HttpError(400, "Unknown action.");
  } catch (e) {
    return errorResponse(e);
  }
});

async function status(svc: SupabaseClient): Promise<Record<string, unknown>> {
  const config = await loadConfig(svc);
  const credentials = await loadCredentials(svc, false);
  let mailboxEmail: string | null = null;
  if (config.sender_user_id) {
    const { data } = await svc.from("mail_accounts").select("ms_email")
      .eq("user_id", config.sender_user_id).maybeSingle();
    mailboxEmail = data?.ms_email ?? null;
  }
  const { count } = await svc.from("lexpress_leads")
    .select("fingerprint", { count: "exact", head: true });
  return {
    enabled: config.enabled,
    credentialsConfigured: !!credentials,
    recipient: LEXPRESS_RECIPIENT,
    mailboxEmail,
    baselineAt: config.baseline_at,
    lastCheckedAt: config.last_checked_at,
    lastSuccessAt: config.last_success_at,
    lastSentAt: config.last_sent_at,
    lastDeliveryStatus: config.last_delivery_status,
    lastSentWebLink: config.last_sent_web_link,
    lastError: config.last_error,
    knownLeads: count ?? 0,
  };
}

async function runMonitor(
  svc: SupabaseClient,
  config: MonitorConfig,
): Promise<Record<string, unknown>> {
  const checkedAt = new Date().toISOString();
  try {
    const credentials = await loadCredentials(svc, true);
    if (!credentials) {
      throw new HttpError(400, "Configure the L'Express portal login first.");
    }
    const leads = await fetchLeads(credentials.email, credentials.password);
    const known = await knownFingerprints(svc);
    const newlyFound = leads.filter((lead) => !known.has(lead.fingerprint));
    await storeLeads(svc, newlyFound, false);

    const { data: pendingRows, error: pendingError } = await svc
      .from("lexpress_leads")
      .select("*")
      .is("notified_at", null)
      .order("lead_at", { ascending: true })
      .limit(MAX_LEADS_PER_EMAIL);
    if (pendingError) throw new HttpError(500, "Could not load new enquiries.");
    const pending = (pendingRows ?? []) as Lead[];

    let sent = 0;
    let deliveryStatus: "accepted" | "confirmed" | null = null;
    let messageId: string | null = null;
    let sentWebLink: string | null = null;
    if (pending.length > 0) {
      if (!config.sender_user_id) {
        throw new HttpError(400, "Reconnect the notification mailbox from Jade Agent.");
      }
      const { data: account, error: accountError } = await svc
        .from("mail_accounts")
        .select("refresh_token")
        .eq("user_id", config.sender_user_id)
        .maybeSingle();
      if (accountError || !account) {
        throw new HttpError(400, "Reconnect the notification mailbox from Jade Agent.");
      }

      const token = await accessTokenFromRefresh(account.refresh_token);
      if (token.refreshToken) {
        await svc.from("mail_accounts").update({ refresh_token: token.refreshToken })
          .eq("user_id", config.sender_user_id);
      }
      const delivery = await sendLexpressDigest(
        token.accessToken,
        `New L'Express Property ${pending.length === 1 ? "enquiry" : "enquiries"} (${pending.length})`,
        digestHtml(pending),
      );
      deliveryStatus = delivery.status;
      messageId = delivery.messageId;
      sentWebLink = delivery.webLink;

      const fingerprints = pending.map((lead) => lead.fingerprint);
      const { error: markError } = await svc.from("lexpress_leads")
        .update({ notified_at: checkedAt })
        .in("fingerprint", fingerprints);
      if (markError) throw new HttpError(500, "The email was sent but could not be recorded.");
      sent = pending.length;
    }

    const { error: configError } = await svc.from("lexpress_monitor_config").update({
      last_checked_at: checkedAt,
      last_success_at: checkedAt,
      last_sent_at: sent > 0 ? checkedAt : config.last_sent_at,
      last_delivery_status: sent > 0 ? deliveryStatus : config.last_delivery_status,
      last_message_id: sent > 0 ? messageId : config.last_message_id,
      last_sent_web_link: sent > 0 ? sentWebLink : config.last_sent_web_link,
      last_error: null,
      updated_at: checkedAt,
    }).eq("id", true);
    if (configError) throw new HttpError(500, "Could not save the monitor status.");

    return {
      checked: leads.length,
      new: newlyFound.length,
      sent,
      recipient: LEXPRESS_RECIPIENT,
      deliveryStatus,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Monitor failed";
    await svc.from("lexpress_monitor_config").update({
      last_checked_at: checkedAt,
      last_error: message.slice(0, 500),
      updated_at: checkedAt,
    }).eq("id", true);
    throw e;
  }
}

async function loadConfig(svc: SupabaseClient): Promise<MonitorConfig> {
  const { data, error } = await svc.from("lexpress_monitor_config")
    .select("enabled,sender_user_id,baseline_at,last_checked_at,last_success_at,last_sent_at,last_delivery_status,last_message_id,last_sent_web_link,last_error")
    .eq("id", true).maybeSingle();
  if (error || !data) throw new HttpError(500, "Could not load the monitor settings.");
  return data as MonitorConfig;
}

async function loadCredentials(
  svc: SupabaseClient,
  required: boolean,
): Promise<{ email: string; password: string } | null> {
  const { data, error } = await svc.rpc("get_lexpress_credentials");
  if (error) throw new HttpError(500, "Could not read the portal credentials.");
  const row = Array.isArray(data) ? data[0] : data;
  const email = clean(row?.login_email);
  const password = typeof row?.login_password === "string" ? row.login_password : "";
  if (email && password) return { email, password };
  if (required) throw new HttpError(400, "Configure the L'Express portal login first.");
  return null;
}

async function isCronRequest(req: Request, svc: SupabaseClient): Promise<boolean> {
  const presented = req.headers.get("x-cron-secret");
  if (!presented) return false;
  const { data, error } = await svc.from("cron_config")
    .select("cron_secret").limit(1).maybeSingle();
  const expected = error ? null : data?.cron_secret;
  if (!expected || presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < presented.length; i++) {
    diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

async function knownFingerprints(svc: SupabaseClient): Promise<Set<string>> {
  const { data, error } = await svc.from("lexpress_leads").select("fingerprint");
  if (error) throw new HttpError(500, "Could not load known enquiries.");
  return new Set((data ?? []).map((row) => String(row.fingerprint)));
}

async function storeLeads(
  svc: SupabaseClient,
  leads: Lead[],
  baseline: boolean,
): Promise<void> {
  const notifiedAt = baseline ? new Date().toISOString() : null;
  for (let i = 0; i < leads.length; i += 200) {
    const rows = leads.slice(i, i + 200).map((lead) => ({
      ...lead,
      notified_at: notifiedAt,
    }));
    const { error } = await svc.from("lexpress_leads").upsert(rows, {
      onConflict: "fingerprint",
      ignoreDuplicates: true,
    });
    if (error) throw new HttpError(500, "Could not save L'Express enquiries.");
  }
}

async function fetchLeads(email: string, password: string): Promise<Lead[]> {
  const cookies = new Map<string, string>();
  await portalFetch(LOGIN_URL, cookies, { method: "GET" });
  const login = await portalFetch(LOGIN_URL, cookies, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email, password }).toString(),
  });
  await login.body?.cancel();

  const csvRes = await portalFetch(CSV_URL, cookies, { method: "GET" });
  const csv = await csvRes.text();
  if (!csvRes.ok || !csv.replace(/^\uFEFF/, "").startsWith('"Date"')) {
    throw new HttpError(400, "L'Express rejected the login. Check the email and password.");
  }
  const rows = parseCsv(csv);
  if (rows.length < 1) throw new HttpError(502, "L'Express returned an empty export.");
  const headers = rows[0];
  const records = rows.slice(1).filter((row) => row.some(Boolean));
  const leads: Lead[] = [];
  for (const record of records) {
    const source = Object.fromEntries(headers.map((header, i) => [header, record[i] ?? ""]));
    leads.push(await leadFrom(source));
  }
  return leads;
}

async function portalFetch(
  url: string,
  cookies: Map<string, string>,
  init: RequestInit,
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("User-Agent", USER_AGENT);
  headers.set("Accept", "text/csv,text/html;q=0.9,*/*;q=0.8");
  headers.set("Referer", LOGIN_URL);
  if (cookies.size > 0) {
    headers.set("Cookie", [...cookies].map(([k, v]) => `${k}=${v}`).join("; "));
  }
  const res = await fetch(url, { ...init, headers, redirect: "manual" });
  const setCookieHeaders = typeof res.headers.getSetCookie === "function"
    ? res.headers.getSetCookie()
    : [res.headers.get("set-cookie") ?? ""].filter(Boolean);
  for (const raw of setCookieHeaders) {
    const first = raw.split(";", 1)[0];
    const equals = first.indexOf("=");
    if (equals > 0) cookies.set(first.slice(0, equals), first.slice(equals + 1));
  }
  const location = res.headers.get("location");
  if (location && res.status >= 300 && res.status < 400) {
    await res.body?.cancel();
    return portalFetch(new URL(location, url).toString(), cookies, { method: "GET" });
  }
  return res;
}

async function leadFrom(source: Record<string, string>): Promise<Lead> {
  const fields = [
    source.Date, source.Civility, source.Last_Name, source.First_Name,
    source.Email, source.Phone, source.Advert, source.Reference,
    source.Transaction, source["Property Type"], source.Price, source.Currency,
    source.City, source.Region, source["Real Estate Agent"], source.Message,
  ].map((value) => clean(value));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(fields.join("\u001f")),
  );
  return {
    fingerprint: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join(""),
    lead_at: mauritiusTimestamp(fields[0]),
    civility: fields[1],
    last_name: fields[2],
    first_name: fields[3],
    email: fields[4],
    phone: fields[5],
    advert_id: fields[6],
    reference: fields[7],
    transaction: fields[8],
    property_type: fields[9],
    price: fields[10],
    currency: fields[11],
    city: fields[12],
    region: fields[13],
    agent: fields[14],
    message: fields[15],
  };
}

function mauritiusTimestamp(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new HttpError(502, `L'Express returned an invalid date: ${value}`);
  const parsed = new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}+04:00`);
  if (Number.isNaN(parsed.getTime())) throw new HttpError(502, "L'Express returned an invalid date.");
  return parsed.toISOString();
}

function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const text = input.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}

function digestHtml(leads: Lead[]): string {
  const cards = leads.map((lead) => {
    const name = [lead.civility, lead.first_name, lead.last_name].filter(Boolean).join(" ") || "Not supplied";
    const price = [lead.price, lead.currency].filter(Boolean).join(" ") || "Not supplied";
    const advertUrl = `https://www.lexpressproperty.com/spip.php?page=permalink&lang=en&id_annonce=${encodeURIComponent(lead.advert_id)}`;
    return `<div style="border:1px solid #d1d5db;border-radius:10px;padding:16px;margin:0 0 16px">
      <h2 style="font-size:17px;margin:0 0 10px">${html(lead.reference || `Advert ${lead.advert_id}`)}</h2>
      <p style="margin:4px 0"><strong>Date:</strong> ${html(formatMauritius(lead.lead_at))}</p>
      <p style="margin:4px 0"><strong>Customer:</strong> ${html(name)}</p>
      <p style="margin:4px 0"><strong>Email:</strong> ${html(lead.email || "Not supplied")}</p>
      <p style="margin:4px 0"><strong>Phone:</strong> ${html(lead.phone || "Not supplied")}</p>
      <p style="margin:4px 0"><strong>Property:</strong> ${html([lead.transaction, lead.property_type].filter(Boolean).join(" · "))}</p>
      <p style="margin:4px 0"><strong>Price:</strong> ${html(price)}</p>
      <p style="margin:4px 0"><strong>Location:</strong> ${html([lead.city, lead.region].filter(Boolean).join(", ") || "Not supplied")}</p>
      <p style="margin:10px 0 4px"><strong>Request:</strong><br>${html(lead.message || "No message supplied")}</p>
      <p style="margin:10px 0 0"><a href="${advertUrl}">Open advert</a></p>
    </div>`;
  }).join("");
  return `<div style="font-family:Arial,sans-serif;color:#111827;line-height:1.45">
    <h1 style="font-size:20px">New L'Express Property ${leads.length === 1 ? "enquiry" : "enquiries"}</h1>
    <p>Jade Agent found ${leads.length} new ${leads.length === 1 ? "request" : "requests"}.</p>
    ${cards}
    <p style="color:#6b7280;font-size:12px">Automatically checked by Jade Agent.</p>
  </div>`;
}

function formatMauritius(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Indian/Mauritius",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));
}

function html(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[ch] ?? ch);
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
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
