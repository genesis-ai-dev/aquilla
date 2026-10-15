/**
 * The product promise, end to end, on a watched folder:
 * translate once, stay translated; correct once, propagate.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { idmlAdapter } from "../src/adapters/idml/index.ts"
import { markdownAdapter } from "../src/adapters/markdown/index.ts"
import { readZip, entryText, rewriteZip } from "../src/adapters/zip.ts"
import { Workspace } from "../src/ambient/workspace.ts"
import { brochureSpec, buildIdml } from "../src/fixtures/build-idml.ts"
import { main } from "../src/ambient/cli.ts"
import { humanConflicts } from "../src/core/ledger.ts"
import { plainOf } from "../src/core/tagged.ts"
import type { TranslationJob, TranslationOutput, Translator } from "../src/engine/translator.ts"
import { PseudoTranslator } from "../src/engine/translator.ts"

/** Pseudo translator that counts what it was asked to translate. */
class CountingTranslator implements Translator {
  readonly id = "counting"
  readonly calls: TranslationJob[][] = []
  private readonly inner = new PseudoTranslator()
  async translate(jobs: readonly TranslationJob[]): Promise<TranslationOutput[]> {
    this.calls.push([...jobs])
    return this.inner.translate(jobs)
  }
  get last(): TranslationJob[] {
    return this.calls.at(-1) ?? []
  }
  reset(): void {
    this.calls.length = 0
  }
}

