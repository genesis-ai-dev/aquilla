# Public-release pipeline

Mirrors this private repo to a **public, AGPL-3.0 open-source repo** for trust
and transparency — with secrets, production/customer data, third-party
copyrighted media, partner-proprietary code, and other-product branding scrubbed
out.

This whole directory is **excluded from the public tree** (it names real
identifiers as scrub targets).

## Model

The public repo is a **separate git repo with no shared history** ("squashed
fork"). A scheduled job snapshots private `main`, scrubs it, and commits the
result into the public mirror. Private commit history never crosses over, so a
secret buried in an old private commit can never leak.

The core safety property: the tree is built with **`git archive` (tracked files
only)**. Untracked files — `.env`, `.dev.vars`, worktree copies — are
structurally incapable of entering the public tree. Everything else is defense
in depth.

## Commands

```bash
# 1. Build the scrubbed tree from a ref (default: main) into .public-build/
pnpm tsx scripts/public-release/build-public-tree.ts --ref main --out .public-build

# 2. Safety gate — asserts no secret/forbidden path/forbidden string survived
pnpm tsx scripts/public-release/verify-public-tree.ts --dir .public-build

# 3. Prove it compiles/tests in isolation (do this before first publish)
cd .public-build && pnpm i && pnpm build && pnpm test

# 4. Publish into the public mirror clone (dry run without --confirm)
pnpm tsx scripts/public-release/publish.ts --staging .public-build --public ../aquilla-public
pnpm tsx scripts/public-release/publish.ts --staging .public-build --public ../aquilla-public --confirm --push
```

## Pipeline stages (all driven by `config.ts`)

1. **`git archive`** the ref → staging (tracked files only).
2. **EXCLUDE_PATHS** — remove seed prod-metadata, kokoro copyrighted audio,
   other-brand assets, real Modal model code, one-off importers, this tooling.
3. **STRING_REPLACEMENTS** — genericize CF account id, Hyperdrive ids, the
   PostHog key, admin/contact emails, internal git hosts, Modal endpoints.
4. **GENERATED_FILES** — `LICENSE` (AGPL-3.0), `NOTICE.md`, a regenerated brand
   registry (aquilla + an **Acme** example brand), generic Modal stubs, and
   synthetic example seed files.
5. **CODEMODS** — narrow the `BrandId` union to the public brands.
6. **Safety gate** (`verify-public-tree.ts`) — FORBIDDEN_PATTERNS /
   FORBIDDEN_PATHS must both be empty, or publish is blocked.

`config.ts` is the single source of truth — review it to see exactly what the
scrub does. It is drift-resistant where it can be (the brand registry is
regenerated, not patched), and fails loud where it can't (the gate blocks
publish on any surprise).

## Pending: Biblica (blocks first publish by design)

The Biblica partner integration cannot be cleanly file-deleted, because it is
coupled into the app: its code spans `src/lib/biblica/**`,
`src/lib/parsers/biblica*.ts`, and `src/lib/export/exporters/idml.{reach4life,
treasure-hunt,rejoin}.*`, and it is woven into `src/components/ImportDialog.tsx`
in ~23 places (imports, the `Screen` union, the `BiblicaPanel` component, a
landing card, render branches, and the `importExport.biblica.*` i18n namespace).

Deleting those files would produce a non-compiling public tree. So Biblica stays
in the tree today, and the `FORBIDDEN_PATTERNS` "Biblica" rule intentionally
**blocks publish** until it is handled one of two ways:

- **(A) Seam refactor (recommended).** Move the Biblica code into a
  `src/lib/partner-integrations/biblica/` module and make ImportDialog consume
  import sources from a registry. Then the scrub excludes the folder cleanly and
  drift never breaks it. This is real work on the live app and must keep the
  Biblica feature working for current users.
- **(B) Hand-maintained codemod.** A scrub-time transform that excises Biblica
  from ImportDialog + i18n each run. Brittle across ImportDialog changes; the
  safety gate catches breakage but the scheduled sync then needs a human.

Until (A) or (B) lands, first publish is correctly blocked.

## Scheduling

Once the gate passes and the public tree builds green, run steps 1→4 on a
schedule (cron/CI) against `main`. Keep the `--confirm --push` step in a job that
a human owns, or behind a protected CI environment — publishing is irreversible.
