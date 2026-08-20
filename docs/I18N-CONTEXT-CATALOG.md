# Context-rich localization catalog standard (AQU-832)

The bottleneck in UI localization is never the string count — it's missing context.
"Save" translates differently depending on whether it's a button or a menu item, what it
saves, and how much room it has. A catalog that is just `key → English string` forces every
translator (human or AI) to guess, and guesses are where localization bugs come from.

So **the catalog carries its own context**. Every message key resolves to a description of
what the string does, the surface it lives on (with a screenshot where one is declared), and
the semantics of every `{placeholder}`. Coverage is enforced by a test, so it can't rot.

This builds on the AQU-511 framework (typed `en` catalog, `translate()` fallback,
`I18nProvider`, `LanguageSwitcher`). AQU-511 built the machinery; this standard is about
**filling** the catalogs fast and repeatably.

## Why this changed

The standard originally required (in practice, if not in the letter of the lint) a
hand-authored per-key description for nearly every key. That produced genuinely good
translations at 1,337 keys, but it does not scale to the ~4,000 keys the catalog is about to
carry, for reasons that are measured, not guessed at:

- **The prose was the majority of the file, not a supplement to it.** At 1,337 keys, this
  worktree's sidecar carries authored context on 1,143 of them (85.5%) — a namespace note
  plus a per-key entry on top for nearly every string. Scaled linearly to ~4,000 keys, that's
  roughly 3,400 hand-written entries before a single word gets translated.
- **It was already being routed around.** `autopilot`, the newest and second-largest
  namespace (259 keys), ships with a per-key entry on roughly a quarter of its keys and
  `surfaces: []`, and `pnpm test` passed the whole time — because coverage only ever gated on
  the namespace `_context.description`, never on individual keys. A rule that's easy to skip
  isn't a standard, it's a suggestion with extra steps.
- **The no-duplicates guard forced English to be reworded to dodge false collisions.** Its
  `normalize()` stripped a trailing ellipsis/colon before comparing strings, so an
  accessible name ("Search") and the visible field it names ("Search…") normalized to the
  same value and were flagged as duplicates — even though the mark is *required* on one and
  *forbidden* on the other (a screen reader reads "…" aloud as punctuation). 20 of this
  guard's 30 documented exceptions existed for no reason other than that stripped mark; a
  wave that reworded English purely to dodge the false collision had to be reverted (commit
  `6b2977f5f`).
- **The screenshot check only proved a file exists, not that it's current.** `project-settings`
  is stale today and nothing detects it: its capture driver stops at
  `/project/:projectId/settings`, which now renders an 8-card index, not the ~150 form
  strings its `notes` promise a translator will see. `context.test.ts` only ever asserted
  `existsSync`.

The fix in each case is the same shape: keep the reuse pressure, drop the part that was
either ignorable or actively counterproductive. See **The schema** for the class test that
replaced "every key," **Screenshots** for the staleness manifest, and **No-duplicates** for
the warning-not-error change and the `normalize()` fix.

Measuring, not estimating, the effect on this worktree's 1,337 keys: **1,143 keys (85.5%)
carried authored per-key prose under the old convention; 653 (48.8%) are classified as
needing it under the class test below** — a 43% cut in what must be hand-written, with the
existing per-namespace and per-key content otherwise untouched (every namespace passes
unchanged; the one pre-existing gap this shipped with has since been filled, so
`LEGACY_CONTEXT_GAPS` in `context.ts` is empty).

## Where things live

| Path | What it is |
| --- | --- |
| `src/lib/i18n/messages/en.ts` | Base catalog — the source of truth for **keys and English strings** |
| `src/lib/i18n/plurals.ts` | CLDR plural categories: the `plural()` authoring shape, selection, fallback |
| `src/lib/i18n/context.ts` | **Context sidecar** — the authored metadata + resolution + lint |
| `src/lib/i18n/screenshots.ts` | Registry of screenshot **surfaces** (id, route, viewing notes) |
| `src/lib/i18n/screenshots/<id>.png` | The captured surface images |
| `src/lib/i18n/screenshots/manifest.json` | Per-surface hash + route + commit, for staleness detection |
| `src/lib/i18n/screenshot-manifest.ts` | Reads the manifest, compares it to the committed PNGs and declared routes |
| `src/lib/i18n/namespaces/duplicate-exceptions.ts` | Reviewed same-English-different-meaning exceptions |
| `src/lib/i18n/catalog-export.ts` | Interchange: catalog ⇄ Aquilla project ⇄ `messages/<locale>.ts` |
| `src/lib/i18n/messages/<locale>.ts` | **Generated** per-locale catalogs (do not hand-edit) |
| `scripts/i18n-catalog.ts` | CLI: `check` / `export` / `import` |

