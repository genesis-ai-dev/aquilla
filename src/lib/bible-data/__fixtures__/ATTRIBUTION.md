# `bkp-v1-*.json` — attribution

Source: the bibletranslation.org Bible Knowledge Pack, version 1.0.0 (built
2026-10-06T03:39:26Z by bible-wiki `pipeline/src/bkp`, commit 20a12e9).

Licence: the `voices`, `people` and `structure` layers are **CC BY-SA 4.0**
(<https://creativecommons.org/licenses/by-sa/4.0/>); the `text` layer is
**CC BY 4.0** (<https://creativecommons.org/licenses/by/4.0/>). They are built
from:

- OpenText context-annotation, CC BY-SA 4.0;
- Clear-Bible speaker-quotations (FCBH character ids), CC BY 4.0;
- MACULA Greek (Clear-Bible / Biblica), CC BY 4.0;
- ACAI (BibleAquifer), CC BY-SA 4.0.

Every value is copied from the published pack, unchanged. The files are
trimmed to whole records:

- `bkp-v1-JHN-4.voices.json` (AQU-1687): JHN 4:1–15 and 4:34–38 only, with
  the speeches those verses use (and their parent speeches).
- `bkp-v1-JHN-4.people.json` (AQU-1687, AQU-1689): the mentions in
  JHN 4:1–42, the entities they name, the members of those groups, and the
  entities the voices fixture names.
- `bkp-v1-JHN-4.text.json` (AQU-1689): the words of JHN 4:6–11, 4:14 and 4:27.
- `bkp-v1-JHN-4.structure.json` (AQU-1689): JHN 4's segments, and the verse
  facts and moves of the verses in the text fixture.
- `bkp-v1-MRK-1.*.json` (AQU-1689): the mentions in MRK 1:21–34 with their
  entities and group members; the words, verse facts and moves of
  MRK 1:29–31; MRK 1's segments.

To refresh: rebuild the pack (`pnpm --filter pipeline run:bkp` in bible-wiki)
and re-run the extraction for the same verses. The golden tests in
`../voice-index.test.ts`, `../speech-rails.test.ts` and
`../people-index.test.ts` then show what changed.

# `bkp-v1.1-*.json` — attribution (AQU-1695)

Source: the bibletranslation.org Bible Knowledge Pack, version 1.1.0 (built
2026-10-06T07:29:11Z by bible-wiki `pipeline/src/bkp`, after commit 7ec5c21).

Licence: the `notes`, `terms` and `people` layers are **CC BY-SA 4.0**
(<https://creativecommons.org/licenses/by-sa/4.0/>); the `text` layer is
**CC BY 4.0** (<https://creativecommons.org/licenses/by/4.0/>). Besides the
sources above, `notes` and `terms` are built from unfoldingWord Translation
Notes, Translation Questions and Translation Words (via BibleAquifer),
CC BY-SA 4.0, and ACAI keyterms, CC BY-SA 4.0.

Every value is copied from the published pack, unchanged. The files are
trimmed to whole records:

- `bkp-v1.1-JHN-4.text.json`: the words of JHN 4:5, 4:6, 4:9–11, 4:14, 4:51
  and 5:12. JHN 4 has no `unanchored` note, so JHN 5:12's is the example.
- `bkp-v1.1-JHN-4.notes.json`: the notes and questions on those verses, and
  the JHN 1:40–42 General Information note (a note on a range of verses).
- `bkp-v1.1-JHN-4.terms.json`: the tagged words of those verses, and the
  terms they use.
- `bkp-v1.1-JHN-4.people.json`: every mention in JHN 4 and JHN 5:12; the
  entities they name, the members of those groups, the speakers and
  addressees of `bkp-v1-JHN-4.voices.json`, and the relatives (`kin`) of
  all of those. A relative only mentioned outside these verses (Levi,
  Joseph of Nazareth, Mary) is in the entity map without a mention.

The text and structure layers of JHN 4 are the same in 1.0.0 and 1.1.0. The
golden tests in `../helps-index.test.ts` show what a refreshed file changes.

# `bridge-jhn4.json` — attribution (AQU-1694)

Written by `pnpm bridges:eval --data <Clear-Bible/Alignments> --pack <bkp/v1>
--book JHN --text BSB --write-fixture` (scripts/bridge-align-eval.ts). For
each verse of JHN 4:

- the Greek words, with only the fields the aligner reads (id, text, lemma,
  class, type), from the Bible Knowledge Pack `text` layer (built from MACULA
  Greek, Clear-Bible / Biblica): **CC BY 4.0**;
- the verse in the **Berean Standard Bible** (BSB), public domain, as the
  tokens of Clear-Bible's `data/eng/targets/BSB/nt_BSB.tsv` spaced as that
  file's `skip_space_after` column says;
- per Greek word, the BSB tokens (indexes in `tokenize(bsb)` order) that the
  manual alignment `data/eng/alignments/BSB/SBLGNT-BSB-manual.json` links it
  to. Clear-Bible Alignments (<https://github.com/Clear-Bible/Alignments>),
  alignment by Biblica: **CC BY 4.0**
  (<https://creativecommons.org/licenses/by/4.0/>).

The golden test in `../source-alignment.test.ts` checks the aligner against
these links; the full evaluation (all of John, other books, YLT) needs the
complete Clear files and is in the script.

# `bkp-v1.2-*.json` and `macula-hebrew-RUT-1.tsv` — attribution (AQU-1700)

Source: the bibletranslation.org Bible Knowledge Pack, version 1.2.0 (built
2026-10-06T10:18:50Z by bible-wiki `pipeline/src/bkp`, commit 1e097b0), the
first version with the Old Testament.

Licence: the `voices`, `people`, `structure`, `notes` and `terms` layers are
**CC BY-SA 4.0** (<https://creativecommons.org/licenses/by-sa/4.0/>); the
`text` layer is **CC BY 4.0** (<https://creativecommons.org/licenses/by/4.0/>).
For the Old Testament they are built from:

- MACULA Hebrew (Clear-Bible), the Westminster Leningrad Codex, CC BY 4.0;
- Clear-Bible speaker-quotations (FCBH character ids, the "Clear" consensus), CC BY 4.0;
- SIL Open Translator's Notes section headings, CC BY-SA 4.0;
- ACAI (BibleAquifer), CC BY-SA 4.0;
- unfoldingWord Translation Notes, Questions and Words (via BibleAquifer), CC BY-SA 4.0.

Every value is copied from the published pack, unchanged. The files are
trimmed to whole records:

- `bkp-v1.2-RUT-1-2.voices.json`: the verses of RUT 1–2, the speeches they
  use, and their parent speeches.
- `bkp-v1.2-RUT-1-2.people.json`: every mention in RUT 1–2; the entities
  they name, the members of those groups, the speakers and addressees of the
  voices fixture, and the relatives (`kin`) of all of those.
- `bkp-v1.2-RUT-1-2.structure.json`: the SIL OTN sections of RUT 1–2 and
  the verse facts of RUT 1–2. `moves` is empty, as in every OT book.
- `bkp-v1.2-RUT-1-2.text.json`: the morphemes of RUT 1:1, 1:8 and 1:14–17.
- `bkp-v1.2-RUT-1-2.notes.json`: the notes and questions on those verses.
- `bkp-v1.2-RUT-1-2.terms.json`: the tagged morphemes of those verses, and
  the terms they use.
- `bkp-v1.2-GEN-1-3.people.json`: every mention in GEN 1–3, with the same
  entity rule as Ruth's.
- `bkp-v1.2-GEN-1-3.structure.json`: the verse facts of GEN 1–3. Genesis has
  no segments in the pack.
- `bkp-v1.2-PSA-23.voices.json` and `bkp-v1.2-PSA-23.people.json`: PSA 23,
  which has no speeches, and its mentions.

`macula-hebrew-RUT-1.tsv`: the header and the rows of RUT 1:1 and RUT 1:16
of MACULA Hebrew's `WLC/tsv/macula-hebrew.tsv` (Clear-Bible/macula-hebrew,
commit 47db250b), **CC BY 4.0**: the file a project's Macula import reads.
The SDBH columns (`lexdomain`, `contextualdomain`, `coredomain`, `sdbh`) are
blanked; nothing reads them.

To refresh: rebuild the pack (`pnpm --filter pipeline run:bkp` in bible-wiki)
and re-run the extraction for the same chapters and verses.
