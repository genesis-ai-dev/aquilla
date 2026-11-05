import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { checkDocPins, exportsSymbol, extractPins, stripFencedBlocks } from "./check-doc-pins"

let root = ""

const write = (relative: string, contents: string): void => {
  const absolute = path.join(root, relative)
  mkdirSync(path.dirname(absolute), { recursive: true })
  writeFileSync(absolute, contents, "utf8")
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "doc-pins-"))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("checkDocPins", () => {
  it("passes when a strict record's pins resolve", () => {
    write("src/lib/thing.ts", "export function doThing() {}\n")
    write("docs/decisions/0001-thing.md", "Pinned: `src/lib/thing.ts::doThing` in `src/lib/`.\n")

    const report = checkDocPins(root)

    expect(report.failures).toEqual([])
    expect(report.pins).toBe(2)
  })

  it("fails when a pinned symbol is renamed (AQU-2387: the whole point)", () => {
    write("src/lib/thing.ts", "export function doThing() {}\n")
    write("docs/decisions/0001-thing.md", "Pinned: `src/lib/thing.ts::doThing`.\n")
    expect(checkDocPins(root).failures).toEqual([])

    write("src/lib/thing.ts", "export function doThingDifferently() {}\n")

    const { failures } = checkDocPins(root)
    expect(failures).toHaveLength(1)
    expect(failures[0]?.pin.raw).toBe("src/lib/thing.ts::doThing")
    expect(failures[0]?.pin.doc).toBe("docs/decisions/0001-thing.md")
    expect(failures[0]?.reason).toContain("doThing")
  })

  it("fails when a pinned file is moved away", () => {
    write("docs/decisions/0002-gone.md", "Pinned: `src/lib/missing.ts`.\n")

    const { failures } = checkDocPins(root)
    expect(failures).toHaveLength(1)
    expect(failures[0]?.reason).toBe("no such file")
  })

  it("checks only `path::symbol` pins outside the strict folder", () => {
    write("src/lib/thing.ts", "export const kept = 1\n")
    // The repo's older docs name paths that are deliberately stale, so a bare
    // path span there is prose, not a pin.
    write("docs/legacy.md", "The old layout had `apps/workspace/App.tsx`.\n")
    write("CLAUDE.md", "Stale: `packages/api-client/index.ts`.\n")
    expect(checkDocPins(root).failures).toEqual([])

    write("docs/legacy.md", "Now scoped: `src/lib/thing.ts::dropped`.\n")

    const { failures } = checkDocPins(root)
    expect(failures).toHaveLength(1)
    expect(failures[0]?.pin.doc).toBe("docs/legacy.md")
  })

  it("resolves a directory pin, and rejects one that names a file", () => {
    write("src/lib/thing.ts", "export const kept = 1\n")
    write("docs/decisions/0003-dirs.md", "`src/lib/` holds it; `src/lib/thing.ts/` does not.\n")

    const { failures } = checkDocPins(root)
    expect(failures).toHaveLength(1)
    expect(failures[0]?.pin.target).toBe("src/lib/thing.ts/")
    expect(failures[0]?.reason).toBe("pinned as a directory but is a file")
  })

  it("will not resolve a symbol in a file type it cannot read", () => {
    write("docs/decisions/0004-md.md", "`docs/decisions/0004-md.md::heading`\n")

    expect(checkDocPins(root).failures[0]?.reason).toContain("pin the file alone")
  })

  it("finds tables, views and routines in a pinned .sql file", () => {
    write("db/postgres/schema.sql", "CREATE TABLE IF NOT EXISTS public.events (id text);\n")
    write("docs/decisions/0005-sql.md", "`db/postgres/schema.sql::events` and `db/postgres/schema.sql::cells`\n")

    const { failures } = checkDocPins(root)
    expect(failures).toHaveLength(1)
    expect(failures[0]?.reason).toContain("no such table")
  })

  it("ignores a doc that opts out on a line of its own", () => {
    write("docs/decisions/0006-off.md", "<!-- doc-pins: off -->\n\n`src/lib/missing.ts`\n")

    expect(checkDocPins(root).failures).toEqual([])
  })

  it("does not let a doc quoting the marker switch itself off", () => {
    // docs/decisions/INDEX.md documents both markers inline.
    write("docs/decisions/INDEX.md", "A doc opts out with `<!-- doc-pins: off -->`.\n\n`src/lib/missing.ts`\n")

    expect(checkDocPins(root).failures).toHaveLength(1)
  })

  it("honours the strict marker in a doc outside the decisions folder", () => {
    write("docs/ARCHITECTURE.md", "<!-- doc-pins: strict -->\n\n`src/lib/missing.ts`\n")

    expect(checkDocPins(root).failures).toHaveLength(1)
  })
})

describe("extractPins", () => {
  it("skips fenced code blocks, globs and package specifiers", () => {
    const markdown = [
      "```ts",
      "import x from `src/lib/fenced.ts`",
      "```",
      "Globs like `docs/**/*.md` and specifiers like `@tauri-apps/api/core::invoke` are not pins.",
      "Nor is a cast like `date_utc::text` or a bare `commands.ts::validateCommands`.",
      "But `src/lib/real.ts` is.",
    ].join("\n")

    expect(extractPins("docs/decisions/x.md", markdown, true).map((pin) => pin.raw)).toEqual([
      "src/lib/real.ts",
    ])
  })

  it("reports the line a pin sits on, with fences blanked but counted", () => {
    const markdown = ["```", "fenced", "```", "", "`src/lib/real.ts`"].join("\n")

    expect(extractPins("docs/decisions/x.md", markdown, true)[0]?.line).toBe(5)
    expect(stripFencedBlocks(markdown).split("\n")).toHaveLength(5)
  })
})

describe("exportsSymbol", () => {
  it("accepts every export shape the repo actually uses", () => {
    expect(exportsSymbol("export async function handlePrepare() {}", "handlePrepare", "ts")).toBe(true)
    expect(exportsSymbol("export const sentinelFor = () => {}", "sentinelFor", "ts")).toBe(true)
    expect(exportsSymbol("export interface TagMask {}", "TagMask", "ts")).toBe(true)
    expect(exportsSymbol("export class ChainHeadReplay {}", "ChainHeadReplay", "ts")).toBe(true)
    expect(exportsSymbol("export function* walk() {}", "walk", "ts")).toBe(true)
    expect(exportsSymbol('export { createTagMask } from "../x"', "createTagMask", "ts")).toBe(true)
    expect(
      exportsSymbol('export {\n  parseIdml,\n  exportIdml,\n} from "./engine.js"', "exportIdml", "ts"),
    ).toBe(true)
    expect(exportsSymbol('export type { TagLadderResult } from "./x"', "TagLadderResult", "ts")).toBe(true)
    expect(exportsSymbol('export { inner as outer } from "./x"', "outer", "ts")).toBe(true)
    expect(exportsSymbol('export * as helpers from "./x"', "helpers", "ts")).toBe(true)
  })

  it("rejects a symbol that is only local, or only an alias source", () => {
    expect(exportsSymbol("function privateThing() {}", "privateThing", "ts")).toBe(false)
    expect(exportsSymbol('export { inner as outer } from "./x"', "inner", "ts")).toBe(false)
    expect(exportsSymbol("export const almost = 1", "almostTwo", "ts")).toBe(false)
  })
})
