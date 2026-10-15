/**
 * Operations shared by every interaction surface (CLI, inspector UI, MCP
 * agent tools). Each one reads the folded ledger and records facts; none of
 * them touches the customer's files except `materialize`, which runs a sync.
 */
import { existsSync } from "node:fs"
import { hashValue } from "../core/hash.ts"
import { effectiveTranslation, humanConflicts, lastPublish, openConflicts, unitKey } from "../core/ledger.ts"
import type { LedgerState, UnitSnapshot } from "../core/ledger.ts"
import { unitContext } from "../core/context.ts"
import { plainOf } from "../core/tagged.ts"
import type { Workspace } from "./workspace.ts"

export interface UnitView {
  readonly logicalId: string
  readonly kind: string
  readonly structuralPath: string
  readonly source: string
  readonly status: string
  readonly targets: Record<string, { text: string; authority: string; stale: boolean } | null>
}

export const status = (ws: Workspace): unknown => {
  const state = ws.state()
  return {
    root: ws.root,
    sourceLocale: ws.config.sourceLocale,
    targets: ws.config.targets,
    translator: ws.config.translator ?? "pseudo",
    facts: state.size,
    docs: ws.sources().map((docId) => {
      const doc = state.docs.get(docId)
      return {
        docId,
        synced: !!doc,
        units: doc?.units.length ?? 0,
        revisions: doc?.revisions.length ?? 0,
        locales: Object.fromEntries(ws.config.targets.map((l) => [l, lastPublish(state, docId, l) ? "published" : "pending"])),
      }
    }),
    conflicts: openConflicts(state),
    concurrentEdits: humanConflicts(state).map((c) => ({ docId: c.docId, logicalId: c.logicalId, locale: c.locale, versions: c.versions.map((v) => ({ actor: v.actor, text: plainOf(v.content) })) })),
    suggestions: [...state.corrections.values()].filter((c) => c.status === "suggested"),
    terms: [...state.terms.values()].filter((t) => t.status === "active"),
  }
}

export const docView = (ws: Workspace, docId: string, state: LedgerState = ws.state()): UnitView[] => {
  const doc = state.docs.get(docId)
  if (!doc) return []
  return doc.units.map((u) => ({
    logicalId: u.logicalId,
    kind: u.kind,
    structuralPath: u.structuralPath,
    source: u.plain,
    status: u.status,
    targets: Object.fromEntries(
      ws.config.targets.map((l) => {
        const ctx = unitContext(state, l, u.plain)
        const e = effectiveTranslation(state, docId, u.logicalId, l, u.contentHash, ctx.contextRevision)
        if (e) return [l, { text: plainOf(e.content), authority: e.authority, stale: false }]
        const h = state.units.get(unitKey(docId, u.logicalId, l))?.human.at(-1)
        return [l, h ? { text: plainOf(h.content), authority: h.approved ? "approved" : "human", stale: true } : null]
      }),
    ),
  }))
}

export const findUnit = (state: LedgerState, docId: string, ref: string): UnitSnapshot | undefined => {
  const doc = state.docs.get(docId)
  if (!doc) return undefined
  return (
    doc.units.find((u) => u.logicalId === ref || u.structuralPath === ref) ??
    (Number.isInteger(Number(ref)) && Number(ref) >= 1 ? doc.units[Number(ref) - 1] : undefined) ??
    doc.units.find((u) => u.plain.toLowerCase().includes(ref.toLowerCase()))
  )
}

export const edit = (ws: Workspace, docId: string, ref: string, locale: string, text: string, via: "ui" | "agent-tool" | "cli" = "ui"): string => {
  const state = ws.state()
  const u = findUnit(state, docId, ref)
  if (!u) throw new Error(`no unit matching '${ref}' in ${docId}`)
  const ctx = unitContext(state, locale, u.plain)
  const e = effectiveTranslation(state, docId, u.logicalId, locale, u.contentHash, ctx.contextRevision)
  ws.record({ type: "translation.edited", docId, logicalId: u.logicalId, locale, sourceHash: u.contentHash, content: text, basedOn: e?.contentHash ?? "none", via })
  return u.logicalId
}

export const approve = (ws: Workspace, docId: string, locale: string, ref?: string): number => {
  const state = ws.state()
  const doc = state.docs.get(docId)
  if (!doc) throw new Error(`${docId} has not been synced`)
  const list = ref ? [findUnit(state, docId, ref)].filter((x): x is UnitSnapshot => !!x) : doc.units
  let n = 0
  for (const u of list) {
    const ctx = unitContext(state, locale, u.plain)
    const e = effectiveTranslation(state, docId, u.logicalId, locale, u.contentHash, ctx.contextRevision)
    if (!e || e.authority === "approved") continue
    ws.record({ type: "translation.approved", docId, logicalId: u.logicalId, locale, sourceHash: u.contentHash, content: e.content, basedOn: e.contentHash })
    n++
  }
  return n
}

export const addTerm = (ws: Workspace, source: string, target: string, locale: string, note?: string): string => {
  const id = `t${hashValue([locale, source.toLowerCase()]).slice(0, 10)}`
  ws.record({ type: "decision.term", id, locale, source, target, status: "active", ...(note ? { note } : {}) })
  return id
}

export const decideCorrection = (ws: Workspace, id: string, accept: boolean): void => {
  const c = ws.state().corrections.get(id)
  if (!c) throw new Error(`no correction ${id}`)
  ws.record({ type: "decision.correction", id, locale: c.locale, from: c.from, to: c.to, status: accept ? "accepted" : "rejected", ...(c.origin ? { origin: c.origin } : {}) })
}

/** "Open any file in any language": translate on demand and return the path. */
export const materialize = async (ws: Workspace, docId: string, locale: string): Promise<string> => {
  if (!ws.sources().includes(docId)) throw new Error(`${docId} is not a source document in this folder`)
  const s = await ws.sync({ docs: [docId], locales: [locale] })
  const beside = s.docs[0]?.locales[0]?.besideTarget
  const p = beside ? ws.besidePath(docId, locale) : ws.targetPath(docId, locale)
  if (!existsSync(p)) {
    // Up to date already: the file exists from an earlier sync.
    const t = ws.targetPath(docId, locale)
    if (existsSync(t)) return t
    throw new Error(`could not produce ${docId} in ${locale}`)
  }
  return p
}

export const LOCALE_RE = /^[a-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/