The sidecar is authored in TypeScript rather than JSON on purpose: `tsc` then rejects an
entry for a key that doesn't exist and a reference to a screenshot surface that isn't
declared. The JSON interchange file translators receive is *generated* from it verbatim.

## The schema

Context has two levels, so per-key notes stay tiny:

- **Namespace `_context`** — describes the surrounding surface once. The namespace is the
  segment before the first `.` of a key, so one entry covers every key under `nav.*`.
- **Per-key entry** — only where the namespace note isn't enough: a placeholder to explain,
  a length limit, a non-obvious action.

A key is **covered** when its namespace has a `_context.description`. Per-key entries
refine the namespace note; resolution layers the key entry over the namespace entry field by
field, and merges `placeholders`.

### When a per-key entry is required, not just allowed

A generic namespace note can't carry everything a translator needs. Four classes of key
genuinely need their own entry, and `catalogContextIssues()` requires one — everything else
may skip an entry entirely and pass on the namespace note alone (`contextRequirementFor()` /
`requiresOwnContextEntry()` in `context.ts` are the class test, called out of the lint):

| Class | Why a namespace note can't cover it |
| --- | --- |
| Has a `{placeholder}` | The namespace can't say what `{target}` or `{count}` holds for every key that uses one — that's per-string. |
| Is count-governed (`plural()`) | A translator needs to reason about *this* key's forms, not the namespace's. |
| Carries a `maxLength` ceiling (its own, or inherited from the namespace) | A length constraint is a fact about *this* string's layout, worth calling out even when the namespace already flags the surface as tight. |
| Is an accessibility name (`aria-label` / screen-reader-only text) | Read by assistive tech with none of the surrounding visual layout to lean on — see `looksLikeAccessibilityName()`, which recognizes the `Aria`/`screenReader`/`srOnly`/`visuallyHidden` key-naming convention already used by 30+ existing keys (`nav.version.copyAriaLabel`, `editor.row.selectedAria`). It's a heuristic on the key's own name, not a scan of the component tree, so a string wired to `aria-label` under a name that doesn't say so won't be caught — name the key so it does. |

A key outside all four classes — the large majority: a plain button, a heading, a confirm
title, most of a namespace's vocabulary — inherits the namespace description and needs
nothing else. This is what makes coverage a **class test** instead of a per-key tax: the
requirement is decided by what the key *is* (shape of its English value, shape of its name),
never by whether someone already wrote an entry for it.

**The tracked-exception hatch.** `LEGACY_CONTEXT_GAPS` in `context.ts` lists keys that predate
the class test and still lack the entry they need, so a known gap is carried as an explicit,
reviewed admission rather than silently passing. It is **empty today** — the one key it
shipped with (`autopilot.inspector.activity.logAria`, a real `aria-label`) has its own entry
in `autopilot.ts`. The same lint verifies any listing both ways: the key must still genuinely
need the exemption, and gains its own issue ("no longer needs the exemption — drop it") the
moment someone adds the missing entry.

```ts
export const CATALOG_CONTEXT: Record<string, NamespaceBlock> = {
  nav: {
    _context: {
      description:
        "Top-level workspace navigation — links and controls in the left sidebar…",
      screenshot: "workspace-nav",
      maxLength: 24,
    },
    keys: {
      "nav.projects": {
        description: "Sidebar link to the list of translation projects…",
      },
    },
  },
}
```

Fields on a `ContextEntry`:

| Field | Meaning |
| --- | --- |
| `description` | **Required.** What the string does: element type (button / label / toast / tooltip / heading), the action it triggers, wording constraints. Written for someone who cannot see the code. |
| `screenshot` | Surface id from `screenshots.ts`. Inherited from the namespace unless overridden. |
| `maxLength` | Soft character ceiling, only where the layout genuinely constrains the translation. Omit when the string has room to grow. |
| `placeholders` | Meaning of each `{name}` in the string. Required for every placeholder the English string uses — enforced in **both** directions. |

> Keys inside `keys` are the **full** message key (`error.generic.title`), not the suffix,
> so multi-segment keys stay unambiguous.

### The JSON interchange shape

`pnpm i18n:export` emits the sidecar as JSON in the same shape, versioned:

```jsonc
{
  "version": 1,
  "generatedFrom": "src/lib/i18n/context.ts",
  "namespaces": {
    "nav": {
      "_context": { "description": "…", "screenshot": "workspace-nav", "maxLength": 24 },
      "keys": { "nav.projects": { "description": "…" } }
    }
  }
}
```

