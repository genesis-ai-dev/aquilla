// Shared knowledge_docs domain module (Task 2). WHY: this module is the ONE
// place auth-worker routes, agent tools, and sync-worker external reads all
// go through for knowledge base CRUD — org inheritance (a project sees its
// org's shared docs) and node-addressed reads (an agent asking for "n2" gets
// exactly that section's text, not the whole doc) are the contracts those
// later callers rely on. Each test asserts one of those contracts directly.

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import {
  createDoc, listProjectDocs, listProjectDocsForLane, listOrgDocs, getDocMeta, getDocTree,
  getDocText, deleteDoc, setIndexResult, searchKnowledge, resolveNode, kbExtension, kbR2Key,
  type KnowledgeNode,
} from "../../../db/shared/knowledge"

const TEXT = "# Alpha\nThe quick brown fox.\n\n# Beta\nJumps over the lazy dog."

function nodeFixture(): KnowledgeNode[] {
  return [
    { id: "n1", title: "Alpha", charStart: 0, charEnd: 29 },
    { id: "n2", title: "Beta", charStart: 30, charEnd: TEXT.length },
  ]
}

async function seedScope() {
  await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)")
    .bind(77, "Org", 1)
    .run()
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by, org_id) VALUES (?, ?, ?, ?)")
    .bind("proj-kb", "KB Project", 1, 77).run()
}

async function seedDoc(id: string, scope: { projectId: string } | { orgId: number }, name = "guide.md") {
  await createDoc(env.AQUILLA_PG, {
    id, scope, name, contentType: "text/markdown", sizeBytes: TEXT.length,
    sha256: "abc", r2Key: `kb/x/${id}`, extractedText: TEXT, createdBy: "test-user",
  })
}

describe("knowledge shared primitives", () => {
  it("listProjectDocs returns project docs AND inherits org docs, scope-tagged", async () => {
    await seedScope()
    await seedDoc("11111111-1111-1111-1111-111111111111", { projectId: "proj-kb" }, "proj.md")
    await seedDoc("22222222-2222-2222-2222-222222222222", { orgId: 77 }, "org.md")
    const docs = await listProjectDocs(env.AQUILLA_PG, "proj-kb")
    expect(docs.map((d) => [d.name, d.scope]).sort()).toEqual([["org.md", "org"], ["proj.md", "project"]])
  })

  it("getDocText resolves a nodeId to its char-range substring; unknown nodeId → null", async () => {
    await seedScope()
    await seedDoc("33333333-3333-3333-3333-333333333333", { projectId: "proj-kb" })
    await setIndexResult(env.AQUILLA_PG, "33333333-3333-3333-3333-333333333333", "ready", nodeFixture(), "sum")
    const node = await getDocText(env.AQUILLA_PG, "33333333-3333-3333-3333-333333333333", "n2")
    expect(node?.text).toBe(TEXT.slice(30))
    expect(await getDocText(env.AQUILLA_PG, "33333333-3333-3333-3333-333333333333", "nope")).toBeNull()
  })

  it("searchKnowledge finds case-insensitive matches across project + org docs with a snippet window", async () => {
    await seedScope()
    await seedDoc("44444444-4444-4444-4444-444444444444", { orgId: 77 }, "org.md")
    const hits = await searchKnowledge(env.AQUILLA_PG, "proj-kb", "LAZY DOG")
    expect(hits).toHaveLength(1)
    expect(hits[0].docName).toBe("org.md")
    expect(hits[0].snippet).toContain("lazy dog")
  })

  it("searchKnowledge returns [] on no match and never throws on % or _ in the query", async () => {
    await seedScope()
    await seedDoc("55555555-5555-5555-5555-555555555555", { projectId: "proj-kb" })
    expect(await searchKnowledge(env.AQUILLA_PG, "proj-kb", "zzz%_zzz")).toEqual([])
  })

  it("deleteDoc returns the r2Key and removes the row", async () => {
    await seedScope()
    await seedDoc("66666666-6666-6666-6666-666666666666", { projectId: "proj-kb" })
    expect(await deleteDoc(env.AQUILLA_PG, "66666666-6666-6666-6666-666666666666")).toBe("kb/x/66666666-6666-6666-6666-666666666666")
    expect(await getDocMeta(env.AQUILLA_PG, "66666666-6666-6666-6666-666666666666")).toBeNull()
  })

  it("setIndexResult('failed') leaves the doc listed and searchable", async () => {
    await seedScope()
    await seedDoc("77777777-7777-7777-7777-777777777777", { projectId: "proj-kb" })
    await setIndexResult(env.AQUILLA_PG, "77777777-7777-7777-7777-777777777777", "failed", null, null)
    expect((await listProjectDocs(env.AQUILLA_PG, "proj-kb"))[0].indexStatus).toBe("failed")
    expect(await searchKnowledge(env.AQUILLA_PG, "proj-kb", "quick brown")).toHaveLength(1)
  })

  it("kbExtension + kbR2Key helpers", () => {
    expect(kbExtension("Style Guide.DOCX")).toBe(".docx")
    expect(kbExtension("noext")).toBeNull()
    expect(kbR2Key(undefined, { projectId: "p1" }, "d1")).toBe("kb/project/p1/d1")
    expect(kbR2Key("pre", { orgId: 9 }, "d2")).toBe("pre/kb/org/9/d2")
  })

  it("resolveNode walks children", () => {
    const tree: KnowledgeNode[] = [{ id: "n1", title: "A", charStart: 0, charEnd: 10,
      children: [{ id: "n1.1", title: "A1", charStart: 0, charEnd: 5 }] }]
    expect(resolveNode(tree, "n1.1")?.title).toBe("A1")
    expect(resolveNode(tree, "nx")).toBeNull()
  })
})

