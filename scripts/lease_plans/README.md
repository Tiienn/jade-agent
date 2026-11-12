# Lease plans — Mac helper

The website lists actual project folders through its authenticated Browse API.
It searches direct lease folders first, or discovers lease folders through
CAD/DWG/tenant folders when none exist directly. It matches exact unit tokens,
with a 100-folder cap and refusal at the
Browse API's 500-entry truncation limit. It chooses the newest SharePoint
modified time, displays the source, and repeats the lookup before generation.
No filename date guessing. Other naming conventions require manual review.

## Setup

Run Enable Automatic Helper.command once (Python 3 + CADCraft required).
It installs a per-user LaunchAgent mu.jade.dot-cad-helper, starts at login,
and restarts after exit. CADCraft has its own isolated profile. No open
Terminal or pasted code is required. The Mac must be awake and logged in.
Disable Automatic Helper.command unloads the service and removes its plist.
Saved drawings remain under ~/Documents/Jade Lease Plans/<request-id>.

## Supported drawings

A unique unit label, title ending in UNIT - TENANT - Lease Agreement,
a date and numeric 1:N scale on the title layer, millimetre geometry,
and an existing closed red polyline containing the requested unit label.
Unrecognized or ambiguous inputs stop for manual review. Missing boundaries
are not redrawn. The title prefix/suffix and unit outline are preserved.
The smallest A4–A0 portrait/landscape sheet fitting the drawing at its stated
scale is selected with 10 mm total clearance. MEASUREMENT is normalized to
metric for CADCraft's export. F18 remains A3 portrait at 1:300.

Exports are DWG 2018 and PDF from the reopened output DWG. Import warnings,
skipped objects, changes to unrelated inspected entities, save/reopen changes,
wrong text, lost boundaries or clipping bounds fail the job. Aligned-dimension
cache regeneration is accepted only when the original scaled measurement and
saved geometric distance agree with the unchanged DIMLFAC. Automatic text
centres and anonymous dimension block names can regenerate; endpoints, explicit
text positions and dimension styles must remain unchanged. A second guard
requires byte-identical CADCraft PDFs before and after save/reopen; unexpected
rendering or even PDF metadata differences stop the job for manual review. These checks cover
CADCraft's exposed entities; they do not establish fidelity for unsupported DWG
metadata, fonts, proxy objects or arbitrary drawings. Visually review every set.
Long names are compressed only within a bounded range; otherwise rejected.

## Local security

127.0.0.1:17819 only. Exact Host and Origin checks restrict automatic pairing
to jade-agent.vercel.app, jade-file-finder.vercel.app and localhost:5173.
The opt-in --auto-pair endpoint returns a random process token to those sites;
all other requests still require the bearer token, kept in React memory.
Without --auto-pair the manual command-line mode requires its printed code.
No Microsoft/Supabase tokens, caller filesystem paths, or CAD commands are
accepted. Source metadata is whitelisted. No source overwrite or email.
The CAD socket is loopback-only. Anyone already controlling this Mac can
access local sockets; this is not isolation from other local processes.

Browser timeout does not cancel a job; saved reviews reconnect automatically.
Only a successful review.json exposes a completed set. Failed working copies
remain for troubleshooting. Logs contain no tenant data or pairing tokens.

## Validation

npm run build
python3 -m unittest discover -s scripts/lease_plans -p 'test_*.py'

Use actual source drawings for integration tests, reopen outputs and inspect
PDFs visually. Do not commit company drawings or authentication state.

2026-10-14 validation: F18 saves/reopens successfully with exact before/after PDF equality. Raffles Tower 1 / 5D latest source is located; export correctly stops on OLE2FRAME proxy C7BC owner-tag rewrite. Its embedded-object fidelity is not approved. Automatic startup, restart and pairing were verified on this Mac.
