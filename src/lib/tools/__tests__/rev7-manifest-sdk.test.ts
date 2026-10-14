/**
 * apiRev 7: manifest actions/exports, the "check on project open" rule, the
 * code hash covering them, and the SDK 1.1 readers (zip, TSV, USFM with
 * alignment milestones, markdown blocks) — evaluated from the exact SDK source
 * that ships into the frame.
 */

import { beforeEach, describe, expect, it } from "vitest"
import JSZip from "jszip"
import { toolCodeHash, validateManifest, type ToolManifest } from "../../../../shared/tools/manifest"
import { SDK_IO } from "../../../../shared/tools/sdk/sdk-io"
import { dueOnOpenActions, markOnOpenRun, ON_OPEN_INTERVAL_MS } from "../on-open-actions"
import { smartExtensionsEnabledIn } from "../../../../shared/tools/smart-extensions-flag"

describe("manifest actions and exports", () => {
  const base = { name: "Importer", description: "", scopes: ["read:web", "write:files"], web: ["example.org"], apiRev: 7 }

  it("accepts well-formed actions and exports and keeps them in the manifest", () => {
    const v = validateManifest({
      ...base,
      actions: [{ id: "import", label: "Import", where: ["settings", "menu"] }, { id: "refresh", label: "Check for updates", onOpen: true }],
      exports: [{ id: "aligned-usfm", label: "Aligned USFM", extension: ".USFM", tags: ["uw:ult"] }],
    })
    expect(v.errors).toEqual([])
    expect(v.manifest?.actions).toEqual([
      { id: "import", label: "Import", where: ["settings", "menu"] },
      { id: "refresh", label: "Check for updates", where: ["bar"], onOpen: true },
    ])
    expect(v.manifest?.exports).toEqual([{ id: "aligned-usfm", label: "Aligned USFM", extension: "usfm", tags: ["uw:ult"] }])
  })

  it("rejects malformed ones and needs apiRev 7", () => {
    expect(validateManifest({ ...base, actions: [{ id: "Bad Id", label: "x" }] }).errors.join()).toMatch(/lowercase/)
    expect(validateManifest({ ...base, actions: [{ id: "a", label: "x", where: ["toolbar"] }] }).errors.join()).toMatch(/unknown place/)
    expect(validateManifest({ ...base, actions: [{ id: "a", label: "x" }, { id: "a", label: "y" }] }).errors.join()).toMatch(/two actions/)
    expect(validateManifest({ ...base, exports: [{ id: "x", label: "X", extension: "../evil" }] }).errors.join()).toMatch(/extension/)
    expect(validateManifest({ ...base, apiRev: 6 }).errors.join()).toMatch(/write:files needs apiRev 7/)
    expect(validateManifest({ name: "x", scopes: [], apiRev: 6, actions: [{ id: "a", label: "A" }] }).errors.join()).toMatch(/need apiRev 7/)
  })

  it("changes the code hash when an action or export changes, and not for tools without them", async () => {
    const m = validateManifest(base).manifest as ToolManifest
    const withAction = validateManifest({ ...base, actions: [{ id: "a", label: "A" }] }).manifest as ToolManifest
    expect(await toolCodeHash("x", m)).not.toBe(await toolCodeHash("x", withAction))
    expect(await toolCodeHash("x", m)).toBe(await toolCodeHash("x", { ...m }))
  })
})

