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
