# 0001 — Parser version stamps and the re-import rule

*Decided before 2026-11; recorded 2026-11-05 (AQU-2387).*

## Context

A file in a project is the output of one importer run, and importers keep
changing: a parser learns a construct, a profile starts splitting cells
differently, a partner recipe is added. Months later someone re-imports the
same upstream file into the same project and expects the same shape — not
whatever today's default importer would produce.

The file row therefore has to remember which importer made it, and that memory
has to survive the importer being improved.

## Decision

Every imported file is stamped with `parserVersion`, written as
`<profileId>@<profileVersion>` — see the writes in `src/lib/import.ts` and the
stamp assembled in `src/lib/import/import-service.ts`, over the normalized
manifest shape `src/lib/import/normalized-manifest.ts::NormalizedImportFile`.

- **`profileId` identifies the importer** (`builtin:usx-to-usfm`,
  `agentic:<recipe>`, a partner profile). It is a stable contract: once used,
  an id never comes to mean a different importer.
- **`profileVersion` identifies that importer's output shape.** When the same
  importer starts producing different cells, the version is bumped — IDML sits
  at `2` today, everything else at `1`.
- **Re-import reopens the importer the file was made with, not the default.**
  The file's `importProfile` — the part before `@`, on
  `src/lib/parsers/types.ts::FileReference` — is what the workspace passes to
  the import dialog as the re-import target (`src/components/ImportDialog.tsx`),
  which re-enters that profile rather than re-detecting one from the bytes.
- **The profile id is also how a file is attributed to a partner**, via
  `src/lib/partners/registry.ts::partnerIdForImportProfile` — so an id is not
  a free-form label; the registry reads it.

## Consequences

- Changing an importer's output is a version bump, never an id rename: a rename
  loses every existing file's route back to its importer, silently, and the
  next re-import quietly produces a different shape.
- Stamps are historical facts. An existing file keeps the stamp it was imported
  with, so the same project can hold files from several versions of one
  profile, and anything reading a stamp has to tolerate old versions.
- A new partner or recipe importer is unusable for re-import until it stamps a
  profile id the registry knows.

## Not covered yet

- Nothing re-parses a file when `profileVersion` moves. There is no migration
  from `profile@1` to `profile@2`; a user re-imports to pick up the new shape,
  and no code warns that their file is on an older version.
- The stamp records *which* importer ran, not the settings it ran with — those
  live in the file's import manifest (`src/lib/import/normalized-manifest.ts::summarizeNormalizedImport`),
  which is a summary, not a replayable input.
