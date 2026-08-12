# All-surfaces UI localization: th / my / mfa / ar (AQU-511)

Ship a localized Aquilla UI for Biblica's late-August rollout. The i18n machinery already
exists; the content does not. This spec covers extracting every user-facing string in the
app into the context-rich catalog, filling four locales through Aquilla's own translation
pipeline, and making Arabic's right-to-left layout actually correct.

## Where we're starting from

Merged and working:

- **AQU-511** (`0d2141d22`) — `src/lib/i18n/`: locale registry, `I18nProvider` (mounted at
  `src/main.tsx:46`), typed `t()`, per-key English fallback, `<html lang>`/`<html dir>`
  mirroring, `LanguageSwitcher`, localStorage + `navigator.language` detection.
- **AQU-832** (PR #311) — the context standard: `context.ts` sidecar, `screenshots.ts`
  surface registry, `catalog-export.ts` interchange, `pnpm i18n:check|export|import|shots`,
  coverage enforced by `context.test.ts` on the `pnpm test` CI gate.

Not started, and the whole of the work:

| | |
| --- | --- |
| Keys in `messages/en.ts` | 13, across 4 namespaces |
| `t()` calls in components | 0 |
| Locales registered / filled | 5 registered (`en th my mfa ar`) / 4 empty |
| `LanguageSwitcher` mounted in the app | nowhere — it exists only in its own tests |
| User-facing strings in `src/**/*.tsx` (non-test) | ~1,515, of which ~220 are marketing |

So AQU-511's only satisfied acceptance criterion is "untranslated keys fall back to English",
and it holds trivially because nothing is extracted.

## Scope

**In:** every string rendered by the SPA — nav, editor, dialogs, project setup, import, org,
admin, settings, terminology, rules, agent, audio, comments, search, brief, credits,
onboarding, metrics, chat. Four target locales, all agent-drafted. `my` and `mfa` are then
reviewed in-app by the Biblica teams and `th` is read by the consultant; `ar` ships
agent-drafted and unreviewed, since there is no Arabic team yet — its value in this release is
the RTL layout audit, which does not depend on wording quality.

**Out, deliberately:**

- **Marketing pages.** `homepage.html`, `bible-translation.html`, `beta.html`, the case
  studies and `PrivacyPolicy` are separate vite inputs with their own React entries; they are
  prerendered by `scripts/prerender-marketing.ts` and must stay DOM-free-safe. They never
  mount `I18nProvider`, and calling `t()` there would break prerendering. English only.
- **Strings originating in `src/lib/**`** — thrown errors, agent prompt text. `t()` is a
  hook and cannot be called outside React. That is **AQU-510**. The rule for this release:
  key the text your *component* renders; where a component renders a message handed up from
  `lib`, leave that payload English and do not invent a key for it.
- **Per-user server-side locale persistence.** localStorage via `store.ts` is enough; a
  translator on a second machine re-picks their language once.

## Architecture

### The namespace is the unit of ownership

One namespace = one area of the app = one screenshot surface = one subagent = a set of files
no other agent touches. Derived from the real `src/components/*` structure:

| Namespace | Owns | Surface(s) |
| --- | --- | --- |
| `common` `nav` `error` `language` | existing 13 keys + preallocated shared strings | already captured |
| `auth` | `Login`, `ResetPassword`, `AccessLinkPage` | `auth` |
| `editor` | `EditorTable`, `cell/`, `footnotes/`, `ChapterNavigator`, `timeline/` | `cell-editor` ✓, `editor-table` |
| `dialog` | `ConfirmActionDialog`, `AssignModal` | `confirm-dialog` ✓ |
| `project` | `ProjectCreateDialog`, `ProjectSettings/`, `Dashboard` | `project-settings` ✓, `project-create` |
| `import` | `ImportDialog`, `import/`, `git-import/`, `dcs/`, `linked/` | `import-dialog`, `dcs-catalog` |
| `org` | `org/`, `MembersPage` | `org-home`, `members` |
| `admin` | `admin/`, `AdminConsole` | `admin-console` |
| `settings` | `Settings`, `Preferences`, `settings/` | `preferences`, `api-tokens` |
| `terminology` | `TerminologyPage`, `AddConceptDialog`, `CandidateTermsPanel` | `terminology` |
| `rules` | `RuleCreateDialog`, `RuleEditor`, `BuiltinChecksList`, `CheckFindingsDrawer` | `rules` |
| `agent` | `agent/`, `AgentDockPanel`, `LivingMemoryPage`, `ApproveChangeset/` | `agent-dock`, `changeset-approval` |
| `audio` `comments` `search` `brief` `credits` `onboarding` `metrics` `chat` | their `src/components/<dir>/` | one surface each |

The exact file→namespace partition is computed once in Phase 0 and handed to agents as an
explicit file list, so ownership is data, not judgement.

### Four registries split for conflict-free parallelism

Today four files are single points of contention. Twenty-plus agents appending to any of them
is a guaranteed conflict pile, and at ~1,300 keys they would blow well past the repo's
~500-line target. Each is split into per-namespace modules behind a barrel that preserves
exactly what today's code derives:

| Today | Becomes |
| --- | --- |
| `messages/en.ts` | `messages/en/<ns>.ts` + `messages/en/index.ts` |
| `context.ts` | `context/<ns>.ts` + `context/index.ts` (keeps `catalogContextIssues()`) |
| `screenshots.ts` `SCREENSHOTS` | `screenshots/<ns>.ts` + `screenshots/index.ts` |
| `scripts/i18n-shots.ts` `DRIVERS` | `scripts/i18n-shots/<ns>.ts` + a merged driver map |

```ts
// messages/en/index.ts
export const en = { ...common, ...nav, ...editor, /* … */ } as const
export type MessageKey = keyof typeof en   // stays a precise literal union
```

Each namespace module is `as const`, so the spread preserves literal key types and
`MessageKey` narrows exactly as it does now. `SCREENSHOTS` merges the same way and keeps its
`as const satisfies readonly ScreenshotSurface[]`, so `ScreenshotId` stays a literal union
and `DRIVERS: Record<ScreenshotId, …>` keeps *compile-time* enforcement that every declared
surface has a driver. `CATALOG_CONTEXT` merges into the same shape, so the existing lint and
its test need no changes.

Two deliberate asymmetries:

- **Generated locale catalogs stay single-file.** `messages/my.ts` will be ~1,300 lines, but
  it is machine-written and marked do-not-hand-edit; splitting it would mean rewriting
  `i18n:import`'s writer for no human benefit.
- **`common.*` is preallocated before the fan-out**, from a frequency scan of the codebase.
  `Cancel` appears 21 times, `Loading…` 11. Each shared string gets exactly one key, and
  namespace agents are forbidden from re-keying anything on that list — otherwise translators
  pay for the same word twenty times over.

### The subagent contract

Each namespace agent receives its namespace, its explicit file list, its surface id(s), and
the frozen `common.*` list. It must:

1. Add keys + English strings to `messages/en/<ns>.ts`, namespaced `<ns>.thing`.
2. Add context to `context/<ns>.ts`: a namespace `_context` with `description`, `screenshot`,
   and `maxLength` only where layout genuinely constrains; per-key entries only where the
   namespace note is insufficient; **every `{placeholder}` documented** (the lint checks this
   in both directions).
3. Declare its surface(s) in `screenshots/<ns>.ts` and write the matching Playwright driver
   in `scripts/i18n-shots/<ns>.ts`.
4. Replace literals with `t()` in its own files only.
5. Verify: `pnpm i18n:check` plus the existing test files for the components it touched.

It must not touch another namespace's files, the marketing pages, the generated locale
catalogs, or `src/lib/**` strings. It reports back: key count, files touched, and any string
it deliberately left with the reason.

Agents share one working tree rather than getting worktrees — the partition makes their file
sets disjoint, so worktrees would add setup cost and merge overhead for no isolation benefit.
The full `tsc -b` and `pnpm test` gate runs once serially in the tail, not 20× concurrently.

### Translation loop

Locale registration needs no change: `th my mfa ar` are already in `LOCALES`. Per locale:

```
pnpm i18n:export                    # → en.catalog.json, en.context.json, en.notes.json
  → import into a dedicated Aquilla project (one per locale, so review access scopes
    cleanly per team via member-scopes — the Burmese team never sees Arabic)
  → translation agent drafts, with QA / health / completion tooling flagging issues
  → the Burmese and Patani Malay teams review and correct in-app; the consultant
    validates quality by reading the Thai catalog
  → export → pnpm i18n:import <locale> <file> → messages/<locale>.ts
```

The review pass is doing double duty: it is also the teams' first real use of the web app
they are being migrated onto.

### Making the switcher reachable

`LanguageSwitcher` is mounted in `AppShell` (app chrome) and on the settings page. This is
not a new decision — the existing context metadata already describes the switcher as living
"in settings and the app chrome", and the `project-settings` surface notes say that shot
includes it.

### RTL audit

Once `ar` is filled, `pnpm i18n:shots` gains a locale parameter (seed
`localStorage["aquilla-locale"]` before load) and captures every surface in Arabic. Then one
agent per surface compares against the LTR shot and fixes: physical Tailwind spacing
(`pl-`/`pr-`/`ml-`/`mr-` → logical `ps-`/`pe-`/`ms-`/`me-`), directional icons
(`ChevronLeft`/`Right`), `text-align`, and `flex-direction`. Fixes are per-component and
therefore still disjoint, so this fans out by surface — but it is visual work, and it is the
least parallelizable part of the project.

## Verification

The context lint already gates coverage on `pnpm test`, and it fails naming exactly what is
missing (`billing.upgrade: no context block for namespace "billing"`). On top of it:

- **A duplicate-string test.** Fails if a namespace catalog defines a string that already
  exists in `common.*`. This encodes *why* it matters — every duplicate is a string a human
  translator pays for twice — so it cannot be quietly reintroduced.
- **A surface-coverage test**, extending `context.test.ts`: every namespace resolves to a
  declared surface whose PNG exists, and every surface is referenced by metadata.
- **E2E stays green by construction.** No spec touches `aquilla-locale`, and Playwright's
  `navigator.language` is `en-US`, which `normalizeLocale` maps to `en` — so existing
  English-text assertions are unaffected. One new spec switches to `my` and asserts the nav
  chrome is non-English with no raw keys visible.
- **RTL evidence is screenshots, not unit tests.** Visual mirroring cannot be honestly
  asserted in vitest; the per-surface Arabic captures are the artifact, reviewed and
  committed.

## Sequencing

Ordered so a slip degrades gracefully — the translator-facing surfaces land and ship first,
and admin surfaces falling back to English is survivable for the rollout.

| Phase | Work | Parallel? |
| --- | --- | --- |
| 0 | Four-way registry split; file→namespace partition; `common.*` preallocation; mount `LanguageSwitcher`; fix the stale capture-path comment in `screenshots.ts` | serial |
| 1 | Extract the daily path: `common` `nav` `error` `dialog` `editor` `comments` `auth` `search` `audio` | fan-out |
| 2 | Capture Phase-1 surfaces, lint, export, translate `th`/`my`/`mfa`, import, verify — **shippable for Biblica** | serial |
| 3 | Extract the rest: `project` `import` `org` `admin` `settings` `terminology` `rules` `agent` `brief` `credits` `onboarding` `metrics` `chat` | fan-out |
| 4 | `ar` catalog, Arabic captures, per-surface RTL fixes | mixed |
| 5 | New e2e spec, docs update, close AQU-511, update AQU-832 / AQU-510 | serial |

## Risks

- **The gate is team review capacity, not extraction.** Agents can draft four locales in
  hours; the Burmese and Patani Malay reviewers cannot. Phase 2 must reach them early, and
  the rollout should not assume reviewed strings for surfaces they have not seen.
- **The all-surfaces scope is larger than the deadline needs.** The phase order is the
  mitigation: Phase 2 is independently shippable, so Phases 3–4 can land after late August
  without the rollout waiting on them.
- **The RTL audit competes with the deadline.** It is sequenced after `my`/`mfa` are verified
  for exactly this reason. Arabic is a near-future need, not an August one.
- **The context lint makes partial work unmergeable.** A key without context fails
  `pnpm test`. That is the intended design, but it means each namespace agent's output must be
  complete — keys, context, surface, and driver — or not merged at all.
- **Untranslated-but-extracted is a real intermediate state.** Between extraction and import,
  every extracted string falls back to English. That is correct behaviour, not a regression,
  and it means extraction can merge safely ahead of translation.
