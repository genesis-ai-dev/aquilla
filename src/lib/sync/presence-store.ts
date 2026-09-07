import { useSyncExternalStore } from "react"
import { peerColor } from "@/hooks/useFileSync"

export interface TargetPresenceSelection {
  side: "target"
  anchor: number
  head: number
  /**
   * Ephemeral plain-text snapshot used only to position the remote caret over
   * what the collaborator is currently typing. Durable cell content still
   * flows through target.cell.commit; this is never written to the event log.
   */
  draftText?: string
}

export interface PresenceUserSnapshot {
  userId: string
  /** Lock-bearing: the cell the user holds the edit lease on. */
  focusedCell?: string
  /** Non-lock-bearing: the row the user is on (selected/reading), lease or not. */
  viewingCell?: string
  currentFileId?: string
  selection?: TargetPresenceSelection
  ts: number
}

export interface ProjectPresencePeer {
  peerId: string
  username: string
  color: string
  currentFileId?: string
  focusedCell?: string
  viewingCell?: string
  selection?: TargetPresenceSelection
  /** True iff the peer holds the edit lease on `focusedCell`. */
  isEditing: boolean
  lastSeenAt: number
}

export interface CellPresencePeer extends ProjectPresencePeer {
  cellId: string
}

type Listener = () => void

interface PresenceDraft {
  cellId: string
  draftText: string
  ts: number
}

function sameSelection(
  a: TargetPresenceSelection | undefined,
  b: TargetPresenceSelection | undefined,
): boolean {
  if (!a && !b) return true
  if (!a || !b) return false
  return (
    a.side === b.side &&
    a.anchor === b.anchor &&
    a.head === b.head &&
    a.draftText === b.draftText
  )
}

function sameUser(a: PresenceUserSnapshot | undefined, b: PresenceUserSnapshot | undefined): boolean {
  if (!a && !b) return true
  if (!a || !b) return false
  return (
    a.userId === b.userId &&
    a.focusedCell === b.focusedCell &&
    a.viewingCell === b.viewingCell &&
    a.currentFileId === b.currentFileId &&
    a.ts === b.ts &&
    sameSelection(a.selection, b.selection)
  )
}

function sameRosterUser(
  a: PresenceUserSnapshot | undefined,
  b: PresenceUserSnapshot | undefined,
): boolean {
  if (!a && !b) return true
  if (!a || !b) return false
  return (
    a.userId === b.userId &&
    a.focusedCell === b.focusedCell &&
    a.viewingCell === b.viewingCell &&
    a.currentFileId === b.currentFileId
  )
}

/** The row a user is on: the lease-held cell wins, else the selected row. */
export function presentCellOf(user: Pick<PresenceUserSnapshot, "focusedCell" | "viewingCell">): string | undefined {
  return user.focusedCell ?? user.viewingCell
}

function affectedCellIds(
  before: PresenceUserSnapshot | undefined,
  after: PresenceUserSnapshot | undefined,
): string[] {
  const ids = new Set<string>()
  if (before?.focusedCell) ids.add(before.focusedCell)
  if (before?.viewingCell) ids.add(before.viewingCell)
  if (after?.focusedCell) ids.add(after.focusedCell)
  if (after?.viewingCell) ids.add(after.viewingCell)
  return Array.from(ids)
}

export class ProjectPresenceStore {
  /**
   * Every identity that represents the *current* user. Presence frames stamp
   * the connection's `auth.claims.username`, but legacy tokens that predate the
   * username claim fall back to a `user:<numericId>` form (see
   * sync-worker `project-do.ts`). Filtering by username alone would then leak
   * the user's *own* presence back to them (AQU-559). We hold every known self
   * form here and exclude all of them.
   */
  private readonly selfIds: Set<string>
  private users = new Map<string, PresenceUserSnapshot>()
  /**
   * Live draft text per user, delivered by `presence.draft` frames (and by the
   * `selection.draftText` of a full snapshot). Kept out of `users` so a draft
   * frame never touches roster-visible state — only the cell it belongs to.
   */
  private drafts = new Map<string, PresenceDraft>()
  private lockHolders = new Map<string, string>()
  private rosterListeners = new Set<Listener>()
  private cellListeners = new Map<string, Set<Listener>>()
  private rosterSnapshot: ProjectPresencePeer[] = []
  private cellSnapshots = new Map<string, CellPresencePeer[]>()

  constructor(currentUserId: string | readonly string[]) {
    this.selfIds = new Set(typeof currentUserId === "string" ? [currentUserId] : currentUserId)
  }

  private isSelf(userId: string): boolean {
    return this.selfIds.has(userId)
  }

