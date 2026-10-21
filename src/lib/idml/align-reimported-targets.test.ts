import JSZip from "jszip"
import { describe, expect, it, vi } from "vitest"
import {
  parseIdml,
  renderIdmlUnitHtml,
  validateIdmlTranslation,
  type IdmlTranslationUnit,
} from "@aquilla/idml-roundtrip"
import type { CellRow } from "@/lib/sync/cells-read-types"
import {
  alignReimportedIdmlTargets,
  commitsForAlignedIdmlTargets,
  idmlReimportPlacement,
  pairedCellsForIdmlAlignment,
  type IdmlReimportAlignCell,
} from "./align-reimported-targets"

const IDML_MIME = "application/vnd.adobe.indesign-idml-package"
const IDPKG = 'xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"'

describe("IDML re-import style alignment", () => {
  it("places a legacy translation into the source runs and chains the commit on the existing target", async () => {
    const unit = await parsedUnit(["Hello", "WORLD"])
    const cell = legacyCell(unit, "cell-1", "Bonjour MONDE")
    const ask = vi.fn().mockResolvedValue(JSON.stringify({
      slots: [{ i: 0, t: "Bonjour " }, { i: 1, t: "MONDE" }],
    }))

    const outcome = await alignReimportedIdmlTargets([cell], ask)

    expect(ask).toHaveBeenCalledOnce()
    expect(outcome.failed).toBe(0)
    expect(outcome.aligned).toHaveLength(1)
    const html = outcome.aligned[0]!.completion.valueHtml!
    const checked = validateIdmlTranslation(unit.sourceHtml, html, unit.metadata)
    expect(checked.valid).toBe(true)
    expect(checked.slots[0]).toBe("Bonjour ")
    expect(checked.slots[1]).toBe("MONDE")

    const [commit] = commitsForAlignedIdmlTargets(outcome.aligned, {
      projectId: "project",
      fileId: "file",
      author: "frontier-default",
      model: "frontier-default",
      provider: "frontier",
      sourceLanguage: "en",
      targetLanguage: "pt",
    })
    expect(commit?.cellId).toBe("cell-1")
    expect(commit?.parentId).toBe("target-event")
    expect(commit?.sourceEventId).toBe("source-event")
    expect(commit?.valueHtml).toBe(html)
    expect(commit?.aiDraft?.mode).toBe("align-styles")
    expect(commit?.value.replace(/\s+/g, " ").trim()).toBe("Bonjour MONDE")
  })

  it("keeps the translation when the model changes the wording, and still aligns the next cell", async () => {
    const unit = await parsedUnit(["Hello", "WORLD"])
    const broken = legacyCell(unit, "broken", "Bonjour MONDE")
    const kept = legacyCell(unit, "kept", "disse o Senhor")
    const ask = vi.fn(async (messages: readonly { content: string }[]) => {
      const wording = messages[1]?.content ?? ""
      if (wording.includes("Bonjour MONDE")) {
        return JSON.stringify({ slots: [{ i: 0, t: "Olá " }, { i: 1, t: "MUNDO" }] })
      }
      return JSON.stringify({ slots: [{ i: 0, t: "disse " }, { i: 1, t: "o Senhor" }] })
    })

    const outcome = await alignReimportedIdmlTargets([broken, kept], ask, { concurrency: 1 })

    expect(outcome.failed).toBe(0)
    expect(outcome.aligned.map((entry) => entry.cell.id)).toEqual(["broken", "kept"])
    const brokenHtml = outcome.aligned[0]!.completion.valueHtml!
    const brokenSlots = validateIdmlTranslation(unit.sourceHtml, brokenHtml, unit.metadata)
    expect(brokenSlots.valid).toBe(true)
    expect(brokenSlots.slots.join("")).toContain("Bonjour MONDE")
    expect(brokenSlots.slots.join("")).not.toContain("Olá")
    expect(outcome.aligned[1]!.completion.value.replace(/\s+/g, " ").trim()).toBe("disse o Senhor")
  })

  it("does not call the model for a target that already matches the new source", async () => {
    const unit = await parsedUnit(["Hello", "WORLD"])
    const cell: IdmlReimportAlignCell = {
      ...legacyCell(unit, "ready", "Bonjour MONDE"),
      translatedHtml: renderIdmlUnitHtml({
        ...unit,
        slots: unit.slots.map((slot, index) => ({
          ...slot,
          text: index === 0 ? "Bonjour " : "MONDE",
        })),
      }),
    }
    const ask = vi.fn()

    const outcome = await alignReimportedIdmlTargets([cell], ask)

    expect(idmlReimportPlacement(cell)).toBe("current")
    expect(ask).not.toHaveBeenCalled()
    expect(outcome.aligned).toHaveLength(0)
    expect(outcome.unchanged).toBe(1)
  })

  it("stitches a one-run translation without a model call", async () => {
    const unit = await parsedUnit(["Hello WORLD"])
    const cell = legacyCell(unit, "single", "Bonjour MONDE")
    const ask = vi.fn()

    const outcome = await alignReimportedIdmlTargets([cell], ask)

    expect(idmlReimportPlacement(cell)).toBe("single")
    expect(ask).not.toHaveBeenCalled()
    expect(outcome.aligned).toHaveLength(1)
    const html = outcome.aligned[0]!.completion.valueHtml!
    const checked = validateIdmlTranslation(unit.sourceHtml, html, unit.metadata)
    expect(checked.valid).toBe(true)
    expect(checked.slots.join("")).toBe("Bonjour MONDE")
  })

  it("places a long note into its runs without calling the model", async () => {
    const unit = await parsedUnit(["Hello", "WORLD"])
    const translated = `${"O comandante do exército do Senhor era um ser espiritual. ".repeat(20)}`
    const cell = legacyCell(unit, "long-note", translated)
    const ask = vi.fn()

    const outcome = await alignReimportedIdmlTargets([cell], ask)

    expect(translated.replace(/\s+/g, " ").trim().length).toBeGreaterThan(1000)
    expect(ask).not.toHaveBeenCalled()
    expect(outcome.failed).toBe(0)
    expect(outcome.manual).toHaveLength(0)
    expect(outcome.aligned).toHaveLength(1)
    expect(outcome.aligned[0]!.completion.value).toBe(translated)
    const checked = validateIdmlTranslation(
      unit.sourceHtml,
      outcome.aligned[0]!.completion.valueHtml!,
      unit.metadata,
    )
    expect(checked.valid).toBe(true)
    expect(checked.slots[1]?.replace(/\s+/g, " ").trim().length).toBeGreaterThan(0)
  })

  it("places scripture references and bold phrases without calling the model", async () => {
    const unit = await parsedStyled([
      ["CharacterStyle/bd", "1:1\u201315"],
      ["CharacterStyle/Plain", " "],
      ["CharacterStyle/k_xt", "John"],
      ["CharacterStyle/Plain", " called the "],
      ["CharacterStyle/k_xt", "church elder"],
      ["CharacterStyle/Plain", ". In "],
      ["CharacterStyle/xt", "1 John 3:18"],
      ["CharacterStyle/Plain", " about "],
      ["CharacterStyle/k_xt", "faith"],
      ["CharacterStyle/Plain", " and the "],
      ["CharacterStyle/k_xt", "good news"],
      ["CharacterStyle/Plain", "."],
    ])
    const translated = "1.1\u201315 João chamou o presbítero. Em 1 João 3.18 sobre a fé e as boas-novas."
    const cell = legacyCell(unit, "acts-note", translated)
    const ask = vi.fn()

    const outcome = await alignReimportedIdmlTargets([cell], ask)

    expect(ask).not.toHaveBeenCalled()
    expect(outcome.manual).toHaveLength(0)
    expect(outcome.aligned).toHaveLength(1)
    const html = outcome.aligned[0]!.completion.valueHtml!
    const checked = validateIdmlTranslation(unit.sourceHtml, html, unit.metadata)
    expect(checked.valid).toBe(true)
    expect(checked.slots[0]).toBe("1.1\u201315")
    expect(checked.slots[2]).toContain("João")
    expect(checked.slots[4]).toContain("presbítero")
    expect(checked.slots[6]).toBe("1 João 3.18")
    expect(checked.slots[8]).toContain("fé")
    expect(checked.slots[10]).toContain("boas-novas")
    expect(outcome.aligned[0]!.completion.value).toBe(translated)
  })

  it("keeps the saved words when it places phrases the model was not asked for", async () => {
    const unit = await parsedStyled([
      ["CharacterStyle/k_xt", "John"],
      ["CharacterStyle/Plain", " and "],
      ["CharacterStyle/k_xt", "faith"],
      ["CharacterStyle/Plain", " and "],
      ["CharacterStyle/k_xt", "church"],
      ["CharacterStyle/Plain", " and "],
      ["CharacterStyle/k_xt", "Peter"],
      ["CharacterStyle/Plain", "."],
    ])
    const translated = "João e a fé e a igreja e Pedro."
    const cell = legacyCell(unit, "missing-phrase", translated)
    const ask = vi.fn()

    const outcome = await alignReimportedIdmlTargets([cell], ask)

    expect(ask).not.toHaveBeenCalled()
    expect(outcome.manual).toHaveLength(0)
    expect(outcome.aligned).toHaveLength(1)
    expect(outcome.aligned[0]!.completion.value).toBe(translated)
    const checked = validateIdmlTranslation(
      unit.sourceHtml,
      outcome.aligned[0]!.completion.valueHtml!,
      unit.metadata,
    )
    expect(checked.slots[0]).toContain("João")
    expect(checked.slots[2]).toContain("fé")
    expect(checked.slots[4]).toContain("igreja")
    expect(checked.slots[6]).toContain("Pedro")
  })

  it("places the Exodus covenant note into its keyword runs without a model call", async () => {
    const unit = await parsedStyled([
      ["CharacterStyle/bd", "1:1 – 2:25"],
      ["CharacterStyle/Plain", " "],
      ["CharacterStyle/k_xt", "God"],
      ["CharacterStyle/Plain", " made a "],
      ["CharacterStyle/k_xt", "covenant with Abraham"],
      ["CharacterStyle/Plain", " in Genesis. In this "],
      ["CharacterStyle/k_xt", "covenant"],
      ["CharacterStyle/Plain", " God promised to give "],
      ["CharacterStyle/k_xt", "Abraham"],
      ["CharacterStyle/Plain", " many children and grandchildren. They would become a nation of many people. He promised to give them the land of "],
      ["CharacterStyle/k_xt", "Canaan"],
      ["CharacterStyle/Plain", " to live in. And he promised to "],
      ["CharacterStyle/k_xt", "bless all nations"],
      ["CharacterStyle/Plain", " and people groups on earth through them. Exodus shows that God"],
      ["CharacterStyle/source serif", "\u02BC"],
      ["CharacterStyle/Plain", "s first promise began to be fulfilled. Abraham"],
      ["CharacterStyle/source serif", "\u02BC"],
      ["CharacterStyle/Plain", "s "],
      ["CharacterStyle/k_xt", "family line"],
      ["CharacterStyle/Plain", " through "],
      ["CharacterStyle/k_xt", "Jacob"],
      ["CharacterStyle/Plain", " had grown very large. The new "],
      ["CharacterStyle/k_xt", "Pharaoh"],
      ["CharacterStyle/Plain", " of "],
      ["CharacterStyle/k_xt", "Egypt"],
      ["CharacterStyle/Plain", " was worried because there were so many "],
      ["CharacterStyle/k_xt", "Israelites"],
      ["CharacterStyle/Plain", ". So he made them work as "],
      ["CharacterStyle/k_xt", "slaves"],
      ["CharacterStyle/Plain", ". He later commanded that all male babies born to Israelite families must be killed. But Shiphrah and Puah helped save the boys when they were born. They were the women who helped mothers give birth. And Pharaoh"],
      ["CharacterStyle/source serif", "\u02BC"],
      ["CharacterStyle/Plain", "s daughter saved "],
      ["CharacterStyle/k_xt", "Moses"],
      ["CharacterStyle/Plain", " from dying in the "],
      ["CharacterStyle/k_xt", "River Nile"],
      ["CharacterStyle/Plain", "."],
    ])
    const translated = "1.1 – 2.25 Deus fez uma aliança com Abraão em Gênesis. Nessa aliança, Deus prometeu dar a Abraão muitos filhos e netos. Eles se tornariam uma nação de muitas pessoas. Deus prometeu dar a eles a terra de Canaã para morar. E prometeu abençoar todas as nações e povos da terra por meio deles. Êxodo mostra que a primeira promessa de Deus começou a se cumprir. A descendência de Abraão por meio de Jacó havia crescido muito. O novo faraó do Egito ficou preocupado porque havia muitos israelitas. Por isso, ele os fez trabalhar como escravos. Mais tarde, ele ordenou que todos os meninos recém-nascidos das famílias israelitas fossem mortos. Mas Sifrá e Puá ajudaram a salvar os meninos quando eles nasciam. Elas eram as mulheres que ajudavam as mães no parto. E a filha do faraó salvou Moisés de morrer no rio Nilo."
    const ask = vi.fn()

    const outcome = await alignReimportedIdmlTargets([legacyCell(unit, "exodus-178", translated)], ask)

    expect(ask).not.toHaveBeenCalled()
    expect(outcome.aligned).toHaveLength(1)
    expect(outcome.aligned[0]!.completion.value).toBe(translated)
    const checked = validateIdmlTranslation(unit.sourceHtml, outcome.aligned[0]!.completion.valueHtml!, unit.metadata)
    expect(checked.valid).toBe(true)
    expect(checked.slots[0]).toBe("1.1 – 2.25")
    expect(checked.slots[2]).toContain("Deus")
    expect(checked.slots[4]).toContain("Abraão")
    expect(checked.slots[6]).toContain("aliança")
    expect(checked.slots[8]).toContain("Abraão")
    expect(checked.slots[10]).toContain("Canaã")
    expect(checked.slots[12]).toContain("nações")
    expect(checked.slots[22]).toContain("faraó")
    expect(checked.slots[24]).toContain("Egito")
    expect(checked.slots[26]).toContain("israelitas")
    expect(checked.slots[28]).toContain("escravos")
    expect(checked.slots[32]).toContain("Moisés")
    expect(checked.slots[34]).toContain("Nilo")
  })

  it("places the 3 John note references and keywords without a model call", async () => {
    const unit = await parsedStyled([
      ["CharacterStyle/bd", "1:1–15"],
      ["CharacterStyle/Plain", " "],
      ["CharacterStyle/k_xt", "John"],
      ["CharacterStyle/Plain", " called himself the elder. He may have been talking about his age or about being a "],
      ["CharacterStyle/k_xt", "church elder"],
      ["CharacterStyle/Plain", ". He was full of joy because his friend Gaius"],
      ["CharacterStyle/source serif", "\u02BC"],
      ["CharacterStyle/Plain", " "],
      ["CharacterStyle/k_xt", "spiritual"],
      ["CharacterStyle/Plain", " life was going well. This meant that Gaius was following "],
      ["CharacterStyle/k_xt", "Jesus"],
      ["CharacterStyle/Plain", " faithfully. In "],
      ["CharacterStyle/xt", "1 John 3:18"],
      ["CharacterStyle/Plain", " John wrote about "],
      ["CharacterStyle/k_xt", "believers"],
      ["CharacterStyle/Plain", " putting their "],
      ["CharacterStyle/k_xt", "faith"],
      ["CharacterStyle/Plain", " and love into action. Gaius did that by welcoming and helping believers who were travelling. In this way he supported people who spread the "],
      ["CharacterStyle/k_xt", "good news"],
      ["CharacterStyle/Plain", " about Jesus. This was very different from what a man named Diotrephes did. Diotrephes ruled over others in the "],
      ["CharacterStyle/k_xt", "church"],
      ["CharacterStyle/Plain", ". This went against "],
      ["CharacterStyle/k_xt", "Peter"],
      ["CharacterStyle/source serif", "\u02BC"],
      ["CharacterStyle/k_xt", "s"],
      ["CharacterStyle/Plain", " instructions for church leaders in "],
      ["CharacterStyle/xt", "1 Peter 5:3"],
      ["CharacterStyle/Plain", ". Diotrephes told lies about John. John planned to speak to Diotrephes about what he was doing wrong. His plan agreed with what "],
      ["CharacterStyle/k_xt", "Paul"],
      ["CharacterStyle/Plain", " taught about correcting "],
      ["CharacterStyle/k_xt", "church elders"],
      ["CharacterStyle/Plain", " in "],
      ["CharacterStyle/xt", "1 Timothy 5:20"],
      ["CharacterStyle/Plain", ". John wanted Gaius to avoid doing evil and instead to do good. Demetrius was an example of a believer who did good. He was faithful to the truth about Jesus."],
    ])
    const translated = "1.1–15 João chamou a si mesmo de ancião. Talvez estivesse falando da própria idade ou de ser um presbítero da igreja. Estava cheio de alegria porque a vida espiritual do seu amigo Gaio ia bem. Isso queria dizer que Gaio seguia Jesus fielmente. Em 1 João 3.18, João escreveu sobre crentes que praticam a fé e o amor. Gaio fez isso ao receber e ajudar crentes que estavam viajando. Assim, apoiava quem anunciava as boas-novas sobre Jesus. Isso era muito diferente do que fazia um homem chamado Diótrefes. Diótrefes dominava os outros na igreja. Isso ia contra as instruções de Pedro para os líderes da igreja em 1 Pedro 5.3. Diótrefes contava mentiras sobre João. João planejava falar com Diótrefes sobre o que ele fazia de errado. Em 1 Timóteo 5.20, Paulo ensinou sobre corrigir presbíteros da igreja. O plano de João estava de acordo com esse ensino. João queria que Gaio evitasse fazer o mal e, em vez disso, fizesse o bem. Demétrio era exemplo de um crente que fazia o bem. Era fiel à verdade sobre Jesus."
    const ask = vi.fn()

    const outcome = await alignReimportedIdmlTargets([legacyCell(unit, "acts-1924", translated)], ask)

    expect(ask).not.toHaveBeenCalled()
    expect(outcome.aligned).toHaveLength(1)
    expect(outcome.aligned[0]!.completion.value).toBe(translated)
    const checked = validateIdmlTranslation(unit.sourceHtml, outcome.aligned[0]!.completion.valueHtml!, unit.metadata)
    expect(checked.valid).toBe(true)
    expect(checked.slots[0]).toBe("1.1–15")
    expect(checked.slots[2]).toContain("João")
    expect(checked.slots[8]).toContain("espiritual")
    expect(checked.slots[10]).toContain("Jesus")
    expect(checked.slots[12]).toBe("1 João 3.18")
    expect(checked.slots[18]).toContain("boas-novas")
    expect(checked.slots[20]).toContain("igreja")
    expect(checked.slots[26]).toBe("1 Pedro 5.3")
    expect(checked.slots[32]).toBe("1 Timóteo 5.20")
  })

  it("aligns again when protected HTML leaves a bold run empty", async () => {
    const unit = await parsedUnit(["Hello", "WORLD"])
    const translatedHtml = renderIdmlUnitHtml({
      ...unit,
      slots: unit.slots.map((slot, index) => ({
        ...slot,
        text: index === 0 ? "Bonjour MONDE" : "",
      })),
    })
    const cell: IdmlReimportAlignCell = {
      ...legacyCell(unit, "shifted", "Bonjour MONDE"),
      translatedHtml,
    }

    expect(validateIdmlTranslation(unit.sourceHtml, translatedHtml, unit.metadata).valid).toBe(true)
    expect(idmlReimportPlacement(cell)).toBe("align")
  })

  it("keeps the translation when Align styles crashes instead of saving an empty target", async () => {
    const unit = await parsedUnit(["Hello", "WORLD"])
    const cell: IdmlReimportAlignCell = {
      ...legacyCell(unit, "crash", "Bonjour MONDE"),
      originalHtml: "<div>not a paragraph</div>",
    }
    const ask = vi.fn().mockRejectedValue(new Error("context length exceeded"))

    const outcome = await alignReimportedIdmlTargets([cell], ask)

    expect(outcome.aligned).toHaveLength(0)
    expect(outcome.failed).toBe(0)
    expect(outcome.manual.map((entry) => entry.id)).toEqual(["crash"])
    expect(outcome.manual[0]?.translated).toBe("Bonjour MONDE")
  })

  it("stops before the next cell when alignment is cancelled", async () => {
    const unit = await parsedUnit(["Hello", "WORLD"])
    const controller = new AbortController()
    const ask = vi.fn(async () => {
      controller.abort()
      return JSON.stringify({ slots: [{ i: 0, t: "Bonjour " }, { i: 1, t: "MONDE" }] })
    })

    const outcome = await alignReimportedIdmlTargets(
      [legacyCell(unit, "first", "Bonjour MONDE"), legacyCell(unit, "second", "Bonjour MONDE")],
      ask,
      { concurrency: 1, signal: controller.signal },
    )

    expect(ask).toHaveBeenCalledOnce()
    expect(outcome.aligned.map((entry) => entry.cell.id)).toEqual(["first"])
  })

  it("pairs the new source with the translation on the same lane", () => {
    const cells = pairedCellsForIdmlAlignment([
      row("source", "cell-1", "source-event", "<p>new</p>", "Hello"),
      row("target", "cell-1", "target-event", "<p>old</p>", "Olá", ""),
      row("target", "cell-1", "other-event", "<p>other</p>", "Hola", "es"),
    ])

    expect(cells).toEqual([expect.objectContaining({
      id: "cell-1",
      originalHtml: "<p>new</p>",
      translated: "Olá",
      translatedHtml: "<p>old</p>",
      sourceEventId: "source-event",
      targetEventId: "target-event",
    })])
  })
})

