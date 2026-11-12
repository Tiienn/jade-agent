# Email Assistant — Setup

The agent reads your mailbox 4× a day (09:00, 12:00, 15:00, 17:00 Mauritius
time), separates what needs a reply from the noise, and writes draft replies in
your style. Those mailbox replies still cannot send themselves. The one narrow
exception is the L'Express Property monitor: it sends a deterministic new-lead
digest to `charles.li@jadegroup.mu`. Portal text is HTML-escaped, never passed
to an AI model, and cannot choose or change the recipient.

---

## How access works (and why it changed)

The agent signs in **as you**, once. Microsoft then issues it a token that
reaches your mailbox and nothing else.

An earlier design used an *application* permission, where the app authenticates
as itself. That approach grants access to **every mailbox in the company** by
default and has to be fenced back in with an Exchange policy. We tried it: the
fence was created, Microsoft's own test reported it active, and the app could
still read colleagues' mailboxes 42 minutes later. That permission was revoked
and removed.

Delegated sign-in removes the problem rather than configuring around it. There
is no company-wide key to leak or misconfigure — the agent is you, so it can
only see what you can see.

---

## 1. Azure — already done

Configured on the `Jade File Finder` app registration
(`b0673ca1-ad39-44f9-b3e7-8df0d6bbf17b`):

| Setting | Value |
| --- | --- |
| `Mail.ReadWrite` | **Delegated** — "read and write access to *user* mail" |
| `Mail.Send` | **Delegated** — used only for the fixed-recipient L'Express lead digest |
| `offline_access` | Delegated — lets the scheduled job keep working without you re-signing in |
| Redirect URI (Web) | `https://nfnpwkkcafaumxrqjdai.supabase.co/functions/v1/mail-callback` |

Admin consent was deliberately **not** pre-granted. You approve these yourself
at first sign-in, on Microsoft's own consent screen, so you can see exactly what
is being asked for.

`Mail.ReadWrite` as an *Application* permission was removed. SharePoint file
search is untouched and still uses its own app-only permissions.

---

## 2. OpenAI key

Only *drafting* needs this. Triage is plain rules and costs nothing — newsletters
and staff notices are filtered out before anything reaches OpenAI.

1. **platform.openai.com** → API keys → Create new secret key
2. Billing → add roughly **$20** of credit

```bash
cd ~/projects/jade-agent
supabase secrets set OPENAI_API_KEY=PASTE_THE_REAL_KEY_HERE
```

> Replace `PASTE_THE_REAL_KEY_HERE` with the key you just copied — it starts
> `sk-` and is about 50 characters. Running the line unchanged stores the
> placeholder itself, and drafting then fails with
> `Incorrect API key provided`. To check what is stored, re-run the command
> with the correct key; it overwrites.

Expect **$5–15/month** at your volume. To change model:
`supabase secrets set OPENAI_MODEL=gpt-4o` (that is the default).

The **Invoices** page reuses this same key. It reads up to four PDF invoices
with the Responses API and defaults to `gpt-6-astra`; set
`OPENAI_INVOICE_MODEL` only if you intentionally need a different model.

---

## 3. Connect your mailbox

Once deployed: open **Jade Agent → Email → Connect mailbox**, sign in as
`Stephan.AhThien@jadegroup.mu`, and approve. That is the only time you sign in;
`offline_access` keeps it working afterwards.

To disconnect at any point, either use the app or revoke it yourself at
**myaccount.microsoft.com → Privacy → Apps and services**.

---

## What is stored

- **Kept:** sender, subject, date, and the triage decision — enough for a
  priority list and to remember "always ignore this sender".
- **Not kept:** message bodies. Fetched from Microsoft only while a draft is
  being written, then discarded.
- **Refresh token:** in a table with row-level security enabled and *no access
  policies at all*, so no browser session can read it — only the server.
- Drafts are created in your Outlook Drafts folder and listed in the app.
- Invoice PDFs are not stored by Jade Agent. They exist only for the request,
  are analysed with OpenAI storage disabled, and are attached to the Outlook
  draft before the request ends.
- When you change an invoice message before creating its draft, Jade keeps the
  original and edited wording as a private, per-user style example. Browser
  sessions cannot read this history; the invoice function uses it only to
  match future invoice-email wording and never as a source of invoice facts.

## What the mailbox assistant will never do

- Send a reply or leave notice — those always remain Outlook drafts
- Delete anything
- Read anyone else's mailbox — Microsoft prevents it; it signs in as you
- Reply on its own — every draft waits for you to press send

## Invoice drafts

Open **Jade Agent → Invoices**, choose up to four PDF invoices, and select
**Prepare email**. Jade extracts the visible client and invoice details, warns
when the files appear to belong to different clients or contain no email
address, and lets you edit the To, Cc, Bcc, subject, and message fields. Multiple
addresses can be entered with commas between them. **Create draft**
then writes one Outlook draft with the original PDFs attached. Each PDF must be
under 2.9 MB and all selected files together must be under 8 MB. Outlook on the
web is fully supported; no desktop Outlook app is required.

## L'Express Property monitor

An admin configures this under **Admin → Settings → L'Express enquiry monitor**.
The portal email and password are encrypted in Supabase Vault and never returned
to the browser. Saving the login validates it, baselines all existing enquiries,
and enables the hourly 08:00–18:00 Mauritius schedule. Only enquiries first seen
after that baseline are emailed.

Notifications are created as Outlook drafts internally, sent immediately, and
then looked up again by immutable Microsoft message id. The Settings card says
**Confirmed in Sent Items** only after that lookup succeeds; Microsoft's initial
acceptance response alone is shown as pending rather than confirmed delivery.

Reconnect Outlook once after deploying this feature so Microsoft can show and
record the added delegated `Mail.Send` consent.
