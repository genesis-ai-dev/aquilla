import "fake-indexeddb/auto"
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createOpfsFs } from "@/lib/git/opfs-fs"
import { MemoryDirectoryHandle } from "@/lib/git/__test__/mem-fs-handles"
import { importFromOpfs } from "@/lib/importer/git-importer"
import { isFileDirty } from "./dirty"
import { setFragmentFromHtml } from "@/lib/richtext/translated-xml"
import * as Y from "yjs"

const FIX = join(__dirname, "../../../tests/fixtures/codex-editor")

async function importSample() {
  const root = new MemoryDirectoryHandle("r")
  const fs = createOpfsFs(root as unknown as FileSystemDirectoryHandle)
  await fs.promises.mkdir("/repo/files/target", { recursive: true })
  await fs.promises.mkdir("/repo/.project/sourceTexts", { recursive: true })
  await fs.promises.writeFile("/repo/metadata.json", readFileSync(join(FIX, "metadata.json"), "utf8"))
  await fs.promises.writeFile("/repo/files/target/sample.codex", readFileSync(join(FIX, "sample.codex"), "utf8"))
  await fs.promises.writeFile("/repo/.project/sourceTexts/sample.source", readFileSync(join(FIX, "sample.source"), "utf8"))
  return importFromOpfs({
    fs,
    repoDir: "/repo",
    origin: { kind: "git", cloneUrl: "u", gitlabProjectId: 1, branch: "main", headSha: "abc", importedAt: "now" },
    permissions: {
      source: "gitlab",
      canEditContent: true,
      canEditComments: true,
      canResolveComments: true,
      canPush: true,
      accessLevel: 30,
    },
  })
}

describe("isFileDirty", () => {
  it("returns false right after import", async () => {
    const { docs } = await importSample()
    expect(isFileDirty(Object.values(docs)[0])).toBe(false)
  })

  it("returns true after a cell value edit", async () => {
    const { docs } = await importSample()
    const doc = Object.values(docs)[0]
    const cellsMap = doc.getMap("cells")
    const firstKey = Array.from(cellsMap.keys())[0]
    const c = cellsMap.get(firstKey) as Y.Map<unknown>
    const frag = c.get("translatedXml") as Y.XmlFragment
    setFragmentFromHtml(frag, "<p>changed for dirty check</p>")
    expect(isFileDirty(doc)).toBe(true)
  })

  it("returns true after a new history entry", async () => {
    const { docs } = await importSample()
    const doc = Object.values(docs)[0]
    const cellsMap = doc.getMap("cells")
    const firstKey = Array.from(cellsMap.keys())[0]
    const c = cellsMap.get(firstKey) as Y.Map<unknown>
    const hist = c.get("history") as Y.Array<unknown>
    hist.push([
      {
        timestamp: new Date().toISOString(),
        value: "<p>x</p>",
        source: "human",
        author: "alice",
        validated: false,
      },
    ])
    expect(isFileDirty(doc)).toBe(true)
  })
})
