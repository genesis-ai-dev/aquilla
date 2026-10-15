/**
 * A watched folder: the simplest "ambient" surface. Drop source files in;
 * translated files appear under translations/<locale>/ and stay in sync.
 * Edit a translated file in any tool and the edit becomes a human decision.
 *
 * Durable state lives in .ambient/: an append-only JSONL ledger of facts and a
 * content-addressed object store holding the exact bytes of every published
 * output (needed for three-way merges and rollback). Source files are never
 * copied there — the customer's folder stays the system of record.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { hostname } from "node:os"
import { dirname, extname, join, relative, sep } from "node:path"
import { adapterFor } from "../adapters/registry.ts"
import { sha256, shortHash } from "../core/hash.ts"
import { Clock, fold, seal } from "../core/ledger.ts"
import type { Envelope, Fact, LedgerState } from "../core/ledger.ts"
import type { PlanPolicy } from "../core/plan.ts"
import { syncDocument } from "../engine/pipeline.ts"
import type { DocReport } from "../engine/pipeline.ts"
import { renderHtmlReport, renderMarkdownReport } from "../engine/report.ts"
import { makeTranslator } from "../engine/translator.ts"
import type { Translator } from "../engine/translator.ts"
import "../adapters/all.ts"

export interface AmbientConfig {
  readonly sourceLocale: string
  readonly targets: string[]
  readonly translator?: string
  readonly outputDir?: string
  readonly policy?: Partial<PlanPolicy>
  /** Free-text organisational context passed to LLM translators. */
  readonly orgContext?: string
  /** Relative paths or directory prefixes to ignore. */
  readonly ignore?: string[]
}

export const CONFIG_FILE = "ambient.json"
const STATE_DIR = ".ambient"

export interface SyncSummary {
  readonly docs: DocReport[]
  readonly written: string[]
  readonly facts: number
  readonly startedAt: string
  readonly durationMs: number
}

export class Workspace {
  readonly clock: Clock
  readonly actor: string
  private translatorOverride: Translator | undefined

  private constructor(
    readonly root: string,
    readonly config: AmbientConfig,
    actor?: string,
  ) {
    this.actor = actor ?? process.env.AMBIENT_ACTOR ?? `${process.env.USER ?? "user"}@${hostname()}`
    this.clock = new Clock(shortHash(`${this.actor}|${root}`).slice(0, 8))
    for (const e of this.envelopes()) this.clock.observe(e.hlc)
  }

