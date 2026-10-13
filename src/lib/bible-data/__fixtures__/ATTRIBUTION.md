# `bkp-v1-JHN-4.*.json` — attribution

Source: the bibletranslation.org Bible Knowledge Pack, version 1.0.0 (built
2026-10-06T03:39:26Z by bible-wiki `pipeline/src/bkp`, commit 20a12e9).

Licence: the `voices` and `people` layers are **CC BY-SA 4.0**
(<https://creativecommons.org/licenses/by-sa/4.0/>). They are built from:

- OpenText context-annotation, CC BY-SA 4.0;
- Clear-Bible speaker-quotations (FCBH character ids), CC BY 4.0;
- MACULA Greek (Clear-Bible / Biblica), CC BY 4.0;
- ACAI (BibleAquifer), CC BY-SA 4.0.

Trimmed for AQU-1687 tests: JHN 4:1–15 and 4:34–38 only, with the speeches
those verses use (and their parent speeches) and the entities those speeches
name. `people.mentions` is empty, because Voices does not read it. Every value
is copied from the published pack, unchanged.

To refresh: rebuild the pack (`pnpm --filter pipeline run:bkp` in bible-wiki)
and re-run the extraction for the same verses. The golden tests in
`../voice-index.test.ts` and `../speech-rails.test.ts` then show what changed.
