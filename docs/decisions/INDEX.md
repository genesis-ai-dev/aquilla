# Decision records

One page per decision that shapes behaviour you cannot read off a single file.
Before this folder existed, the rule behind a behaviour lived in a Linear issue
quoted in a code comment — findable only with the issue tracker open. A record
here is the durable answer to "why does it do that, and what may I change?".

Records are additive and dated. We do not rewrite one when the code moves; we
amend it, or supersede it with a new record and say so in both.

## The four headings

Every record uses exactly these, in this order, and stays under about one page:

- **Context** — the forces that made the decision necessary.
- **Decision** — the rule, stated so a reviewer can apply it.
- **Consequences** — what follows, including what it costs.
- **Not covered yet** — what the record deliberately leaves open, so nobody
  reads silence as a promise.

## Pins

A claim about code carries a **pin**: an inline code span naming a repo-root
relative file, optionally with an exported symbol after `::`.

```text
`src/lib/import.ts`                      — the file
`db/shared/inline-tags.ts::maskInlineTags` — the file and an exported symbol
```

**Pins never carry line numbers.** Line numbers rot on the next edit; a file
and an exported name survive refactors, and when they do not, that is exactly
the signal worth failing on.

`scripts/check-doc-pins.ts` proves every pin resolves. It reads every Markdown
file under `docs/`, plus `CLAUDE.md` and `AGENTS.md`, and runs in two tiers:

- **strict** — in this folder (and in any doc carrying
  `<!-- doc-pins: strict -->`), *every* path-shaped span is a pin and must
  resolve.
- **scoped** — everywhere else, only the `path::symbol` form is checked. The
  older docs quote paths that are deliberately stale — `CLAUDE.md` names the
  abandoned layouts on purpose — so a tree-wide flag day would only teach
  everyone to ignore a red check.

A doc opts out entirely with `<!-- doc-pins: off -->`.

Run it with `pnpm run check:doc-pins`; CI runs it in the `lint` job
(`.github/workflows/ci.yml`). Its own behaviour is covered by
`scripts/check-doc-pins.test.ts`, including the case the guard exists for: a
pinned symbol gets renamed and the check goes red.

## The records

| # | Record | Subject |
| --- | --- | --- |
| 0001 | [Parser version stamps and the re-import rule](0001-parser-version-stamps-and-re-import.md) | `parserVersion`, `importProfile`, what re-import reopens |
| 0002 | [Byte-identical untouched exports](0002-byte-identical-untouched-exports.md) | an IDML export that changes nothing returns the original bytes |
| 0003 | [Inline-tag masking and the repair ladder](0003-inline-tag-masking-and-the-repair-ladder.md) | prevent → detect → repair → quarantine around every model call |
| 0004 | [Named versus ordered placeholders](0004-named-versus-ordered-placeholders.md) | which tokens a translation may move, and which it may not |
| 0005 | [The partner-integrations seam](0005-partner-integrations-seam.md) | publisher code in a folder you can delete |
| 0006 | [The event log's head compare-and-swap](0006-event-log-head-compare-and-swap.md) | how two offline edits to one cell resolve |
| 0007 | [Cell labels are metadata, never cast](0007-cell-labels-are-metadata-never-cast.md) | a typed label on a line never becomes a character or a voice |
| 0008 | [File revisions and derived source cells](0008-file-revisions-and-derived-source-cells.md) | a file is an artifact + a filter stamp + a revision chain; alignment assigns cell ids |
| 0009 | [Connector support access](0009-connector-support-access.md) | how a platform admin's cross-tenant reach gets onto a connector token, and what expires it |
| 0010 | [USFM target layout](0010-usfm-target-layout.md) | a translation keeps the paragraph lines after its verse; breaks and headings the translator adds ride the next verse's value; one serializer for export and preview |
| 0011 | [In-flight statement cap](0011-in-flight-statement-cap.md) | a request handle never gives the driver more statements at once than its pool has connections |
| 0012 | [A desktop release is a draft until it is verified](0012-desktop-release-is-a-draft-until-verified.md) | the shell release line cuts itself, and installed apps are offered a build only after its signed files pass verification |
| 0013 | [An interaction costs commits × rendered tree × work in render](0013-interaction-cost-is-commits-times-tree.md) | what makes a click slow in this app, the patterns that are not allowed, and the benchmark that enforces them |
| 0014 | [Direct dev commits on the release line](0014-direct-dev-commits-on-the-release-line.md) | a commit pushed to `dev` with no PR is picked when it only touches locale catalogs, and held as "not a PR" until a person picks it otherwise |
| 0015 | [A release hold is a gate to build, not a label to add](0015-a-release-hold-is-a-gate-to-build.md) | what may keep a merged PR out of production, how an area gets a gate, and what watches a release nobody walked |
| 0016 | [Smart edits are project-wide, on by default, and cheap per reader](0016-smart-edits-are-project-wide-and-on.md) | where the switch lives, why a project is mined once a minute after the response, and why the editor asks only about cells it has no answer for |
| 0017 | [Search matches words, or text, by script](0017-search-matches-words-or-text-by-script.md) | Chinese, Japanese, Thai, Burmese, Korean and similar queries are matched as text and ranked by occurrences; every other script stays on the word index |
| 0018 | [Example retrieval and confidence compare text by character n-grams](0018-retrieval-covers-text-by-character-ngrams.md) | the branching search covers a verse by character trigrams (bigrams in Han, Kana and Hangul), so it works the same in scripts with no spaces |
| 0019 | [A settings collection moves to rows, and the key never leaves the API](0019-settings-collections-move-to-rows.md) | how a large `project_settings` key leaves the multi-MB blob without any reader being able to tell |
| 0020 | [What the app can do and an agent cannot is written down as data](0020-agent-app-parity-tables.md) | every file type, event kind and command has a row saying whether an agent can do it; a new one fails the build until it has a row |

## Adding a record

1. Take the next number. Use the four headings. Pin each claim.
2. Add a row above, and link the record from the topic doc or code comment that
   used to carry the rule.
3. Run `pnpm run check:doc-pins`.