  static init(root: string, config: AmbientConfig): Workspace {
    mkdirSync(root, { recursive: true })
    const path = join(root, CONFIG_FILE)
    if (!existsSync(path)) writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`)
    mkdirSync(join(root, STATE_DIR, "objects"), { recursive: true })
    return Workspace.open(root)
  }

  static open(root: string, actor?: string): Workspace {
    const path = join(root, CONFIG_FILE)
    if (!existsSync(path)) throw new Error(`${root} is not an ambient folder (no ${CONFIG_FILE}); run \`ambient init\``)
    const config = JSON.parse(readFileSync(path, "utf8")) as AmbientConfig
    mkdirSync(join(root, STATE_DIR, "objects"), { recursive: true })
    return new Workspace(root, config, actor)
  }

  /** Use a specific translator instance (tests, demos). */
  withTranslator(t: Translator): this {
    this.translatorOverride = t
    return this
  }

  get translator(): Translator {
    return this.translatorOverride ?? makeTranslator(this.config.translator, this.config.orgContext)
  }

  get outputDir(): string {
    return this.config.outputDir ?? "translations"
  }

  get policy(): PlanPolicy {
    return { onSourceChangeUnderHuman: this.config.policy?.onSourceChangeUnderHuman ?? "revise" }
  }

  // ── Ledger ────────────────────────────────────────────────────────────────

  private get ledgerPath(): string {
    return join(this.root, STATE_DIR, "ledger.jsonl")
  }

  envelopes(): Envelope[] {
    if (!existsSync(this.ledgerPath)) return []
    const out: Envelope[] = []
    for (const line of readFileSync(this.ledgerPath, "utf8").split("\n")) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line) as Envelope)
      } catch {
        // A torn final line (crash mid-append) is ignored; every complete fact is kept.
      }
    }
    return out
  }

  state(): LedgerState {
    return fold(this.envelopes())
  }

  append(envs: readonly Envelope[]): void {
    if (envs.length === 0) return
    appendFileSync(this.ledgerPath, envs.map((e) => `${JSON.stringify(e)}\n`).join(""))
  }

  /** Record a fact authored by this workspace's actor (CLI/UI/agent decisions). */
  record(fact: Fact): Envelope {
    const env = seal(fact, this.actor, this.clock.tick())
    this.append([env])
    return env
  }

  /** Merge facts from another replica's ledger (sync between machines). Idempotent. */
  importLedger(envs: readonly Envelope[]): number {
    const have = new Set(this.envelopes().map((e) => e.opId))
    const fresh = envs.filter((e) => !have.has(e.opId))
    for (const e of fresh) this.clock.observe(e.hlc)
    this.append(fresh)
    return fresh.length
  }

  // ── Objects ───────────────────────────────────────────────────────────────

  putBlob(bytes: Uint8Array, key: string): void {
    const path = join(this.root, STATE_DIR, "objects", key.slice(0, 2), key.slice(2))
    if (existsSync(path)) return
    mkdirSync(dirname(path), { recursive: true })
    writeAtomic(path, bytes)
  }

  getBlob(key: string): Uint8Array | undefined {
    const path = join(this.root, STATE_DIR, "objects", key.slice(0, 2), key.slice(2))
    return existsSync(path) ? new Uint8Array(readFileSync(path)) : undefined
  }

  // ── Files ─────────────────────────────────────────────────────────────────

  /** Source documents: every file a registered adapter understands, outside the state/output dirs. */
  sources(): string[] {
    const out: string[] = []
    const ignore = [STATE_DIR, this.outputDir, "node_modules", ".git", ...(this.config.ignore ?? [])]
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir).sort()) {
        const abs = join(dir, name)
        const rel = toPosix(relative(this.root, abs))
        if (ignore.some((p) => rel === p || rel.startsWith(`${p}/`))) continue
        if (name.startsWith(".") || name === CONFIG_FILE || name.startsWith("ambient-report")) continue
        const st = statSync(abs)
        if (st.isDirectory()) walk(abs)
        else if (adapterFor(name)) out.push(rel)
      }
    }
    walk(this.root)
    return out
  }

  targetPath(docId: string, locale: string): string {
    return join(this.root, this.outputDir, locale, ...docId.split("/"))
  }

  besidePath(docId: string, locale: string): string {
    const p = this.targetPath(docId, locale)
    const ext = extname(p)
    return `${p.slice(0, p.length - ext.length)}.ambient-proposed${ext}`
  }

  // ── Sync ──────────────────────────────────────────────────────────────────

  async sync(options: { docs?: string[]; locales?: string[]; quiet?: boolean } = {}): Promise<SyncSummary> {
    const started = Date.now()
    const docs = options.docs ?? this.sources()
    const locales = options.locales ?? this.config.targets
    const reports: DocReport[] = []
    const written: string[] = []
    let facts = 0
    const translator = this.translator
    for (const docId of docs) {
      const adapter = adapterFor(docId)
      if (!adapter) continue
      const srcPath = join(this.root, ...docId.split("/"))
      if (!existsSync(srcPath)) continue
      const source = new Uint8Array(readFileSync(srcPath))
      const targets = new Map<string, Uint8Array | undefined>()
      for (const l of locales) {
        const p = this.targetPath(docId, l)
        targets.set(l, existsSync(p) ? new Uint8Array(readFileSync(p)) : undefined)
      }
      let result
      try {
        result = await syncDocument(
          { docId, adapter, source, targets, getBlob: (k) => this.getBlob(k), envelopes: this.envelopes() },
          { sourceLocale: this.config.sourceLocale, locales, policy: this.policy, translator, clock: this.clock, actor: this.actor },
        )
      } catch (e) {
        reports.push({
          docId,
          format: adapter.format,
          revision: "",
          sourceChanged: false,
          identity: {},
          deleted: 0,
          diagnostics: [{ code: "SYNC_FAILED", severity: "error", message: (e as Error).message }],
          locales: [],
        })
        continue
      }
      // Blobs first, then outputs, then facts: a crash leaves at worst an unreferenced blob.
      for (const b of result.blobs) this.putBlob(b, sha256Key(b))
      for (const o of result.outputs) {
        if (!o.write) continue
        const p = o.besideTarget ? this.besidePath(docId, o.locale) : this.targetPath(docId, o.locale)
        mkdirSync(dirname(p), { recursive: true })
        writeAtomic(p, o.bytes)
        written.push(toPosix(relative(this.root, p)))
      }
      this.append(result.facts)
      facts += result.facts.length
      reports.push(result.report)
    }
    const summary: SyncSummary = { docs: reports, written, facts, startedAt: new Date(started).toISOString(), durationMs: Date.now() - started }
    if (facts > 0 || written.length > 0) this.writeReport(summary)
    return summary
  }

  writeReport(summary: SyncSummary): void {
    const state = this.state()
    const dir = join(this.root, STATE_DIR, "reports")
    mkdirSync(dir, { recursive: true })
    const md = renderMarkdownReport(summary, state, this.config)
    const html = renderHtmlReport(summary, state, this.config)
    const stamp = summary.startedAt.replace(/[:.]/g, "-")
    writeFileSync(join(dir, `${stamp}.md`), md)
    writeFileSync(join(this.root, "ambient-report.md"), md)
    writeFileSync(join(this.root, "ambient-report.html"), html)
  }
}

const sha256Key = (b: Uint8Array): string => sha256(b)

export const toPosix = (p: string): string => p.split(sep).join("/")

const writeAtomic = (path: string, bytes: Uint8Array | string): void => {
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, bytes)
  renameSync(tmp, path)
}