let dir: string
let t: CountingTranslator
const open = (): Workspace => Workspace.open(dir, "tester").withTranslator(t)
const texts = (bytes: Uint8Array): string[] => idmlAdapter.extract(bytes, "x").units.map((u) => plainOf(u.tagged))
const target = (rel: string, locale = "fr"): Uint8Array => new Uint8Array(readFileSync(join(dir, "translations", locale, rel)))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ambient-"))
  t = new CountingTranslator()
  Workspace.init(dir, { sourceLocale: "en", targets: ["fr", "de"], translator: "pseudo" })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("IDML lifecycle", () => {
  it("first sync translates everything; a second sync does nothing at all", async () => {
    writeFileSync(join(dir, "brochure.idml"), buildIdml(brochureSpec()))
    const ws = open()
    const s1 = await ws.sync()
    expect(s1.docs[0]!.locales.map((l) => l.translated)).toEqual([14, 14])
    expect(s1.written).toHaveLength(2)
    const fr = target("brochure.idml")
    expect(idmlAdapter.validate(new Uint8Array(readFileSync(join(dir, "brochure.idml"))), fr).ok).toBe(true)
    expect(texts(fr).every((x) => x.startsWith("⟦fr⟧") || x.includes("⟦fr⟧"))).toBe(true)
    const factsBefore = ws.envelopes().length
    t.reset()
    const s2 = await open().sync()
    expect(t.calls).toHaveLength(0)
    expect(s2.written).toHaveLength(0)
    expect(open().envelopes().length).toBe(factsBefore)
  })

  it("a source edit retranslates only the affected paragraph and keeps human edits made in the target file", async () => {
    writeFileSync(join(dir, "brochure.idml"), buildIdml(brochureSpec()))
    await open().sync()

    // A person fixes one paragraph directly in the French IDML (as InDesign would save it).
    const fr = target("brochure.idml")
    const zip = readZip(fr)
    const story = zip.entries.find((e) => e.name === "Stories/Story_u200.xml")!
    const xml = entryText(story)
    const machine = /<Content>(⟦fr⟧ Ŕéhéáŕšáļš[^<]*|⟦fr⟧ Réhéáršálš[^<]*)<\/Content>/.exec(xml)![1]!
    const human = "Les répétitions ont lieu chaque jeudi soir dans la salle paroissiale, à dix-neuf heures."
    const edited = rewriteZip(zip, new Map([["Stories/Story_u200.xml", new TextEncoder().encode(xml.replace(machine, human))]]))
    writeFileSync(join(dir, "translations/fr/brochure.idml"), edited)

    // Meanwhile the source changes elsewhere: one paragraph edited, one inserted.
    const spec = brochureSpec({
      u200: [
        { runs: [{ text: "Welcome to a new season of the " }, { style: "Bold", text: "Community Choir" }, { text: ". Everyone who loves to sing is welcome, whatever their experience." }] },
        "Rehearsals take place every Thursday evening in the church hall, starting at seven o'clock.",
        { runs: [{ text: "Bring water, a pencil, and your music folder. Page " }, { inline: "variable" }, { text: " lists the full schedule." }], footnote: "Parking is free after six o'clock." },
        "Our spring concert will feature music from five centuries, including two new commissions.",
        "New this year: a beginners' workshop on the first Saturday of every month.",
        { table: [["Month", "Focus"], ["September", "Warm-ups and sight reading"], ["October", "Spring concert repertoire"]] },
        "Questions? Speak to any section leader after rehearsal, or write to the choir office.",
      ],
    })
    writeFileSync(join(dir, "brochure.idml"), buildIdml(spec))
    t.reset()
    const s = await open().sync()
    const fr2 = s.docs[0]!.locales.find((l) => l.locale === "fr")!
    expect(fr2.humanEditsCaptured).toBe(1)
    // Only the edited and the inserted paragraphs went to the translator.
    const asked = t.calls.flat().filter((j) => j.targetLocale === "fr").map((j) => plainOf(j.sourceTagged))
    expect(asked.sort()).toEqual([
      "New this year: a beginners' workshop on the first Saturday of every month.",
      "Our spring concert will feature music from five centuries, including two new commissions.",
    ])
    // The human sentence survived the source update, byte-for-byte.
    const out = texts(target("brochure.idml"))
    expect(out).toContain(human)
    expect(out.some((x) => x.includes("fívé çéñtüríéš")), out.join("\n")).toBe(true)
    // German had no human edits: it was simply updated.
    expect(texts(target("brochure.idml", "de")).some((x) => x.includes("fívé"))).toBe(true)
  })

  it("source change under a human translation: revised and flagged (policy revise) or held (policy hold)", async () => {
    writeFileSync(join(dir, "brochure.idml"), buildIdml(brochureSpec()))
    await open().sync()
    expect(await main(["edit", join(dir, "brochure.idml"), "Rehearsals take place", "--locale", "fr", "--text", "Répétitions le jeudi."])).toBe(0)
    await open().sync()
    expect(texts(target("brochure.idml"))).toContain("Répétitions le jeudi.")

    const changed = (time: string): Uint8Array =>
      buildIdml(
        brochureSpec({
          u200: [
            { runs: [{ text: "Welcome to a new season of the " }, { style: "Bold", text: "Community Choir" }, { text: ". Everyone who loves to sing is welcome, whatever their experience." }] },
            `Rehearsals take place every Thursday evening in the church hall, starting at ${time} o'clock.`,
            { runs: [{ text: "Bring water, a pencil, and your music folder. Page " }, { inline: "variable" }, { text: " lists the full schedule." }], footnote: "Parking is free after six o'clock." },
            "Our spring concert will feature music from four centuries, including two new commissions.",
            { table: [["Month", "Focus"], ["September", "Warm-ups and sight reading"], ["October", "Spring concert repertoire"]] },
            "Questions? Speak to any section leader after rehearsal, or write to the choir office.",
          ],
        }),
      )
    writeFileSync(join(dir, "brochure.idml"), changed("half past seven"))
    t.reset()
    const s = await open().sync()
    const fr = s.docs[0]!.locales.find((l) => l.locale === "fr")!
    expect(fr.review).toHaveLength(1)
    expect(fr.review[0]!.reason).toMatch(/revised from the human text/)
    const job = t.calls.flat().find((j) => j.targetLocale === "fr")!
    expect(job.prior[0]).toMatchObject({ authority: "human", target: "Répétitions le jeudi." })

    // Same scenario under the "hold" policy keeps the human words verbatim.
    const cfg = JSON.parse(readFileSync(join(dir, "ambient.json"), "utf8"))
    writeFileSync(join(dir, "ambient.json"), JSON.stringify({ ...cfg, policy: { onSourceChangeUnderHuman: "hold" } }))
    writeFileSync(join(dir, "brochure.idml"), changed("eight"))
    await open().sync()
    // The human edit was for the original source; under hold it is still what we publish.
    expect(texts(target("brochure.idml"))).toContain("Répétitions le jeudi.")
  })

  it("a glossary decision retranslates only the paragraphs that contain the term", async () => {
    writeFileSync(join(dir, "brochure.idml"), buildIdml(brochureSpec()))
    await open().sync()
    process.chdir(dir)
    expect(await main(["term", "add", "church hall", "salle paroissiale", "--locale", "fr"])).toBe(0)
    t.reset()
    await open().sync()
    const asked = t.calls.flat()
    expect(asked).toHaveLength(1)
    expect(asked[0]!.targetLocale).toBe("fr")
    expect(texts(target("brochure.idml")).some((x) => x.includes("salle paroissiale"))).toBe(true)
  })

  it("a correction made once in the target file can be accepted and propagates to every machine translation", async () => {
    writeFileSync(join(dir, "brochure.idml"), buildIdml(brochureSpec()))
    await open().sync()
    const fr = target("brochure.idml")
    const zip = readZip(fr)
    const xml = entryText(zip.entries.find((e) => e.name === "Stories/Story_u100.xml")!)
    // Pseudo-French renders "Choir" as "Çhöír"; the editor prefers "Chorale".
    const edited = rewriteZip(zip, new Map([["Stories/Story_u100.xml", new TextEncoder().encode(xml.replace("Çhöír", "Chorale"))]]))
    writeFileSync(join(dir, "translations/fr/brochure.idml"), edited)
    const s = await open().sync()
    const sug = s.docs[0]!.locales.find((l) => l.locale === "fr")!.suggestions
    expect(sug).toHaveLength(1)
    expect(sug[0]).toMatchObject({ from: "Çhöír", to: "Chorale" })
    expect(sug[0]!.otherUnits).toBeGreaterThanOrEqual(2)
    process.chdir(dir)
    expect(await main(["correction", "accept", sug[0]!.id])).toBe(0)
    t.reset()
    const s2 = await open().sync()
    expect(t.calls).toHaveLength(0) // deterministic post-edit, no model call
    expect(s2.docs[0]!.locales.find((l) => l.locale === "fr")!.correctionsApplied).toBeGreaterThanOrEqual(2)
    const out = texts(target("brochure.idml")).join("\n")
    expect(out).not.toContain("Çhöír")
    expect(out.match(/Chorale/g)!.length).toBeGreaterThanOrEqual(3)
    // German is untouched by a French correction.
    expect(texts(target("brochure.idml", "de")).join("\n")).toContain("Çhöír")
  })

  it("layout edits a designer makes in the translated IDML survive later source updates (three-way merge)", async () => {
    writeFileSync(join(dir, "brochure.idml"), buildIdml(brochureSpec()))
    await open().sync()
    const fr = target("brochure.idml")
    const zip = readZip(fr)
    const spread = entryText(zip.entries.find((e) => e.name === "Spreads/Spread_sp1.xml")!)
    const widened = spread.replace(/Anchor="-110 -150"/g, 'Anchor="-140 -150"')
    expect(widened).not.toBe(spread)
    writeFileSync(join(dir, "translations/fr/brochure.idml"), rewriteZip(zip, new Map([["Spreads/Spread_sp1.xml", new TextEncoder().encode(widened)]])))
    // Source text changes.
    const spec = brochureSpec({ u100: [{ style: "Heading", runs: [{ text: "Community Choir Season Guide 2027" }] }] })
    writeFileSync(join(dir, "brochure.idml"), buildIdml(spec))
    const s = await open().sync()
    const out = target("brochure.idml")
    expect(entryText(readZip(out).entries.find((e) => e.name === "Spreads/Spread_sp1.xml")!)).toBe(widened)
    expect(texts(out)[0]).toContain("2027")
    expect(s.docs[0]!.locales.find((l) => l.locale === "fr")!.conflicts).toHaveLength(0)
  })

  it("every publish is traceable and can be rolled back byte-for-byte", async () => {
    writeFileSync(join(dir, "brochure.idml"), buildIdml(brochureSpec()))
    await open().sync()
    const v1 = target("brochure.idml")
    writeFileSync(join(dir, "brochure.idml"), buildIdml(brochureSpec({ u100: [{ style: "Heading", runs: [{ text: "A different title" }] }] })))
    await open().sync()
    expect(Buffer.from(target("brochure.idml")).equals(Buffer.from(v1))).toBe(false)
    expect(await main(["rollback", join(dir, "brochure.idml"), "--locale", "fr"])).toBe(0)
    expect(Buffer.from(target("brochure.idml")).equals(Buffer.from(v1))).toBe(true)
    const pubs = open().state().publishes.get("brochure.idml\u0000fr")!
    expect(pubs.at(-1)!.rollbackOf).toBe(pubs[0]!.opId)
  })

  it("never overwrites a target file it did not publish", async () => {
    writeFileSync(join(dir, "brochure.idml"), buildIdml(brochureSpec()))
    const { mkdirSync } = await import("node:fs")
    mkdirSync(join(dir, "translations/fr"), { recursive: true })
    writeFileSync(join(dir, "translations/fr/brochure.idml"), "precious agency file")
    const s = await open().sync()
    expect(readFileSync(join(dir, "translations/fr/brochure.idml"), "utf8")).toBe("precious agency file")
    expect(s.written).toContain("translations/fr/brochure.ambient-proposed.idml")
  })
})

