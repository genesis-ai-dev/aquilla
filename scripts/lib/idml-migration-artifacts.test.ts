import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { FilePairInput } from "../../src/lib/migrate/map"
import {
  downloadGitlabIdmlOriginalBytes,
  readGitlabIdmlOriginalBytes,
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
  vi.unstubAllGlobals()
})

describe("Codex IDML original resolution", () => {
  it("resolves the exact local files/originals member and hashes its bytes", () => {
    const root = tempProject()
    const originals = path.join(root, ".project", "attachments", "files", "originals")
    fs.mkdirSync(originals, { recursive: true })
    fs.writeFileSync(path.join(originals, "other.idml"), "OTHER")
    fs.writeFileSync(path.join(originals, "book.idml"), "BOOK")

    const resolved = resolveLocalIdmlOriginal(root, pair())
    expect(resolved).toMatchObject({
      kind: "local",
      relativePath: ".project/attachments/files/originals/book.idml",
      name: "book.idml",
      size: 4,
    })
    expect(resolved?.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(Array.from(resolved?.bytes ?? [])).toEqual(Array.from(Buffer.from("BOOK")))
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
      filesAbsolutePath: path.join(
        root,
        ".project",
        "attachments",
        "files",
        "originals",
        "book.idml",
      ),
    })
  })

  it("accepts only locally dereferenced GitLab bytes matching the pointer OID and size", () => {
    const root = tempProject()
    const pointerDir = path.join(root, ".project", "attachments", "pointers", "originals")
    const filesDir = path.join(root, ".project", "attachments", "files", "originals")
    fs.mkdirSync(pointerDir, { recursive: true })
    fs.mkdirSync(filesDir, { recursive: true })
    const bytes = Buffer.from("BOOK")
    const oid = createHash("sha256").update(bytes).digest("hex")
    fs.writeFileSync(
      path.join(pointerDir, "book.idml"),
      `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${bytes.byteLength}\n`,
    )
    const original = resolveGitlabIdmlOriginal(root, pair())!

    fs.writeFileSync(original.filesAbsolutePath, bytes)
    expect(Array.from(readGitlabIdmlOriginalBytes(original) ?? [])).toEqual(Array.from(bytes))

    fs.writeFileSync(original.filesAbsolutePath, "EVIL")
    expect(readGitlabIdmlOriginalBytes(original)).toBeUndefined()
  })

  it("downloads only the selected GitLab original and verifies it before assessment", async () => {
    const root = tempProject()
    const pointerDir = path.join(root, ".project", "attachments", "pointers", "originals")
    fs.mkdirSync(pointerDir, { recursive: true })
    const bytes = Buffer.from("BOOK")
    const oid = createHash("sha256").update(bytes).digest("hex")
    fs.writeFileSync(
      path.join(pointerDir, "book.idml"),
      `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${bytes.byteLength}\n`,
    )
    const original = resolveGitlabIdmlOriginal(root, pair())!
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        objects: [{
          oid,
          size: bytes.byteLength,
          actions: { download: { href: "https://objects.example/book" } },
        }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(bytes, { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)

    await expect(downloadGitlabIdmlOriginalBytes({
      original,
      repositoryUrl: "https://gitlab.example/group/repo.git",
      gitlabToken: "secret",
    })).resolves.toEqual(new Uint8Array(bytes))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toMatchObject({
      objects: [{ oid, size: bytes.byteLength }],
    })
  })
})
