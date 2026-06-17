# Translation Brief — open traces (post-swarm)

Deferred items from the adversarial review panel that are acceptable for v1 but
worth a follow-up.

## TRACE-1 (MAJOR, deferred): completion path uses a stale brief L1 until refetch

`ProjectWorkspace` reads `project?.translationBrief?.l1Summary` via its own
`useProject` instance, which carries a separate `useProjectSettings` instance
from the one `LivingMemoryPage` saves through. After a maintainer edits the brief
in Living Memory, inline-completion prompts in the workspace keep the previous L1
until `useProject` re-fetches (on mount / reconnect / navigation).

- **Why acceptable for v1:** the brief is a rarely-edited settings document; a
  navigate-away-and-back (or reconnect) refreshes it. No data loss — only a lag
  in which L1 the completion injects.
- **Fix when needed:** same class as the file-rename overlay fix
  (`project_file_rename_server_synced`) — surface brief changes through an
  optimistic overlay / shared settings source so the workspace picks them up
  without a refetch. See `src/hooks/useProject.ts` `overlaySettings`.

## Addressed during integration (not deferred)

- Races finding 2 (stale-closure clobber on regenerate): FIXED — `handleGenerate`
  now gates on `canEdit` and locks the section (`busy`) during generation so a
  concurrent open-and-save cannot clobber the re-persisted brief.
- Regressions: budget-test coverage gap FIXED — added a worst-case multi-line
  `briefSummary` case to the agent ≤250-line budget test.
- Contracts: maintainer gating, data-shape (l1Summary/l2Markdown/parameters),
  sibling-key merge safety, L1 length cap, and LLM-unavailable degradation all
  verified correct by the panel.
