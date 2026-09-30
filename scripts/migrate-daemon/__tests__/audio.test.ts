// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { migrateProjectAudio, type AudioDeps } from "../stages/audio"
import type { ProjectRow } from "../db"

const PROJECT: ProjectRow = {
  gitlab_id: 47,
  aquilla_id: "11111111-1111-4111-8111-111111111111",
  name: "Sample",
  namespace: "org/team",
  org_id: 1,
  team_id: null,
  owner_user_id: 9,
  last_activity_at: "2026-09-01T00:00:00Z",
  head_sha: "sha1",
  applied_sha: "sha1",
  audio_applied_sha: null,
  content_logic: 4,
  cast_hash: null,
  status: "ok",
  last_error: null,
  project_upserted: 1,
  updated_at: 0,
}

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function repoWithAudio(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-audio-"))
  roots.push(root)
  fs.mkdirSync(path.join(root, "files/target"), { recursive: true })
  fs.mkdirSync(path.join(root, ".project/attachments/pointers"), { recursive: true })
  fs.writeFileSync(path.join(root, ".project/attachments/pointers/clip.webm"),
    `version https://git-lfs.github.com/spec/v1\noid sha256:${"ab".repeat(32)}\nsize 12\n`)
  fs.writeFileSync(path.join(root, "files/target/GEN 1.codex"), JSON.stringify({
    metadata: { id: "book", originalName: "GEN 1" },
    cells: [{
      kind: 2,
      languageId: "scripture",
      value: "text",
      metadata: {
        id: "GEN 1:1",
        type: "text",
        selectedAudioId: "clip",
        attachments: {
          clip: {
            url: ".project/attachments/files/clip.webm",
            type: "audio",
            createdAt: 100,
          },
        },
      },
    }],
  }))
  return root
}

/** Add a target notebook whose attachments have NO pointer in the tree, so every
 *  take in it fails oid resolution (the book-silently-dropped case). */
function addBook(root: string, relPath: string, cellId: string, ...clips: string[]): void {
  const attachments = Object.fromEntries(
    clips.map((clip, i) => [
      `clip-${i}`,
      { url: `.project/attachments/files/${clip}`, type: "audio", createdAt: 200 + i },
    ]),
  )
  fs.writeFileSync(path.join(root, `files/target/${relPath}.codex`), JSON.stringify({
    metadata: { id: relPath, originalName: relPath },
    cells: [{
      kind: 2,
      languageId: "scripture",
      value: "text",
      metadata: { id: cellId, type: "text", attachments },
    }],
  }))
}

function deps(over: Partial<AudioDeps> = {}): AudioDeps {
  return {
    copyObject: async () => {},
    sync: { ingest: async () => ({ status: 200, ms: 1, accepted: 0 }) } as never,
    copyConcurrency: 2,
    dryRun: false,
    ...over,
  }
}

describe("migrateProjectAudio", () => {
  it("copies pointer objects R2-to-R2 and ingests deterministic attach/select events", async () => {
    const copies: string[][] = []
    const ingests: Array<{ projectId: string; events: Array<{ kind: string }> }> = []
    const result = await migrateProjectAudio(deps({
      copyObject: async (...args) => { copies.push(args) },
      sync: { ingest: async (projectId: string, events: Array<{ kind: string }>) => {
        ingests.push({ projectId, events })
        return { status: 200, ms: 1, accepted: events.length }
      } } as never,
    }), { project: PROJECT, dir: repoWithAudio() })

    expect(copies).toHaveLength(1)
    expect(copies[0]).toMatchObject([
      "codex-attachments-v1-1",
      `ab/ab/${"ab".repeat(30)}`,
      "aquilla-snapshots",
      expect.stringMatching(new RegExp(`^projects/${PROJECT.aquilla_id}/files/.+/audio/clip\\.webm$`)),
    ])
    expect(ingests).toHaveLength(1)
    expect(ingests[0].projectId).toBe(PROJECT.aquilla_id)
    expect(ingests[0].events.map((event) => event.kind)).toEqual([
      "cell.audio.attach",
      "cell.audio.select",
    ])
    expect(result).toMatchObject({ total: 1, copied: 1, events: 2, missingOid: 0, lfsMiss: 0, failed: 0 })
  })

  it("dry-run reads the manifest but does not copy or ingest audio", async () => {
    let copies = 0
    let ingests = 0
    const result = await migrateProjectAudio(deps({
      dryRun: true,
      copyObject: async () => { copies++ },
      sync: { ingest: async () => { ingests++; return { status: 200, ms: 1, accepted: 0 } } } as never,
    }), { project: PROJECT, dir: repoWithAudio() })
    expect(result.total).toBe(1)
    expect(copies).toBe(0)
    expect(ingests).toBe(0)
  })

  it("does not mark an audio migration complete when every attachment lacks an LFS pointer", async () => {
    const dir = repoWithAudio()
    fs.rmSync(path.join(dir, ".project/attachments/pointers"), { recursive: true, force: true })
    await expect(migrateProjectAudio(deps(), { project: PROJECT, dir }))
      .rejects.toThrow("1 attachments have no LFS object id")
  })

  // AQU-1373: Pattani Malay came across with Luke and Mark but no Matthew. A
  // book whose takes all fail oid resolution produces no CopyUnits, so the old
  // `units.length === 0` guard never fired once ANY other book copied — the job
  // went `done`, audio_applied_sha advanced, and the book was never retried.
  it("fails the stage when one book lacks LFS pointers even though another book copies", async () => {
    const dir = repoWithAudio()
    addBook(dir, "MAT 1", "MAT 1:1", "missing-in-lfs.webm")

    const copies: string[][] = []
    await expect(migrateProjectAudio(deps({
      copyObject: async (...args) => { copies.push(args) },
    }), { project: PROJECT, dir })).rejects.toThrow(
      /audio copy incomplete: 1 attachments have no LFS object id \(MAT 1: 1\)/,
    )

    // The book that DID resolve is still copied — the failure is a signal to
    // retry, not a reason to discard work that landed.
    expect(copies).toHaveLength(1)
  })

  it("names every book that lost takes, worst first", async () => {
    const dir = repoWithAudio()
    addBook(dir, "MAT 1", "MAT 1:1", "gone-a.webm")
    addBook(dir, "MAT 2", "MAT 2:1", "gone-b.webm", "gone-c.webm")

    await expect(migrateProjectAudio(deps(), { project: PROJECT, dir }))
      .rejects.toThrow("3 attachments have no LFS object id (MAT 2: 2, MAT 1: 1)")
  })
})
