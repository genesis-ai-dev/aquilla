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
- `bkp-v1-JHN-4.text.json` (AQU-1689): the words of JHN 4:6–10 and 4:27.
- `bkp-v1-JHN-4.structure.json` (AQU-1689): JHN 4's segments, and the verse
  facts and moves of the verses in the text fixture.
- `bkp-v1-MRK-1.*.json` (AQU-1689): the mentions in MRK 1:21–34 with their
  entities and group members; the words, verse facts and moves of
  MRK 1:29–31; MRK 1's segments.

To refresh: rebuild the pack (`pnpm --filter pipeline run:bkp` in bible-wiki)
and re-run the extraction for the same verses. The golden tests in
`../voice-index.test.ts`, `../speech-rails.test.ts` and
`../people-index.test.ts` then show what changed.
