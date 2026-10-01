# Partner integrations

How publisher-specific code is kept separable from the app, so the open-source
copy of this repo can be produced by *deleting* it. AQU-1286.

This is hygiene, not hiding. The code stays in the private repo and partners keep
their access. The point is to not ship someone else's copyright under an open
license, and to not have to wonder whether we did.

## The convention

**Any folder named `partner-integrations`, at any depth, is partner-owned.**

```
src/partner-integrations/<partner>/        # app code: parsers, note rules, panel, fixtures
  register.ts                              # the ONLY entry point generic code sees
e2e/specs/partner-integrations/<partner>/  # that partner's e2e specs
```

Two rules follow, and they are the whole contract:

1. **Nothing outside a `partner-integrations` folder may import from inside one.**
   Generic code reaches partner code only through the registry
   (`src/lib/partners/registry.ts`). The reverse is fine: partner code imports
   freely from `src/lib`, `src/components`, and the shared packages.
2. **Deleting the folders must leave the app compiling, building, and running**,
   with that partner's options simply absent — no error toast, no console
   exception, no empty panel. `pnpm build` and `pnpm test` are the gate.

Rule 1 is what makes rule 2 achievable, and rule 2 is what the filter script
checks.

### Why a glob and not an import list

`registry.ts` discovers partners with

```ts
import.meta.glob<{ default: PartnerIntegration }>(
  "/src/partner-integrations/*/register.ts",
  { eager: true },
)
```

A Vite glob that matches nothing is an empty object. A static
`import "…/biblica/register"` would fail `tsc -b` the moment the folder went
away — which is precisely the coupling the seam exists to remove. Do not replace
the glob with a hand-maintained list.

The glob is **eager** because some seams have to be synchronous: the IDML
completion path normalizes html inside a sync function and cannot await a
registry. So keep `register.ts` small — descriptors and sync hooks only.
Everything heavy hangs off a thunk on the descriptor and stays code-split:

* `importScreen.panel` — `() => import("./BiblicaPanel")`
* `PartnerImportEdition.parse` — pulls the partner's parser in on demand

## Registering an integration

Add `src/partner-integrations/<partner>/register.ts` with a default export of
`PartnerIntegration` (`src/lib/partners/types.ts`). Every field is optional
except `id`, so an integration contributes only the surfaces it needs:

| Field | What it adds |
| --- | --- |
| `importScreen` | A tile on the import dialog's landing screen plus the lazily-loaded panel behind it. The dialog routes to it generically — there is no per-partner `Screen` id. |
| `idmlTargetHtmlNormalizers` | Synchronous normalizations applied to a translated IDML cell before validation, for typesetting a publisher's templates carry that is not text (see the apostrophe glue, AQU-1174). |

Editions are deliberately **not** in the registry. Which templates a publisher
ships, and which one a given package is, is that partner's own business: its
panel picks a `PartnerImportEdition` and hands the descriptor to
`importPartnerNotes` in `src/lib/import.ts`. Generic code never enumerates a
partner's titles.

A `PartnerImportEdition` carries the `builtin:*` profile id stamped onto imported
files, the sidebar corpus marker, a `parse` thunk, and the message to show when a
package parses to nothing (almost always the wrong edition was chosen).

## Producing the public copy

```bash
npx tsx scripts/make-public-copy.ts --out ../aquilla-public
```

It snapshots the tracked files of the **current state** (the history is ~1.7 GB
and carries partner code in it, so it is not exported), skips every
`partner-integrations` path, and then scans the result for partner copyright
notices. A hit fails the run.

Verify rule 2 the same way CI would:

```bash
rm -rf src/partner-integrations e2e/specs/partner-integrations
pnpm build && pnpm test
```

## Known gaps (not yet carved out)

The folder convention removes every *module* dependency on partner code. It does
not yet remove every *mention* of a partner name from the generic tree. These are
string- and data-level, so they do not break the stripped build, and each needs
its own decision rather than a move:

* **i18n catalogs** — `src/lib/i18n/namespaces/importExport.ts` and the seven
  locale catalogs hold the partner tile's UI copy, translated. Moving the keys
  into the partner folder means either giving up those translations or teaching
  the catalog pipeline about partner-contributed namespaces.
* **`metadata.biblica` cell bucket** — read by `src/lib/import/milestones.ts`,
  `src/lib/milestone-navigation.ts` and `src/lib/idml/style-catalog.ts`. This is a
  persisted shape on already-imported cells, so renaming it is a data migration.
* **`sync-worker/src/events/corpus-marker.ts`** — a server-side backfill map from
  `builtin:biblica-*` profile ids to sidebar folders, for files imported before
  the marker was stored. Historical data recovery; the Workers are outside the
  SPA's module graph and the convention.
* **`packages/idml-roundtrip` corpus** — a `biblica-profile.idml` conformance
  fixture and its generator. Synthetic, named after the template shape it models.

`scripts/make-public-copy.ts` enforces the part that matters — no partner
copyright notices — rather than pretending the name-level scrub is done.