describe("import contributions (AQU-1937)", () => {
  const base = { name: "Importer", description: "", scopes: ["read:web", "write:files"], web: ["example.org"], apiRev: 7 }
  it("validates an options schema and needs write:files", () => {
    const ok = validateManifest({ ...base, importers: [{ id: "g", label: "Glossary", options: [
      { key: "books", label: "Books", type: "multiselect", dynamic: true, dependsOn: ["lang"] },
      { key: "lang", label: "Language", type: "select", choices: [{ value: "en", label: "English" }], default: "en" },
    ] }] })
    expect(ok.errors).toEqual([])
    expect(ok.manifest?.importers?.[0].options[0]).toMatchObject({ key: "books", dynamic: true, dependsOn: ["lang"] })
    expect(validateManifest({ ...base, scopes: ["read:web"], importers: [{ id: "g", label: "G", options: [] }] }).errors.join()).toMatch(/needs the write:files scope/)
    expect(validateManifest({ ...base, importers: [{ id: "g", label: "G", options: [{ key: "x", label: "X", type: "select" }] }] }).errors.join()).toMatch(/needs choices/)
    expect(validateManifest({ ...base, importers: [{ id: "g", label: "G", options: [{ key: "1bad", label: "X", type: "text" }] }] }).errors.join()).toMatch(/short identifier/)
  })
  it("the Smart Extensions switch is on only when explicitly true", () => {
    expect(smartExtensionsEnabledIn({ smartExtensionsEnabled: true })).toBe(true)
    expect(smartExtensionsEnabledIn({ smartExtensionsEnabled: "true" })).toBe(false)
    expect(smartExtensionsEnabledIn({})).toBe(false)
    expect(smartExtensionsEnabledIn(null)).toBe(false)
  })
})

describe("check on project open", () => {
  beforeEach(() => window.localStorage.clear())
  const tool = (granted: string[]) => ({
    id: "t1",
    grantedScopes: granted as never[],
    manifest: { scopes: ["read:web", "write:files"] as never[], actions: [{ id: "refresh", onOpen: true }, { id: "import" }] },
  })

  it("runs a lead's fully-granted onOpen action at most once a day", () => {
    const ctx = { username: "u", projectId: "p", roleLevel: 500, now: 1_000_000_000 }
    expect(dueOnOpenActions([tool(["read:web", "write:files"])], ctx)).toEqual([{ toolId: "t1", actionId: "refresh" }])
    markOnOpenRun({ username: "u", projectId: "p", toolId: "t1", actionId: "refresh", now: ctx.now })
    expect(dueOnOpenActions([tool(["read:web", "write:files"])], { ...ctx, now: ctx.now + 1000 })).toEqual([])
    expect(dueOnOpenActions([tool(["read:web", "write:files"])], { ...ctx, now: ctx.now + ON_OPEN_INTERVAL_MS })).toHaveLength(1)
  })

  it("never runs for someone who would be prompted or refused", () => {
    const ctx = { username: "u", projectId: "p", roleLevel: 500, now: 1 }
    expect(dueOnOpenActions([tool(["read:web"])], ctx)).toEqual([])
    expect(dueOnOpenActions([tool(["read:web", "write:files"])], { ...ctx, roleLevel: 400 })).toEqual([])
  })
})

type Io = {
  zip: { read: (b: ArrayBuffer) => Promise<{ names: string[]; text: (n: string) => Promise<string> }> }
  parse: {
    tsv: (t: string) => { header: string[]; rows: Record<string, string>[] }
    usfm: (t: string) => { book: string; verses: Array<{ ref: string; text: string; words: Array<{ text: string; attrs: Record<string, string>; occurrence: number; occurrences: number; milestones: Record<string, string>[] }> }> }
    mdBlocks: (t: string) => Array<{ kind: string; level: number; text: string; section: string }>
  }
}
const io = new Function(`${SDK_IO}; return io;`)() as Io