## Plurals

English has two plural forms. **Arabic has six** (`zero`/`one`/`two`/`few`/`many`/
`other`); Thai, Burmese and Patani Malay have one. A message keyed as a pair of
`*One`/`*Many` strings picked with `count === 1` at the call site therefore cannot be
made grammatical in Arabic by any translator — that is a ceiling in the catalog's
*shape*, not a quality problem in its content. Arabic ships, so counted messages are
keyed by CLDR plural category instead.

A count-governed key holds a record of category → string:

```ts
"search.resultCount": plural({ one: "{count} result", other: "{count} results" }),

// Where the counted noun agrees with something other than {count}, name it:
"editor.completion.failed": plural(
  { one: "{failed} of {total} cell failed.", other: "{failed} of {total} cells failed." },
  "total",
),
```

- **English supplies only the categories English uses** (`one`, `other`). `other` is
  required — it is where every fallback chain ends.
- **Call sites pass the count, never a branch**: `t("search.resultCount", { count: n })`.
  `translate()` selects the category with `Intl.PluralRules` for the *active locale*,
  which is why it takes a locale as well as a catalog.
- **Fallback**: locale's form for the selected category → locale's `other` → English's
  form for the category → English's `other`. A locale that filled only `other` renders
  for every count; a locale missing the category Arabic selected still renders real
  text. It never yields a raw key.
- `mfa` is overridden to a single form: `Intl.PluralRules` does not know the tag and
  would silently ask a Patani Malay translator for an unusable `one`.
- The lint (`catalogContextIssues()`) requires `other`, rejects an empty form, and
  requires every form to use the same placeholders — otherwise a rendered sentence
  silently loses its number in whichever category the count happens to hit.

### How a plural key reaches a translator

A plural key exports **one leaf per category the target locale needs**, named
`<key>#<category>` — six cells for Arabic, one for Thai. So `pnpm i18n:export` writes a
catalog and a notes file **per locale**, not one shared `en.catalog.json`, and each
note states the governing number, the locale's full category set, and which form that
cell is. The sidecar (`en.context.json`, schema v2) carries the same information in a
`plurals` section.

## Screenshots

A **surface** is one screen or dialog a translator can look at to understand a whole group
of strings at once. One screenshot covers dozens of keys, which is what makes this cheap
enough to keep complete — where it's worth capturing one at all. A namespace can declare
`surfaces: []` and pass; a screenshot is a force-multiplier for context prose, not a
substitute requirement of its own, and forcing one for every namespace regardless of whether
a single surface actually explains it just adds captures nobody will look at.

`src/lib/i18n/screenshots.ts` is the single source of truth for the declared set. Each entry
declares a stable `id` (also the PNG basename), a `title`, the `route` to reach it, and
`notes` on what a translator should look for — layout pressure, adjacent controls, whether
the string is a heading or a button.

Metadata references surfaces **by id, never by path**, so the images can move from the repo
to R2 without rewriting a single context entry.

Current surfaces (11): `workspace-nav` (sidebar/header nav), `cell-editor` (a focused
source/target row), `editor-table` (the full editing table), `confirm-dialog` and
`assign-modal` (two dialog patterns), `project-settings`, `error-state`, `audio-studio`,
`auth` (signed-out screens), `comments`, and `search`.

### Capturing them

`pnpm i18n:shots` (`scripts/i18n-shots.ts`) regenerates the full set. With the dev stack
running (`pnpm dev`), it signs in via the `/__dev/login` bypass, drives each declared
surface into the state its `notes` describe (importing a small sample file when the seed
project is empty, opening the lane-remove confirm, hitting an unreachable project for the
error surface), and overwrites `src/lib/i18n/screenshots/<id>.png`. Re-run it after visual
changes to a captured surface and commit the diff.

Every surface in the registry must have a driver in the script — a new registry entry
without one fails the run — and `context.test.ts` asserts each declared surface's PNG
exists in the repo, so registry, captures, and metadata cannot drift apart. (In sandboxed
agent environments where the pinned Playwright build lacks its browser, point the script at
a pre-installed one: `I18N_SHOTS_CHROMIUM_PATH=/opt/pw-browsers/chromium pnpm i18n:shots`.)

### Staleness

`existsSync` alone proves a PNG is *present*, not that it's *current* — a surface whose
driver quietly stopped matching its `notes` still has a file on disk. That's exactly what
happened to `project-settings`: its driver stops at `/project/:projectId/settings`, which now
renders an 8-card index, not the deep settings form the surface's `notes` describe. Nothing
caught it, because nothing compared the capture to what it claimed to show.

