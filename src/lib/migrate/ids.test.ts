import { describe, it, expect } from "vitest"
import {
  AQUILLA_MIGRATION_NS,
  projectIdFor,
  fileIdFor,
  fileCreateEventId,
  sourceCellCreateEventId,
  sourceArtifactBindingIdFor,
  sourceArtifactIdFor,
  targetCommitEventId,
  audioAttachEventId,
  audioSelectEventId,
} from "./ids"

// WHY these tests matter: deterministic ids ARE the idempotency guarantee. If
// any of these stopped being a pure function of their inputs (e.g. someone
// reached for uuidv7/Date.now), a re-run would duplicate events and the
// migration would no longer converge. These tests fail loudly if that happens.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe("migrate deterministic ids", () => {
  it("the namespace constant is pinned (changing it re-keys every import)", () => {
    expect(AQUILLA_MIGRATION_NS).toBe("7f3c8a91-2b4d-4e6f-9a8c-1d3e5f2b4a6c")
  })

  it("is stable across calls — the backbone of idempotent re-runs", () => {
    expect(projectIdFor("blgw0", "local")).toBe(projectIdFor("blgw0", "local"))
    expect(fileIdFor("blgw0", "files/target/X.codex")).toBe(
      fileIdFor("blgw0", "files/target/X.codex"),
    )
    expect(sourceCellCreateEventId("p", "f", "GEN 1:1")).toBe(
      sourceCellCreateEventId("p", "f", "GEN 1:1"),
    )
    expect(targetCommitEventId("p", "f", "c", 3)).toBe(targetCommitEventId("p", "f", "c", 3))
  })

  it("separates gitlab vs local project keys", () => {
    expect(projectIdFor("123", "local")).not.toBe(projectIdFor("123", "gitlab"))
  })

  it("distinguishes different files, cells, and edit indices", () => {
    expect(fileIdFor("k", "a")).not.toBe(fileIdFor("k", "b"))
    expect(sourceCellCreateEventId("p", "f", "c1")).not.toBe(
      sourceCellCreateEventId("p", "f", "c2"),
    )
    expect(targetCommitEventId("p", "f", "c", 0)).not.toBe(targetCommitEventId("p", "f", "c", 1))
  })

  it("source-create and file-create ids never collide for the same inputs", () => {
    expect(fileCreateEventId("p", "f")).not.toBe(sourceCellCreateEventId("p", "f", "f"))
  })

  it("emits valid v5 UUIDs", () => {
    expect(projectIdFor("k", "local")).toMatch(UUID_RE)
    expect(targetCommitEventId("p", "f", "c", 0)).toMatch(UUID_RE)
  })

  it("pins source artifact ids to the cross-runtime migration contract", () => {
    const sha = "ab12cd34" + "0".repeat(56)
    expect(sourceArtifactIdFor("p1", "f1", sha))
      .toBe("d8b2d842-2c4f-57d6-b61f-d057edff9ce4")
    expect(sourceArtifactBindingIdFor("p1", "f1", sha))
      .toBe("e96365df-b317-5e79-a675-174ea420fefd")
  })

  it("audio-select ids are stable, valid, and never collide with audio-attach for the same take", () => {
    // The all-takes import emits one attach per take plus one select to pin the
    // active take. The select id must be deterministic (idempotent re-runs) and
    // must NOT collide with that take's attach id (both reference the same
    // project/file/cell/audioId but are distinct events).
    expect(audioSelectEventId("p", "f", "c", "a1.webm")).toBe(
      audioSelectEventId("p", "f", "c", "a1.webm"),
    )
    expect(audioSelectEventId("p", "f", "c", "a1.webm")).toMatch(UUID_RE)
    expect(audioSelectEventId("p", "f", "c", "a1.webm")).not.toBe(
      audioAttachEventId("p", "f", "c", "a1.webm"),
    )
    expect(audioSelectEventId("p", "f", "c", "a1.webm")).not.toBe(
      audioSelectEventId("p", "f", "c", "a2.webm"),
    )
  })
})
