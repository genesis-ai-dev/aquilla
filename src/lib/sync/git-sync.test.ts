import "fake-indexeddb/auto"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import * as git from "isomorphic-git"
import { createOpfsFs } from "@/lib/git/opfs-fs"
import { MemoryDirectoryHandle } from "@/lib/git/__test__/mem-fs-handles"
import { importFromOpfs, persistImportedProject } from "@/lib/importer/git-importer"
import { setFragmentFromHtml } from "@/lib/richtext/translated-xml"
import * as Y from "yjs"
import type { FrontierSession } from "@/lib/frontier/types"

vi.mock("isomorphic-git", async () => {
  const actual = await vi.importActual<typeof import("isomorphic-git")>("isomorphic-git")
  return {
    ...actual,
    fetch: vi.fn(async () => ({ fetchHead: "abc", fetchHeadDescription: "" })),
    resolveRef: vi.fn(async () => "abc"),
    addRemote: vi.fn(async () => {}),
    statusMatrix: vi.fn(async () => [["files/target/sample.codex", 1, 2, 1]]),
    add: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    commit: vi.fn(async () => "newsha"),
    push: vi.fn(async () => ({ ok: true })),
  }
})

// Phase 3 merge path — mock so remote-moved tests don't need a real git DAG.
vi.mock("./git-merge", () => {
  class MergeFailure extends Error {
    backupRef?: string
    constructor(msg: string, opts: { backupRef?: string } = {}) {
      super(msg); this.name = "MergeFailure"; this.backupRef = opts.backupRef
    }
  }
  return {
    MergeFailure,
    mergeRemoteIntoOurs: vi.fn(async () => ({ mergeSha: "mergesha", touchedPaths: [] })),
  }
})

// Import after mock so syncProject picks up the mocked module.
import { syncProject, findOriginalPath } from "./git-sync"

const FIX = join(__dirname, "../../../tests/fixtures/codex-editor")

const session: FrontierSession = {
  jwt: "j",
  gitlabToken: "t",
  gitlabUrl: "https://gitlab.frontierrnd.com",
  username: "tester",
  createdAt: "now",
}

async function setupProject() {
  const root = new MemoryDirectoryHandle("r")
  const fs = createOpfsFs(root as unknown as FileSystemDirectoryHandle)
  await fs.promises.mkdir("/repo/files/target", { recursive: true })
  await fs.promises.mkdir("/repo/.project/sourceTexts", { recursive: true })
  await fs.promises.writeFile("/repo/metadata.json", readFileSync(join(FIX, "metadata.json"), "utf8"))
  await fs.promises.writeFile(
    "/repo/files/target/sample.codex",
    readFileSync(join(FIX, "sample.codex"), "utf8"),
  )
  await fs.promises.writeFile(
    "/repo/.project/sourceTexts/sample.source",
    readFileSync(join(FIX, "sample.source"), "utf8"),
  )
  const imported = await importFromOpfs({
    fs,
    repoDir: "/repo",
    origin: {
      kind: "git",
      cloneUrl: "https://gitlab.example.com/g/r.git",
      gitlabProjectId: 1,
      branch: "main",
      headSha: "abc",
      importedAt: "now",
    },
    permissions: {
      source: "gitlab",
      canEditContent: true,
      canEditComments: true,
      canResolveComments: true,
      canPush: true,
      accessLevel: 30,
    },
  })
  const { project, docs } = imported
  // Re-root fs so "/files/..." maps to "/repo/files/..." inside the handle.
  // We'll rebuild a fresh fs with the "/repo" directory as root.
  const repoRoot = new MemoryDirectoryHandle("repo")
  const repoFs = createOpfsFs(repoRoot as unknown as FileSystemDirectoryHandle)
  await repoFs.promises.mkdir("/files/target", { recursive: true })
  await repoFs.promises.mkdir("/.project/sourceTexts", { recursive: true })
  await repoFs.promises.writeFile(
    "/metadata.json",
    readFileSync(join(FIX, "metadata.json"), "utf8"),
  )
  await repoFs.promises.writeFile(
    "/files/target/sample.codex",
    readFileSync(join(FIX, "sample.codex"), "utf8"),
  )
  await repoFs.promises.writeFile(
    "/.project/sourceTexts/sample.source",
    readFileSync(join(FIX, "sample.source"), "utf8"),
  )
  return { project, docs, fs: repoFs }
}

describe("findOriginalPath", () => {
  it("strips repo prefix and locates /files/target/{name}.codex", () => {
    const got = findOriginalPath(
      {
        originalFileListing: {
          "/repo/metadata.json": "h",
          "/repo/files/target/sample.codex": "h",
        },
      } as never,
      "sample",
    )
    expect(got).toBe("/files/target/sample.codex")
  })

  it("returns null when no matching entry", () => {
    expect(findOriginalPath({ originalFileListing: {} } as never, "nope")).toBeNull()
  })
})

describe("syncProject", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Re-stub in case clearAllMocks wiped returns
    vi.mocked(git.fetch).mockResolvedValue({ fetchHead: "abc", fetchHeadDescription: "" } as never)
    vi.mocked(git.resolveRef).mockResolvedValue("abc")
    vi.mocked(git.commit).mockResolvedValue("newsha")
    vi.mocked(git.push).mockResolvedValue({ ok: true } as never)
  })

  it("returns no-changes when project is clean", async () => {
    const { project, docs, fs } = await setupProject()
    await persistImportedProject({ project, docs })
    const result = await syncProject(project, session, { fs })
    expect(result.status).toBe("no-changes")
    expect(git.commit).not.toHaveBeenCalled()
    expect(git.push).not.toHaveBeenCalled()
  })

  it("merges when remote moved since last sync", async () => {
    const { project, docs, fs } = await setupProject()
    await persistImportedProject({ project, docs })
    // fetched head differs from project.origin.headSha → Phase 3 merge path.
    vi.mocked(git.resolveRef).mockResolvedValueOnce("differentsha")
    const result = await syncProject(project, session, { fs })
    expect(result.status).toBe("merged")
    expect(result.mergeSha).toBe("mergesha")
    expect(git.push).toHaveBeenCalled()
  })

  it("returns synced and updates origin.headSha on a dirty file", async () => {
    const { project, docs, fs } = await setupProject()
    // Mutate a cell on the imported in-memory doc before persisting.
    const doc = Object.values(docs)[0]
    const cellsMap = doc.getMap("cells")
    const firstKey = Array.from(cellsMap.keys())[0]
    if (!firstKey) throw new Error("no cells imported")
    const cell = cellsMap.get(firstKey) as Y.Map<unknown>
    const frag = cell.get("translatedXml") as Y.XmlFragment
    setFragmentFromHtml(frag, "<p>dirty edit</p>")
    const hist = cell.get("history") as Y.Array<unknown>
    hist.push([
      {
        timestamp: new Date().toISOString(),
        value: "<p>dirty edit</p>",
        source: "human",
        author: "tester",
        validated: false,
      },
    ])
    await persistImportedProject({ project, docs })

    const result = await syncProject(project, session, { fs })
    expect(result.status).toBe("synced")
    expect(result.commitSha).toBe("newsha")
    expect(git.add).toHaveBeenCalled()
    expect(git.commit).toHaveBeenCalled()
    expect(git.push).toHaveBeenCalled()

    // Verify file was written via fs
    const written = (await fs.promises.readFile("/files/target/sample.codex", {
      encoding: "utf8",
    })) as string
    expect(written).toContain("dirty edit")
  })
})
