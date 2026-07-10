# Jade File Finder

Internal tool for Jade Group staff to search company SharePoint files with short, loose
queries (e.g. `RT 1D pdf`). Two roles: **worker** (search + preview/download files) and
**admin** (same, plus dashboard / users / settings). Built with React 18, TypeScript,
Vite 5, Tailwind CSS v4, react-router-dom v6 and Supabase.

## Local development

```bash
npm install
cp .env.example .env   # then fill in your Supabase URL + anon key
npm run dev
```

The app runs against Supabase Auth + edge functions. All Microsoft Graph / SharePoint
calls happen server-side — no Microsoft credentials ever live in the frontend.

## Full setup

Provisioning Supabase (database, RLS, edge functions, Azure app registration and secrets)
is documented in **SETUP.md**.
