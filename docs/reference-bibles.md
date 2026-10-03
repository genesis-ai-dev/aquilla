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

## The "Reference Bible quotes" check

A built-in check (on by default, minor, so it shows amber; it never blocks
anything) compares each draft with the verses its source cites, in the active
lane's Bible:

- **Does not match**: the draft quotes a cited verse (three or more words in a
  row match) but changes, adds or drops words inside the quote. Inside the
  draft's own quotation marks every word must be the verse's, so a changed
  first or last word, or a quote that copies the opening and paraphrases the
  rest, is caught; outside quotation marks, a different word where the verse
  runs on is caught for a verse the source quotes. The quoted part of the
  translation is marked.
- **Not taken from the Bible**: the source visibly quotes the verse but the
  draft does not use the Bible's wording at all. "Visibly quotes" means
  quotation marks around three or more words tied to the reference: cited
  right after the closing mark (`"…" (John 3:16)`), or introduced a few words
  before the opening mark (`Isaiah 40:25 says, "…"`); or, with no marks, the
  reference in brackets closing a clause of three or more words. A quotation
  of someone else next to a verse that is only mentioned does not count, and
  only the reference(s) citing the quotation are named (not a "see also").
  The reference in the source is marked.

A cell with both (one quote changed, another not taken from the Bible) shows
both sentences, each naming only its own verses.

Ignored: vowel marks (Arabic tashkeel, shadda, sukun, superscript alef),
tatweel, hamza and alef-wasla spellings, punctuation and case. A partial quote
passes; an ellipsis or a `[bracketed insertion]` splits a quote into parts that
are checked separately. A source that only mentions a verse, a lane with no
Bible, and a verse that has not loaded yet are left alone.

It runs live in the editor, in Check file (which loads every cited verse
first), and in the in-app agent's staging lint, where a mismatch becomes a
`NEEDS REVIEW` line that hands the model the Bible's wording. Agent proposal
cards and the rules preview do not run it yet.

## Demo project for testing

On a running dev stack (any ports):

```sh
npx tsx scripts/dev-seed-reference-bible.ts \
  --identity http://127.0.0.1:8788 --sync http://127.0.0.1:8789 --web http://localhost:5173
```

It builds **Sermon demo — reference Bible** in the dev org: source English,
default lane Arabic quoting Van Dyck, a **Plain English** lane quoting the KJV,
Bible resources off, and one sermon file of twelve rows. It prints the link,
what each row should show, and (unless `--no-token`) a fresh Agent API token
with ready-to-paste curl lines. It is re-runnable: settings and every seeded
draft are put back to the demo state, and a deleted demo file is replaced by a
fresh copy. If the stack has no Bibles yet it runs the loader first
(`AQUILLA_DATABASE_URL`, else `LOCAL_PG_URL`, else the dev default database).

The rows live in `scripts/reference-bible-demo.ts`, and every quoted draft is
derived from the committed text. `scripts/reference-bible-demo.test.ts` runs the
built-in checks over each row, so the expectations below are tested:

| Row | Source | Arabic draft | Shows |
|-----|--------|--------------|-------|
| 1 | Heading "Who is God?" | translated | clean |
| 2 | Prose, no reference | translated | clean |
| 3 | Isaiah 40:25 quoted | blank | draft it: the Van Dyck verse arrives, no warning |
| 4 | John 3:16 quoted, reference in brackets | exact vowelled Van Dyck (KJV in Plain English) | clean |
| 5 | 1 Cor. 13:4–7, first clause quoted | that clause without vowel marks | clean |
| 6 | Romans 8:28 quoted | Van Dyck with one word changed (KJV too, in Plain English) | does not match |
| 7 | Psalm 23:1 quoted | a fresh translation | not taken from Van Dyck |
| 8 | Philippians 4:13 mentioned | translated | clean |
| 9 | An allusion, no reference | translated | clean, no verses added |
| 10 | Romans 5:8; John 15:13 | blank | draft it: both verses arrive |
| 11 | "Read Romans 8 this week." | blank | draft it: no verses (a chapter is not a verse) |
| 12 | "John chapter 3, verse 16 …" | blank | draft it: John 3:16 arrives |

Blank rows also show the usual "Empty translation" warning until drafted. The
local stack's mock AI copies the verses in the prompt into its draft, so the
copied wording is visible without a real model key.

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
- `src/lib/lqa/check-functions/reference-quote.ts`: the built-in check (the
  lane's Bible arrives through the check context, `src/lib/lqa/check-context.ts`);
  `auth-worker/src/lib/agent/reference-lint.ts`: the same check in emit staging.
- `scripts/dev-seed-reference-bible.ts` and `scripts/reference-bible-demo.ts`:
  the demo project.