describe("Markdown lifecycle (second adapter, same core)", () => {
  const doc = (extra = ""): string =>
    `---\ntitle: Choir handbook\nlayout: page\n---\n\n# Welcome\n\nThe **choir** meets on *Thursdays*. See [the calendar](https://example.org/cal).\n\n${extra}- Bring water\n- Bring a pencil\n\n\`\`\`sh\nchoir --help\n\`\`\`\n`

  it("updates incrementally and keeps human edits made in the translated Markdown", async () => {
    writeFileSync(join(dir, "handbook.md"), doc())
    await open().sync()
    const path = join(dir, "translations/fr/handbook.md")
    const fr = readFileSync(path, "utf8")
    expect(fr).toContain("```sh\nchoir --help\n```")
    expect(fr).toContain("(https://example.org/cal)")
    // Human edit in the French file.
    const edited = fr.replace(/^- ⟦fr⟧ Bríñg wátér.*$/m, "- Apportez de l'eau")
    expect(edited).not.toBe(fr)
    writeFileSync(path, edited)
    // Source gains a paragraph.
    writeFileSync(join(dir, "handbook.md"), doc("New members should arrive early.\n\n"))
    t.reset()
    const s = await open().sync()
    expect(s.docs[0]!.locales.find((l) => l.locale === "fr")!.humanEditsCaptured).toBe(1)
    expect(t.calls.flat().map((j) => plainOf(j.sourceTagged))).toEqual(["New members should arrive early.", "New members should arrive early."])
    const after = readFileSync(path, "utf8")
    expect(after).toContain("- Apportez de l'eau")
    expect(after).toContain("Ñéw")
    expect(markdownAdapter.validate(new Uint8Array(readFileSync(join(dir, "handbook.md"))), new Uint8Array(readFileSync(path))).ok).toBe(true)
  })
})