  /**
   * Register an additional identity for the current user (e.g. the
   * `user:<numericId>` fallback resolved once the project roster loads). Any
   * presence already surfaced under that identity is re-filtered out, so the
   * user never sees themselves even if their own frame arrived first.
   */
  addSelfId(id: string): void {
    if (this.selfIds.has(id)) return
    this.selfIds.add(id)
    this.rosterSnapshot = this.computePeers()
    this.emitRoster()
    for (const cellId of Array.from(this.cellSnapshots.keys())) {
      this.updateCellSnapshot(cellId)
    }
  }

  reset(): void {
    const affected = new Set<string>()
    for (const user of this.users.values()) {
      for (const cellId of affectedCellIds(user, undefined)) affected.add(cellId)
    }
    for (const cellId of this.lockHolders.keys()) affected.add(cellId)
    this.users = new Map()
    this.drafts = new Map()
    this.lockHolders = new Map()
    this.rosterSnapshot = EMPTY_PEERS
    this.cellSnapshots = new Map()
    this.emitRoster()
    for (const cellId of affected) this.emitCell(cellId)
  }

  applyPresenceFrame(users: PresenceUserSnapshot[]): void {
    const next = new Map<string, PresenceUserSnapshot>()
    const affected = new Set<string>()
    let rosterChanged = this.users.size !== users.length

    for (const user of users) {
      next.set(user.userId, user)
      const old = this.users.get(user.userId)
      if (!sameRosterUser(old, user)) rosterChanged = true
      if (!sameUser(old, user)) {
        for (const cellId of affectedCellIds(old, user)) affected.add(cellId)
      }
      if (this.syncDraftFromSnapshot(user) && user.focusedCell) affected.add(user.focusedCell)
    }

    for (const [userId, old] of this.users) {
      if (next.has(userId)) continue
      rosterChanged = true
      this.drafts.delete(userId)
      for (const cellId of affectedCellIds(old, undefined)) affected.add(cellId)
    }

    this.users = next
    if (rosterChanged) {
      this.rosterSnapshot = this.computePeers()
      this.emitRoster()
    }
    for (const cellId of affected) this.updateCellSnapshot(cellId)
  }

  /**
   * `presence.diff`: exactly one user changed. Roster listeners fire only when a
   * roster-visible field changed (focusedCell / currentFileId / joined); cell
   * listeners fire for the cells the user left and entered.
   */
  applyPresenceDiff(user: PresenceUserSnapshot): void {
    const old = this.users.get(user.userId)
    this.users.set(user.userId, user)
    const draftChanged = this.syncDraftFromSnapshot(user)
    if (!sameRosterUser(old, user)) {
      this.rosterSnapshot = this.computePeers()
      this.emitRoster()
    }
    if (sameUser(old, user) && !draftChanged) return
    for (const cellId of affectedCellIds(old, user)) this.updateCellSnapshot(cellId)
  }

  /** `presence.left`: the user disconnected (all of their sockets are gone). */
  applyPresenceLeft(userId: string): void {
    const old = this.users.get(userId)
    this.drafts.delete(userId)
    if (!old) return
    this.users.delete(userId)
    this.rosterSnapshot = this.computePeers()
    this.emitRoster()
    for (const cellId of affectedCellIds(old, undefined)) this.updateCellSnapshot(cellId)
  }

  /**
   * `presence.draft`: live draft text for one cell. Notifies ONLY that cell's
   * listeners — never the roster — so typing peers do not re-render the
   * workspace root. Exposed on the cell peer's `selection.draftText`.
   */
  applyPresenceDraft(userId: string, cellId: string, draftText: string, ts: number): void {
    const previous = this.drafts.get(userId)
    if (previous && previous.ts > ts) return
    this.drafts.set(userId, { cellId, draftText, ts })
    if (previous && previous.cellId !== cellId) this.updateCellSnapshot(previous.cellId)
    this.updateCellSnapshot(cellId)
  }

  /**
   * Mirror a snapshot/diff's selection into the drafts map: a user with no
   * selection has no draft; a selection carrying `draftText` IS the draft; a
   * selection without `draftText` (diffs strip it) leaves the live draft alone.
   * Returns true when the stored draft changed.
   */
  private syncDraftFromSnapshot(user: PresenceUserSnapshot): boolean {
    const previous = this.drafts.get(user.userId)
    if (!user.selection) {
      if (!previous) return false
      this.drafts.delete(user.userId)
      return true
    }
    const draftText = user.selection.draftText
    if (draftText === undefined) return false
    const cellId = user.focusedCell
    if (!cellId) return false
    if (previous && previous.cellId === cellId && previous.draftText === draftText) return false
    this.drafts.set(user.userId, { cellId, draftText, ts: user.ts })
    return true
  }

  applyLockClaimed(cellId: string, userId: string): void {
    const previous = this.lockHolders.get(cellId)
    if (previous === userId) return
    this.lockHolders.set(cellId, userId)
    this.updateCellSnapshot(cellId)
  }

