import JSZip from "jszip"
import { describe, expect, it } from "vitest"
import { inspectIdml } from "./archive.js"
import { IdmlError } from "./errors.js"
import { exportIdml, parseIdml, validateExport } from "./engine.js"
import { upgradeLegacyIdmlMetadata } from "./legacy.js"
import type { IdmlTranslation, IdmlTranslationUnit } from "./types.js"
import { makeIdml, mixedStoryXml } from "./test-helpers/idml-fixture.js"

describe("IDML structural parser", () => {
  it("creates immutable ordered units without allowing outer paragraphs to steal nested slots", async () => {
    const bytes = await makeIdml()
    const parsed = await parseIdml(bytes)

    expect(parsed.units.map((unit) => unit.locator.elementId)).toEqual([
      "p1",
      "p2",
      "p3",
      "p4",
      "p9",
      "TextVariable/Custom",
    ])
    const outer = unitById(parsed.units, "p1")
    expect(outer.slots.map((slot) => slot.text)).toEqual([
      " Bold ",
      "and",
      " italic e\u0301漢字",
    ])
    expect(outer.slots.map((slot) => slot.characterStyleId)).toEqual([
      "CharacterStyle/Bold",
      "CharacterStyle/Bold",
      "CharacterStyle/Italic",
    ])
    expect(outer.sourceText).toBe(" Bold and italic e\u0301漢字")
    expect(outer.locator.slotIndexes).toEqual([0, 1, 2])
    expect(outer.locator.sourceBlockHash).toMatch(/^[a-f0-9]{64}$/)
    expect(outer.protectedTokens.map(({ kind, position }) => ({ kind, position }))).toEqual([
      { kind: "cross-reference", position: 3 },
      { kind: "variable", position: 3 },
      { kind: "unknown", position: 3 },
      { kind: "inline-object", position: 3 },
      { kind: "br", position: 3 },
    ])
    expect(unitById(parsed.units, "p2").slots.map((slot) => slot.text)).toEqual([" cell "])
    expect(unitById(parsed.units, "p2").locator.scope).toBe("table-cell")
    expect(unitById(parsed.units, "p3").slots.map((slot) => slot.text)).toEqual(["foot&note"])
    expect(unitById(parsed.units, "p3").locator.scope).toBe("footnote")
    expect(unitById(parsed.units, "p4").locator.scope).toBe("anchored-story")
    expect(unitById(parsed.units, "p9").order).toBe(4)
    expect(unitById(parsed.units, "TextVariable/Custom").locator.scope).toBe("custom-variable")
    expect(parsed.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "UNSUPPORTED_CONSTRUCT",
        message: expect.stringContaining("Computed"),
        details: expect.objectContaining({
          unsupportedDisposition: "preserved-nonliteral",
          constructKind: "computed-text-variable",
        }),
      }),
    )
    expect(outer.diagnostics).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("Unknown inline IDML element <Mystery>"),
        details: expect.objectContaining({
          unsupportedDisposition: "preserved-nonliteral",
          constructKind: "unknown-inline-element",
          xmlName: "Mystery",
        }),
      }),
    )

    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.isFrozen(parsed.units)).toBe(true)
    expect(Object.isFrozen(outer)).toBe(true)
    expect(Object.isFrozen(outer.slots)).toBe(true)
    expect(Object.isFrozen(parsed.manifest)).toBe(true)
    expect(parsed.manifest.members).toHaveLength(9)
  })

  it("discovers designmap stories first and appends remaining stories deterministically", async () => {
    const parsed = await parseIdml(await makeIdml())
    expect(parsed.units.map((unit) => unit.locator.memberPath)).toEqual([
      "Stories/Story_u1.xml",
      "Stories/Story_u1.xml",
      "Stories/Story_u1.xml",
      "Stories/Story_u3.xml",
      "Stories/Story_u9.xml",
      "Resources/TextVariables.xml",
    ])
  })

  it("orders spread and master-spread story references before unreferenced stories", async () => {
    const story = (storyId: string, paragraphId: string) =>
      `<?xml version="1.0"?><idPkg:Story xmlns:idPkg="urn:test"><Story Self="${storyId}"><ParagraphStyleRange Self="${paragraphId}"><CharacterStyleRange><Content>${storyId}</Content></CharacterStyleRange></ParagraphStyleRange></Story></idPkg:Story>`
    const parsed = await parseIdml(
      await makeIdml({
        "designmap.xml": `<?xml version="1.0"?><idPkg:DesignMap xmlns:idPkg="urn:test"><idPkg:MasterSpread src="MasterSpreads/MasterSpread_first.xml"/><idPkg:Spread src="Spreads/Spread_second.xml"/></idPkg:DesignMap>`,
        "MasterSpreads/MasterSpread_first.xml":
          `<?xml version="1.0"?><idPkg:MasterSpread xmlns:idPkg="urn:test"><TextFrame ParentStory="master"/></idPkg:MasterSpread>`,
        "Spreads/Spread_second.xml":
          `<?xml version="1.0"?><idPkg:Spread xmlns:idPkg="urn:test"><TextFrame ParentStory="spread"/></idPkg:Spread>`,
        "Stories/Story_u1.xml": null,
        "Stories/Story_u3.xml": null,
        "Stories/Story_u9.xml": null,
        "Stories/Story_z.xml": story("master", "pmaster-order"),
        "Stories/Story_y.xml": story("spread", "pspread-order"),
        "Stories/Story_a.xml": story("remaining", "premaining-order"),
      }),
    )

    expect(parsed.units.map((unit) => unit.locator.elementId)).toEqual([
      "pmaster-order",
      "pspread-order",
      "premaining-order",
      "TextVariable/Custom",
    ])
  })

  it("keeps unknown non-self-closing containers opaque while traversing known literal wrappers", async () => {
    const story = `<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Story xmlns:idPkg="urn:test"><Story Self="u1"><ParagraphStyleRange Self="popaque"><CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Body"><Content>before</Content><HyperlinkTextSource Self="link"><Content>linked</Content></HyperlinkTextSource><FutureContainer Self="future"><Content>must stay locked</Content></FutureContainer><Content>after</Content></CharacterStyleRange></ParagraphStyleRange></Story></idPkg:Story>`
    const bytes = await makeIdml({ "Stories/Story_u1.xml": story })
    const parsed = await parseIdml(bytes)
    const unit = unitById(parsed.units, "popaque")

    expect(unit.slots.map((slot) => slot.text)).toEqual(["before", "linked", "after"])
    expect(unit.slots.some((slot) => slot.text.includes("must stay locked"))).toBe(false)
    expect(unit.protectedTokens).toContainEqual(
      expect.objectContaining({ kind: "unknown", xmlName: "FutureContainer", position: 2 }),
    )
    expect(unit.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "UNSUPPORTED_CONSTRUCT",
        details: expect.objectContaining({
          unsupportedDisposition: "unsupported-literal",
          constructKind: "unknown-inline-element",
          xmlName: "FutureContainer",
        }),
      }),
    )

    const targetHtml = unit.sourceHtml
      .replace(">before<", ">avant<")
      .replace(">linked<", ">lié<")
      .replace(">after<", ">après<")
    const exported = await exportIdml(bytes, [translationFor(unit, targetHtml)], { strict: true })
    const exportedStory = await memberText(exported.bytes, "Stories/Story_u1.xml")
    expect(exportedStory).toContain(
      '<FutureContainer Self="future"><Content>must stay locked</Content></FutureContainer>',
    )
    expect(exportedStory).toContain("<Content>avant</Content>")
    expect(exportedStory).toContain("<Content>lié</Content>")
    expect(exportedStory).toContain("<Content>après</Content>")
  })

  it("does not manufacture units for paragraphs nested inside unknown containers", async () => {
    const story = `<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Story xmlns:idPkg="urn:test"><Story Self="u1"><FutureContainer><ParagraphStyleRange Self="pfuture"><CharacterStyleRange><Content>future literal</Content></CharacterStyleRange></ParagraphStyleRange></FutureContainer><ParagraphStyleRange Self="pknown"><CharacterStyleRange><Content>known literal</Content></CharacterStyleRange></ParagraphStyleRange></Story></idPkg:Story>`
    const parsed = await parseIdml(await makeIdml({ "Stories/Story_u1.xml": story }))

    expect(parsed.units.some((unit) => unit.locator.elementId === "pfuture")).toBe(false)
    expect(unitById(parsed.units, "pknown").sourceText).toBe("known literal")
    expect(parsed.diagnostics).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("FutureContainer"),
        details: expect.objectContaining({
          unsupportedDisposition: "unsupported-literal",
          constructKind: "unknown-container",
          xmlName: "FutureContainer",
        }),
      }),
    )
  })

  it("models literal tabs as protected boundaries between editable virtual slots", async () => {
    const tabStory = `<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Story xmlns:idPkg="urn:test"><Story Self="u1"><ParagraphStyleRange Self="ptab"><CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Body"><Content>before\tmiddle\t\tend</Content></CharacterStyleRange></ParagraphStyleRange></Story></idPkg:Story>`
    const bytes = await makeIdml({ "Stories/Story_u1.xml": tabStory })
    const parsed = await parseIdml(bytes)
    const unit = unitById(parsed.units, "ptab")

    expect(unit.slots.map(({ index, text, editable }) => ({ index, text, editable }))).toEqual([
      { index: 0, text: "before", editable: true },
      { index: 1, text: "middle", editable: true },
      { index: 2, text: "", editable: true },
      { index: 3, text: "end", editable: true },
    ])
    expect(unit.sourceText).toBe("before\tmiddle\t\tend")
    expect(unit.metadata.editableSlotIndexes).toEqual([0, 1, 2, 3])
    expect(unit.protectedTokens.map(({ kind, position }) => ({ kind, position }))).toEqual(
      [
        { kind: "tab", position: 1 },
        { kind: "tab", position: 2 },
        { kind: "tab", position: 3 },
      ],
    )

    const targetHtml = unit.sourceHtml
      .replace("before", "avant")
      .replace("middle", "milieu")
      .replace(">end<", ">fin<")
    const exported = await exportIdml(bytes, [translationFor(unit, targetHtml)], {
      strict: true,
    })
    expect(await memberText(exported.bytes, "Stories/Story_u1.xml")).toContain(
      "<Content>avant\tmilieu\t\tfin</Content>",
    )
  })

  it("ignores designmap variable references and only diagnoses actual computed definitions", async () => {
    const bytes = await makeIdml({
      "designmap.xml":
        '<?xml version="1.0" encoding="UTF-8"?><idPkg:DesignMap xmlns:idPkg="urn:test"><idPkg:Story src="Stories/Story_u1.xml"/><idPkg:Story src="Stories/Story_u3.xml"/><idPkg:TextVariable src="Resources/TextVariables.xml"/></idPkg:DesignMap>',
    })
    const parsed = await parseIdml(bytes)

    expect(
      parsed.units.filter((unit) => unit.locator.scope === "custom-variable"),
    ).toHaveLength(1)
    expect(
      parsed.diagnostics.filter(
        (entry) =>
          entry.code === "UNSUPPORTED_CONSTRUCT" && entry.message.includes("Computed text variable"),
      ),
    ).toEqual([
      expect.objectContaining({
        memberPath: "Resources/TextVariables.xml",
        message: expect.stringContaining("TextVariable/Page"),
        details: expect.objectContaining({
          unsupportedDisposition: "preserved-nonliteral",
          constructKind: "computed-text-variable",
        }),
      }),
    ])
  })

  it("reports protected-only paragraphs without manufacturing an editable unit", async () => {
    const protectedStory = `<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Story xmlns:idPkg="urn:test"><Story Self="u1"><ParagraphStyleRange Self="protected-only"><CharacterStyleRange><TextVariableInstance Self="page"/><Br/></CharacterStyleRange></ParagraphStyleRange></Story></idPkg:Story>`
    const parsed = await parseIdml(
      await makeIdml({ "Stories/Story_u1.xml": protectedStory }),
    )

    expect(parsed.units.some((unit) => unit.locator.elementId === "protected-only")).toBe(false)
    expect(parsed.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "UNSUPPORTED_CONSTRUCT",
        memberPath: "Stories/Story_u1.xml",
        details: {
          elementPath: "/idPkg:Story[1]/Story[1]/ParagraphStyleRange[1]",
          protectedTokenCount: 2,
          unsupportedDisposition: "preserved-nonliteral",
          constructKind: "protected-only-paragraph",
        },
      }),
    )
  })

  it("preserves running-header whitespace and processing instructions without blank units", async () => {
    const runningHeaderStory = `<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Story xmlns:idPkg="urn:test"><Story Self="u1">
<ParagraphStyleRange Self="running-header-tab"><CharacterStyleRange><Content>	<?ACE 18?><?ACE 8?></Content></CharacterStyleRange></ParagraphStyleRange>
<ParagraphStyleRange Self="running-header-variable"><CharacterStyleRange><TextVariableInstance Self="section"/></CharacterStyleRange><CharacterStyleRange><Content> </Content></CharacterStyleRange><CharacterStyleRange><Content>	<?ACE 18?></Content></CharacterStyleRange></ParagraphStyleRange>
<ParagraphStyleRange Self="real-copy"><CharacterStyleRange><Content>Translate me</Content></CharacterStyleRange></ParagraphStyleRange>
</Story></idPkg:Story>`
    const bytes = await makeIdml({ "Stories/Story_u1.xml": runningHeaderStory })
    const parsed = await parseIdml(bytes)

    expect(parsed.units.filter((unit) => unit.locator.memberPath === "Stories/Story_u1.xml"))
      .toHaveLength(1)
    expect(unitById(parsed.units, "real-copy").sourceText).toBe("Translate me")
    expect(parsed.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "UNSUPPORTED_CONSTRUCT",
        memberPath: "Stories/Story_u1.xml",
        details: expect.objectContaining({
          elementPath: "/idPkg:Story[1]/Story[1]/ParagraphStyleRange[1]",
          unsupportedDisposition: "preserved-nonliteral",
          constructKind: "nonliteral-paragraph",
        }),
      }),
      expect.objectContaining({
        code: "UNSUPPORTED_CONSTRUCT",
        memberPath: "Stories/Story_u1.xml",
        details: expect.objectContaining({
          elementPath: "/idPkg:Story[1]/Story[1]/ParagraphStyleRange[2]",
          unsupportedDisposition: "preserved-nonliteral",
          constructKind: "nonliteral-paragraph",
        }),
      }),
    ]))

    const exported = await exportIdml(bytes, [], { strict: true })
    expect(exported.bytes).toEqual(new Uint8Array(bytes))
    expect(await memberText(exported.bytes, "Stories/Story_u1.xml")).toBe(runningHeaderStory)
  })

  it("uses deterministic code-unit ordering for stories not listed in designmap", async () => {
    const story = (storyId: string, paragraphId: string) =>
      `<?xml version="1.0"?><idPkg:Story xmlns:idPkg="urn:test"><Story Self="${storyId}"><ParagraphStyleRange Self="${paragraphId}"><CharacterStyleRange><Content>${storyId}</Content></CharacterStyleRange></ParagraphStyleRange></Story></idPkg:Story>`
    const parsed = await parseIdml(
      await makeIdml({
        "Stories/Story_Z.xml": story("Z", "pZ"),
        "Stories/Story_a.xml": story("a", "pa"),
        "Stories/Story_ä.xml": story("ä", "pä"),
      }),
    )

    expect([
      ...new Set(
        parsed.units
          .map((unit) => unit.locator.memberPath)
          .filter((path) => path.startsWith("Stories/")),
      ),
    ]).toEqual([
      "Stories/Story_u1.xml",
      "Stories/Story_u3.xml",
      "Stories/Story_Z.xml",
      "Stories/Story_a.xml",
      "Stories/Story_u9.xml",
      "Stories/Story_ä.xml",
    ])
  })

  it("keeps Biblica lossless by exposing the same complete literal locations as generic", async () => {
    const bytes = await makeIdml()
    const generic = await parseIdml(bytes, "generic")
    const biblica = await parseIdml(bytes, "biblica")

    expect(biblica.units.map((unit) => unit.locator)).toEqual(
      generic.units.map((unit) => unit.locator),
    )
    expect(biblica.manifest.profile).toBe("biblica")
  })

  it("derives note, endnote, text-path, and master-story scopes from structural evidence", async () => {
    const scopedStory = (storyId: string, paragraphId: string, text: string) =>
      `<?xml version="1.0" encoding="UTF-8"?><idPkg:Story xmlns:idPkg="urn:test"><Story Self="${storyId}"><ParagraphStyleRange Self="${paragraphId}"><CharacterStyleRange><Content>${text}</Content></CharacterStyleRange></ParagraphStyleRange></Story></idPkg:Story>`
    const nestedStory = `<?xml version="1.0" encoding="UTF-8"?><idPkg:Story xmlns:idPkg="urn:test"><Story Self="u1"><Note><ParagraphStyleRange Self="pnote"><CharacterStyleRange><Content>note</Content></CharacterStyleRange></ParagraphStyleRange></Note><EndnoteRange><ParagraphStyleRange Self="pendnote"><CharacterStyleRange><Content>endnote</Content></CharacterStyleRange></ParagraphStyleRange></EndnoteRange></Story></idPkg:Story>`
    const bytes = await makeIdml({
      "designmap.xml":
        '<?xml version="1.0" encoding="UTF-8"?><idPkg:DesignMap xmlns:idPkg="urn:test"><idPkg:Story src="Stories/Story_u1.xml"/><idPkg:Story src="Stories/Story_u5.xml"/><idPkg:Story src="Stories/Story_u6.xml"/></idPkg:DesignMap>',
      "Stories/Story_u1.xml": nestedStory,
      "Stories/Story_u5.xml": scopedStory("u5", "pmaster", "master"),
      "Stories/Story_u6.xml": scopedStory("u6", "ppath", "path"),
      "MasterSpreads/MasterSpread_u5.xml":
        '<?xml version="1.0"?><idPkg:MasterSpread xmlns:idPkg="urn:test"><TextFrame ParentStory="u5"/></idPkg:MasterSpread>',
      "Spreads/Spread_u6.xml":
        '<?xml version="1.0"?><idPkg:Spread xmlns:idPkg="urn:test"><TextPath ParentStory="u6"/></idPkg:Spread>',
    })
    const parsed = await parseIdml(bytes)

    expect(unitById(parsed.units, "pnote").locator.scope).toBe("note")
    expect(unitById(parsed.units, "pendnote").locator.scope).toBe("endnote")
    expect(unitById(parsed.units, "pmaster").locator.scope).toBe("master-story")
    expect(unitById(parsed.units, "ppath").locator.scope).toBe("text-path")
  })

  it("validates every XML member and rejects malformed XML and DTD declarations", async () => {
    await expect(
      parseIdml(await makeIdml({ "Resources/Styles.xml": "<Styles><Broken></Styles>" })),
    ).rejects.toMatchObject({ code: "MALFORMED_XML" })
    await expect(
      parseIdml(
        await makeIdml({
          "Resources/Styles.xml": '<!DOCTYPE Styles [<!ENTITY x "bad">]><Styles>&x;</Styles>',
        }),
      ),
    ).rejects.toMatchObject({ code: "UNSAFE_XML_DECLARATION" })
  })

  it("emits paragraph progress and cooperatively cancels parsing", async () => {
    const paragraphs = Array.from(
      { length: 64 },
      (_, index) =>
        `<ParagraphStyleRange Self="p${index}"><CharacterStyleRange><Content>text ${index}</Content></CharacterStyleRange></ParagraphStyleRange>`,
    ).join("")
    const story = `<?xml version="1.0"?><idPkg:Story xmlns:idPkg="urn:test"><Story Self="u1">${paragraphs}</Story></idPkg:Story>`
    const controller = new AbortController()
    const progress: number[] = []

    await expect(
      parseIdml(
        await makeIdml({ "Stories/Story_u1.xml": story }),
        "generic",
        {
          signal: controller.signal,
          onProgress(update) {
            if (update.phase !== "parse") return
            progress.push(update.completed)
            if (update.completed === 1) {
              controller.abort(new DOMException("fixture cancellation", "AbortError"))
            }
          },
        },
      ),
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(progress).toEqual([0, 1])
  })
})

