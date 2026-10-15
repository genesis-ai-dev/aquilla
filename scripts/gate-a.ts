/**
 * Gate A — technical feasibility scorecard (spec §6).
 *
 * Every row is *measured* by running the real engine on the fixture corpus or
 * on generated scenarios. Rows that cannot be measured without Adobe software
 * say so instead of claiming a pass. Writes docs/GATE-A.md.
 *
 *   pnpm gate            # default sizes
 *   pnpm gate --quick    # smaller, for CI
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import fc from "fast-check"
import { idmlAdapter } from "../src/adapters/idml/index.ts"
import { entryText, readZip, rewriteZip } from "../src/adapters/zip.ts"
import { parseXml } from "../src/adapters/xml.ts"
import { Workspace } from "../src/ambient/workspace.ts"
import { main as cliMain } from "../src/ambient/cli.ts"
import { contentHashOf, fold, formatHlc, humanConflicts, seal } from "../src/core/ledger.ts"
import type { Envelope } from "../src/core/ledger.ts"
import { applyPatches } from "../src/core/patch.ts"
import type { Authority, ContentPatch } from "../src/core/types.ts"
import { reconcile } from "../src/core/reconcile.ts"
import { plainOf } from "../src/core/tagged.ts"
import { buildIdml } from "../src/fixtures/build-idml.ts"
import type { ParagraphSpec } from "../src/fixtures/build-idml.ts"
import { PseudoTranslator } from "../src/engine/translator.ts"
import type { TranslationJob, TranslationOutput, Translator } from "../src/engine/translator.ts"
import { sentence, units as mkUnits } from "../test/helpers.ts"
import { applyScript, opArb } from "../test/edit-scripts.ts"

const QUICK = process.argv.includes("--quick")
/** Run a CLI command without its console output. */
const cli = async (args: string[]): Promise<number> => {
  const log = console.log
  console.log = () => {}
  try {
    return await cliMain(args)
  } finally {
    console.log = log
  }
}
const ROOT = join(import.meta.dirname, "..")

type Status = "PASS" | "FAIL" | "PARTIAL" | "NOT VERIFIED"
interface Row {
  readonly metric: string
  readonly target: string
  readonly measured: string
  readonly status: Status
  readonly how: string
}
const rows: Row[] = []
const row = (r: Row): void => {
  rows.push(r)
  console.log(`${r.status.padEnd(13)} ${r.metric} — ${r.measured}`)
}
const pct = (a: number, b: number): string => (b === 0 ? "n/a" : `${((100 * a) / b).toFixed(1)}%`)

class Counting implements Translator {
  readonly id = "counting"
  jobs: TranslationJob[] = []
  private readonly inner = new PseudoTranslator()
  async translate(j: readonly TranslationJob[]): Promise<TranslationOutput[]> {
    this.jobs.push(...j)
    return this.inner.translate(j)
  }
}

/** Public corpus plus any private customer files in fixtures/private/ (git-ignored). */
const corpus = (): Array<[string, Uint8Array]> =>
  ["fixtures/cc0", "fixtures/third-party/simpleidml", ...(existsSync(join(ROOT, "fixtures/private")) ? ["fixtures/private"] : [])].flatMap((d) =>
    readdirSync(join(ROOT, d))
      .filter((f) => f.endsWith(".idml"))
      .map((f): [string, Uint8Array] => [`${d}/${f}`, new Uint8Array(readFileSync(join(ROOT, d, f)))]),
  )

const pseudoAll = async (bytes: Uint8Array): Promise<Map<string, string>> => {
  const g = idmlAdapter.extract(bytes, "x")
  const out = await new PseudoTranslator().translate(
    g.units.map((u) => ({ logicalId: u.structuralPath, sourceLocale: "en", targetLocale: "de", sourceTagged: u.tagged, contextRevision: "", policyRevision: "", terms: [], rules: [], prior: [] })),
  )
  return new Map(out.map((o) => [o.logicalId, o.tagged]))
}

