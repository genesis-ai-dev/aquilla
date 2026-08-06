# Aquilla system specification

Aquilla is a browser-first collaborative Bible-translation workspace. Translators
work in aligned source and target cells with terminology, rich text, validation,
comments, audio/oral translation, back-translation, and AI-assisted drafting.
USFM/Paratext import-export fidelity is a product requirement.

The sibling `aquilla-specs` repository is the source of truth for intended product
behavior. This document maps that behavior onto the currently deployed system so
old VS Code-extension and D1-era notes are not mistaken for live architecture.

## Current system boundaries

- The React/Vite SPA is the primary product surface. The optional Tauri shell uses
  the same application code; the retired VS Code extension is not the runtime.
- The in-repo identity Worker owns identity, organizations, projects, membership,
  permissions, sync-token minting, and chat routes.
- The in-repo sync Worker owns event acceptance, the append-only event log,
  projections, reads, transient project realtime state, and blob endpoints.
- Neon Postgres through Hyperdrive is the durable database. The client keeps an
  IndexedDB outbox for offline-safe delivery.
- R2 stores blobs only. It never stores the event log or cell/file projections.
- A ProjectSync Durable Object owns transient presence, focus locks, and broadcast
  relay. It holds no durable application state.

See [Sync architecture](SYNC.md) for the producer/consumer contract.

## Core journeys

1. A user authenticates and opens an organization project they are permitted to
   access.
2. The SPA loads file and cell projections from the sync Worker.
3. Edits are placed in the local outbox, submitted as idempotent events, persisted
   to the event log, and projected into the current read model.
4. ProjectSync relays accepted changes to connected collaborators and manages
   transient presence/focus-lock feedback.
5. Import and export preserve the applicable source representations and artifacts;
   format-specific behavior is covered through preparation and commit.
6. AI actions stage reviewable changes rather than bypassing the same project,
   permission, event, and artifact boundaries.

## Load-bearing invariants

- Environment, tenant, project, file, and cell scope must never be inferred from a
  convenient fallback.
- Server-side permissions are authoritative; UI visibility is not authorization.
- Event submission is idempotent and conflicts are explicit.
- Projections are derived from the accepted event log and are never reconstructed
  from R2.
- Import changes cover original text/bytes, converted sources, containers, event
  emission/reconciliation, and source-artifact upload as one contract.
- A transient read failure is not an empty project and must not trigger data
  deletion or branch reset.
- Production and development use explicit isolated Worker, route, Neon,
  and R2 bindings.

## Deployment contract

[Deployment environments](DEPLOYMENT-ENVIRONMENTS.md) is the canonical executable
matrix. It defines the only supported branch/profile/hostname combinations and the
commands that verify them. The
[Workers Builds runbook](runbooks/cloudflare-workers-builds.md) contains the detailed
operating procedures.

## Documentation precedence

For intended product behavior, use `aquilla-specs`. For exact deployed resource
names and commands, use this repository's current docs and configuration. Dated
audits, rollout notes, and design folders are historical evidence; they do not
override the current docs index in [docs/README.md](README.md).
