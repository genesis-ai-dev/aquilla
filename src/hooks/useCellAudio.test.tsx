import "fake-indexeddb/auto"
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { createOpfsFs } from "@/lib/git/opfs-fs"
import { MemoryDirectoryHandle } from "@/lib/git/__test__/mem-fs-handles"
import * as cache from "@/lib/lfs/cache"
import type { CodexCell } from "@/lib/codex-editor/types"
import type { ProjectRecord } from "@/lib/parsers/types"

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes as BufferSource)
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("")
}

const session = { gitlabToken: "tok", username: "u" }

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session }),
}))

const fakeRepoRoot = new MemoryDirectoryHandle("repo")
vi.mock("@/lib/git/opfs-fs", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/git/opfs-fs")>()
  return {
    ...actual,
    openOpfsRepoDir: vi.fn(async () => fakeRepoRoot as unknown as FileSystemDirectoryHandle),
  }
})

// Pull useCellAudio after mocks are declared.
import { useCellAudio } from "./useCellAudio"

let nextUrlId = 0
const createdUrls: string[] = []
const revokedUrls: string[] = []

beforeEach(() => {
  nextUrlId = 0
  createdUrls.length = 0
  revokedUrls.length = 0
  Object.defineProperty(globalThis.URL, "createObjectURL", {
    writable: true, configurable: true,
    value: vi.fn((_blob: Blob) => {
      const u = `blob:mock-${++nextUrlId}`
      createdUrls.push(u)
      return u
    }),
  })
  Object.defineProperty(globalThis.URL, "revokeObjectURL", {
    writable: true, configurable: true,
    value: vi.fn((u: string) => { revokedUrls.push(u) }),
  })
  Object.defineProperty(globalThis, "Audio", {
    writable: true, configurable: true,
    value: class {
      src: string = ""
      public onplay: (() => void) | null = null
      public onpause: (() => void) | null = null
      public onended: (() => void) | null = null
      constructor(src?: string) { if (src) this.src = src }
      async play() { this.onplay?.() }
      pause() { this.onpause?.() }
    },
  })
  cache.__setRootForTests(createOpfsFs(new MemoryDirectoryHandle("cacheroot") as unknown as FileSystemDirectoryHandle))
})
afterEach(() => { vi.restoreAllMocks() })

async function seedPointerInRepo(urlRelative: string, oid: string, size: number): Promise<void> {
  const repoFs = createOpfsFs(fakeRepoRoot as unknown as FileSystemDirectoryHandle)
  const text = `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${size}\n`
  await repoFs.promises.writeFile(urlRelative, text)
}

function makeProject(): ProjectRecord {
  return {
    id: "p1", name: "P", sourceLanguage: "en", targetLanguage: "es",
    createdAt: "", files: [], members: [],
    origin: { kind: "git", cloneUrl: "https://git.genesisrnd.com/g/r.git",
              gitlabProjectId: 1, branch: "main", headSha: "abc",
              importedAt: "" },
  } as unknown as ProjectRecord
}

function makeCell(selectedAudioId: string, attachmentUrl: string): CodexCell {
  return {
    kind: 2, languageId: "html", value: "",
    metadata: {
      id: "cell-1", type: "text",
      attachments: { [selectedAudioId]: { url: attachmentUrl, type: "audio" } },
      selectedAudioId,
    },
  } as unknown as CodexCell
}

describe("useCellAudio", () => {
  const fetchMock = vi.fn()
  beforeEach(() => { vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset() })

  it("happy path: loads pointer, downloads, plays", async () => {
    const bytes = new TextEncoder().encode("audio-bytes")
    const oid = await sha256Hex(bytes)
    const size = bytes.byteLength
    await seedPointerInRepo("/.project/attachments/files/JUD/a.webm", oid, size)

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        objects: [{ oid, size, actions: { download: { href: "https://r2/o" } } }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(bytes.buffer as ArrayBuffer, { status: 200 }))

    const project = makeProject()
    const cell = makeCell("a1", "/.project/attachments/files/JUD/a.webm")
    const { result } = renderHook(() => useCellAudio(project, cell))

    expect(result.current.state).toBe("idle")

    await act(async () => { await result.current.play() })

    expect(result.current.state).toBe("ready")
    expect(result.current.error).toBeNull()
    expect(createdUrls.length).toBe(1)
  })

  it("surfaces pointer-missing when the file isn't in the repo", async () => {
    const project = makeProject()
    const cell = makeCell("a2", "/.project/attachments/files/JUD/nope.webm")
    const { result } = renderHook(() => useCellAudio(project, cell))

    await act(async () => { await result.current.play() })
    expect(result.current.state).toBe("error")
    expect(result.current.error).toMatchObject({ kind: "pointer-missing" })
  })

  it("surfaces pointer-invalid when the file isn't a pointer", async () => {
    const repoFs = createOpfsFs(fakeRepoRoot as unknown as FileSystemDirectoryHandle)
    await repoFs.promises.writeFile("/.project/attachments/files/JUD/weird.webm", "not a pointer")

    const project = makeProject()
    const cell = makeCell("a3", "/.project/attachments/files/JUD/weird.webm")
    const { result } = renderHook(() => useCellAudio(project, cell))

    await act(async () => { await result.current.play() })
    expect(result.current.state).toBe("error")
    expect(result.current.error).toMatchObject({ kind: "pointer-invalid" })
  })

  it("uses the cache on replay (no fetch second time)", async () => {
    const bytes = new TextEncoder().encode("cached-audio")
    const oid = await sha256Hex(bytes)
    const size = bytes.byteLength
    await seedPointerInRepo("/.project/attachments/files/JUD/c.webm", oid, size)

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        objects: [{ oid, size, actions: { download: { href: "https://r2/o" } } }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(bytes.buffer as ArrayBuffer, { status: 200 }))

    const project = makeProject()
    const cell = makeCell("a4", "/.project/attachments/files/JUD/c.webm")
    const { result } = renderHook(() => useCellAudio(project, cell))

    await act(async () => { await result.current.play() })
    expect(fetchMock.mock.calls.length).toBe(2)

    const { result: result2 } = renderHook(() => useCellAudio(project, cell))
    await act(async () => { await result2.current.play() })
    expect(fetchMock.mock.calls.length).toBe(2)
  })

  it("revokes the object URL on unmount", async () => {
    const bytes = new TextEncoder().encode("revoke-test")
    const oid = await sha256Hex(bytes)
    const size = bytes.byteLength
    await seedPointerInRepo("/.project/attachments/files/JUD/r.webm", oid, size)

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        objects: [{ oid, size, actions: { download: { href: "https://r2/o" } } }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(bytes.buffer as ArrayBuffer, { status: 200 }))

    const project = makeProject()
    const cell = makeCell("a5", "/.project/attachments/files/JUD/r.webm")
    const { result, unmount } = renderHook(() => useCellAudio(project, cell))
    await act(async () => { await result.current.play() })
    expect(createdUrls.length).toBe(1)

    unmount()
    expect(revokedUrls).toContain(createdUrls[0])
  })
})