// ── A1, A2, A8: corpus integrity, text preservation, fidelity ───────────────
{
  const files = corpus()
  let valid = 0
  let units = 0
  let preserved = 0
  let members = 0
  let identical = 0
  let noop = 0
  for (const [, bytes] of files) {
    const tr = await pseudoAll(bytes)
    const out = idmlAdapter.render(bytes, tr, { locale: "de" }).bytes
    const v = idmlAdapter.validate(bytes, out)
    if (v.ok) valid++
    // XML well-formedness of every member, mimetype first & stored
    const z = readZip(out)
    for (const e of z.entries) if (e.name.endsWith(".xml")) parseXml(entryText(e))
    const src = idmlAdapter.extract(bytes, "x").units
    const back = idmlAdapter.extract(out, "x").units
    units += src.length
    src.forEach((u, i) => {
      if (back[i] && back[i]!.structuralPath === u.structuralPath && back[i]!.plain === plainOf(tr.get(u.structuralPath)!)) preserved++
    })
    const sz = readZip(bytes)
    for (const e of sz.entries) {
      if (e.name.startsWith("Stories/")) continue
      members++
      const o = z.entries.find((x) => x.name === e.name)
      if (o && Buffer.from(o.localRecord).equals(Buffer.from(e.localRecord))) identical++
    }
    if (idmlAdapter.render(bytes, new Map(), { locale: "de" }).bytes === bytes) noop++
  }
  row({
    metric: "Native format integrity",
    target: "100% of outputs open in the target InDesign version",
    measured: `${valid}/${files.length} outputs pass structural validation (ZIP/UCF, every XML member parses, designmap references, story skeletons, inline tokens). Not opened in InDesign.`,
    status: "NOT VERIFIED",
    how: "Proxy checks in `idmlAdapter.validate`. The InDesign open/preflight/save/reopen gate from aquilla `docs/IDML_ADOBE_VALIDATION.md` must run on these outputs before this row can pass.",
  })
  row({
    metric: "Text preservation",
    target: "No missing, duplicated or misordered content",
    measured: `${preserved}/${units} units read back exactly, in order, across ${files.length} files (${files.length - 1} real InDesign exports)`,
    status: preserved === units ? "PASS" : "FAIL",
    how: "Translate every unit (pseudo-German, +30%), render, re-extract, compare unit-by-unit by structural path.",
  })
  row({
    metric: "Round-trip fidelity",
    target: "Unrelated styles, links, assets and structure intact",
    measured: `${identical}/${members} non-story members byte-identical (raw ZIP records); story markup outside text identical in ${valid}/${files.length}; no-op round trip byte-identical in ${noop}/${files.length}`,
    status: identical === members && noop === files.length && valid === files.length ? "PASS" : "FAIL",
    how: "Compare raw local ZIP records of every non-story member; compare text-masked story skeletons; render with no translations.",
  })
}

// ── Generated documents for incremental scenarios ───────────────────────────
const docFrom = (paras: readonly string[]): Uint8Array =>
  buildIdml({ stories: [{ id: "body", frames: [{ width: 300, height: 4000 }], paragraphs: paras.map((p): ParagraphSpec => ({ runs: [{ text: p }] })) }] })

