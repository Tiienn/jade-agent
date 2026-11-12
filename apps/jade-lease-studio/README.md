# Jade Lease Studio 0.2 — Windows F18 pilot

Native Windows Forms application with a private headless CADCraft engine. The
existing Jade Agent lease-plan page connects using its existing loopback
protocol; no separate helper, Python installation, CADCraft window or pasted
code is required. The user signs into Jade Agent in their usual browser.

## Use

Extract the distribution ZIP and run JadeLeaseStudio.exe. It offers a per-user
installation in LocalAppData, adds a Start-menu shortcut and starts at sign-in.
Close hides the window to the tray; Quit and disconnect ends the worker and
engine. Startup can be disabled in the app. An uninstall command is included.
Documents/Jade Lease Plans is retained on uninstall.

The first version supports Palm Square F18 only: locate on the existing website
or open a local F18 DWG, enter tenant/date, save a new checked DWG/PDF and review.
Use Edit highlight and text on a saved review to drag corners, redraw the boundary,
choose its colour, and add/move/edit/delete plain text notes. Undo works before
saving; each save creates a separate checked review and keeps the previous one. Windows must be awake and signed in.

The existing live website still uses Mac-specific connection labels. Its wire
protocol is compatible; the outputs are generated on the Windows machine.
Windows customers may need to allow Chrome/Edge's local-network permission once.
PDF preview uses an existing WebView2 runtime, with Open PDF as a fallback.

## Build

Python 3 and .NET 10 SDK, on Windows or another .NET-supported build host:

```
python3 apps/jade-lease-studio/packaging/package.py
```

The packager verifies pinned SHA-256 digests of official CADCraft 0.7.0 and
Python 3.13.12 Windows x64 downloads, compiles a self-contained Windows .NET
application, carries upstream licences/notices, and writes the distribution
under artifacts/. It does not publish anything. Build-generated files, runtime
caches and private drawings are excluded from Git.

The CAD engine is an unmodified CLI distribution. Jade Lease Studio uses its
MCP stdio API. It does not expose general CAD commands or arbitrary paths to
the website. The shared validator remains scripts/lease_plans/cadcraft_bridge.py.
The pilot worker adds a server-side Palm Square/F18 allowlist and a product
identifier. Trusted production Jade origins can pair; other origins are denied.
A process bearer token authenticates subsequent HTTP calls. These controls
isolate websites, not other software already running as the same Windows user.

## Verification performed on 17 October 2026

- Windows x64 self-contained publish succeeds, with zero compiler warnings.
- 13 shared input, geometry/dimension and HTTP checks pass on macOS.
- 9 Studio tests pass on macOS: geometry/text validation plus real
  headless-engine/HTTP integration covering automatic
  pairing, untrusted origins/tokens, rejection of other units, an actual F18
  round trip, PDF/DWG retrieval, retry semantics, editing and reopening the real F18 DWG, repeated note removal,
  stale-source rejection and graceful worker cleanup.
- Actual F18 source: Dr. Antoine Leuteritz, 14 October 2026. A3 portrait at 1:300.
  Saved DWG reopens with expected text; dimension styles/geometry and outline
  are retained; before/after-save PDF bytes match; original bytes are unchanged.

The embedded editor was tested in Chrome at 1280×900 and 1000×720: redraw,
corner dragging, colour changes, note placement/editing/deletion, Undo, valid
save, crossed-outline rejection and recovery. No unexpected console or script
errors were observed. The test host substituted the native message bridge;
its save requests used the real editing pipeline.

This is not a native Windows runtime validation. On a Windows 10/11 x64 pilot
machine still verify installation, startup at sign-in, Edge/Chrome connection,
PDF preview/font rendering, tray exit, restart and uninstall. Also visually
compare the exported plan with the approved reference PDF before customer use.
The application is unsigned; a signed installer is a later release step.

Run the optional real tests with local, private fixture paths:

```
STUDIO_TEST_ENGINE=/path/to/cadcraft-cli STUDIO_TEST_DWG=/path/to/F18.dwg python3 -m unittest discover -s apps/jade-lease-studio/tests -v
python3 -m unittest discover -s scripts/lease_plans -p 'test_*.py'
```

## REA research

See docs/REA-ASSESSMENT.md for the investigation, source links and concrete
verification contract. REA 6.5.0 is now installed and registered for Codex. Its
CLI captured the synthetic outline/colour/text/save/reopen experiment successfully;
the evidence is under artifacts/rea/ (local and ignored by Git). No decompiler
was needed. REA is a development tool; customers do not need it. The MCP
registration becomes available to Codex after reconnection/restart.

## Editing constraints

The server accepts only review IDs, a closed polygon, one of four highlight
colours, and up to 20 plain notes of 120 characters. It accepts no commands or
caller-chosen file paths. It checks finite/in-bounds coordinates, polygon
self-intersections, F18 containment and exclusion of other F-numbered unit
labels. These checks do not establish architectural boundary accuracy; the
user must visually review the chosen boundary. Curved source boundaries are
not supported by this simple corner editor.

Editable notes are restricted to object handles recorded by Studio in each
review's manifest. Original drawing text and unrelated geometry are preserved.
Text that extends beyond the original drawing bounds is rejected. The editor
shows an approximate text overlay; the final PDF uses the CAD engine's fonts.
The new review reopens and verifies exact intended outline/note properties,
unrelated objects, title/date/scale, dimension styles and before/after-save PDF
equality. Final manifests are published atomically. A source hash prevents
saving edits against a review that changed after the editor opened.
