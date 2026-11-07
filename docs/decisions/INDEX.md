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

## Adding a record

1. Take the next number. Use the four headings. Pin each claim.
2. Add a row above, and link the record from the topic doc or code comment that
   used to carry the rule.
3. Run `pnpm run check:doc-pins`.
