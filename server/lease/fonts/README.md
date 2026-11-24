# Fonts for cloud lease plans

Lease drawings name their fonts by Windows file name. The ones that matter here
are Arial Narrow — `ARIALN.TTF`, plus `ARIALNB.TTF`, `ARIALNI.TTF` and
`ARIALNBI.TTF` — used by the `STYLE2` and `arial` text styles for unit numbers,
tenant names and sheet titles. CADCraft finds a TrueType font by file or family
name in the system font folders, and the cloud sandbox has none. When it can't
find one it draws the text with its own stroke font, which is much wider than
Arial Narrow: the same text height then reads as oversized, heavy lettering.
The Manhattan S08B plan of 24 Nov 2026 showed exactly that.

Arial Narrow itself is Monotype's, licensed to the computers it ships with, so
it is not copied here. These files are **Liberation Sans Narrow 1.07.6**. Its
letters have the same widths as Arial Narrow's (that is what it was made for),
so every label keeps the footprint the drafter gave it.

At job start `server/lease/cloud.mjs` writes each file into the sandbox's
`~/.local/share/fonts` under the Windows names, upper- and lower-case, and runs
the CAD engine with that home folder. Nothing in the drawing is changed: the
saved DWG still asks for `ARIALN.TTF`, which is what AutoCAD users need. The
build copies these files into `server/lease/runtime/fonts` with the rest of the
cloud runtime.

| Windows name | File | SHA-256 |
|---|---|---|
| `ARIALN.TTF` | `LiberationSansNarrow-Regular.ttf` | `546e8957e5dccece4ac07ea02f57a5cdb3dc3b0e902ea75a837a7784ba4b7eef` |
| `ARIALNB.TTF` | `LiberationSansNarrow-Bold.ttf` | `8e5eb5090ef4a3143794c230b82f174f7f2fbbfcd6cb789ccfa1f90bf8795d54` |
| `ARIALNI.TTF` | `LiberationSansNarrow-Italic.ttf` | `c5de4127c273dbcfc173414d170448cbe800c3a7fb1f97beaeee1b076d6a5eea` |
| `ARIALNBI.TTF` | `LiberationSansNarrow-BoldItalic.ttf` | `57fe1513fa84379d36e7da6fd9a45d053ded5e895042ab36692d8d05a8c4f4d8` |

Source: `liberation-narrow-fonts-ttf-1.07.6.tar.gz` from the `liberationfonts`
GitHub project (archive SHA-256
`8879d89b5ff7b506c9fc28efc31a5c0b954bbe9333e66e5283d27d20a8519ea3`), files
unmodified. Licence: GNU GPL v2 with Red Hat's font exception — a document that
embeds the font is not thereby covered by the GPL. See `License.txt` and
`COPYING`.

SHX fonts (`romans.shx`, `romant.shx`) are not affected: CADCraft does not read
SHX files and draws those styles with its own stroke font, which is close to
`romans` and is what the title blocks already use.

A drawing that names another TrueType font that isn't here gets the stroke
font. The review checklist says so — "Font not available, drawn in a
substitute: …" — so a reviewer sees it before the plan is sent.
