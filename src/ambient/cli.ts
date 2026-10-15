/**
 * `ambient` — command-line surface for a watched folder.
 *
 *   ambient init [dir] --source en --targets fr,es [--translator pseudo|claude]
 *   ambient sync [dir]                one pass: translate what changed
 *   ambient watch [dir]               keep the folder in sync as files change
 *   ambient open <file> --in <locale> materialise any file in any language now
 *   ambient status [dir]
 *   ambient explain <file> <unit>     lineage, provenance and authority of one unit
 *   ambient approve <file> --locale fr [--unit id]
 *   ambient edit <file> <unit> --locale fr --text "…"
 *   ambient term add <source> <target> --locale fr [--note …]
 *   ambient term list
 *   ambient rule add "<text>" --locale fr [--retroactive]
 *   ambient correction accept|reject <id>
 *   ambient resolve <conflict-id> [--as <logical-id>] [--note …]
 *   ambient history <file> --locale fr
 *   ambient rollback <file> --locale fr [--to <publish-op-id>]
 *   ambient serve [dir] [--port 4477]  inspector UI + JSON API + WebDAV "any language" drive
 *   ambient mcp [dir]                  Model Context Protocol server on stdio
 */
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { hashValue, shortHash } from "../core/hash.ts"
import { effectiveTranslation, humanConflicts, lastPublish, openConflicts, unitKey } from "../core/ledger.ts"
import type { LedgerState } from "../core/ledger.ts"
import { unitContext } from "../core/context.ts"
import { plainOf } from "../core/tagged.ts"
import { findUnit } from "./ops.ts"
import { toPosix, Workspace } from "./workspace.ts"
import type { SyncSummary } from "./workspace.ts"

interface Args {
  readonly _: string[]
  readonly flags: Record<string, string | true>
}

const parse = (argv: string[]): Args => {
  const _: string[] = []
  const flags: Record<string, string | true> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2) as [string, string | undefined]
      if (v !== undefined) flags[k] = v
      else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--")) flags[k] = argv[++i]!
      else flags[k] = true
    } else _.push(a)
  }
  return { _, flags }
}

const str = (v: string | true | undefined): string | undefined => (typeof v === "string" ? v : undefined)

/** Find the ambient folder containing a path (walks up). */
export const findRoot = (start: string): string => {
  let dir = resolve(start)
  for (;;) {
    if (existsSync(join(dir, "ambient.json"))) return dir
    const up = dirname(dir)
    if (up === dir) throw new Error(`no ambient.json found at or above ${start}; run \`ambient init\``)
    dir = up
  }
}

const docIdOf = (ws: Workspace, file: string): string => toPosix(relative(ws.root, resolve(file)))

export const printSummary = (s: SyncSummary, log: (m: string) => void = console.log): void => {
  for (const d of s.docs) {
    const id = Object.entries(d.identity)
      .filter(([k]) => k !== "unchanged")
      .map(([k, v]) => `${v} ${k}`)
      .join(", ")
    log(`${d.docId}${d.sourceChanged ? `  (source changed${id ? `: ${id}` : ""})` : ""}`)
    for (const x of d.diagnostics.filter((x) => x.severity === "error")) log(`  ✗ ${x.code}: ${x.message}`)
    for (const l of d.locales) {
      const flags = [
        l.translated ? `${l.translated} translated` : "",
        `${l.reused} reused`,
        l.humanEditsCaptured ? `${l.humanEditsCaptured} human edit(s) captured` : "",
        l.correctionsApplied ? `${l.correctionsApplied} corrected` : "",
        l.review.length ? `${l.review.length} to review` : "",
        l.conflicts.length ? `${l.conflicts.length} conflict(s)` : "",
        l.layout.filter((f) => f.severity === "overset").length ? `${l.layout.filter((f) => f.severity === "overset").length} overset risk` : "",
        l.diagnostics.filter((x) => x.severity === "error").length ? `${l.diagnostics.filter((x) => x.severity === "error").length} error(s)` : "",
      ].filter(Boolean)
      log(`  → ${l.locale}: ${flags.join(" · ")}${l.besideTarget ? " · written beside existing file" : ""}`)
      for (const sug of l.suggestions) log(`    💡 "${sug.from}" → "${sug.to}" seen in a human edit. Accept everywhere: ambient correction accept ${sug.id}`)
    }
  }
  if (s.written.length) log(`wrote ${s.written.length} file(s): ${s.written.join(", ")}`)
  else log("everything is up to date")
}