function legacyCell(unit: IdmlTranslationUnit, id: string, translated: string): IdmlReimportAlignCell {
  return {
    id,
    originalHtml: unit.sourceHtml,
    translated,
    translatedHtml: `<p>${translated}</p>`,
    metadata: { idml: unit.metadata },
    sourceEventId: "source-event",
    targetEventId: "target-event",
  }
}

function row(
  side: "source" | "target",
  cellId: string,
  eventId: string,
  valueHtml: string,
  value: string,
  targetLang = "",
): CellRow {
  return {
    cellId,
    side,
    targetLang,
    value,
    valueHtml,
    type: "text",
    canonicalRef: null,
    anchorCellId: null,
    eventId,
    sourceEventId: null,
    lastEditor: null,
    lastEditAt: 0,
    validated: false,
    wordCount: 1,
  }
}

async function parsedUnit(runs: readonly string[]): Promise<IdmlTranslationUnit> {
  return parsedStyled(runs.map((text, index) => [
    index === 0 ? "CharacterStyle/Plain" : "CharacterStyle/Bold",
    text,
  ]))
}

async function parsedStyled(runs: readonly (readonly [string, string])[]): Promise<IdmlTranslationUnit> {
  const storyPath = "Stories/Story_u100.xml"
  const ranges = runs.map(([style, text]) => (
    `<CharacterStyleRange AppliedCharacterStyle="${style}"><Content>${text}</Content></CharacterStyleRange>`
  )).join("")
  const zip = new JSZip()
  zip.file("mimetype", IDML_MIME, { compression: "STORE", createFolders: false })
  zip.file(
    "designmap.xml",
    `<?xml version="1.0"?><Document ${IDPKG}><idPkg:Story src="${storyPath}"/></Document>`,
    { compression: "DEFLATE", createFolders: false },
  )
  zip.file(
    storyPath,
    [
      `<?xml version="1.0"?><idPkg:Story ${IDPKG}><Story Self="u100">`,
      '<ParagraphStyleRange Self="mixed" AppliedParagraphStyle="ParagraphStyle/Body">',
      ranges,
      "</ParagraphStyleRange></Story></idPkg:Story>",
    ].join(""),
    { compression: "DEFLATE", createFolders: false },
  )
  const parsed = await parseIdml(await zip.generateAsync({
    type: "arraybuffer",
    compression: "DEFLATE",
  }))
  const unit = parsed.units[0]
  if (!unit) throw new Error("Missing IDML re-import fixture unit")
  return unit
}
