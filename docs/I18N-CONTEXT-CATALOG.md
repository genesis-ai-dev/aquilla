# Context-rich localization catalog standard (AQU-832)

The bottleneck in UI localization is never the string count — it's missing context.
"Save" translates differently depending on whether it's a button or a menu item, what it
saves, and how much room it has. A catalog that is just `key → English string` forces every
translator (human or AI) to guess, and guesses are where localization bugs come from.

So **the catalog carries its own context**. Every message key resolves to a description of
what the string does, the surface it lives on, a screenshot of that surface, and the
semantics of every `{placeholder}`. Coverage is enforced by a test, so it can't rot.

This builds on the AQU-511 framework (typed `en` catalog, `translate()` fallback,
`I18nProvider`, `LanguageSwitcher`). AQU-511 built the machinery; this standard is about
**filling** the catalogs fast and repeatably.

## Where things live

| Path | What it is |
| --- | --- |
| `src/lib/i18n/messages/en.ts` | Base catalog — the source of truth for **keys and English strings** |
| `src/lib/i18n/plurals.ts` | CLDR plural categories: the `plural()` authoring shape, selection, fallback |
| `src/lib/i18n/context.ts` | **Context sidecar** — the authored metadata + resolution + lint |
| `src/lib/i18n/screenshots.ts` | Registry of screenshot **surfaces** (id, route, viewing notes) |
| `src/lib/i18n/screenshots/<id>.png` | The captured surface images |
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
refine; they don't gate. Resolution layers the key entry over the namespace entry field by
field, and merges `placeholders`.

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
enough to keep complete.

`src/lib/i18n/screenshots.ts` is the single source of truth for the set. Each entry declares
a stable `id` (also the PNG basename), a `title`, the `route` to reach it, and `notes` on
what a translator should look for — layout pressure, adjacent controls, whether the string
is a heading or a button.

Metadata references surfaces **by id, never by path**, so the images can move from the repo
to R2 without rewriting a single context entry.

Current surfaces: `workspace-nav`, `cell-editor`, `confirm-dialog`, `project-settings`,
`error-state` — nav, editor, dialogs, settings, and errors respectively.

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

## Adding a message key — the workflow

1. Add the key + English string to its namespace module under `src/lib/i18n/namespaces/`
   (which `messages/en.ts` spreads). If the string counts something, author it as
   `plural({ … })` — see **Plurals** below.
   Before adding it, check whether another namespace already renders that exact
   English: `no-duplicates.test.ts` compares every namespace against every other, and
   the fix is to reuse the existing key or promote it to `common.*`, not to reword.
2. Add its context in `src/lib/i18n/context.ts`:
   - if its namespace already has a `_context` that genuinely describes the surface, you're
     done — the key inherits it;
   - otherwise add a namespace `_context`, or a per-key entry when the surface note isn't
     specific enough.
3. Document any `{placeholder}` the string uses.
4. Run `pnpm i18n:check` (or just `pnpm test`).

**This is enforced, not advisory.** `catalogContextIssues()` runs in
`src/lib/i18n/context.test.ts`, so `pnpm test` — the CI gate — fails on an uncovered key
with a message naming exactly what's missing:

```
billing.upgrade: no context block for namespace "billing"
```

The lint checks:

1. every key's namespace has a usable `_context.description`;
2. per-key descriptions are present and non-trivial when the entry exists;
3. no orphan entries — every context key and namespace maps to a real message key, and
   lives under the right namespace;
4. every referenced screenshot id is declared in `screenshots.ts`;
5. placeholders agree in both directions between the string and its context — across
   every plural form of a count-governed key;
6. every declared screenshot surface is actually referenced by the metadata.

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
