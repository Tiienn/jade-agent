# Setting Up Jade File Finder

Welcome! This guide walks you through getting Jade File Finder live, one step at a time. You can copy and paste every command exactly as written. Where you need to fill in your own value, it's written in `CAPITAL_LETTERS` so it's easy to spot.

> **Where things stand (10 July 2026):** the app is fully built, you're already logged in to both the Supabase and Vercel CLIs, and a Supabase **organization named "Jade Group"** already exists in your account — pick it when creating the project in step 1b. Your free plan allows 2 active projects; "Auto Ecole" is paused, so a slot should be free (if creation still complains about the limit, pause or delete another project, or upgrade the plan). Start at step 1b.

**Before you start, you should have:**

- A Mac.
- The **Supabase CLI** and **Vercel CLI** already installed. (If a command below ever says "command not found", that tool isn't installed yet — reach out to whoever set up your machine.)
- This project's code on your computer at `~/projects/jade-agent` (the `~` is a shortcut for your home folder).

A quick vocabulary note so nothing is a surprise:

- **Supabase** is the service that stores your accounts, your list of buildings, and the log of every search. Think of it as the app's filing cabinet and security guard.
- **Vercel** is the service that puts the actual website online so staff can open it in a browser.
- **Terminal** is the Mac app where you paste commands. Open it from Applications → Utilities → Terminal, or press `Cmd + Space`, type "Terminal", and press Return.
- The **`~/projects/jade-agent`** folder is where all the code lives. Several commands below start by moving into it with `cd ~/projects/jade-agent` ("cd" just means "change directory").

Take these sections in order. You only do steps 1, 2, and 4 once. Step 3 is your very first login, and step 5 is your day-to-day.

---

## 1. Create the Supabase project (the app's database)

This sets up the filing cabinet: the accounts, the buildings, and the search history.

**1a. Log in to Supabase from Terminal.**

```
supabase login
```

This opens your web browser and asks you to sign in / authorize. Once it says you're logged in, come back to Terminal.

**1b. Create a project.** The easiest way is on the website:

1. Go to **https://supabase.com** and sign in.
2. Click **New project**.
3. Give it a name (for example, `jade-file-finder`), choose a **strong database password** (write it down somewhere safe — you'll rarely need it, but you don't want to lose it), and pick the region closest to your staff.
4. Click **Create new project** and wait a minute or two while it gets ready.

> Prefer the command line? You can instead run `supabase projects create jade-file-finder` and follow the prompts. Either way is fine.

**1c. Find your Project Reference ("ref").** In the Supabase dashboard for your new project, go to **Settings → General**. The **Reference ID** is a short string of letters and numbers. Copy it.

**1d. Connect this code to your project.** In Terminal:

```
cd ~/projects/jade-agent
supabase link --project-ref YOUR_PROJECT_REF_HERE
```

Replace `YOUR_PROJECT_REF_HERE` with the Reference ID you just copied. If it asks for the database password, paste the one you chose in step 1b.

**1e. Build the database tables.** This creates the accounts, buildings, and search-history tables, and fills in your 9 buildings automatically:

```
supabase db push
```

**1f. Publish the three backend functions.** These are the small programs that actually search SharePoint, fetch files, and manage accounts:

```
supabase functions deploy search file admin-users --no-verify-jwt
```

> `--no-verify-jwt` is intentional and required — the functions check who you are internally, and the very first "create admin" screen has to work before any account exists.

**1g. Get the two values the website needs.** In the Supabase dashboard, go to **Settings → API**. You'll copy two things:

- **Project URL** (looks like `https://abcdefgh.supabase.co`)
- **anon public** key (a long string, under "Project API keys")

Now create a file that tells the website about them. In Terminal:

```
cd ~/projects/jade-agent
cp .env.example .env 2>/dev/null || touch .env
open -e .env
```

That opens a small text file in TextEdit. Put these two lines in it (pasting your own values after the `=` signs), then save and close:

```
VITE_SUPABASE_URL=https://YOUR_PROJECT_URL_HERE.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_ANON_PUBLIC_KEY_HERE
```

> These two values are safe to put in the website — they're designed to be public. The truly secret values come next, and those go somewhere else entirely.

---

## 2. Connect Microsoft / SharePoint (so the app can read your files)

The app reads files from your company's SharePoint. To let it do that safely, you create a small "app registration" in Microsoft and give this project four secret values. **These four secrets live only in Supabase — never in the website code, never in email.**

The four secrets are:

```
supabase secrets set MS_TENANT_ID=YOUR_TENANT_ID_HERE
supabase secrets set MS_CLIENT_ID=YOUR_CLIENT_ID_HERE
supabase secrets set MS_CLIENT_SECRET=YOUR_CLIENT_SECRET_HERE
supabase secrets set SHAREPOINT_SITE_ID=YOUR_SITE_ID_HERE
```

Here's how to get each one. (You'll need a Microsoft 365 administrator's help for the "grant consent" moment near the end — line that up in advance if you're not one yourself.)

**2a. Create the app registration.**

1. Go to **https://portal.azure.com** and sign in with your work account.
2. Search for and open **Microsoft Entra ID** (this used to be called "Azure Active Directory").
3. In the left menu, click **App registrations**, then **New registration**.
4. **Name:** `Jade File Finder`. Leave **Redirect URI** blank — you don't need one.
5. Click **Register**.

**2b. Copy the Tenant ID and Client ID.** On the app's **Overview** page you'll now see:

- **Directory (tenant) ID** → this is your `MS_TENANT_ID`.
- **Application (client) ID** → this is your `MS_CLIENT_ID`.