`src/lib/i18n/screenshot-manifest.ts` adds that comparison. `screenshots/manifest.json`
records, per surface, the sha256 of its PNG and the `route` it was captured against, at the
commit that capture was last verified current. `screenshotStaleness()` flags a mismatch as
one of:

- `hash-mismatch` — the PNG changed without a manifest update;
- `route-mismatch` — the surface's declared `route` changed without a recapture;
- `missing-manifest-entry` — never captured, or a known, deliberately-unattested gap;
- `missing-file` — the PNG itself is gone.

`project-settings` is exactly the last-but-one case today: it has no manifest entry, on
purpose, until its driver is fixed to reach the actual settings form. This only ever hashes
committed files and reads a committed JSON manifest — it never launches a browser, so it runs
in the normal `pnpm test` path, not just when `pnpm i18n:shots` is run against a live stack.

## No-duplicates

Two keys rendering the same English string is worth catching — it's a translator asked to
translate one sentence twice, in four locales, possibly two different ways. But English
being reused on purpose is also common and correct (two buttons that really do both say
"Cancel"), so the guard in `src/lib/i18n/namespaces/no-duplicates.test.ts` has to tell the two
apart, and only one of its two failure modes still blocks `pnpm test`.

- **Detection is a single pass, not a comparison matrix.** `groupsByEnglish()` builds one
  `Map` keyed by normalized English over the whole catalog — O(N) in the key count — and
  looks up collisions by that key. It never compares one namespace against another
  namespace directly; it widened to catalog-wide in AQU-511 wave 4 specifically because a
  namespace-vs-`common.*`-only comparison hid 48 duplicate groups where sibling namespaces
  were duplicating **each other**.
- **An unexcused duplicate warns; it no longer fails.** This used to be
  `expect(offenders).toEqual([])` — a hard failure that, in practice, forced a wave of
  English rewording purely to dodge collisions and had to be reverted (commit `6b2977f5f`):
  the guard was punishing already-correct, reused English to satisfy a linter. It's now
  `console.warn`, visible in test output but non-blocking. Reuse pressure is still real, it
  just can't force bad English anymore.
- **Justified reuse is a reviewed exceptions file**, `src/lib/i18n/namespaces/duplicate-exceptions.ts`
  (`DUPLICATE_EXCEPTIONS`), not an inline test fixture. Default is deny: an entry there is a
  deliberate act, and the reason must say why the two strings can't share a translation — a
  nominalized heading against an imperative button, a term of art against an everyday verb.
  It is never a reason that the English differs only in case (three of the four target
  locales have no letter case at all) — and, as of the fix below, never a reason that it
  differs only in a trailing ellipsis or colon either. `no-duplicates.test.ts` still hard-fails
  if an exception goes stale (names a key that no longer exists, or no longer collides) or
  lets one exception excuse an unrelated second collision — that part isn't about whether
  duplicate English exists, it's about whether the exceptions file itself can be trusted, so
  it stays enforced.
- **The `normalize()` fix.** The comparison used to strip a trailing ellipsis/colon
  (`/[…:]+$/`) before folding case, so an accessible name ("Search") and the visible field it
  names ("Search…") normalized to the same string and were flagged as duplicates — even
  though the mark is required on the placeholder and forbidden on the accessible name (a
  screen reader reads "…" aloud). `normalize()` now only trims and case-folds; it no longer
  strips the mark. Measured against this worktree's catalog, that dropped 20 of the 30
  exceptions `duplicate-exceptions.ts` used to need — they simply don't collide anymore — and
  they were removed rather than left stale, per the guard above.

## Adding a message key — the workflow

1. Add the key + English string to its namespace module under `src/lib/i18n/namespaces/`
   (which `messages/en.ts` spreads). If the string counts something, author it as
   `plural({ … })` — see **Plurals** below.
   Before adding it, check whether another namespace already renders that exact
   English: `no-duplicates.test.ts` scans the whole catalog in one pass (a `Map` keyed by
   normalized English, not a namespace-by-namespace comparison) and warns — without
   blocking `pnpm test` — when it finds an unexcused duplicate. Reuse the existing key or
   promote it to `common.*` where you can; see **No-duplicates**.
2. Add its context in `src/lib/i18n/context.ts` — or don't:
   - if the key has no `{placeholder}`, isn't count-governed, carries no `maxLength`, and
     isn't an accessibility name, the namespace `_context` already covers it. Nothing to add.
   - otherwise it needs an entry of its own; see **When a per-key entry is required, not
     just allowed** above.
