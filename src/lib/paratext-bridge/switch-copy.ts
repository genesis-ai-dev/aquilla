// Moving a mirror from one copy of a Paratext project to another (Paratext 9
// to Paratext 10, say). Safe only when nothing can be lost or misread:
//
// - every mirrored book is in the new copy and byte-identical to the old one,
//   so the old base is the new file's base and Aquilla's unwritten edits (cells
//   that differ from that base) simply get written to the new copy instead;
// - no book is on hold after a clobber;
// - Aquilla has caught up with every Paratext change in the old copy, else
//   that change would read as an Aquilla edit reverting it.
//
// When the copies differ, the user runs Send/Receive in both apps first.

import { bridgeStore, type MirrorLink } from "./store"
import { paratextTauri } from "./tauri"
import { bridgeStateId } from "./project"
import type { BridgeProject } from "./use-paratext-discovery"

export type SwitchBlock =
  | { kind: "missing"; books: string[] }
  | { kind: "differs"; books: string[] }
  | { kind: "held"; books: string[] }
  | { kind: "unsynced"; books: string[] }

export type SwitchResult = { kind: "moved"; link: MirrorLink } | { kind: "blocked"; block: SwitchBlock }

export async function switchLiveCopy(link: MirrorLink, to: BridgeProject): Promise<SwitchResult> {
  const from = bridgeStateId(link.projectGuid, link.projectPath)
  const missing: string[] = []
  const differs: string[] = []
  const held: string[] = []
  const unsynced: string[] = []
  const books: MirrorLink["books"] = {}
  for (const [code, entry] of Object.entries(link.books)) {
    const target = to.books.find((b) => b.code === code)
    if (!target) { missing.push(code); continue }
    books[code] = { fileId: entry.fileId, fileName: target.fileName }
    const [oldHash, newHash, hold, seen] = await Promise.all([
      paratextTauri.hashFile(link.projectPath, entry.fileName),
      paratextTauri.hashFile(to.path, target.fileName),
      bridgeStore.hold(from, code),
      bridgeStore.lastSeen(from, code),
    ])
    if (oldHash !== newHash) differs.push(code)
    if (hold) held.push(code)
    if (seen && seen.blobHash !== oldHash) unsynced.push(code)
  }
  if (missing.length) return { kind: "blocked", block: { kind: "missing", books: missing } }
  if (differs.length) return { kind: "blocked", block: { kind: "differs", books: differs } }
  if (held.length) return { kind: "blocked", block: { kind: "held", books: held } }
  if (unsynced.length) return { kind: "blocked", block: { kind: "unsynced", books: unsynced } }
  return { kind: "moved", link: await bridgeStore.moveLink(link, to.path, books) }
}
