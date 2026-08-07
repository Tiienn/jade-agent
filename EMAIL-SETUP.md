# Email Assistant — Setup

The agent reads your mailbox 4× a day (09:00, 12:00, 15:00, 17:00 Mauritius
time), separates what needs a reply from the noise, and writes draft replies in
your style. **It cannot send email.** That is not a policy — the app never
requests permission to send, so there is no code path that could.

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
supabase secrets set OPENAI_API_KEY=sk-your-key-here
```

Expect **$5–15/month** at your volume. To change model:
`supabase secrets set OPENAI_MODEL=gpt-4o` (that is the default).

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

## What it will never do

- Send an email — the permission is not requested
- Delete anything
- Read anyone else's mailbox — Microsoft prevents it; it signs in as you
- Reply on its own — every draft waits for you to press send
