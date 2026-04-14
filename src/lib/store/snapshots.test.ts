import { describe, it, expect, beforeEach } from "vitest"
import * as Y from "yjs"
import {
  createSnapshot, listSnapshots, getSnapshot, deleteSnapshot,
  restoreSnapshot, exportSnapshotToBlob, importSnapshotFromFile,
} from "./snapshots"
import { createProject, _resetDbForTesting } from "./project-index"
import { createFileDoc, loadFileDoc, destroyFileDoc } from "./file-doc"
import { v4 as uuid } from "uuid"
import type { ProjectRecord, TranslatableString } from "../parsers/types"
import { getPlainText, setPlainText } from "@/lib/richtext/translated-xml"

function makeProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: "test-" + Math.random().toString(36).slice(2),
    name: "Test Project",
    sourceLanguage: "en",
    targetLanguage: "fr",
    createdAt: new Date().toISOString(),
    files: [],
    members: [],
    ...overrides,
  }
}

function makeStrings(): TranslatableString[] {
  return [
    {
      id: "c1",
      original: "Hello",
      translated: "Bonjour",
      context: "P1",
      group: uuid(),
      type: "text",
    },
  ]
}

beforeEach(async () => {
  await _resetDbForTesting()
  const dbs = await indexedDB.databases()
  for (const db of dbs) {
    if (db.name) indexedDB.deleteDatabase(db.name)
  }
})

describe("snapshots", () => {
  it("creates a snapshot capturing project state", async () => {
    const project = makeProject({ id: "p1", name: "My Project" })
    const fileId = "f1"
    project.files = [{ id: fileId, name: "test.txt", type: "txt", createdAt: new Date().toISOString(), cellCount: 1 }]
    await createProject(project)

    const handle = createFileDoc(fileId, "test.txt", "txt", "en", "fr", makeStrings())
    await new Promise<void>((resolve) => {
      if (handle.persistence.synced) resolve()
      else handle.persistence.once("synced", () => resolve())
    })
    destroyFileDoc(handle)

    const snapshot = await createSnapshot("p1", "First milestone", "Initial draft", false)
    expect(snapshot.id).toBeTruthy()
    expect(snapshot.projectId).toBe("p1")
    expect(snapshot.name).toBe("First milestone")
    expect(snapshot.description).toBe("Initial draft")
    expect(snapshot.automatic).toBe(false)
    expect(snapshot.files).toHaveLength(1)
    expect(snapshot.files[0].fileId).toBe(fileId)
    expect(snapshot.files[0].ydocState).toBeTruthy()
    expect(snapshot.projectRecord.id).toBe("p1")
  })

  it("lists snapshots for a project", async () => {
    const project = makeProject({ id: "p1" })
    await createProject(project)

    await createSnapshot("p1", "snap1")
    await createSnapshot("p1", "snap2")

    const list = await listSnapshots("p1")
    expect(list).toHaveLength(2)
    const names = list.map((s) => s.name)
    expect(names).toContain("snap1")
    expect(names).toContain("snap2")
  })

  it("listSnapshots is scoped per project", async () => {
    await createProject(makeProject({ id: "p1" }))
    await createProject(makeProject({ id: "p2" }))
    await createSnapshot("p1", "p1-snap")
    await createSnapshot("p2", "p2-snap")

    const p1List = await listSnapshots("p1")
    expect(p1List).toHaveLength(1)
    expect(p1List[0].name).toBe("p1-snap")

    const p2List = await listSnapshots("p2")
    expect(p2List).toHaveLength(1)
    expect(p2List[0].name).toBe("p2-snap")
  })

  it("deletes a snapshot", async () => {
    await createProject(makeProject({ id: "p1" }))
    const snap = await createSnapshot("p1", "to-delete")
    expect(await getSnapshot(snap.id)).toBeDefined()

    await deleteSnapshot(snap.id)
    expect(await getSnapshot(snap.id)).toBeUndefined()
  })

  it("restores a snapshot and recreates Y.Doc state", async () => {
    const project = makeProject({ id: "p1" })
    const fileId = "f1"
    project.files = [{ id: fileId, name: "test.txt", type: "txt", createdAt: new Date().toISOString(), cellCount: 1 }]
    await createProject(project)

    // Create initial state
    const handle1 = createFileDoc(fileId, "test.txt", "txt", "en", "fr", [
      { id: "c1", original: "Hello", translated: "Bonjour", context: "P1", group: uuid(), type: "text" },
    ])
    await new Promise<void>((resolve) => {
      if (handle1.persistence.synced) resolve()
      else handle1.persistence.once("synced", () => resolve())
    })
    destroyFileDoc(handle1)

    // Snapshot this state
    const snapshot = await createSnapshot("p1", "initial")

    // Modify the doc
    const handle2 = loadFileDoc(fileId)
    await new Promise<void>((resolve) => {
      if (handle2.persistence.synced) resolve()
      else handle2.persistence.once("synced", () => resolve())
    })
    const cellsMap = handle2.doc.getMap("cells")
    const cell = cellsMap.get("c1") as Y.Map<unknown> | undefined
    if (cell) {
      const frag = cell.get("translatedXml") as Y.XmlFragment | undefined
      if (frag) {
        setPlainText(frag, "MODIFIED")
      } else {
        handle2.doc.transact(() => {
          cell.set("translated", "MODIFIED")
        })
      }
    }
    destroyFileDoc(handle2)

    // Restore
    await restoreSnapshot(snapshot.id, "testuser")

    // Verify restore worked
    const handle3 = loadFileDoc(fileId)
    await new Promise<void>((resolve) => {
      if (handle3.persistence.synced) resolve()
      else handle3.persistence.once("synced", () => resolve())
    })
    const restoredCell = handle3.doc.getMap("cells").get("c1") as Y.Map<unknown> | undefined
    const frag = restoredCell?.get("translatedXml") as Y.XmlFragment | undefined
    expect(frag).toBeDefined()
    expect(frag ? getPlainText(frag) : "").toBe("Bonjour")
    destroyFileDoc(handle3)
  })

  it("creates an automatic safety snapshot before restore", async () => {
    await createProject(makeProject({ id: "p1" }))
    const snap = await createSnapshot("p1", "target")

    const countBefore = (await listSnapshots("p1")).length
    await restoreSnapshot(snap.id, "testuser")
    const after = await listSnapshots("p1")

    expect(after.length).toBe(countBefore + 1)
    const autoSnap = after.find((s) => s.automatic)
    expect(autoSnap).toBeDefined()
    expect(autoSnap!.name).toContain("target")
  })

  it("exports snapshot to blob", async () => {
    await createProject(makeProject({ id: "p1" }))
    const snap = await createSnapshot("p1", "export-test")

    const blob = exportSnapshotToBlob(snap)
    expect(blob).toBeInstanceOf(Blob)
    const text = await blob.text()
    const parsed = JSON.parse(text)
    expect(parsed.name).toBe("export-test")
  })

  it("imports snapshot from file with new id", async () => {
    await createProject(makeProject({ id: "p1" }))
    const snap = await createSnapshot("p1", "original")
    const blob = exportSnapshotToBlob(snap)

    const file = new File([blob], "snap.json", { type: "application/json" })
    const imported = await importSnapshotFromFile(file)

    expect(imported.id).not.toBe(snap.id)
    expect(imported.name).toBe("original")
    expect(imported.projectId).toBe("p1")

    const list = await listSnapshots("p1")
    expect(list.length).toBe(2)
  })

  it("rejects invalid snapshot file", async () => {
    const file = new File(["not json"], "bad.json")
    await expect(importSnapshotFromFile(file)).rejects.toThrow()
  })
})