describe("JSON strings lifecycle (third adapter, native anchors)", () => {
  it("translates values, protects placeholders, and follows renamed text by key", async () => {
    const src = { app: { title: "Choir planner", greeting: "Hello {name}, you have {count} rehearsals", rich: "Read the <0>rules</0> first" } }
    writeFileSync(join(dir, "ui.i18n.json"), JSON.stringify(src, null, 2))
    await open().sync()
    const fr = JSON.parse(readFileSync(join(dir, "translations/fr/ui.i18n.json"), "utf8"))
    expect(fr.app.greeting).toContain("{name}")
    expect(fr.app.greeting).toContain("{count}")
    expect(fr.app.rich).toMatch(/<0>.*<\/0>/)
    src.app.title = "Choir planner and roster"
    writeFileSync(join(dir, "ui.i18n.json"), JSON.stringify(src, null, 2))
    t.reset()
    const s = await open().sync()
    expect(s.docs[0]!.identity).toMatchObject({ modified: 1, unchanged: 2 })
    expect(t.calls.flat()).toHaveLength(2)
  })
})

describe("replicas", () => {
  it("two people editing the same translation concurrently on different machines are surfaced, not silently merged", async () => {
    writeFileSync(join(dir, "brochure.idml"), buildIdml(brochureSpec()))
    await open().sync()
    const other = mkdtempSync(join(tmpdir(), "ambient-replica-"))
    try {
      // Replica B starts from A's ledger.
      writeFileSync(join(other, "ambient.json"), readFileSync(join(dir, "ambient.json")))
      const a = Workspace.open(dir, "ana")
      const b = Workspace.open(other, "ben")
      b.importLedger(a.envelopes())
      expect(await main(["edit", join(dir, "brochure.idml"), "Questions?", "--locale", "fr", "--text", "Des questions ? Demandez à un chef de pupitre."])).toBe(0)
      const s = b.state()
      const u = s.docs.get("brochure.idml")!.units.find((x) => x.plain.startsWith("Questions?"))!
      const { effectiveTranslation } = await import("../src/core/ledger.ts")
      const { unitContext } = await import("../src/core/context.ts")
      const eff = effectiveTranslation(s, "brochure.idml", u.logicalId, "fr", u.contentHash, unitContext(s, "fr", u.plain).contextRevision)!
      b.record({ type: "translation.edited", docId: "brochure.idml", logicalId: u.logicalId, locale: "fr", sourceHash: u.contentHash, content: "Une question ? Écrivez au bureau.", basedOn: eff.contentHash, via: "cli" })
      // Exchange ledgers both ways.
      Workspace.open(dir, "ana").importLedger(b.envelopes())
      b.importLedger(Workspace.open(dir, "ana").envelopes())
      const sa = Workspace.open(dir, "ana").state()
      const sb = b.state()
      expect(humanConflicts(sa)).toHaveLength(1)
      expect(humanConflicts(sb)).toHaveLength(1)
      // Both replicas agree on the deterministic winner.
      const winA = effectiveTranslation(sa, "brochure.idml", u.logicalId, "fr", u.contentHash, "x")
      const winB = effectiveTranslation(sb, "brochure.idml", u.logicalId, "fr", u.contentHash, "x")
      expect(winA!.content).toBe(winB!.content)
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })
})