const unitInfo = findUnit

export const main = async (argv: string[]): Promise<number> => {
  const { _, flags } = parse(argv)
  const cmd = _[0] ?? "help"
  const log = console.log
  try {
    switch (cmd) {
      case "init": {
        const dir = resolve(_[1] ?? ".")
        const targets = (str(flags.targets) ?? "fr,es").split(",").map((s) => s.trim()).filter(Boolean)
        const ws = Workspace.init(dir, {
          sourceLocale: str(flags.source) ?? "en",
          targets,
          translator: str(flags.translator) ?? "pseudo",
          outputDir: str(flags["output-dir"]) ?? "translations",
          policy: { onSourceChangeUnderHuman: str(flags.policy) === "hold" ? "hold" : "revise" },
        })
        log(`ambient folder ready at ${ws.root}`)
        log(`drop .idml, .md or .i18n.json files here; translations appear in ${ws.outputDir}/<locale>/`)
        return 0
      }
      case "sync": {
        const ws = Workspace.open(findRoot(_[1] ?? "."))
        const only = str(flags.file) ? [docIdOf(ws, str(flags.file)!)] : undefined
        printSummary(await ws.sync({ ...(only ? { docs: only } : {}) }))
        return 0
      }
      case "watch": {
        const ws = Workspace.open(findRoot(_[1] ?? "."))
        log(`watching ${ws.root} (${ws.config.sourceLocale} → ${ws.config.targets.join(", ")}). Ctrl-C to stop.`)
        printSummary(await ws.sync())
        let timer: NodeJS.Timeout | undefined
        let running = false
        let again = false
        const run = async (): Promise<void> => {
          if (running) {
            again = true
            return
          }
          running = true
          try {
            const s = await ws.sync()
            if (s.facts > 0 || s.written.length > 0) printSummary(s)
          } catch (e) {
            console.error(`sync failed: ${(e as Error).message}`)
          } finally {
            running = false
            if (again) {
              again = false
              void run()
            }
          }
        }
        watch(ws.root, { recursive: true }, (_event, name) => {
          const n = String(name ?? "")
          if (n.startsWith(".ambient") || n.startsWith("ambient-report") || n.includes(".tmp-")) return
          clearTimeout(timer)
          timer = setTimeout(() => void run(), 400)
        })
        await new Promise(() => {})
        return 0
      }
      case "open": {
        const file = _[1]
        const locale = str(flags.in) ?? str(flags.locale)
        if (!file || !locale) throw new Error("usage: ambient open <file> --in <locale>")
        const ws = Workspace.open(findRoot(dirname(resolve(file))))
        const docId = docIdOf(ws, file)
        const s = await ws.sync({ docs: [docId], locales: [locale] })
        const l = s.docs[0]?.locales[0]
        const path = existsSync(ws.besidePath(docId, locale)) && l?.besideTarget ? ws.besidePath(docId, locale) : ws.targetPath(docId, locale)
        log(path)
        if (l && l.translated) console.error(`(${l.translated} unit(s) translated on demand)`)
        if (flags.add && !ws.config.targets.includes(locale)) {
          const cfg = { ...ws.config, targets: [...ws.config.targets, locale] }
          writeFileSync(join(ws.root, "ambient.json"), `${JSON.stringify(cfg, null, 2)}\n`)
        }
        return 0
      }
      case "status": {
        const ws = Workspace.open(findRoot(_[1] ?? "."))
        const state = ws.state()
        log(`${ws.root}  ${ws.config.sourceLocale} → ${ws.config.targets.join(", ")}  translator=${ws.translator.id}  facts=${state.size}`)
        for (const docId of ws.sources()) {
          const doc = state.docs.get(docId)
          if (!doc) {
            log(`  ${docId}: not yet synced`)
            continue
          }
          const cur = new Uint8Array(readFileSync(join(ws.root, docId)))
          const changed = shortHash(cur) !== doc.revision
          const parts = ws.config.targets.map((l) => {
            const p = lastPublish(state, docId, l)
            let human = 0
            let approved = 0
            for (const u of doc.units) {
              const ctx = unitContext(state, l, u.plain)
              const e = effectiveTranslation(state, docId, u.logicalId, l, u.contentHash, ctx.contextRevision)
              if (e?.authority === "human") human++
              if (e?.authority === "approved") approved++
            }
            return `${l}:${p ? "published" : "pending"}${human ? ` ${human}✍️` : ""}${approved ? ` ${approved}✅` : ""}`
          })
          log(`  ${docId}: ${doc.units.length} units, ${doc.revisions.length} revision(s)${changed ? " — source changed since last sync" : ""}  ${parts.join("  ")}`)
        }
        const oc = openConflicts(state)
        const hc = humanConflicts(state)
        if (oc.length || hc.length) log(`\nneeds a decision:`)
        for (const c of oc) log(`  ${c.id}  ${c.kind}: ${c.detail}`)
        for (const c of hc) log(`  concurrent human edits on ${c.logicalId} (${c.locale})`)
        const sugg = [...state.corrections.values()].filter((c) => c.status === "suggested")
        for (const c of sugg) log(`  suggestion ${c.id} (${c.locale}): "${c.from}" → "${c.to}"`)
        return 0
      }
      case "explain": {
        const [, file, ref] = _
        if (!file || !ref) throw new Error("usage: ambient explain <file> <unit-id|number|text>")
        const ws = Workspace.open(findRoot(dirname(resolve(file))))
        const docId = docIdOf(ws, file)
        const state = ws.state()
        const u = unitInfo(state, docId, ref)
        if (!u) throw new Error(`no unit matching '${ref}' in ${docId}`)
        const doc = state.docs.get(docId)!
        log(`${u.logicalId}  ${u.structuralPath}`)
        log(`source: ${u.plain}`)
        const lineage: string[] = []
        let cur = doc.lineage.get(u.logicalId)
        while (cur && lineage.length < 20) {
          lineage.push(cur.join("+"))
          cur = doc.lineage.get(cur[0]!)
        }
        if (lineage.length) log(`lineage: ${u.logicalId} ← ${lineage.join(" ← ")}`)
        for (const l of ws.config.targets) {
          const ctx = unitContext(state, l, u.plain)
          const e = effectiveTranslation(state, docId, u.logicalId, l, u.contentHash, ctx.contextRevision)
          const s = state.units.get(unitKey(docId, u.logicalId, l))
          log(`\n[${l}] ${e ? `${e.authority}: ${plainOf(e.content)}` : "(no current translation)"}`)
          if (ctx.terms.length) log(`  terms: ${ctx.terms.map((t) => `${t.source}→${t.target}`).join(", ")}`)
          for (const p of s?.proposals ?? []) log(`  ${p.hlc.slice(0, 15)} proposed by ${p.provenance.translator}${p.provenance.model ? ` (${p.provenance.model})` : ""} src=${p.sourceHash.slice(0, 8)} ctx=${p.contextRevision.slice(0, 8)}${p.revisesHuman ? " revises-human" : ""}`)
          for (const h of s?.human ?? []) log(`  ${h.hlc.slice(0, 15)} ${h.approved ? "approved" : "edited"} by ${h.actor} via ${h.via} src=${h.sourceHash.slice(0, 8)}`)
        }
        return 0
      }
      case "approve": {
        const file = _[1]
        const locale = str(flags.locale)
        if (!file || !locale) throw new Error("usage: ambient approve <file> --locale <l> [--unit <ref>]")
        const ws = Workspace.open(findRoot(dirname(resolve(file))))
        const docId = docIdOf(ws, file)
        const state = ws.state()
        const doc = state.docs.get(docId)
        if (!doc) throw new Error(`${docId} has not been synced`)
        const targets = str(flags.unit) ? [unitInfo(state, docId, str(flags.unit)!)].filter((x) => x !== undefined) : doc.units
        let n = 0
        for (const u of targets) {
          const ctx = unitContext(state, locale, u.plain)
          const e = effectiveTranslation(state, docId, u.logicalId, locale, u.contentHash, ctx.contextRevision)
          if (!e || e.authority === "approved") continue
          ws.record({ type: "translation.approved", docId, logicalId: u.logicalId, locale, sourceHash: u.contentHash, content: e.content, basedOn: e.contentHash })
          n++
        }
        log(`approved ${n} unit(s) in ${docId} [${locale}]`)
        return 0
      }
      case "edit": {
        const [, file, ref] = _
        const locale = str(flags.locale)
        const text = str(flags.text)
        if (!file || !ref || !locale || text === undefined) throw new Error('usage: ambient edit <file> <unit> --locale <l> --text "…"')
        const ws = Workspace.open(findRoot(dirname(resolve(file))))
        const docId = docIdOf(ws, file)
        const state = ws.state()
        const u = unitInfo(state, docId, ref)
        if (!u) throw new Error(`no unit matching '${ref}'`)
        const ctx = unitContext(state, locale, u.plain)
        const e = effectiveTranslation(state, docId, u.logicalId, locale, u.contentHash, ctx.contextRevision)
        ws.record({ type: "translation.edited", docId, logicalId: u.logicalId, locale, sourceHash: u.contentHash, content: text, basedOn: e?.contentHash ?? "none", via: "cli" })
        log(`recorded human translation for ${u.logicalId} [${locale}]; run \`ambient sync\` to publish`)
        return 0
      }
      case "term": {
        const ws = Workspace.open(findRoot("."))
        if (_[1] === "list") {
          for (const t of ws.state().terms.values()) log(`${t.status === "active" ? "•" : "✗"} ${t.source} → ${t.target} [${t.locale}]${t.note ? ` — ${t.note}` : ""}  (${t.id})`)
          return 0
        }
        if (_[1] === "add") {
          const [, , source, target] = _
          const locale = str(flags.locale)
          if (!source || !target || !locale) throw new Error("usage: ambient term add <source> <target> --locale <l>")
          const id = `t${hashValue([locale, source.toLowerCase()]).slice(0, 10)}`
          ws.record({ type: "decision.term", id, locale, source, target, status: "active", ...(str(flags.note) ? { note: str(flags.note)! } : {}) })
          log(`term ${id}: ${source} → ${target} [${locale}] — units containing "${source}" will be retranslated on the next sync`)
          return 0
        }
        if (_[1] === "retire") {
          const t = ws.state().terms.get(_[2] ?? "")
          if (!t) throw new Error("usage: ambient term retire <term-id>")
          ws.record({ type: "decision.term", id: t.id, locale: t.locale, source: t.source, target: t.target, status: "retired" })
          log(`retired ${t.id}`)
          return 0
        }
        throw new Error("usage: ambient term add|list|retire")
      }
      case "rule": {
        const ws = Workspace.open(findRoot("."))
        if (_[1] !== "add" || !_[2]) throw new Error('usage: ambient rule add "<text>" --locale <l|*> [--retroactive]')
        const locale = str(flags.locale) ?? "*"
        const id = `r${hashValue([locale, _[2]]).slice(0, 10)}`
        ws.record({ type: "decision.rule", id, locale, text: _[2], retroactive: flags.retroactive === true, status: "active" })
        log(`rule ${id} recorded${flags.retroactive ? " (retroactive: affected locales will be retranslated)" : " (applies to new and changed content)"}`)
        return 0
      }
      case "correction": {
        const ws = Workspace.open(findRoot("."))
        const c = ws.state().corrections.get(_[2] ?? "")
        if (!c || (_[1] !== "accept" && _[1] !== "reject")) throw new Error("usage: ambient correction accept|reject <id>")
        ws.record({ type: "decision.correction", id: c.id, locale: c.locale, from: c.from, to: c.to, status: _[1] === "accept" ? "accepted" : "rejected", ...(c.origin ? { origin: c.origin } : {}) })
        log(`${_[1]}ed "${c.from}" → "${c.to}" [${c.locale}]${_[1] === "accept" ? "; machine translations containing it update on the next sync" : ""}`)
        return 0
      }
      case "resolve": {
        const ws = Workspace.open(findRoot("."))
        const state = ws.state()
        const c = state.conflicts.get(_[1] ?? "")
        if (!c) throw new Error("usage: ambient resolve <conflict-id> [--as <previous-logical-id>]")
        const as = str(flags.as)
        if (as && c.logicalId) {
          const doc = state.docs.get(c.docId)
          const u = doc?.units.find((x) => x.logicalId === c.logicalId)
          if (u) ws.record({ type: "identity.asserted", docId: c.docId, structuralPath: u.structuralPath, logicalId: as })
        }
        ws.record({ type: "conflict.resolved", id: c.id, resolution: as ? `asserted ${as}` : (str(flags.note) ?? "acknowledged") })
        log(`resolved ${c.id}`)
        return 0
      }
      case "history": {
        const file = _[1]
        const locale = str(flags.locale)
        if (!file || !locale) throw new Error("usage: ambient history <file> --locale <l>")
        const ws = Workspace.open(findRoot(dirname(resolve(file))))
        const docId = docIdOf(ws, file)
        for (const p of ws.state().publishes.get(`${docId}\u0000${locale}`) ?? []) {
          const human = p.units.filter((u) => u.authority !== "agent").length
          log(`${p.opId}  ${new Date(Number(p.hlc.slice(0, 15))).toISOString()}  ${p.actor}  src=${p.sourceRevision.slice(0, 8)}  ${p.units.length} units (${human} human)  ${p.warnings} warning(s)${p.rollbackOf ? `  rollback→${p.rollbackOf}` : ""}`)
        }
        return 0
      }
      case "rollback": {
        const file = _[1]
        const locale = str(flags.locale)
        if (!file || !locale) throw new Error("usage: ambient rollback <file> --locale <l> [--to <publish-id>]")
        const ws = Workspace.open(findRoot(dirname(resolve(file))))
        const docId = docIdOf(ws, file)
        const list = ws.state().publishes.get(`${docId}\u0000${locale}`) ?? []
        const to = str(flags.to) ? list.find((p) => p.opId === str(flags.to)) : list.at(-2)
        if (!to) throw new Error("no earlier publish to roll back to")
        const bytes = ws.getBlob(to.outputHash)
        if (!bytes) throw new Error(`published bytes ${to.outputHash} missing from the object store`)
        const path = ws.targetPath(docId, locale)
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, bytes)
        ws.record({ type: "publish.recorded", docId, locale, path: locale, outputHash: to.outputHash, sourceRevision: to.sourceRevision, units: to.units, warnings: to.warnings, rollbackOf: to.opId })
        log(`restored ${relative(ws.root, path)} to publish ${to.opId}`)
        return 0
      }
      case "serve": {
        const { serve } = await import("./server.ts")
        await serve(Workspace.open(findRoot(_[1] ?? ".")), Number(str(flags.port) ?? 4477))
        return 0
      }
      case "mcp": {
        const { runMcp } = await import("./mcp.ts")
        await runMcp(findRoot(_[1] ?? "."))
        return 0
      }
      default:
        log(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 22).map((l) => l.replace(/^ \* ?/, "")).join("\n"))
        return cmd === "help" ? 0 : 1
    }
  } catch (e) {
    console.error(`ambient: ${(e as Error).message}`)
    return 1
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => {
    if (code !== 0) process.exit(code)
  })
}
