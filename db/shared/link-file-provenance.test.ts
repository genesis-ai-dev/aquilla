// AQU-2345: the two rules a linked file's provenance follows — see the module
// header. The plan is pure, so the rules are pinned here as a table; the writes
// they drive are pinned where they run (sync-worker link-sync and
// link-provenance tests, auth-worker source-linking-file-identity).

import { describe, expect, it } from "vitest"
import {
  planLinkedFileProvenance,
  type LinkedFileProvenanceInputs,
  type ProvenanceBlobRow,
  type ProvenanceFileRow,
} from "./link-file-provenance"

const pair = { upstreamFileId: "up", downstreamFileId: "down" }

function file(id: string, cols: Partial<Omit<ProvenanceFileRow, "id">> = {}): ProvenanceFileRow {
  return { id, role: null, kind: null, book_code: null, ...cols }
}

function blob(fileId: string, cols: Partial<Omit<ProvenanceBlobRow, "file_id">> = {}): ProvenanceBlobRow {
  return { file_id: fileId, format: "idml", r2_key: "artifacts/up-proj/art-1/original.idml", size_bytes: 1234, ...cols }
}

function inputs(args: {
  upstream?: ProvenanceFileRow
  downstream?: ProvenanceFileRow
  upstreamBlob?: ProvenanceBlobRow
  downstreamBlob?: ProvenanceBlobRow
}): LinkedFileProvenanceInputs {
  const map = <T extends { id?: string; file_id?: string }>(row: T | undefined, key: (r: T) => string) =>
    new Map(row ? [[key(row), row]] : [])
  return {
    pairs: [pair],
    upstreamFiles: map(args.upstream, (r) => r.id),
    downstreamFiles: map(args.downstream, (r) => r.id),
    upstreamBlobs: map(args.upstreamBlob, (r) => r.file_id),
    downstreamBlobs: map(args.downstreamBlob, (r) => r.file_id),
  }
}

describe("planLinkedFileProvenance (AQU-2345)", () => {
  it("decides each pair's type fill and pointer write from the rows alone", () => {
    const cases: Array<{
      name: string
      given: Parameters<typeof inputs>[0]
      typeRepairs: number
      blobPointers: number
      noUpstreamBlob: number
    }> = [
      {
        name: "a copy with no type and no original takes both",
        given: { upstream: file("up", { kind: "idml", book_code: "GEN" }), downstream: file("down"), upstreamBlob: blob("up") },
        typeRepairs: 1,
        blobPointers: 1,
        noUpstreamBlob: 0,
      },
      {
        name: "a copy that matches the upstream needs nothing",
        given: {
          upstream: file("up", { kind: "idml" }),
          downstream: file("down", { kind: "idml" }),
          upstreamBlob: blob("up"),
          downstreamBlob: blob("down"),
        },
        typeRepairs: 0,
        blobPointers: 0,
        noUpstreamBlob: 0,
      },
      {
        name: "a type the copy already has is never overwritten",
        given: { upstream: file("up", { kind: "idml" }), downstream: file("down", { kind: "usfm" }), upstreamBlob: blob("up"), downstreamBlob: blob("down") },
        typeRepairs: 0,
        blobPointers: 0,
        noUpstreamBlob: 0,
      },
      {
        name: "a pointer follows the upstream's new object",
        given: {
          upstream: file("up", { kind: "idml" }),
          downstream: file("down", { kind: "idml" }),
          upstreamBlob: blob("up", { r2_key: "artifacts/up-proj/art-2/original.idml", size_bytes: "5678" }),
          downstreamBlob: blob("down"),
        },
        typeRepairs: 0,
        blobPointers: 1,
        noUpstreamBlob: 0,
      },
      {
        name: "a legacy inline original compares by format and size, not by the missing key",
        given: {
          upstream: file("up"),
          downstream: file("down"),
          upstreamBlob: blob("up", { format: "usfm", r2_key: null, size_bytes: 99 }),
          downstreamBlob: blob("down", { format: "usfm", r2_key: null, size_bytes: "99" }),
        },
        typeRepairs: 0,
        blobPointers: 0,
        noUpstreamBlob: 0,
      },
      {
        name: "an upstream file with no original leaves nothing to point at",
        given: { upstream: file("up", { kind: "codex" }), downstream: file("down") },
        typeRepairs: 1,
        blobPointers: 0,
        noUpstreamBlob: 1,
      },
      {
        name: "a copy whose row is not there yet takes its type from the event that creates it",
        given: { upstream: file("up", { kind: "idml" }), upstreamBlob: blob("up") },
        typeRepairs: 0,
        blobPointers: 1,
        noUpstreamBlob: 0,
      },
    ]
    for (const c of cases) {
      const plan = planLinkedFileProvenance(inputs(c.given))
      expect({ name: c.name, typeRepairs: plan.typeRepairs.length, blobPointers: plan.blobPointers.length, noUpstreamBlob: plan.noUpstreamBlob.length })
        .toEqual({ name: c.name, typeRepairs: c.typeRepairs, blobPointers: c.blobPointers, noUpstreamBlob: c.noUpstreamBlob })
    }
  })

  it("carries the upstream's values on a type fill, for COALESCE to place where the copy's are NULL", () => {
    const plan = planLinkedFileProvenance(
      inputs({ upstream: file("up", { role: null, kind: "idml", book_code: "GEN" }), downstream: file("down", { book_code: "EXO" }) }),
    )
    expect(plan.typeRepairs).toEqual([{ ...pair, role: null, kind: "idml", bookCode: "GEN" }])
  })
})
