# Code Health Candidates

Opportunities spotted during `/code-health` runs that exceeded that run's budget or scope.
Prune entries once a later run completes them.

## 2026-08-10 — dead-code deletion run

Branch: `chore/code-health-2026-08-10` (session branch `claude/bold-davinci-b51z35`).
Theme: dead code deletion. Landed: 5 zero-importer files removed (336 lines) — see commit
`chore(code-health): delete confirmed-dead source modules`.

Additional high-confidence dead-code candidates found but left out to stay inside this run's
~300-line/~8-file budget:

- **`src/lib/sync/sync-debug.ts`** (125 lines) — a "compatibility surface for older imports"
  of a pre-AD-1 Yjs-provider debug logger (`isSyncDebugEnabled`, `attachSyncDebug`,
  `SyncDebugAttach`, `logEffectShortCircuit`). `grep -rn` across the full repo (incl. all
  brand paths) shows zero call sites outside its own definition. Proof-of-preservation
  needed: same as this run's deletions — full-repo grep for each export name, then green
  `pnpm lint && pnpm build && pnpm test`.
- **`src/context/EditorScrollContext.tsx`** lines ~20-23 and ~47-49 — unused
  `@deprecated`-tagged `pendingGroup`/`pendingSection` fields. The sole consumer
  (`ScrollToGroupHandler` in `ProjectWorkspace.tsx`) only reads `.pending`. ~7 lines.
  Needs care: it's a partial-file edit (removing interface fields + their assignment sites),
  not a whole-file delete, so verify no other file destructures those two fields before
  cutting.
- **`src/components/ExamplePanel.tsx`** lines ~12-15 (unused, `@deprecated`-tagged
  `expanded`/`onExpandedChange` props) + the two attributes passed at the only call site in
  `src/components/EditorTable.tsx` (~lines 5542-5543). ~6 lines across 2 files. `expanded`
  state itself (`examplesExpanded`) stays live — only the passthrough props are dead.

None of the three above were independently re-verified by a human reviewer in this run; they
carry the same grep-based proof standard as the landed deletions but weren't re-checked
immediately before writing this entry, so re-verify with fresh greps before cutting.

## Environment note — `pnpm test:e2e:smoke` cannot complete in this sandbox

Not a code-health candidate (no source change would fix it), but worth recording since it
blocked this run's push via the pre-push hook: in the `claude-code-on-web` sandbox used for
this run, `pnpm test:e2e:smoke` cannot reliably finish. Docker's daemon isn't running (only
the CLI is present), so `scripts/e2e-up.ts` falls back to local `psql`, which additionally
needed a one-time `root`/`aquilla` Postgres role to exist. Even with that fixed, the sharded
run (3 concurrent Wrangler `workerd` local-dev stacks) intermittently crashes one or more
`workerd` processes under sustained request load partway through the suite (`bulk import
failed: fetch failed after 3 attempts` cascading through the rest of that shard's tests) —
reproduced identically on a completely clean, unmodified checkout of `origin/dev` with zero
code changes, so it is an environment/infra limitation of this specific sandbox, not a code
regression. `pnpm lint`, `pnpm build`, `pnpm test`, and `sync-worker`'s own `npm test` all
run clean in this same sandbox — only the multi-stack Playwright/Wrangler harness is
affected. Whoever picks this up next should either run the push from an environment with a
working Docker daemon, or treat this as a sandbox-provisioning gap to raise with whoever
configures `claude-code-on-web` environments for this repo.