describe("SDK 1.1 readers", () => {
  it("reads a zipball (stored and deflated members)", async () => {
    const zip = new JSZip()
    zip.file("en_tw/bible/kt/god.md", "# God\n\n## Definition:\n\nThe one true God.\n")
    zip.file("en_tw/manifest.yaml", "dublin_core: {}", { compression: "STORE" })
    const buf = await zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" })
    const archive = await io.zip.read(buf)
    expect(archive.names.sort()).toEqual(["en_tw/bible/kt/god.md", "en_tw/manifest.yaml"])
    expect(await archive.text("en_tw/bible/kt/god.md")).toContain("The one true God.")
    expect(await archive.text("en_tw/manifest.yaml")).toBe("dublin_core: {}")
    await expect(io.zip.read(new ArrayBuffer(10))).rejects.toThrow(/not a zip/)
  })

  it("parses TSV rows by header", () => {
    const t = io.parse.tsv("Reference\tID\tNote\n1:1\tabc1\tFirst\\nline\n1:2\tabc2\t\n")
    expect(t.header).toEqual(["Reference", "ID", "Note"])
    expect(t.rows).toEqual([{ Reference: "1:1", ID: "abc1", Note: "First\\nline" }, { Reference: "1:2", ID: "abc2", Note: "" }])
  })

  it("parses aligned USFM: words with attributes, occurrences and nested milestones", () => {
    const usfm = [
      "\\id TIT EN_ULT en_English_ltr",
      "\\h Titus",
      "\\c 1",
      "\\p",
      '\\v 1 \\zaln-s |x-strong="G39720" x-lemma="Παῦλος" x-morph="Gr,N,,,,,NMS," x-occurrence="1" x-occurrences="1" x-content="Παῦλος"\\*\\w Paul|x-occurrence="1" x-occurrences="1"\\w*\\zaln-e\\*,',
      '\\zaln-s |x-strong="G14010" x-content="δοῦλος"\\*\\w a|x-occurrence="1" x-occurrences="1"\\w*',
      '\\w servant|x-occurrence="1" x-occurrences="1"\\w*\\zaln-e\\* \\f + \\ft a footnote\\f*',
      "\\v 2 \\w in|x-occurrence=\"1\" x-occurrences=\"1\"\\w* hope",
    ].join("\n")
    const doc = io.parse.usfm(usfm)
    expect(doc.book).toBe("TIT")
    expect(doc.verses.map((v) => v.ref)).toEqual(["TIT 1:1", "TIT 1:2"])
    const v1 = doc.verses[0]
    expect(v1.text).toBe("Paul, a servant")
    expect(v1.words.map((w) => w.text)).toEqual(["Paul", "a", "servant"])
    expect(v1.words[0].milestones).toEqual([{ "x-strong": "G39720", "x-lemma": "Παῦλος", "x-morph": "Gr,N,,,,,NMS,", "x-occurrence": "1", "x-occurrences": "1", "x-content": "Παῦλος" }])
    expect(v1.words[2].milestones[0]["x-content"]).toBe("δοῦλος")
    expect(v1.words[1]).toMatchObject({ occurrence: 1, occurrences: 1 })
    expect(doc.verses[1].text).toBe("in hope")
  })

  it("parses original-language words with lemma/strong, counting occurrences when absent", () => {
    const doc = io.parse.usfm('\\id TIT\n\\c 1\n\\v 1 \\w καὶ|lemma="καί" strong="G25320"\\w* \\w λόγος|lemma="λόγος"\\w* \\w καὶ|lemma="καί"\\w*.')
    const w = doc.verses[0].words
    expect(w[0]).toMatchObject({ text: "καὶ", attrs: { lemma: "καί", strong: "G25320" }, occurrence: 1, occurrences: 2 })
    expect(w[2]).toMatchObject({ occurrence: 2, occurrences: 2 })
    expect(doc.verses[0].text).toBe("καὶ λόγος καὶ.")
  })

  it("splits markdown into blocks with stable section slugs", () => {
    const blocks = io.parse.mdBlocks("# God\n\n## Definition:\n\nThe one true God.\nMore.\n\n* item one\n* item two\n\n## Translation Suggestions:\n\nUse a word.")
    expect(blocks.map((b) => [b.kind, b.section])).toEqual([
      ["heading", "god"],
      ["heading", "definition"],
      ["p", "definition"],
      ["list", "definition"],
      ["heading", "translation-suggestions"],
      ["p", "translation-suggestions"],
    ])
    expect(blocks[2].text).toBe("The one true God.\nMore.")
  })
})
