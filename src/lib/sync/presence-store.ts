import { useSyncExternalStore } from "react"
import { peerColor } from "@/hooks/useFileSync"

export interface TargetPresenceSelection {
  side: "target"
  anchor: number
  head: number
}

export interface PresenceUserSnapshot {
  userId: string
  focusedCell?: string
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
  selection?: TargetPresenceSelection
  isEditing: boolean
  lastSeenAt: number
}

export interface CellPresencePeer extends ProjectPresencePeer {
  cellId: string
}

type Listener = () => void

function sameSelection(
  a: TargetPresenceSelection | undefined,
  b: TargetPresenceSelection | undefined,
): boolean {
  if (!a && !b) return true
  if (!a || !b) return false
  return a.side === b.side && a.anchor === b.anchor && a.head === b.head
}

function sameUser(a: PresenceUserSnapshot | undefined, b: PresenceUserSnapshot | undefined): boolean {
  if (!a && !b) return true
  if (!a || !b) return false
  return (
    a.userId === b.userId &&
    a.focusedCell === b.focusedCell &&
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
    a.currentFileId === b.currentFileId
  )
}

function affectedCellIds(
  before: PresenceUserSnapshot | undefined,
  after: PresenceUserSnapshot | undefined,
): string[] {
  const ids = new Set<string>()
  if (before?.focusedCell) ids.add(before.focusedCell)
  if (after?.focusedCell) ids.add(after.focusedCell)
  return Array.from(ids)
}

export class ProjectPresenceStore {
  private readonly currentUserId: string
  private users = new Map<string, PresenceUserSnapshot>()
  private lockHolders = new Map<string, string>()
  private rosterListeners = new Set<Listener>()
  private cellListeners = new Map<string, Set<Listener>>()
  private rosterSnapshot: ProjectPresencePeer[] = []
  private cellSnapshots = new Map<string, CellPresencePeer[]>()

  constructor(currentUserId: string) {
    this.currentUserId = currentUserId
  }

  reset(): void {
    const affected = new Set<string>()
    for (const user of this.users.values()) {
      if (user.focusedCell) affected.add(user.focusedCell)
    }
    for (const cellId of this.lockHolders.keys()) affected.add(cellId)
    this.users = new Map()
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
    }

    for (const [userId, old] of this.users) {
      if (next.has(userId)) continue
      rosterChanged = true
      for (const cellId of affectedCellIds(old, undefined)) affected.add(cellId)
    }

    this.users = next
    if (rosterChanged) {
      this.rosterSnapshot = this.computePeers()
      this.emitRoster()
    }
    for (const cellId of affected) this.updateCellSnapshot(cellId)
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

  getPeers(): ProjectPresencePeer[] {
    return this.rosterSnapshot
  }

  getCellPresence(cellId: string): CellPresencePeer[] {
    return this.cellSnapshots.get(cellId) ?? EMPTY_CELL_PEERS
  }

  private computePeers(): ProjectPresencePeer[] {
    const peers: ProjectPresencePeer[] = []
    for (const user of this.users.values()) {
      if (user.userId === this.currentUserId) continue
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
      if (user.userId === this.currentUserId) continue
      if (user.focusedCell !== cellId) continue
      seen.add(user.userId)
      peers.push({ ...this.toPeer(user), cellId })
    }

    if (explicitHolder && explicitHolder !== this.currentUserId && !seen.has(explicitHolder)) {
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
      selection: user.selection,
      isEditing: Boolean(user.focusedCell),
      lastSeenAt: user.ts,
    }
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
