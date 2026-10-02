# Reference Bibles (AQU-1573)

A project that is not itself Scripture (sermons, devotionals, curriculum) still
quotes Scripture, and its readers know their Bible's wording. A project can
choose, per target language (lane), the Bible those quotes are copied from.
When a source line cites a verse ("Isaiah 40:25", "1 Cor. 13:4–7"), drafting
puts that verse into the prompt with an instruction to copy it word for word,
and a built-in check warns when a draft's quote does not match.

This is separate from **Bible resources** (`bibleResourcesEnabled`), which is
the Aquifer lookup for projects whose cells are Scripture.

## What is installed

| App id        | Text                                         | eBible id     | Language | Notes |
|---------------|----------------------------------------------|---------------|----------|-------|
| `arb-vandyck` | Smith & Van Dyck Arabic Bible (1865)         | `arb-vd`      | Arabic   | Fully vowelled printing, exactly as eBible publishes it. |
| `eng-kjv`     | King James Version (1769 standard text)      | `eng-kjv2006` | English  | No Apocrypha. Strong's tags and italic brackets removed; the supplied words are kept. |

Both are public domain. `arbnav` on eBible is **not** Van Dyck: it is Biblica's
copyrighted New Arabic Version and must not be used.

The texts are committed, processed, under `db/reference-bibles/`:
`<id>.tsv.gz` (one verse per line: `BOOK<TAB>CHAPTER<TAB>VERSE<TAB>TEXT`, USFM
book codes) and `manifest.json` (names, language, licence, eBible build date,
the zip's and the text's sha256, the verse count). Nothing at runtime, boot or
test time downloads anything.

### Verse numbering

Both texts number verses the English (KJV) way: Malachi has four chapters and
psalm titles are not verses. References written in English sermons therefore
look up directly. Van Dyck splits two verses the KJV keeps together:

- 1 Timothy 6:21 (KJV) is 6:21–22 in Van Dyck.
- 3 John 1:14 (KJV) is 1:14–15 in Van Dyck.

So Van Dyck has 31,104 verses and the KJV 31,102. These are left as they are.
The `versification` column (`'eng'` for both) is there so a later Bible with
different numbering (Luther 1912, Reina-Valera 1909) can add a mapping.

## Loading the texts

The tables come from migration `0129_reference_bibles.sql`
(`reference_bible_versions`, `reference_bible_verses`). The loader is
idempotent: a Bible whose stored hash matches the manifest is skipped with one
query, a changed text is replaced in a single transaction, and a failed load
leaves the previous text in place.

**Local dev stack:** nothing to do. `pnpm dev` runs the loader on every boot
(scripts/dev-stack.ts); the first boot takes a few seconds and prints
`reference Bibles: arb-vandyck loaded (31104), eng-kjv loaded (31102)`, later
boots print `already loaded`.

**Production, and every PR-preview database:** apply the migration by hand like
every other migration, then run, as the database owner:

```sh
AQUILLA_DATABASE_URL='postgresql://…' npx tsx scripts/reference-bibles.ts load
# or with NEON_PG_HOST / NEON_PG_PASSWORD (+ NEON_PG_DB, NEON_PG_ROLE) set
```

It is safe to run again. Until it has run, Settings says no reference Bibles are
installed and drafting adds no verses. Options: `--version <id>` (one Bible),
`--if-missing` (skip any Bible already loaded, even an older text), `--force`
(rewrite even when current).

## Updating the texts (maintainers)

```sh
npx tsx scripts/reference-bibles.ts refresh            # both
npx tsx scripts/reference-bibles.ts refresh --version arb-vandyck
```

This downloads `https://ebible.org/Scriptures/<ebibleId>_usfm.zip`, extracts
the verses with the shared `extractUsfmVerses` (src/lib/reference-bible/
usfm-verses.ts), and rewrites the `.tsv.gz` and the manifest. Review the diff,
run `npx vitest run scripts/reference-bibles.test.ts`, commit, then run `load`
against each database. The USFM is used rather than eBible's VPL file (which
merges psalm titles into verse 1) or the BibleNLP corpus (whose files for these
two Bibles are empty and which uses Original numbering).

## Code map

- `src/lib/reference-bible/`: shared by the SPA and both workers (no path
  aliases). `reference-finder.ts` finds explicit references in prose;
  `usfm-verses.ts` extracts verse text; `normalize.ts` and `quote-check.ts` are
  the quote check (vowel marks, tatweel, hamza spellings, punctuation and case
  ignored); `lane-setting.ts` resolves a lane's Bible from the
  `referenceBibleVersions` setting.
- `db/shared/reference-bible.ts`: list installed Bibles, look up passages, the
  passages for a set of source texts, and setting validation.
- `db/shared/reference-bible-load.ts` and `scripts/reference-bibles.ts`: the
  loader.
