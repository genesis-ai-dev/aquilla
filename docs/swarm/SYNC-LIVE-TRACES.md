# SWARM TRACES — live sync

## BLOCKERS (surface to user)

## Deferred (forbidden path / next wave)
- [OPEN] (SL-1) Move remote-draft + lock-holder presence consumption from ProjectWorkspace props into
  `EditorRow` via `useCellPresence(store, cellId)` — EditorTable.tsx is owned by perf-burst WS-1146 this wave.
- [OPEN] (SL-2) Remove `usePresencePeers` from the ProjectWorkspace root once PeerPresence subscribes itself
  (ProjectWorkspace.tsx is perf-burst wave 2/3 territory).
- [OPEN] (SL-3) server_seq has holes (rejected events, unused allocations), so strict "+1" gap detection is not
  possible; live frames use a per-cell seq guard and the `?since=` delta stays the reconcile path (reconnect,
  visibility, idle timer). Revisit if a dense per-project sequence is introduced.

## Quality / polish

## [DONE]
