# Email Assistant — Setup

Three things need doing before the email agent can run. Two are in Microsoft,
one is OpenAI. Everything else is already built or will be.

The agent will: read your mailbox 4× a day (09:00, 12:00, 15:00, 17:00
Mauritius time), sort what actually needs a reply from the noise, and write
draft replies in your style. **It will never send anything.** That is enforced
by not granting it permission to send — see step 1.

---

## 1. Let the app read your mailbox (Azure)

The app already has a Microsoft app registration for SharePoint file search.
We add mailbox permission to that same registration.

1. Go to **portal.azure.com** → **Microsoft Entra ID** → **App registrations**
2. Open **Jade File Finder** (Client ID `b0673ca1-ad39-44f9-b3e7-8df0d6bbf17b`)
3. Left menu → **API permissions** → **+ Add a permission**
4. **Microsoft Graph** → **Application permissions**
5. Tick **`Mail.ReadWrite`** → **Add permissions**
6. Click **Grant admin consent for Jade Group** and confirm

> **Why `Mail.ReadWrite` and not `Mail.Send`?**
> `Mail.ReadWrite` lets the agent read your mail and *save drafts*. It does not
> allow sending. We deliberately never request `Mail.Send`, so even a bug or a
> misread instruction cannot put an email on the wire. Sending stays a thing
> only you can do, from Outlook.

---

## 2. Lock that access to your mailbox only (Exchange) — important

Step 1 on its own grants the app access to **every mailbox at Jade Group**.
That is far more than this feature needs. This step restricts it to yours.

Open **PowerShell** on Windows and run:

```powershell
Install-Module -Name ExchangeOnlineManagement -Scope CurrentUser
Connect-ExchangeOnline -UserPrincipalName Stephan.AhThien@jadegroup.mu
```

Then create the restriction:

```powershell
New-ApplicationAccessPolicy `
  -AppId b0673ca1-ad39-44f9-b3e7-8df0d6bbf17b `
  -PolicyScopeGroupId Stephan.AhThien@jadegroup.mu `
  -AccessRight RestrictAccess `
  -Description "Jade Agent email assistant - Stephan's mailbox only"
```

Verify it worked — the first should say **granted**, the second **denied**:

```powershell
Test-ApplicationAccessPolicy -Identity Stephan.AhThien@jadegroup.mu -AppId b0673ca1-ad39-44f9-b3e7-8df0d6bbf17b
Test-ApplicationAccessPolicy -Identity Charles.Li@jadegroup.mu -AppId b0673ca1-ad39-44f9-b3e7-8df0d6bbf17b
```

Policy changes can take up to ~30 minutes to apply across the tenant.

> Microsoft also offers a newer method for this (*RBAC for Applications* in the
> Exchange admin centre) which achieves the same lock-down. If your tenant
> pushes you toward that instead, either is fine — the goal is simply that this
> App ID can reach only your mailbox.

---

## 3. OpenAI API key

Only the *drafting* needs this. The sorting/triage is plain rules and costs
nothing.

1. Go to **platform.openai.com** → sign in
2. **API keys** → **Create new secret key** → name it `Jade Agent`
3. Copy it immediately (shown once)
4. **Billing** → add a payment method and around **$20** of credit

Then store it as a backend secret (never in the website code):

```bash
cd ~/projects/jade-agent
supabase secrets set OPENAI_API_KEY=sk-paste_your_key_here
```

Expected cost at your volume is roughly **$5–15/month**. Only the handful of
emails that survive triage are ever sent to OpenAI — newsletters and staff
broadcasts are filtered out by rules first and never leave Microsoft.

---

## What gets stored, and what doesn't

- **Stored** in the database: sender, subject, date, and the triage decision —
  enough to show you a priority list and to remember "always ignore this
  sender".
- **Not stored**: email bodies. They are fetched from Microsoft when needed and
  discarded after the draft is written.
- Drafts live in your Outlook Drafts folder (and are listed in the app).

## What the agent will never do

- Send an email (no permission to, by design)
- Delete anything
- Read anyone else's mailbox (blocked by step 2)
- Reply to anything on its own — every draft waits for you