  applyLockReleased(cellId: string): void {
    if (!this.lockHolders.has(cellId)) return
    this.lockHolders.delete(cellId)
    this.updateCellSnapshot(cellId)
  }

  /** Raw per-user snapshots (no drafts) — for lock-holder derivation and the
   *  focus-lock hook, which still consume the full-roster frame shape. */
  getUserSnapshots(): PresenceUserSnapshot[] {
    return Array.from(this.users.values())
  }

  getPeers(): ProjectPresencePeer[] {
    return this.rosterSnapshot
  }

  getCellPresence(cellId: string): CellPresencePeer[] {
    return this.cellSnapshots.get(cellId) ?? EMPTY_CELL_PEERS
  }

  private computePeers(): ProjectPresencePeer[] {
    const peers: ProjectPresencePeer[] = []
    for (const user of this.users.values()) {
      if (this.isSelf(user.userId)) continue
      peers.push(this.toPeer(user))
    }
    peers.sort((a, b) => a.username.localeCompare(b.username))
    return peers
  }

  private computeCellPresence(cellId: string): CellPresencePeer[] {
    const peers: CellPresencePeer[] = []
    const explicitHolder = this.lockHolders.get(cellId)
    const seen = new Set<string>()

    for (const user of this.users.values()) {
      if (this.isSelf(user.userId)) continue
      if (presentCellOf(user) !== cellId) continue
      seen.add(user.userId)
      peers.push({ ...this.toPeer(user), cellId })
    }

    if (explicitHolder && !this.isSelf(explicitHolder) && !seen.has(explicitHolder)) {
      peers.push({
        peerId: explicitHolder,
        username: explicitHolder,
        color: peerColor(explicitHolder),
        cellId,
        focusedCell: cellId,
        isEditing: true,
        lastSeenAt: Date.now(),
      })
    }

    return peers
  }

  private updateCellSnapshot(cellId: string): void {
    const next = this.computeCellPresence(cellId)
    if (next.length === 0) {
      this.cellSnapshots.delete(cellId)
    } else {
      this.cellSnapshots.set(cellId, next)
    }
    this.emitCell(cellId)
  }

  subscribeRoster(listener: Listener): () => void {
    this.rosterListeners.add(listener)
    return () => this.rosterListeners.delete(listener)
  }

  subscribeCell(cellId: string, listener: Listener): () => void {
    let listeners = this.cellListeners.get(cellId)
    if (!listeners) {
      listeners = new Set()
      this.cellListeners.set(cellId, listeners)
    }
    listeners.add(listener)
    return () => {
      listeners?.delete(listener)
      if (listeners?.size === 0) this.cellListeners.delete(cellId)
    }
  }

  private toPeer(user: PresenceUserSnapshot): ProjectPresencePeer {
    return {
      peerId: user.userId,
      username: user.userId,
      color: peerColor(user.userId),
      currentFileId: user.currentFileId,
      focusedCell: user.focusedCell,
      viewingCell: user.viewingCell,
      selection: this.selectionWithDraft(user),
      isEditing: Boolean(user.focusedCell),
      lastSeenAt: user.ts,
    }
  }

  private selectionWithDraft(user: PresenceUserSnapshot): TargetPresenceSelection | undefined {
    const selection = user.selection
    if (!selection) return undefined
    const draft = this.drafts.get(user.userId)
    if (!draft || draft.cellId !== user.focusedCell) return selection
    if (selection.draftText === draft.draftText) return selection
    return { ...selection, draftText: draft.draftText }
  }

  private emitRoster(): void {
    for (const listener of this.rosterListeners) listener()
  }

  private emitCell(cellId: string): void {
    const listeners = this.cellListeners.get(cellId)
    if (!listeners) return
    for (const listener of listeners) listener()
  }
}

export function createProjectPresenceStore(currentUserId: string): ProjectPresenceStore {
  return new ProjectPresenceStore(currentUserId)
}

const EMPTY_PEERS: ProjectPresencePeer[] = []
const EMPTY_CELL_PEERS: CellPresencePeer[] = []

export function usePresencePeers(store: ProjectPresenceStore | null): ProjectPresencePeer[] {
  return useSyncExternalStore(
    (listener) => store?.subscribeRoster(listener) ?? (() => undefined),
    () => store?.getPeers() ?? EMPTY_PEERS,
    () => EMPTY_PEERS,
  )
}

export function useCellPresence(
  store: ProjectPresenceStore | null | undefined,
  cellId: string,
): CellPresencePeer[] {
  return useSyncExternalStore(
    (listener) => store?.subscribeCell(cellId, listener) ?? (() => undefined),
    () => store?.getCellPresence(cellId) ?? EMPTY_CELL_PEERS,
    () => EMPTY_CELL_PEERS,
  )
}