3. Document any `{placeholder}` the string uses.
4. Run `pnpm i18n:check` (or just `pnpm test`).

**This is enforced, not advisory.** `catalogContextIssues()` runs in
`src/lib/i18n/context.test.ts`, so `pnpm test` — the CI gate — fails on an uncovered key
with a message naming exactly what's missing:

```
billing.upgrade: no context block for namespace "billing"
autopilot.newFeature.confirmDelete: needs its own context entry (uses a {placeholder}) —
  the namespace description alone isn't specific enough for it
```

The lint checks:

1. every key's namespace has a usable `_context.description`;
2. per-key descriptions are present and non-trivial when the entry exists;
3. a key in a context-requiring class — placeholder, plural, `maxLength`, or accessibility
   name — has an entry of its own; a key outside every class may have none at all;
4. no orphan entries — every context key and namespace maps to a real message key, and
   lives under the right namespace;
5. every referenced screenshot id is declared in `screenshots.ts`;
6. placeholders agree in both directions between the string and its context — across
   every plural form of a count-governed key;
7. every declared screenshot surface is actually referenced by the metadata.

A key can also be carried as a named, reviewed exception via `LEGACY_CONTEXT_GAPS` in
`context.ts` — see **When a per-key entry is required** above. It's the only escape hatch,
it's self-verifying, and it's empty today.

## Dogfooding: the catalog is an Aquilla project

Aquilla's own localization runs through Aquilla. The context metadata is what makes it
work — imported cells carry real context instead of a bare JSON path, so both human
translators and the translation agent see what each string does.

```
                pnpm i18n:export
en.ts + context.ts ─────────────▶ <loc>.catalog.json ─import──▶  Aquilla project
                                  en.context.json                (one cell per key, or
                                  <loc>.notes.json                per plural category,
                                                                  context attached)
                                                                        │
                                                                   translate
                                                                (human or agent,
                                                                 with QA / health /
                                                                 completion tooling)
                                                                        │
messages/<locale>.ts  ◀──pnpm i18n:import──  translated.json  ◀──export──┘
        │
        └─▶ CATALOGS → I18nProvider → LanguageSwitcher
```

```bash
pnpm i18n:check                                   # lint the sidecar
pnpm i18n:export [outDir]                         # default: i18n-export/ (gitignored)
pnpm i18n:import th i18n-export/th.translated.json # regenerates messages/th.ts
```

`i18n:export` writes `en.context.json` plus a `<locale>.catalog.json` and
`<locale>.notes.json` for every locale in `locales.ts`. The per-locale split exists for
plurals: the number of cells a counted key needs is a property of the target language.

`en.notes.json` is the piece that does the work: message key → a flattened, standalone
context note, which is what lands on the imported cell and what the translation agent
receives in its prompt.

```
Surface: UI-language switcher in settings and the app chrome, which changes the language
  of the interface itself (not the language being translated in the project). …
String: Accessible description of a single option in the language switcher, naming the
  language that option selects.
Screenshot: Project settings — src/lib/i18n/screenshots/project-settings.png
In this screenshot: Settings surface, including the language switcher. Labels are form
  labels above or beside their control and have more room than nav or button text.
Placeholder {language}: Name of the target UI language, already written in that language's
  own script (its endonym) — e.g. 'ไทย', 'العربية'. Do not translate the substituted value.
```

### Mechanics worth knowing

- **Path mapping.** `parsers/json-i18n.ts` addresses leaves by JSON path, and message keys
  contain dots, so `common.save` lives at `messages["common.save"]`. `catalogJsonPath()` /
  `messageKeyForPath()` are the only places that encoding is written down; keyed export
  matches cells to leaves by it, so they must agree with the parser exactly. A test asserts
  they do.
- **Partial catalogs are safe.** `exportJson` falls back to `cell.original` for an untouched
  cell, so a skipped string comes back as English. `parseTranslatedCatalog()` treats a value
  identical to the English source as **missing**, not translated — otherwise a locale would
  look complete when it isn't. Omitted keys fall back per key in `translate()`, so the app
  never renders a raw key.
- **Drifted keys don't break the import.** A key renamed in `en` after the file went to a
  translator is reported and skipped, not thrown on.
- **Generated locale modules.** `messages/<locale>.ts` are written by the CLI in
  base-catalog key order, so regenerating a locale produces a minimal diff. Don't hand-edit
  them.

## Related work

- **AQU-511** — the i18n framework this builds on.
- **AQU-510** — runtime error messages and AI prompt strings flow through the same pipeline
  once they're keyed.
