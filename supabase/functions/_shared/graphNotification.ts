// Narrow Microsoft Graph sender for deterministic system notifications.
//
// Keep this separate from graphMail.ts. That module handles attacker-controlled
// incoming email and intentionally cannot send. This helper accepts one fixed
// recipient and already-rendered HTML from the L'Express monitor only.

import { HttpError } from "./auth.ts";

const GRAPH = "https://graph.microsoft.com/v1.0";
export const LEXPRESS_RECIPIENT = "charles.li@jadegroup.mu";

export interface LexpressDelivery {
  messageId: string;
  status: "accepted" | "confirmed";
  webLink: string | null;
}

const IMMUTABLE_ID = 'IdType="ImmutableId"';

async function responseDetail(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "";
  }
}

async function throwNotificationError(res: Response): Promise<never> {
  const detail = await responseDetail(res);
  if (res.status === 401 || res.status === 403) {
    throw new HttpError(
      502,
      "Microsoft needs the mailbox to be reconnected with permission to send L'Express notifications.",
      "mailbox_reconnect",
    );
  }
  throw new HttpError(
    502,
    `Microsoft Graph could not process the notification (${res.status}). ${detail}`,
  );
}

async function waitForSentCopy(
  accessToken: string,
  messageId: string,
): Promise<string | null> {
  const delays = [350, 700, 1_200, 1_800, 2_500];
  for (const delay of delays) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    const res = await fetch(
      `${GRAPH}/me/messages/${encodeURIComponent(messageId)}?$select=id,isDraft,sentDateTime,webLink`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Prefer: IMMUTABLE_ID,
        },
      },
    );
    if (res.status === 404) {
      await res.body?.cancel();
      continue;
    }
    if (!res.ok) await throwNotificationError(res);
    const message = await res.json();
    if (message.isDraft === false && message.sentDateTime) {
      return typeof message.webLink === "string" ? message.webLink : "";
    }
  }
  return null;
}

export async function sendLexpressDigest(
  accessToken: string,
  subject: string,
  bodyHtml: string,
): Promise<LexpressDelivery> {
  // Create a draft first so Graph gives us an immutable message id. Sending
  // that draft moves the same item to Sent Items, where we can verify it.
  const createRes = await fetch(`${GRAPH}/me/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Prefer: IMMUTABLE_ID,
    },
    body: JSON.stringify({
      subject,
      body: { contentType: "HTML", content: bodyHtml },
      toRecipients: [
        { emailAddress: { address: LEXPRESS_RECIPIENT } },
      ],
    }),
  });
  if (!createRes.ok) await throwNotificationError(createRes);
  const draft = await createRes.json();
  const messageId = typeof draft.id === "string" ? draft.id : "";
  if (!messageId) {
    throw new HttpError(502, "Microsoft created the notification draft without an id.");
  }

  const sendRes = await fetch(
    `${GRAPH}/me/messages/${encodeURIComponent(messageId)}/send`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Length": "0",
        Prefer: IMMUTABLE_ID,
      },
    },
  );
  if (!sendRes.ok) await throwNotificationError(sendRes);
  await sendRes.body?.cancel();

  const webLink = await waitForSentCopy(accessToken, messageId);
  return {
    messageId,
    status: webLink === null ? "accepted" : "confirmed",
    webLink: webLink || null,
  };
}