// ── A3, A4: stability and incremental updates ───────────────────────────────
{
  const runs = QUICK ? 15 : 60
  let unaffected = 0
  let stable = 0
  let humanTotal = 0
  let humanKept = 0
  let translatedUnaffected = 0
  let affected = 0
  let translatedAffected = 0
  const rng = fc.sample(fc.tuple(fc.array(fc.integer({ min: 1, max: 99999 }), { minLength: 12, maxLength: 40 }), fc.array(opArb, { minLength: 1, maxLength: 5 })), { numRuns: runs, seed: 7 })
  for (const [seeds, ops] of rng) {
    const initial = [...new Set(seeds)].map((s) => sentence(s, 10 + (s % 10)))
    const dir = mkdtempSync(join(tmpdir(), "gate-"))
    try {
      Workspace.init(dir, { sourceLocale: "en", targets: ["fr"], translator: "pseudo" })
      writeFileSync(join(dir, "doc.idml"), docFrom(initial))
      const t = new Counting()
      const ws = Workspace.open(dir, "gate").withTranslator(t)
      await ws.sync()
      // Human edits on every third paragraph, recorded via the CLI path.
      const state = ws.state()
      const doc = state.docs.get("doc.idml")!
      const humanText = new Map<string, string>()
      for (const u of doc.units.filter((_, i) => i % 3 === 0)) {
        const text = `HUMAN ${u.plain.slice(0, 20)}`
        humanText.set(u.plain, text)
        await cli(["edit", join(dir, "doc.idml"), u.logicalId, "--locale", "fr", "--text", text])
      }
      await Workspace.open(dir, "gate").withTranslator(t).sync()
      // Source edit script with ground truth.
      const { truth } = applyScript(initial, ops)
      writeFileSync(join(dir, "doc.idml"), docFrom(truth.map((x) => x.text)))
      t.jobs = []
      await Workspace.open(dir, "gate").withTranslator(t).sync()
      const out = idmlAdapter.extract(new Uint8Array(readFileSync(join(dir, "translations/fr/doc.idml"))), "x").units.map((u) => u.plain)
      const asked = new Set(t.jobs.map((j) => plainOf(j.sourceTagged)))
      truth.forEach((x, i) => {
        const untouched = x.how === "unchanged" || x.how === "moved"
        if (untouched) {
          unaffected++
          if (asked.has(x.text)) translatedUnaffected++
          const h = humanText.get(x.text)
          if (h !== undefined) {
            humanTotal++
            if (out[i] === h) humanKept++
          }
          // Stable = the published translation for this paragraph did not change.
          if (!asked.has(x.text)) stable++
        } else {
          affected++
          if (asked.has(x.text)) translatedAffected++
        }
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  row({
    metric: "Unchanged-content stability",
    target: "100% of unchanged, unaffected units keep approved translations",
    measured: `${pct(stable, unaffected)} of ${unaffected} unaffected units kept their translation; ${humanKept}/${humanTotal} human translations survived verbatim`,
    status: stable === unaffected && humanKept === humanTotal ? "PASS" : "FAIL",
    how: `${runs} generated documents (12–40 paragraphs), human edits on every third paragraph, then random edit scripts (modify/insert/delete/move/split/merge), full sync through the watched-folder pipeline.`,
  })
  row({
    metric: "Incremental updates",
    target: "≥95% of straightforward edits avoid retranslating unaffected units",
    measured: `${pct(unaffected - translatedUnaffected, unaffected)} of unaffected units were not retranslated; ${translatedAffected}/${affected} affected units were (re)translated`,
    status: translatedUnaffected / Math.max(1, unaffected) <= 0.05 ? "PASS" : "FAIL",
    how: "Same scenarios; counts the jobs actually sent to the translator.",
  })
}

// ── Identity reconciliation quality at scale ────────────────────────────────
{
  const n = QUICK ? 1500 : 6000
  let decisions = 0
  let wrong = 0
  let expected = 0
  let found = 0
  let ambiguous = 0
  const cases = fc.sample(
    fc.tuple(fc.array(fc.integer({ min: 1, max: 50000 }), { minLength: 3, maxLength: 30 }), fc.array(opArb, { maxLength: 8 })),
    { numRuns: n, seed: 2026 },
  )
  for (const [seeds, ops] of cases) {
    const initial = [...new Set(seeds)].map((s) => sentence(s, 10 + (s % 8)))
    const { prev, truth } = applyScript(initial, ops)
    const m = reconcile(prev, mkUnits(truth.map((t) => t.text)))
    truth.forEach((t, i) => {
      const x = m.matches[i]!
      if (x.status === "ambiguous") ambiguous++
      else if (x.predecessors.length > 0) {
        decisions++
        if (!x.predecessors.every((p) => t.from.includes(p))) wrong++
      }
      if (t.how !== "inserted") {
        expected++
        if (x.status !== "ambiguous" && x.predecessors.some((p) => t.from.includes(p))) found++
      }
    })
  }
  row({
    metric: "Identity reconciliation (precision / recall)",
    target: "Ambiguous matches remain explicit, never guessed (spec §4.2); stop condition if ambiguity needs extensive intervention",
    measured: `${n} random edit scripts: ${wrong} wrong attributions in ${decisions} decisions (precision ${pct(decisions - wrong, decisions)}); recall ${pct(found, expected)}; escalated as ambiguous ${pct(ambiguous, expected)}`,
    status: wrong === 0 ? "PASS" : "FAIL",
    how: "Ground-truth edit scripts (test/edit-scripts.ts) over a deliberately small vocabulary, which makes unrelated paragraphs look more alike than real prose.",
  })
}

// ── A5, A6: idempotency and ordering ────────────────────────────────────────
{
  const runs = QUICK ? 300 : 2000
  const patchArb = fc
    .record({
      unit: fc.constantFrom("u1", "u2", "u3"),
      from: fc.constantFrom("none", "a", "b", "c"),
      to: fc.constantFrom("a", "b", "c", "d"),
      auth: fc.constantFrom<Authority>("agent", "human", "approved"),
      rev: fc.boolean(),
    })
    .map(({ unit, from, to, auth, rev }): ContentPatch => ({
      operationId: `${unit}:${from}>${to}:${auth}:${rev}`,
      logicalId: unit,
      expectedRevision: from === "none" ? "none" : contentHashOf(from),
      targetLocale: "fr",
      operation: from === "none" ? "insert" : "replace",
      content: to,
      authority: auth,
      revisesHuman: rev,
    }))
  let idemFail = 0
  let orderFail = 0
  const batches = fc.sample(fc.tuple(fc.array(patchArb, { maxLength: 14 }), fc.integer()), { numRuns: runs, seed: 11 })
  const view = (m: ReadonlyMap<string, unknown>): string => JSON.stringify([...m.entries()].sort())
  for (const [batch, seed] of batches) {
    const a = applyPatches(new Map(), batch)
    const again = applyPatches(a.state, batch, a.processed)
    if (again.applied.length > 0 || view(again.state) !== view(a.state)) idemFail++
    const perm = fc.sample(fc.shuffledSubarray(batch, { minLength: batch.length, maxLength: batch.length }), { numRuns: 1, seed })[0]!
    if (view(applyPatches(new Map(), perm).state) !== view(a.state)) orderFail++
  }
  row({
    metric: "Patch idempotency",
    target: "Reapplying an operation produces no additional changes",
    measured: `${runs - idemFail}/${runs} random patch batches were strict no-ops when reapplied`,
    status: idemFail === 0 ? "PASS" : "FAIL",
    how: "Property test over batches mixing inserts, chained replaces, concurrent siblings and all three authorities.",
  })
  // Ledger convergence
  const factArb = fc
    .record({ unit: fc.constantFrom("u1", "u2"), text: fc.constantFrom("a", "b", "c"), wall: fc.integer({ min: 1, max: 30 }), node: fc.constantFrom("x", "y", "z"), human: fc.boolean() })
    .map(({ unit, text, wall, node, human }): Envelope =>
      seal(
        human
          ? { type: "translation.edited", docId: "d", logicalId: unit, locale: "fr", sourceHash: "s", content: text, basedOn: "p", via: "cli" }
          : { type: "translation.proposed", docId: "d", logicalId: unit, locale: "fr", sourceHash: "s", contextRevision: "c", content: text, provenance: { translator: "t" } },
        node,
        formatHlc(wall, 0, node),
      ),
    )
  let ledgerFail = 0
  const sets = fc.sample(fc.tuple(fc.array(factArb, { maxLength: 25 }), fc.integer()), { numRuns: runs, seed: 5 })
  const proj = (e: Envelope[]): string => {
    const s = fold(e)
    return JSON.stringify([[...s.units.entries()].sort().map(([k, v]) => [k, v.proposals.map((p) => p.opId), v.human.map((h) => h.opId)]), humanConflicts(s).length])
  }
  for (const [set, seed] of sets) {
    const perm = fc.sample(fc.shuffledSubarray(set, { minLength: set.length, maxLength: set.length }), { numRuns: 1, seed })[0]!
    if (proj([...perm, ...set.slice(0, 3)]) !== proj(set)) ledgerFail++
  }
  row({
    metric: "Event ordering",
    target: "All supported concurrent-operation permutations converge",
    measured: `patch batches: ${runs - orderFail}/${runs} permutations converged; ledger: ${runs - ledgerFail}/${runs} shuffled+duplicated fact sets folded to identical state`,
    status: orderFail === 0 && ledgerFail === 0 ? "PASS" : "FAIL",
    how: "Property tests: random permutation of each batch / fact set, with duplicates for the ledger.",
  })
}

// ── A7: conflict safety (constructed cases) ─────────────────────────────────
{
  const cases: Array<[string, () => Promise<boolean>]> = []
  const withWs = async (fn: (dir: string) => Promise<boolean>): Promise<boolean> => {
    const dir = mkdtempSync(join(tmpdir(), "gate-c-"))
    try {
      Workspace.init(dir, { sourceLocale: "en", targets: ["fr"], translator: "pseudo" })
      return await fn(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  cases.push([
    "duplicate paragraph with a human edit changes multiplicity",
    () =>
      withWs(async (dir) => {
        writeFileSync(join(dir, "d.idml"), docFrom(["Amen.", "Glory to God in the highest.", "Amen."]))
        await Workspace.open(dir).sync()
        await cli(["edit", join(dir, "d.idml"), "1", "--locale", "fr", "--text", "Ainsi soit-il."])
        await Workspace.open(dir).sync()
        writeFileSync(join(dir, "d.idml"), docFrom(["Glory to God in the highest.", "Amen."]))
        const s = await Workspace.open(dir).sync()
        return (s.docs[0]!.identity.ambiguous ?? 0) > 0 && Workspace.open(dir).state().conflicts.size > 0
      }),
  ])
  cases.push([
    "edit equally close to two earlier paragraphs",
    async () => {
      const prev = mkUnits(["The meeting starts at seven in the main hall tonight.", "The meeting starts at seven in the side hall tonight."], ["a", "b"])
      return reconcile(prev, mkUnits(["The meeting starts at seven in the hall tonight."])).matches[0]!.status === "ambiguous"
    },
  ])
  cases.push([
    "two people edit the same translation concurrently",
    async () => {
      const p = contentHashOf("m")
      const e = (actor: string, content: string): Envelope =>
        seal({ type: "translation.edited", docId: "d", logicalId: "u", locale: "fr", sourceHash: "s", content, basedOn: p, via: "cli" }, actor, formatHlc(5, 0, actor))
      return humanConflicts(fold([e("ana", "A"), e("ben", "B")])).length === 1
    },
  ])
  cases.push([
    "agent output tries to overwrite a human translation",
    async () => applyPatches(new Map([["u", { content: "h", contentHash: contentHashOf("h"), authority: "human" }]]), [{ operationId: "x", logicalId: "u", expectedRevision: contentHashOf("h"), targetLocale: "fr", operation: "replace", content: "m", authority: "agent" }]).rejected.length === 1,
  ])
  cases.push([
    "stale patch against changed target",
    async () => applyPatches(new Map([["u", { content: "new", contentHash: contentHashOf("new"), authority: "agent" }]]), [{ operationId: "x", logicalId: "u", expectedRevision: contentHashOf("old"), targetLocale: "fr", operation: "replace", content: "m", authority: "agent" }]).rejected[0]?.reason === "stale",
  ])
  cases.push([
    "designer changed story markup in the target while the source changed the same story",
    () =>
      withWs(async (dir) => {
        writeFileSync(join(dir, "d.idml"), docFrom(["First paragraph of the story.", "Second paragraph of the story."]))
        await Workspace.open(dir).sync()
        const p = join(dir, "translations/fr/d.idml")
        const z = readZip(new Uint8Array(readFileSync(p)))
        const xml = entryText(z.entries.find((e) => e.name === "Stories/Story_body.xml")!)
        writeFileSync(p, rewriteZip(z, new Map([["Stories/Story_body.xml", new TextEncoder().encode(xml.replace("<CharacterStyleRange ", '<CharacterStyleRange Tracking="-10" '))]])))
        writeFileSync(join(dir, "d.idml"), docFrom(["First paragraph of the story.", "A new middle paragraph.", "Second paragraph of the story."]))
        const s = await Workspace.open(dir).sync()
        const kept = entryText(readZip(new Uint8Array(readFileSync(p))).entries.find((e) => e.name === "Stories/Story_body.xml")!).includes('Tracking="-10"')
        return s.docs[0]!.locales[0]!.conflicts.length > 0 && kept
      }),
  ])
  cases.push([
    "a target file exists that this system never published",
    () =>
      withWs(async (dir) => {
        writeFileSync(join(dir, "d.idml"), docFrom(["Hello there, friends."]))
        const { mkdirSync } = await import("node:fs")
        mkdirSync(join(dir, "translations/fr"), { recursive: true })
        writeFileSync(join(dir, "translations/fr/d.idml"), "agency deliverable")
        await Workspace.open(dir).sync()
        return readFileSync(join(dir, "translations/fr/d.idml"), "utf8") === "agency deliverable"
      }),
  ])
  cases.push([
    "a human edit made directly in the published target is not overwritten by a re-sync",
    () =>
      withWs(async (dir) => {
        writeFileSync(join(dir, "d.idml"), docFrom(["Hello there, friends."]))
        await Workspace.open(dir).sync()
        const p = join(dir, "translations/fr/d.idml")
        const z = readZip(new Uint8Array(readFileSync(p)))
        const xml = entryText(z.entries.find((e) => e.name === "Stories/Story_body.xml")!)
        writeFileSync(p, rewriteZip(z, new Map([["Stories/Story_body.xml", new TextEncoder().encode(xml.replace(/<Content>[^<]*<\/Content>/, "<Content>Bonjour les amis.</Content>"))]])))
        await Workspace.open(dir).sync()
        await Workspace.open(dir).sync()
        return idmlAdapter.extract(new Uint8Array(readFileSync(p)), "x").units[0]!.plain === "Bonjour les amis."
      }),
  ])
  let ok = 0
  const failed: string[] = []
  for (const [name, fn] of cases) {
    if (await fn()) ok++
    else failed.push(name)
  }
  row({
    metric: "Conflict safety",
    target: "100% of constructed ambiguous/conflicting cases detected, none silently overwritten",
    measured: `${ok}/${cases.length} constructed cases detected or protected${failed.length ? ` — failed: ${failed.join("; ")}` : ""}`,
    status: ok === cases.length ? "PASS" : "FAIL",
    how: cases.map(([n]) => n).join("; "),
  })
}

// ── A9: recovery ────────────────────────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), "gate-r-"))
  let ok = false
  let traced = 0
  let pubs = 0
  try {
    Workspace.init(dir, { sourceLocale: "en", targets: ["fr", "de"], translator: "pseudo" })
    const versions: Uint8Array[] = []
    for (let v = 0; v < 4; v++) {
      writeFileSync(join(dir, "d.idml"), docFrom([`Version ${v} of the opening line.`, "A stable second paragraph about the choir."]))
      await Workspace.open(dir).sync()
      versions.push(new Uint8Array(readFileSync(join(dir, "translations/fr/d.idml"))))
    }
    const ws = Workspace.open(dir)
    const list = ws.state().publishes.get("d.idml\u0000fr")!
    for (const p of [...list, ...ws.state().publishes.get("d.idml\u0000de")!]) {
      pubs++
      if (ws.getBlob(p.outputHash) && p.actor && p.sourceRevision && p.units.length > 0) traced++
    }
    await cli(["rollback", join(dir, "d.idml"), "--locale", "fr", "--to", list[1]!.opId])
    ok = Buffer.from(readFileSync(join(dir, "translations/fr/d.idml"))).equals(Buffer.from(versions[1]!))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  row({
    metric: "Recovery",
    target: "Every published change traceable and reversible",
    measured: `${traced}/${pubs} publishes carry actor, source revision, per-unit authority and stored bytes; rollback to an earlier publish ${ok ? "restored identical bytes" : "FAILED"}`,
    status: traced === pubs && ok ? "PASS" : "FAIL",
    how: "Four source revisions, two locales; `ambient rollback --to <publish>`.",
  })
}

// ── A10: rendering / overflow ───────────────────────────────────────────────
{
  let tp = 0
  let fn = 0
  let fp = 0
  let tn = 0
  for (let k = 0; k < 40; k++) {
    const words = 20 + (k % 7) * 10
    const text = sentence(k + 1, words)
    const fill = 0.55 + (k % 5) * 0.1 // source fill 55%…95%
    const expansion = 1 + (k % 4) * 0.2 // 1.0…1.6
    // Frame sized so the source occupies ~`fill` of it at 11pt in a 200pt column.
    const lines = Math.ceil((text.length * 0.5 * 11 * 1.05) / 200)
    const height = (lines * 13.75) / fill
    const bytes = buildIdml({ stories: [{ id: "s", frames: [{ width: 200, height }], paragraphs: [text] }] })
    const u = idmlAdapter.extract(bytes, "x").units[0]!
    const grown = `${text} ${text}`.slice(0, Math.round(text.length * expansion))
    const out = idmlAdapter.render(bytes, new Map([[u.structuralPath, grown]]), { locale: "de" }).bytes
    const f = idmlAdapter.layout!(bytes, out)[0]!
    const truth = fill * expansion > 1.02
    const flagged = f.severity === "overset"
    if (truth && flagged) tp++
    else if (truth) fn++
    else if (flagged) fp++
    else tn++
  }
  row({
    metric: "Rendering: overflow and missing content",
    target: "All overflow and missing-content defects in the corpus detected",
    measured: `missing content: covered by text preservation (above). Overflow estimator on 40 constructed frames: ${tp} detected, ${fn} missed, ${fp} false alarms, ${tn} correct passes`,
    status: "PARTIAL",
    how: "Calibrated geometric estimate (frames, threading, columns, insets, style point size/leading, per-script glyph widths). Real overset needs InDesign's composer; the estimator is a triage signal until the InDesign Server oracle is wired in (docs/LAYOUT.md).",
  })
}

// ── Performance (stop condition: incremental must beat regeneration) ───────
{
  const n = QUICK ? 300 : 1000
  const paras = Array.from({ length: n }, (_, i) => sentence(i + 1, 18))
  const dir = mkdtempSync(join(tmpdir(), "gate-p-"))
  let first = 0
  let second = 0
  let jobs = 0
  try {
    Workspace.init(dir, { sourceLocale: "en", targets: ["fr"], translator: "pseudo" })
    writeFileSync(join(dir, "big.idml"), docFrom(paras))
    let t = performance.now()
    await Workspace.open(dir).sync()
    first = performance.now() - t
    const edited = paras.map((p, i) => (i % 50 === 0 ? p.replace(/^\S+/, "Edited") : p))
    writeFileSync(join(dir, "big.idml"), docFrom(edited))
    const c = new Counting()
    t = performance.now()
    await Workspace.open(dir).withTranslator(c).sync()
    second = performance.now() - t
    jobs = c.jobs.length
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  row({
    metric: "Incremental cost vs full regeneration",
    target: "Incremental processing cheaper than regeneration (stop condition §9)",
    measured: `${n}-paragraph IDML: first sync ${Math.round(first)} ms; after editing 2% of paragraphs, re-sync ${Math.round(second)} ms with ${jobs} translation job(s) instead of ${n}`,
    status: jobs <= n * 0.03 ? "PASS" : "FAIL",
    how: "Engine time with the zero-cost pseudo translator; with a real model the saving is dominated by the jobs avoided.",
  })
}

// ── Write the scorecard ─────────────────────────────────────────────────────
const md = [
  "# Gate A — technical feasibility scorecard",
  "",
  `Generated by \`pnpm gate${QUICK ? " --quick" : ""}\` on ${new Date().toISOString().slice(0, 10)} (commit-independent: rerun to refresh). Every number below was measured by running the engine; nothing is hand-entered.`,
  "",
  "| Status | Metric | Target (spec §6) | Measured |",
  "| --- | --- | --- | --- |",
  ...rows.map((r) => `| **${r.status}** | ${r.metric} | ${r.target} | ${r.measured} |`),
  "",
  "## How each row is measured",
  "",
  ...rows.map((r) => `- **${r.metric}.** ${r.how}`),
  "",
  "## Reading this honestly",
  "",
  "- **NOT VERIFIED** means the claim needs Adobe software we do not run here. The structural proxy is necessary, not sufficient.",
  "- **PARTIAL** means the mechanism exists and is tested, but its ground truth is an estimate.",
  "- Gates B (customer) and C (market) cannot be measured by code; see docs/RESEARCH-PLAN.md.",
  "",
].join("\n")
writeFileSync(join(ROOT, "docs", "GATE-A.md"), md)
console.log(`\nwrote docs/GATE-A.md (${rows.filter((r) => r.status === "PASS").length}/${rows.length} PASS)`)
if (rows.some((r) => r.status === "FAIL")) process.exitCode = 1