// AQU-2348: a knowledge document may belong to ONE target lane. Retrieval then
// sees the project's documents plus that lane's own — never another lane's.
// The guard that matters most is the LAST test: a project where nobody has
// given a document to a lane must retrieve exactly what it retrieved before
// the column existed, in every lane, with no migration.
const ES = "0f0f0f0f"
const FR = "a1b2c3d4"

async function seedLanes() {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO lanes (id, project_id, role, name, legacy_tag, position) VALUES
       (?, 'proj-kb', 'target', 'Spanish', 'es', 1),
       (?, 'proj-kb', 'target', 'French', 'fr', 2)`,
  )
    .bind(ES, FR)
    .run()
}

describe("knowledge documents a lane owns (AQU-2348)", () => {
  it("retrieves a lane's own document in that lane and never in another", async () => {
    await seedScope()
    await seedLanes()
    await seedDoc("aaaaaaaa-0000-0000-0000-000000000001", { projectId: "proj-kb" }, "project.md")
    await createDoc(env.AQUILLA_PG, {
      id: "aaaaaaaa-0000-0000-0000-000000000002",
      scope: { projectId: "proj-kb" },
      name: "es-only.md",
      contentType: "text/markdown",
      sizeBytes: TEXT.length,
      sha256: "abc",
      r2Key: "kb/x/es-only",
      extractedText: TEXT,
      createdBy: "test-user",
      laneId: ES,
    })

    const inEs = await listProjectDocsForLane(env.AQUILLA_PG, "proj-kb", ES)
    expect(inEs.map((d) => d.name).sort()).toEqual(["es-only.md", "project.md"])
    const inFr = await listProjectDocsForLane(env.AQUILLA_PG, "proj-kb", FR)
    expect(inFr.map((d) => d.name)).toEqual(["project.md"])

    // Search is the agent's retrieval surface and answers the same way.
    const esHits = await searchKnowledge(env.AQUILLA_PG, "proj-kb", "lazy dog", 5, { laneId: ES })
    expect(esHits.map((h) => h.docName).sort()).toEqual(["es-only.md", "project.md"])
    const frHits = await searchKnowledge(env.AQUILLA_PG, "proj-kb", "lazy dog", 5, { laneId: FR })
    expect(frHits.map((h) => h.docName)).toEqual(["project.md"])
  })

  it("keeps a lane's document out of a retrieval that named no lane", async () => {
    await seedScope()
    await seedLanes()
    await createDoc(env.AQUILLA_PG, {
      id: "aaaaaaaa-0000-0000-0000-000000000003",
      scope: { projectId: "proj-kb" },
      name: "es-only.md",
      contentType: "text/markdown",
      sizeBytes: TEXT.length,
      sha256: "abc",
      r2Key: "kb/x/es-only-2",
      extractedText: TEXT,
      createdBy: "test-user",
      laneId: ES,
    })
    expect(await searchKnowledge(env.AQUILLA_PG, "proj-kb", "lazy dog", 5, {})).toEqual([])
    expect(await listProjectDocsForLane(env.AQUILLA_PG, "proj-kb", undefined)).toEqual([])
    // …while the management list still shows it, with the owning lane on it.
    const managed = await listProjectDocs(env.AQUILLA_PG, "proj-kb")
    expect(managed.map((d) => [d.name, d.laneId])).toEqual([["es-only.md", ES]])
  })

  it("never stamps a lane on an org-shared document — lane ids are project-local", async () => {
    await seedScope()
    await seedLanes()
    await createDoc(env.AQUILLA_PG, {
      id: "aaaaaaaa-0000-0000-0000-000000000004",
      scope: { orgId: 77 },
      name: "org.md",
      contentType: "text/markdown",
      sizeBytes: TEXT.length,
      sha256: "abc",
      r2Key: "kb/x/org",
      extractedText: TEXT,
      createdBy: "test-user",
      laneId: ES,
    })
    const meta = await getDocMeta(env.AQUILLA_PG, "aaaaaaaa-0000-0000-0000-000000000004")
    expect(meta?.laneId).toBeNull()
    // So it is still inherited by every lane, as an org document must be.
    const inFr = await listProjectDocsForLane(env.AQUILLA_PG, "proj-kb", FR)
    expect(inFr.map((d) => d.name)).toEqual(["org.md"])
  })

  it("answers identically in every lane for a project where no document belongs to a lane", async () => {
    await seedScope()
    await seedLanes()
    await seedDoc("aaaaaaaa-0000-0000-0000-000000000005", { projectId: "proj-kb" }, "project.md")
    await seedDoc("aaaaaaaa-0000-0000-0000-000000000006", { orgId: 77 }, "org.md")
    const all = (await listProjectDocs(env.AQUILLA_PG, "proj-kb")).map((d) => d.name).sort()
    for (const lane of [ES, FR, undefined]) {
      const forLane = (await listProjectDocsForLane(env.AQUILLA_PG, "proj-kb", lane))
        .map((d) => d.name)
        .sort()
      expect(forLane).toEqual(all)
    }
  })
})