describe("strict surgical IDML export", () => {
  it("replaces every mixed-style Content slot in place and preserves unknown XML", async () => {
    const bytes = await makeIdml()
    const parsed = await parseIdml(bytes)
    const unit = unitById(parsed.units, "p1")
    const targetHtml = unit.sourceHtml
      .replace(" Bold ", " Gras ")
      .replace(">and<", ">et<")
      .replace(" italic e\u0301漢字", " italique")
    const exported = await exportIdml(bytes, [translationFor(unit, targetHtml)], {
      strict: true,
    })
    const storyXml = await memberText(exported.bytes, "Stories/Story_u1.xml")

    expect(storyXml).toContain(
      'AppliedCharacterStyle="CharacterStyle/Bold"><Content> Gras </Content><Content>et</Content>',
    )
    expect(storyXml).toContain(
      'AppliedCharacterStyle="CharacterStyle/Italic"><Content> italique</Content><CrossReferenceSource Self="xref1"/><TextVariableInstance Self="var1"/><Mystery Self="m1"/>',
    )
    expect(storyXml).not.toContain("<Content></Content>")
    expect(storyXml).toContain('<Mystery Self="m1"/>')
    expect(exported.report).toMatchObject({
      translated: 1,
      unchanged: parsed.units.length - 1,
      missing: 0,
      rejected: 0,
      changedMemberPaths: ["Stories/Story_u1.xml"],
    })
  })

  it("encodes user line breaks as Br and additional Content nodes in the original style run", async () => {
    const bytes = await makeIdml()
    const parsed = await parseIdml(bytes)
    const unit = unitById(parsed.units, "p3")
    const targetHtml = unit.sourceHtml.replace("foot&amp;note", "line 1<br>line 2")
    const exported = await exportIdml(bytes, [translationFor(unit, targetHtml)], {
      strict: true,
    })
    const storyXml = await memberText(exported.bytes, "Stories/Story_u1.xml")

    expect(storyXml).toContain(
      'AppliedCharacterStyle="CharacterStyle/Footnote"><Content>line 1</Content><Br/><Content>line 2</Content>',
    )
    await expect(validateExport(exported.bytes, parsed.manifest)).resolves.toEqual([])
  })

  it("locks and preserves comments or other markup embedded inside Content", async () => {
    const commentStory = `<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Story xmlns:idPkg="urn:test"><Story Self="u1"><ParagraphStyleRange Self="pcomment"><CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Body"><Content>left<!--keep-->right</Content><Content>editable</Content></CharacterStyleRange></ParagraphStyleRange></Story></idPkg:Story>`
    const bytes = await makeIdml({ "Stories/Story_u1.xml": commentStory })
    const parsed = await parseIdml(bytes)
    const unit = unitById(parsed.units, "pcomment")

    expect(unit.slots[0]).toMatchObject({ text: "leftright", editable: false })
    expect(unit.protectedTokens).toContainEqual(
      expect.objectContaining({ kind: "unknown", position: 0 }),
    )
    expect(unit.diagnostics).toContainEqual(
      expect.objectContaining({
        message: "Markup inside an IDML Content slot was locked and preserved",
        details: expect.objectContaining({
          unsupportedDisposition: "unsupported-literal",
          constructKind: "opaque-content-markup",
        }),
      }),
    )
    const exported = await exportIdml(
      bytes,
      [translationFor(unit, unit.sourceHtml.replace(">editable</span>", ">translated</span>"))],
      { strict: true },
    )
    const storyXml = await memberText(exported.bytes, "Stories/Story_u1.xml")
    expect(storyXml).toContain("<Content>left<!--keep-->right</Content>")
    expect(storyXml).toContain("<Content>translated</Content>")
  })

  it("exposes literal text around Content processing instructions while preserving them as anchors", async () => {
    const processingInstructionStory = `<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Story xmlns:idPkg="urn:test"><Story Self="u1"><ParagraphStyleRange Self="ppi"><CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Body"><Content><?ACE 3?>Here is how Jerusalem was captured.</Content><Content>left<?ACE 7?>right	end</Content></CharacterStyleRange></ParagraphStyleRange></Story></idPkg:Story>`
    const bytes = await makeIdml({
      "Stories/Story_u1.xml": processingInstructionStory,
    })
    const parsed = await parseIdml(bytes)
    const unit = unitById(parsed.units, "ppi")

    expect(unit.slots).toEqual([
      expect.objectContaining({
        text: "Here is how Jerusalem was captured.",
        editable: true,
      }),
      expect.objectContaining({ text: "left", editable: true }),
      expect.objectContaining({ text: "right", editable: true }),
      expect.objectContaining({ text: "end", editable: true }),
    ])
    expect(
      unit.protectedTokens.map(({ kind, xmlName, position }) => ({
        kind,
        xmlName,
        position,
      })),
    ).toEqual([
      { kind: "unknown", xmlName: "?ACE", position: 0 },
      { kind: "unknown", xmlName: "?ACE", position: 2 },
      { kind: "tab", xmlName: "Content", position: 3 },
    ])
    expect(unit.diagnostics).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("<?ACE>"),
        details: expect.objectContaining({
          unsupportedDisposition: "preserved-nonliteral",
          constructKind: "processing-instruction",
          xmlName: "?ACE",
        }),
      }),
    )

    const targetHtml = unit.sourceHtml
      .replace(
        ">Here is how Jerusalem was captured.</span>",
        ">Voici comment Jérusalem a été prise.<br>Deuxième ligne</span>",
      )
      .replace(">left</span>", ">gauche</span>")
      .replace(">right</span>", ">droite</span>")
      .replace(">end</span>", ">fin</span>")
    const exported = await exportIdml(
      bytes,
      [translationFor(unit, targetHtml)],
      { strict: true },
    )
    const storyXml = await memberText(exported.bytes, "Stories/Story_u1.xml")

    expect(storyXml).toContain(
      "<Content><?ACE 3?>Voici comment Jérusalem a été prise.</Content><Br/><Content>Deuxième ligne</Content>",
    )
    expect(storyXml).toContain(
      "<Content>gauche<?ACE 7?>droite\tfin</Content>",
    )
    await expect(validateExport(exported.bytes, parsed.manifest)).resolves.toEqual([])

    const withoutProcessingInstruction = await makeIdml({
      "Stories/Story_u1.xml": storyXml.replace("<?ACE 3?>", ""),
    })
    await expect(
      validateExport(withoutProcessingInstruction, parsed.manifest),
    ).resolves.toContainEqual(
      expect.objectContaining({
        code: "MEMBER_CHANGED",
        memberPath: "Stories/Story_u1.xml",
      }),
    )

    const clearedTargetHtml = unit.sourceHtml
      .replace(">Here is how Jerusalem was captured.</span>", "></span>")
      .replace(">left</span>", "></span>")
      .replace(">right</span>", "></span>")
      .replace(">end</span>", "></span>")
    const cleared = await exportIdml(
      bytes,
      [translationFor(unit, clearedTargetHtml)],
      { strict: true },
    )
    expect(await memberText(cleared.bytes, "Stories/Story_u1.xml")).toContain(
      "<Content><?ACE 3?></Content><Content><?ACE 7?>\t</Content>",
    )
    await expect(validateExport(cleared.bytes, parsed.manifest)).resolves.toEqual([])
  })

  it("keeps whitespace-only processing-instruction slots in their established locked shape", async () => {
    const whitespaceInstructionStory = `<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Story xmlns:idPkg="urn:test"><Story Self="u1"><ParagraphStyleRange Self="pcompat"><CharacterStyleRange><Content><?ACE 3?> </Content><Content>Visible text</Content></CharacterStyleRange></ParagraphStyleRange></Story></idPkg:Story>`
    const parsed = await parseIdml(
      await makeIdml({ "Stories/Story_u1.xml": whitespaceInstructionStory }),
    )
    const unit = unitById(parsed.units, "pcompat")

    expect(unit.slots).toEqual([
      expect.objectContaining({ text: " ", editable: false }),
      expect.objectContaining({ text: "Visible text", editable: true }),
    ])
    expect(unit.protectedTokens).toContainEqual(
      expect.objectContaining({
        kind: "unknown",
        xmlName: "Content",
        position: 0,
      }),
    )
    expect(unit.diagnostics).toContainEqual(
      expect.objectContaining({
        details: expect.objectContaining({
          unsupportedDisposition: "unsupported-literal",
          constructKind: "opaque-content-markup",
        }),
      }),
    )
  })

  it("preserves a Content slot's CDATA representation while replacing its text", async () => {
    const cdataStory = `<?xml version="1.0" encoding="UTF-8"?>
<idPkg:Story xmlns:idPkg="urn:test"><Story Self="u1"><ParagraphStyleRange Self="pcdata"><CharacterStyleRange><Content><![CDATA[A < B]]></Content></CharacterStyleRange></ParagraphStyleRange></Story></idPkg:Story>`
    const bytes = await makeIdml({ "Stories/Story_u1.xml": cdataStory })
    const parsed = await parseIdml(bytes)
    const unit = unitById(parsed.units, "pcdata")
    const exported = await exportIdml(
      bytes,
      [translationFor(unit, unit.sourceHtml.replace("A &lt; B", "C &lt; D"))],
      { strict: true },
    )
    expect(await memberText(exported.bytes, "Stories/Story_u1.xml")).toContain(
      "<Content><![CDATA[C < D]]></Content>",
    )
  })

  it("returns the exact original bytes for no translations or unchanged translations", async () => {
    const bytes = await makeIdml()
    const parsed = await parseIdml(bytes)
    const unit = unitById(parsed.units, "p1")

    await expect(exportIdml(bytes, [], { strict: true })).resolves.toMatchObject({
      bytes,
      report: { translated: 0 },
    })
    const unchanged = await exportIdml(bytes, [translationFor(unit, unit.sourceHtml)], {
      strict: true,
    })
    expect(unchanged.bytes).toEqual(bytes)
    expect(unchanged.report.translated).toBe(0)
  })

  it("rejects stale, duplicate, and missing locators without emitting a partial package", async () => {
    const bytes = await makeIdml()
    const parsed = await parseIdml(bytes)
    const unit = unitById(parsed.units, "p1")
    const valid = translationFor(unit, unit.sourceHtml.replace(" Bold ", " Changed "))
    const stale: IdmlTranslation = {
      ...valid,
      locator: { ...valid.locator, sourceBlockHash: "0".repeat(64) },
    }
    const missing: IdmlTranslation = {
      ...valid,
      locator: {
        ...valid.locator,
        elementPath: "/idPkg:Story[1]/Story[1]/Missing[1]",
        elementId: undefined,
      },
    }

    await expect(exportIdml(bytes, [stale], { strict: true })).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof IdmlError &&
        error.diagnostics.some((entry) => entry.code === "SOURCE_HASH_MISMATCH"),
    )
    await expect(exportIdml(bytes, [valid, valid], { strict: true })).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof IdmlError &&
        error.diagnostics.some((entry) => entry.code === "LOCATOR_DUPLICATED"),
    )
    await expect(exportIdml(bytes, [missing], { strict: true })).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof IdmlError &&
        error.diagnostics.some((entry) => entry.code === "LOCATOR_MISSING"),
    )
    await expect(
      exportIdml(bytes, [{ ...valid, locator: { kind: "idml" } } as never], { strict: true }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof IdmlError &&
        error.diagnostics.some((entry) => entry.code === "LOCATOR_STALE"),
    )
  })

  it("reconciles a legacy path through a unique element ID and source hash", async () => {
    const bytes = await makeIdml()
    const parsed = await parseIdml(bytes)
    const unit = unitById(parsed.units, "p1")
    const translation = translationFor(unit, unit.sourceHtml.replace(" Bold ", " Reconciled "))
    const legacyPathTranslation: IdmlTranslation = {
      ...translation,
      locator: {
        ...translation.locator,
        elementPath: "/legacy:Story[1]/ParagraphStyleRange[77]",
      },
    }
    const exported = await exportIdml(bytes, [legacyPathTranslation], { strict: true })
    expect(await memberText(exported.bytes, "Stories/Story_u1.xml")).toContain(
      "<Content> Reconciled </Content>",
    )
  })

  it("merges non-overlapping legacy Codex parts into one surgical paragraph export", async () => {
    const paragraphBlock = [
      '<ParagraphStyleRange Self="legacy-p1" AppliedParagraphStyle="ParagraphStyle/Body">',
      '<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Body"><Content>zero</Content></CharacterStyleRange>',
      '<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Glue"><Content>ʼ</Content></CharacterStyleRange>',
      "<Br/>",
      '<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Body"><Content>one</Content><Content>two</Content></CharacterStyleRange>',
      "</ParagraphStyleRange>",
    ].join("")
    const story = `<?xml version="1.0" encoding="UTF-8"?><idPkg:Story xmlns:idPkg="urn:test"><Story Self="u1">${paragraphBlock}</Story></idPkg:Story>`
    const bytes = await makeIdml({ "Stories/Story_u1.xml": story })
    const first = upgradeLegacyIdmlMetadata(legacyPartInput({
      paragraphBlock,
      part: 0,
      slotIndexes: [0],
      targetTexts: ["ZERO"],
    }))
    const second = upgradeLegacyIdmlMetadata(legacyPartInput({
      paragraphBlock,
      part: 1,
      slotIndexes: [2, 3],
      targetTexts: ["ONE", "TWO"],
    }))
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok || !first.targetHtml || !second.targetHtml) return

    const translations: IdmlTranslation[] = [
      {
        unitId: "legacy-p1-part-0",
        locator: first.locator,
        metadata: first.metadata,
        sourceHtml: first.sourceHtml,
        targetHtml: first.targetHtml,
      },
      {
        unitId: "legacy-p1-part-1",
        locator: second.locator,
        metadata: second.metadata,
        sourceHtml: second.sourceHtml,
        targetHtml: second.targetHtml,
      },
    ]
    const exported = await exportIdml(bytes, translations, { strict: true })
    const exportedStory = await memberText(exported.bytes, "Stories/Story_u1.xml")

    expect(exportedStory).toContain("<Content>ZERO</Content>")
    expect(exportedStory).toContain('<Content>ʼ</Content>')
    expect(exportedStory).toContain("<Br/>")
    expect(exportedStory).toContain("<Content>ONE</Content><Content>TWO</Content>")
    expect(exported.report).toMatchObject({ translated: 1, rejected: 0 })

    const overlapping: IdmlTranslation = {
      ...translations[0]!,
      unitId: "legacy-p1-overlap",
      locator: { ...translations[0]!.locator, part: 9 },
    }
    await expect(
      exportIdml(bytes, [translations[0]!, overlapping], { strict: true }),
    ).rejects.toSatisfy(
      (error: unknown) => (
        error instanceof IdmlError
        && error.diagnostics.some((entry) => entry.code === "LOCATOR_DUPLICATED")
      ),
    )
  })

  it("rejects target text containing characters forbidden by XML 1.0", async () => {
    const bytes = await makeIdml()
    const parsed = await parseIdml(bytes)
    const unit = unitById(parsed.units, "p4")
    const targetHtml = unit.sourceHtml.replace("anchored", "bad\u0000text")

    await expect(
      exportIdml(bytes, [translationFor(unit, targetHtml)], { strict: true }),
    ).rejects.toSatisfy(
      (error: unknown) => (
        error instanceof IdmlError
        && error.code === "EXPORT_REJECTED"
        && error.diagnostics.some((entry) => entry.code === "ANCHOR_INVALID")
      ),
    )
  })

  it("repackages as UCF with mimetype first/stored, other files deflated, and no directory entries", async () => {
    const bytes = await makeIdml({ "Extra/empty.bin": new Uint8Array() })
    const parsed = await parseIdml(bytes)
    const unit = unitById(parsed.units, "p4")
    const exported = await exportIdml(
      bytes,
      [translationFor(unit, unit.sourceHtml.replace("anchored", "ancré"))],
      { strict: true },
    )
    const inspection = await inspectIdml(exported.bytes)

    expect(inspection.members[0]).toMatchObject({
      path: "mimetype",
      compressionMethod: 0,
    })
    expect(inspection.members.slice(1).every((member) => member.compressionMethod === 8)).toBe(true)
    expect(inspection.members.every((member) => !member.isDirectory)).toBe(true)
    expect(new Set(inspection.members.map((member) => member.path))).toEqual(
      new Set(parsed.manifest.members.map((member) => member.path)),
    )
    const zip = await JSZip.loadAsync(exported.bytes)
    await expect(zip.file("Extra/empty.bin")?.async("uint8array")).resolves.toEqual(
      new Uint8Array(),
    )
  })

  it("preserves explicit directory entries without synthesizing parent directories", async () => {
    const bytes = await makeIdml({ "Explicit/": new Uint8Array() })
    const parsed = await parseIdml(bytes)
    const unit = unitById(parsed.units, "p4")
    const exported = await exportIdml(
      bytes,
      [translationFor(unit, unit.sourceHtml.replace("anchored", "translated"))],
      { strict: true },
    )
    const inspection = await inspectIdml(exported.bytes)

    expect(parsed.manifest.members).toContainEqual(
      expect.objectContaining({ path: "Explicit/", isDirectory: true }),
    )
    expect(inspection.members).toContainEqual(
      expect.objectContaining({ path: "Explicit/", isDirectory: true }),
    )
    expect(inspection.members.some((member) => member.path === "Stories/")).toBe(false)
    await expect(validateExport(exported.bytes, parsed.manifest)).resolves.toEqual([])
    await expect(
      validateExport(await makeIdml({ "Explicit/": null }), parsed.manifest),
    ).resolves.toContainEqual(
      expect.objectContaining({ code: "MEMBER_REMOVED", memberPath: "Explicit/" }),
    )
  })

  it("detects XML structural tampering while intentionally allowing arbitrary literal changes", async () => {
    const bytes = await makeIdml()
    const parsed = await parseIdml(bytes)
    expect(
      parsed.manifest.members.find((member) => member.path === "Stories/Story_u1.xml"),
    ).toMatchObject({ structuralSha256: expect.stringMatching(/^[a-f0-9]{64}$/) })

    const literalOnly = await makeIdml({
      "Stories/Story_u1.xml": mixedStoryXml.replace(
        "<Content> Bold </Content>",
        "<Content>arbitrary literal</Content>",
      ),
    })
    // validateExport has no translation inputs, so a literal change is
    // intentionally indistinguishable from an authorized translation.
    await expect(validateExport(literalOnly, parsed.manifest)).resolves.toEqual([])

    const structuralMutations = [
      mixedStoryXml.replace(
        'AppliedParagraphStyle="ParagraphStyle/Body"',
        'AppliedParagraphStyle="ParagraphStyle/Heading"',
      ),
      mixedStoryXml.replace('<Mystery Self="m1"/>', ""),
      mixedStoryXml.replace("<Content>and</Content>", ""),
      mixedStoryXml.replace(
        '<CrossReferenceSource Self="xref1"/><TextVariableInstance Self="var1"/>',
        '<TextVariableInstance Self="var1"/><CrossReferenceSource Self="xref1"/>',
      ),
    ]
    for (const storyXml of structuralMutations) {
      await expect(
        validateExport(
          await makeIdml({ "Stories/Story_u1.xml": storyXml }),
          parsed.manifest,
        ),
      ).resolves.toContainEqual(
        expect.objectContaining({
          code: "MEMBER_CHANGED",
          memberPath: "Stories/Story_u1.xml",
        }),
      )
    }
  })

  it("validates locator presence and hashes of unchanged package members", async () => {
    const bytes = await makeIdml()
    const parsed = await parseIdml(bytes)
    const unit = unitById(parsed.units, "p4")
    const exported = await exportIdml(
      bytes,
      [translationFor(unit, unit.sourceHtml.replace("anchored", "translated"))],
      { strict: true },
    )
    await expect(validateExport(exported.bytes, parsed.manifest)).resolves.toEqual([])

    const tampered = await makeIdml({
      "Resources/Styles.xml":
        '<?xml version="1.0" encoding="UTF-8"?><idPkg:Styles xmlns:idPkg="urn:test"><Root Self="tampered"/></idPkg:Styles>',
    })
    await expect(validateExport(tampered, parsed.manifest)).resolves.toContainEqual(
      expect.objectContaining({
        code: "MEMBER_CHANGED",
        memberPath: "Resources/Styles.xml",
      }),
    )
    await expect(
      validateExport(await makeIdml({ "designmap.xml": null }), parsed.manifest),
    ).resolves.toContainEqual(
      expect.objectContaining({
        code: "MISSING_DESIGNMAP",
      }),
    )
    await expect(
      validateExport(bytes, { ...parsed.manifest, version: 3 } as never),
    ).resolves.toContainEqual(
      expect.objectContaining({
        code: "UNSUPPORTED_SCHEMA_VERSION",
      }),
    )
  })

  it("emits structural-validation progress and cooperatively cancels", async () => {
    const bytes = await makeIdml()
    const parsed = await parseIdml(bytes)
    const controller = new AbortController()
    const progress: number[] = []

    await expect(
      validateExport(bytes, parsed.manifest, {
        signal: controller.signal,
        onProgress(update) {
          if (update.phase !== "validate") return
          progress.push(update.completed)
          if (update.completed === 1) {
            controller.abort(new DOMException("validation cancellation", "AbortError"))
          }
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(progress).toEqual([0, 1])
  })
})

function unitById(
  units: readonly IdmlTranslationUnit[],
  elementId: string,
): IdmlTranslationUnit {
  const unit = units.find((candidate) => candidate.locator.elementId === elementId)
  if (!unit) throw new Error(`Missing fixture unit ${elementId}`)
  return unit
}

function translationFor(unit: IdmlTranslationUnit, targetHtml: string): IdmlTranslation {
  return {
    unitId: unit.id,
    locator: unit.locator,
    metadata: unit.metadata,
    sourceHtml: unit.sourceHtml,
    targetHtml,
  }
}

async function memberText(bytes: Uint8Array, path: string): Promise<string> {
  const zip = await JSZip.loadAsync(bytes, { createFolders: false })
  const entry = zip.file(path)
  if (!entry) throw new Error(`Missing exported fixture member ${path}`)
  return entry.async("string")
}

function legacyPartInput({
  paragraphBlock,
  part,
  slotIndexes,
  targetTexts,
}: {
  paragraphBlock: string
  part: number
  slotIndexes: readonly number[]
  targetTexts: readonly string[]
}): Record<string, unknown> {
  const contentSegments = ["zero", "ʼ", "one", "two"]
  const characterStyles = [
    "CharacterStyle/Body",
    "CharacterStyle/Glue",
    "CharacterStyle/Body",
    "CharacterStyle/Body",
  ]
  const html = (texts: readonly string[]): string => [
    '<p class="indesign-paragraph" data-paragraph-style="ParagraphStyle/Body" data-story-id="u1" data-segment-count="4">',
    ...slotIndexes.flatMap((slotIndex, localIndex) => [
      localIndex === 0
        ? ""
        : '<span class="idml-eoc" data-eoc="1" aria-hidden="true"></span>',
      `<span class="idml-segment" data-segment-index="${slotIndex}" data-character-style="${characterStyles[slotIndex]}">${texts[localIndex]}</span>`,
    ]),
    "</p>",
  ].join("")
  return {
    valueHtml: html(slotIndexes.map((index) => contentSegments[index] ?? "")),
    targetHtml: html(targetTexts),
    metadata: {
      storyId: "u1",
      paragraphId: "legacy-p1",
      data: {
        idmlStructure: {
          storyId: "u1",
          paragraphId: "legacy-p1",
          contentSegments,
          contentSegmentCount: contentSegments.length,
          contentSegmentBreakBefore: [false, false, true, false],
          structuralApostropheSegmentIndexes: [1],
          sourceBlockXml: paragraphBlock,
          paragraphStyleRange: {
            appliedParagraphStyle: "ParagraphStyle/Body",
          },
        },
        relationships: {
          parentStory: "u1",
          paragraphOrder: 0,
          segmentIndex: part,
          totalSegments: 2,
        },
      },
    },
  }
}
