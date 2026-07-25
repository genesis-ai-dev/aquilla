import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { FilePairInput } from "../../src/lib/migrate/map"
import {
  resolveGitlabIdmlOriginal,
  resolveLocalIdmlOriginal,
} from "./idml-migration-artifacts"

const roots: string[] = []

function tempProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aquilla-idml-migration-"))
  roots.push(root)
  return root
}

function pair(originalName = "book.idml"): FilePairInput {
  return {
    relPath: "book",
    name: "book",
    source: {
      metadata: { id: "f", originalName },
      cells: [],
    },
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe("Codex IDML original resolution", () => {
  it("resolves the exact local files/originals member and hashes its bytes", () => {
    const root = tempProject()
    const originals = path.join(root, ".project", "attachments", "files", "originals")
    fs.mkdirSync(originals, { recursive: true })
    fs.writeFileSync(path.join(originals, "other.idml"), "OTHER")
    fs.writeFileSync(path.join(originals, "book.idml"), "BOOK")

    expect(resolveLocalIdmlOriginal(root, pair())).toMatchObject({
      kind: "local",
      relativePath: ".project/attachments/files/originals/book.idml",
      name: "book.idml",
      size: 4,
    })
    expect(resolveLocalIdmlOriginal(root, pair())?.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it("does not guess when several originals exist and none matches", () => {
    const root = tempProject()
    const originals = path.join(root, ".project", "attachments", "files", "originals")
    fs.mkdirSync(originals, { recursive: true })
    fs.writeFileSync(path.join(originals, "a.idml"), "A")
    fs.writeFileSync(path.join(originals, "b.idml"), "B")
    expect(resolveLocalIdmlOriginal(root, pair("missing.idml"))).toBeUndefined()
  })

  it("discovers the exact GitLab LFS pointers/originals member without downloading it", () => {
    const root = tempProject()
    const originals = path.join(root, ".project", "attachments", "pointers", "originals")
    fs.mkdirSync(originals, { recursive: true })
    const oid = "a".repeat(64)
    fs.writeFileSync(
      path.join(originals, "book.idml"),
      `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 123\n`,
    )
    expect(resolveGitlabIdmlOriginal(root, pair())).toEqual({
      kind: "gitlab-lfs",
      relativePath: ".project/attachments/pointers/originals/book.idml",
      name: "book.idml",
      size: 123,
      oid,
    })
  })
})
