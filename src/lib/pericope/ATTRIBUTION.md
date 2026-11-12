# `bible-section-counts.txt` — attribution

Source: <https://a.openbible.info/data/bible-section-counts.txt> (OpenBible.info).

Licence: **CC0 1.0 Universal (public domain dedication)** — see
<https://www.openbible.info/labs/> . No attribution is legally required; it is
recorded here because knowing where a vendored dataset came from is the only way
to refresh it.

Retrieved 2026-09-24 for AQU-515. 12,649 data rows, tab separated, one header
line beginning with `#`:

| Column | Meaning |
| --- | --- |
| 1 | Start verse of the section, OSIS style (`Gen.2.4`) |
| 2 | End verse of the section |
| 3 | Verse after the end verse (equal to column 2 only when the section ends the book) |
| 4 | How many of 20 surveyed translations contain this exact section |

Column 4 is the boundary-strength prior this feature ranks by: a section 15 of
20 translations agree on is a strong suggestion, one that a single translation
draws is weak. Column 3 is unused here — it exists for OpenBible's Sankey
diagrams — but is kept so the file stays byte-identical to the upstream one and
can be diffed against a later download.

To refresh: re-download the file over this one and run
`pnpm test src/lib/pericope` — the parser tests assert the column layout and the
book coverage, so a change in shape upstream fails loudly rather than silently
producing no suggestions.