Copy both.

**2c. Create the Client Secret.**

1. In the left menu, click **Certificates & secrets**.
2. Click **New client secret**, add a description (like `jade-file-finder`), pick an expiry (24 months is reasonable), and click **Add**.
3. **Immediately copy the `Value`** (not the "Secret ID" — the **Value**). This is your `MS_CLIENT_SECRET`. It is shown only once; if you navigate away you'll have to make a new one.

**2d. Grant the app permission to read SharePoint.**

1. In the left menu, click **API permissions**.
2. Click **Add a permission → Microsoft Graph → Application permissions**.
3. Search for and tick **`Sites.Read.All`** and **`Files.Read.All`**, then click **Add permissions**.
4. Click **Grant admin consent for [your organization]** and confirm. *(This button needs a Microsoft 365 admin. If it's greyed out for you, ask your admin to click it.)* When done, both permissions show a green check under "Status".

**2e. Find your SharePoint Site ID.** The easiest way:

1. Go to **https://developer.microsoft.com/graph/graph-explorer** and click **Sign in** (top left), using your work account.
2. In the query box at the top, paste this — replacing `yourtenant` with your organization's SharePoint name and `YourSiteName` with the site that holds the files:

   ```
   https://graph.microsoft.com/v1.0/sites/yourtenant.sharepoint.com:/sites/YourSiteName?$select=id
   ```

   For example, if your SharePoint address is `https://jadegroup.sharepoint.com/sites/Marketing`, you'd use `jadegroup.sharepoint.com:/sites/Marketing`.
3. Make sure the method dropdown says **GET**, then click **Run query**.
4. In the response below, find the `"id"` value (a longish string with commas in it). That whole value is your `SHAREPOINT_SITE_ID`.

**2f. Save all four secrets.** Back in Terminal, run the four `supabase secrets set ...` commands from the top of this section, pasting in the values you just collected. You can confirm they're stored with:

```
supabase secrets list
```

(It shows the names, not the secret values — that's normal and good.)

---

## 3. First launch — create your admin account

You don't create the first account from a command line — the app does it for you, once.

1. Open the app in your browser. (During setup you can run it locally with `npm run dev` from `~/projects/jade-agent`; after step 4 it'll have a real web address.)
2. Because no admin exists yet, the app shows a one-time **"Create admin"** screen.
3. Pick a **username** and a **password** for yourself and submit.

That's it — you're the administrator. This screen never appears again once an admin exists. From now on, every other account is created by you from **Admin → Users** (covered in step 5).

---

## 4. Put the website online with Vercel

Now we publish the actual website so staff can open it from anywhere.

**4a. Deploy it.** In Terminal:

```
cd ~/projects/jade-agent
vercel
```

The first time, Vercel asks a few setup questions — you can **accept the defaults** by pressing Return at each prompt. When it finishes, it prints a web address.

**4b. Give the website its two Supabase values.** The website needs the same two values from step 1g. Add them to Vercel:

```
vercel env add VITE_SUPABASE_URL
vercel env add VITE_SUPABASE_ANON_KEY
```

Each command asks for the value (paste it) and which environments it applies to — choose **Production** (and Preview/Development too, if offered; selecting all is fine).

> Prefer clicking? You can also set these in the Vercel dashboard under your project → **Settings → Environment Variables**.

**4c. Publish the finished version.**

```
vercel --prod
```

This prints your final, shareable web address. Send that link to your staff — **it works great on phones**, which is handy for anyone searching while out at a building.

---

## 5. Everyday admin tasks

Once you're set up, here's what you'll actually do day to day. All of these live under the **Admin** area, which only you and other admins can see.

**Manage people — Admin → Users**

- **Add a worker:** create a username and a starting password, and hand it to them.
- **Disable someone who leaves:** switch them to inactive. (Accounts are never deleted — this keeps the search history intact and honest.)
- **Reset a forgotten password:** set a new one for them right here.

**Edit buildings — Admin → Settings**

- Change a building's **code** (the short letters staff type, like `RT`) or its **SharePoint folder path**.
- The default folder for each building is **Documents → Marketing → Project → [building name]**. If your files live somewhere else in SharePoint, update the path here so it matches exactly.

**Watch the searches — Admin → Dashboard**

- See who searched for what, and when. Filter by worker or by date.
- Searches that **found nothing** are highlighted — a great way to spot a wrong building code, a misnamed folder, or something staff expect to find but can't.

---

## 6. Troubleshooting

| What you see | What it usually means | What to do |
| --- | --- | --- |
| "No building matched" | The code the worker typed isn't in your list | Check **Admin → Settings** and confirm the building's **code** is spelled the way staff type it |
| Search runs but returns nothing | The building's folder path doesn't match SharePoint | In **Admin → Settings**, make sure the **root path** matches the real SharePoint folder exactly (spelling, spaces, capitalization) |
| "401", "Unauthorized", or a secret/permission error | The Microsoft secrets aren't set, or admin consent wasn't granted | Re-check step 2 — run `supabase secrets list` to confirm all four names are present, and make sure the **Grant admin consent** button in step 2d shows green checks |
| You want to see what a function is actually doing | Useful when a search misbehaves | Run `supabase functions logs search` in Terminal (swap `search` for `file` or `admin-users`), or view logs in the Supabase dashboard under **Edge Functions** |

If you get stuck, the two most common fixes are: (1) confirm the four Microsoft secrets are set and consent is granted, and (2) confirm each building's folder path in Settings matches SharePoint exactly. Those cover the large majority of issues.

Welcome aboard — you're all set.
