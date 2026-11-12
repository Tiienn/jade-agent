# REA assessment for Jade Lease Studio

Reviewed 16 October 2026. Repository: https://github.com/morluto/rea

## Decision

Use REA's evidence-based investigation method to define and verify the small
lease-plan workflow. Keep REA as an optional developer diagnostic tool, not a
customer runtime dependency. Keep the current open-source CADCraft engine and
Jade Agent protocol for the F18 pilot. Do not attempt to recreate an entire CAD
engine or infer that REA automatically creates a compatible DWG editor.

The 16 October review examined REA documentation and selected implementation
files. At that point REA had not been installed, registered, or run. The
existing prototype was built using CADCraft's documented MCP protocol and our
own validator; it was not generated or verified by REA.

## What the repository actually provides

- CLI/MCP access to feature investigations, static native and managed analysis,
  application inventories, and selected runtime observations.
- Workflows including investigate_feature, verify_reconstruction,
  compare_application_versions, and audit_residual_unknowns.
- Evidence records tied to artifact hashes and provider identity, with explicit
  limitations and distinctions between observations and inferences.
- Reconstruction comparisons with finite required dimensions; unknown or
  truncated evidence is not treated as proof of equivalence.
- Native deep analysis uses providers such as Hopper, Ghidra or IDA. Source is
  already available for CADCraft, so direct source inspection is the simpler
  first step for this project.
- Native Windows process capture is currently unavailable. Its process-capture
  guide supports new captures on macOS/Linux; Windows can compare existing
  records. This does not validate Windows install/startup/rendering for us.
- Rust artifact inspection can read embedded cargo-auditable dependency metadata;
  it does not recover a complete original Rust project.

Sources examined:
- https://github.com/morluto/rea/blob/main/README.md
- https://github.com/morluto/rea/blob/main/docs/architecture.mermaid
- https://github.com/morluto/rea/blob/main/docs/mcp-prompts.md
- https://github.com/morluto/rea/blob/main/docs/process-capture.md
- https://github.com/morluto/rea/blob/main/docs/rust-binaries.md
- https://github.com/morluto/rea/blob/main/src/domain/evidence.ts
- https://github.com/morluto/rea/blob/main/src/domain/conformanceTrustGate.ts
- https://github.com/morluto/rea/blob/main/.agents/skills/reverse-engineer-anything/references/evidence-workflows.md

The reviewed showcases describe focused reconstructions (for example a DX-Ball
sound-pan calculation and a Notion clipboard bridge). They do not establish
that REA created CADCraft or reproduced all AutoCAD behaviour.

## Application to the F18 pilot

Treat each user operation as a bounded claim with a fixture and expected result:

| Claim | Evidence required |
|---|---|
| Open F18 | Supported import, no skipped entities or import warnings |
| Replace tenant/date | Exact expected text after save and reopen |
| Keep highlight | Same closed red polyline enclosing F18 |
| Keep geometry | Entity count/handles and unchanged unrelated objects |
| Keep dimensions | Style and geometry comparison, narrowly justified cache normalisation |
| Produce PDF | One A3 portrait page at 1:300, before/after-save PDF equality |
| Preserve source | Original source digest unchanged |
| Reject unsupported request | Other project/unit rejected before CAD commands |
| Automatic website connection | Trusted-origin pairing works; untrusted origin denied |
| Disconnect cleanly | Closing the app's input pipe ends worker and engine |
| Windows delivery | Windows executable compiled; native Windows smoke test remains necessary |

These are implemented with our existing validator and executable test harness;
they are not claims of REA verification. Byte-identical PDFs before/after save
prove only that particular round trip. They do not establish visual equality
with AutoCAD or the user's reference PDF, or universal DWG compatibility.

## Where REA would add practical value next

1. Investigate a concrete mismatch, such as the Raffles OLE owner-tag rewrite,
   with the source file, affected object, exact engine versions and failing
   comparison retained. Start with the available CADCraft/acadrust source.
2. If source-level inspection is insufficient, use targeted native function or
   runtime evidence from an authorised reference application to understand the
   particular behaviour. Avoid an open-ended “clone AutoCAD” investigation.
3. Compare a proposed engine update against the same F18 fixture and recorded
   output contract before changing the version shipped to customers.
4. Extend the contract when we implement editable outlines and added text:
   compare their intended geometry while preserving all unrelated objects.

## Product boundaries

The 0.1 pilot changed tenant/date and retained the existing highlight. Version
0.2 adds straight-polygon outline editing and plain-text notes.
Automatic startup and local pairing are application features, not REA features.
A sleeping computer cannot run the local CAD engine.

## 17 October 2026 — REA installed and used

REA 6.5.0 was installed with npm and scoped setup registered Codex and installed
the bundled workflow skill. Setup preserved unrelated configuration and created
its config backup. The current session used the CLI; MCP needs a client restart.
No Hopper/Ghidra/IDA installation was needed.

REA capture_process_scenario ran tests/probe_edit_commands.py against the actual
CADCraft 0.7.0 macOS CLI. This synthetic experiment created a closed polyline,
changed its colour to blue, added positioned text, saved DWG 2018 and reopened
it. The probe asserted exact entity equivalence after reopening. REA observed
exit code 0, no truncation, verified owned-process cleanup and retained the
report's file digest. The report also records the CAD engine SHA-256.

Evidence: ev_105bbdc90a671c1f7f77146d634e100eb105c9e5c395a3e7a2a870904125ff52
Local file: artifacts/rea/edit-command-evidence.json
Probe report: artifacts/rea/probe/report.json

This evidence established the specific command experiment on this Mac. It did
not establish native Windows UI behaviour or general CAD compatibility. REA
explicitly reports sampled process-tree coverage, non-atomic executable binding,
unrecorded inherited environment and unobserved network activity as limitations.

The result informed the implementation: bounded polyline replacement, explicit
colour assignment, text placement with a fixed justification, and save/reopen
verification. Separate tests exercised these edits against the user's F18
drawing and the actual embedded editor in Chromium. Those tests are our own
validation and are not claimed as REA conformance verification.
