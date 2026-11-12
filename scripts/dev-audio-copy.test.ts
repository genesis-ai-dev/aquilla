// AQU-2114 — the dev audio copy's decisions: which objects dev needs, which it
// is missing, that it never overwrites, and the two guards that keep the job off
// production. The job moves user media between buckets, so every one of those is
// locked here rather than left to a live run to discover.
//
// The uploaded-originals half: a file imported on prod exports on dev only if
// the object its `file_source_blobs.r2_key` names was copied. The cases that
// matter are a referenced original (copied), an unreferenced one (left to the
// cleanup), the legacy `.../source/original.ext` shape (copied when a row names
// it, invisible otherwise) and a row naming another project's key (not ours).
import { describe, it, expect } from "vitest"
import type { AquillaDb, AquillaStatement } from "../db/shim/postgres"
import {
  copyProjectAudio,
  copyRefusal,
  expectedMediaKeys,
  formatCopyReport,
  isOwnOriginal,
  loadOriginalRefs,
  missingInDev,
  selectReferencedObjects,
  DEV_MEDIA_BUCKET,
  PROD_MEDIA_BUCKET,
  type DevAudioCopyDeps,
  type ListedObject,
  type ProjectMediaRefs,
} from "./dev-audio-copy"

const PROJECT = "p1"

/** The Portuguese EBL IDML that 404ed on dev on 2026-11-06 — the original
 *  this slice exists to carry. Its key, project and artifact ids verbatim. */
const EBL_PROJECT = "97559250-e286-4d29-ba40-13c296f12ef9"
const EBL_IDML_KEY = `artifacts/${EBL_PROJECT}/01a1afda-32d0-7711-b14e-230a0e56590c/original.idml`

/** A project with: a live take, the piece a cut left behind, a voice clip. */
function refs(overrides: Partial<ProjectMediaRefs> = {}): ProjectMediaRefs {
  return {
    audio: new Set(["f1/take-a.webm", "f1/take-b.webm"]),
    voice: new Set(["clip-1.webm"]),
    original: new Set(),
    ...overrides,
  }
}

function obj(key: string, size = 10): ListedObject {
  return { key, size }
}

describe("copyRefusal", () => {
  it("passes a dev-target copy from prod into the dev bucket", () => {
    expect(
      copyRefusal({ target: "dev", source: PROD_MEDIA_BUCKET, destination: DEV_MEDIA_BUCKET }),
    ).toBeNull()
    expect(
      copyRefusal({ target: "development", source: PROD_MEDIA_BUCKET, destination: DEV_MEDIA_BUCKET }),
    ).toBeNull()
  })

  it.each([
    ["any destination but the dev bucket", { target: "dev", source: PROD_MEDIA_BUCKET, destination: PROD_MEDIA_BUCKET }, /destination must be aquilla-snapshots-dev/],
    ["a destination that is neither bucket", { target: "dev", source: PROD_MEDIA_BUCKET, destination: "aquilla-snapshots-staging" }, /destination must be aquilla-snapshots-dev/],
    ["a source that is not prod", { target: "dev", source: DEV_MEDIA_BUCKET, destination: DEV_MEDIA_BUCKET }, /source must be aquilla-snapshots/],
    ["no recorded target", { target: undefined, source: PROD_MEDIA_BUCKET, destination: DEV_MEDIA_BUCKET }, /AQUILLA_NEON_TARGET is unset/],
    ["an empty target", { target: "  ", source: PROD_MEDIA_BUCKET, destination: DEV_MEDIA_BUCKET }, /AQUILLA_NEON_TARGET is unset/],
    ["the production branch", { target: "production", source: PROD_MEDIA_BUCKET, destination: DEV_MEDIA_BUCKET }, /refusing to read production/],
    ["production under an alias", { target: "PROD", source: PROD_MEDIA_BUCKET, destination: DEV_MEDIA_BUCKET }, /refusing to read prod/],
    ["the retired main alias", { target: "main", source: PROD_MEDIA_BUCKET, destination: DEV_MEDIA_BUCKET }, /refusing to read main/],
    ["a branch that is not dev", { target: "local", source: PROD_MEDIA_BUCKET, destination: DEV_MEDIA_BUCKET }, /must be the dev branch/],
  ])("refuses %s", (_label, input, expected) => {
    expect(copyRefusal(input)).toMatch(expected)
  })
})

describe("expectedMediaKeys", () => {
  it("names the take and clip keys a project's rows claim, not their sidecars", () => {
    expect(expectedMediaKeys(PROJECT, refs())).toEqual([
      "projects/p1/files/f1/audio/take-a.webm",
      "projects/p1/files/f1/audio/take-b.webm",
      "projects/p1/voices/clip-1.webm",
    ])
  })

  it("expects a referenced original under either of the project's prefixes, and not one under another's", () => {
    const keys = expectedMediaKeys(
      PROJECT,
      refs({
        original: new Set([
          "artifacts/p1/art-1/original.idml",
          "projects/p1/files/f2/source/original.usfm",
          "artifacts/p2/art-9/original.docx",
        ]),
      }),
    )
    expect(keys).toContain("artifacts/p1/art-1/original.idml")
    expect(keys).toContain("projects/p1/files/f2/source/original.usfm")
    expect(keys).not.toContain("artifacts/p2/art-9/original.docx")
  })
})

describe("isOwnOriginal", () => {
  it.each([
    ["artifacts/p1/art-1/original.idml", true],
    ["artifacts/p1/art-1", true],
    ["projects/p1/files/f1/source/original.usfm", true],
    ["artifacts/p2/art-1/original.idml", false],
    ["projects/p10/files/f1/source/original.usfm", false],
    ["artifacts/p1x/art-1/original.idml", false],
  ])("%s → %s", (key, own) => {
    expect(isOwnOriginal(PROJECT, key)).toBe(own)
  })
})

describe("selectReferencedObjects", () => {
  it("keeps takes, a cut take's remaining piece, peaks sidecars, clips and clone caches", () => {
    const objects = [
      obj("projects/p1/files/f1/audio/take-a.webm"),
      obj("projects/p1/files/f1/audio/take-a.webm.peaks"),
      obj("projects/p1/files/f1/audio/take-b.webm"),
      obj("projects/p1/voices/clip-1.webm"),
      obj("projects/p1/voices/clip-1.webm.inworld.json"),
    ]
    const selected = selectReferencedObjects(PROJECT, objects, refs())
    expect(selected.referenced.map((o) => o.key)).toEqual(objects.map((o) => o.key))
    expect(selected.skippedUnrecognized).toBe(0)
    expect(selected.skippedUnreferenced).toBe(0)
  })

  it("leaves prod's orphans behind — dev's own cleanup would only delete them", () => {
    const selected = selectReferencedObjects(
      PROJECT,
      [obj("projects/p1/files/f1/audio/regenerated-away.webm"), obj("projects/p1/voices/deleted-clip.webm")],
      refs(),
    )
    expect(selected.referenced).toEqual([])
    expect(selected.skippedUnreferenced).toBe(2)
  })

  it("skips everything that is neither swept media nor a referenced original", () => {
    const selected = selectReferencedObjects(
      PROJECT,
      [
        obj("projects/p1/files/f1/tail/0001"),
        obj("projects/p1/files/f1/checkpoints/0001"),
        obj("projects/p1/files/f1/attachments/shot.png"),
        // A legacy original no row names: not swept media, so not an orphan
        // either — just not this copy's business.
        obj("projects/p1/files/f1/source/original.usfm"),
      ],
      refs(),
    )
    expect(selected.referenced).toEqual([])
    expect(selected.skippedUnrecognized).toBe(4)
    expect(selected.skippedUnreferenced).toBe(0)
  })

  it("copies an uploaded original a blob or artifact row names, and tags it as one", () => {
    const selected = selectReferencedObjects(
      EBL_PROJECT,
      [obj(EBL_IDML_KEY, 304_028)],
      refs({ original: new Set([EBL_IDML_KEY]) }),
    )
    expect(selected.referenced).toEqual([{ key: EBL_IDML_KEY, size: 304_028, kind: "original" }])
    expect(selected.skippedUnreferenced).toBe(0)
    expect(selected.skippedUnrecognized).toBe(0)
  })

  it("leaves an original under artifacts/ that no row names — the cleanup's abandoned upload", () => {
    const selected = selectReferencedObjects(
      PROJECT,
      [obj("artifacts/p1/art-gone/original.idml"), obj("artifacts/p1/art-agent")],
      refs({ original: new Set(["artifacts/p1/art-live/original.idml"]) }),
    )
    expect(selected.referenced).toEqual([])
    expect(selected.skippedUnreferenced).toBe(2)
    expect(selected.skippedUnrecognized).toBe(0)
  })

  it("copies a legacy projects/…/source/original.ext key when a row names it", () => {
    const legacy = "projects/p1/files/f1/source/original.usfm"
    const selected = selectReferencedObjects(
      PROJECT,
      [obj(legacy), obj("projects/p1/files/f2/source/original.usfm")],
      refs({ original: new Set([legacy]) }),
    )
    expect(selected.referenced.map((o) => [o.key, o.kind])).toEqual([[legacy, "original"]])
    expect(selected.skippedUnrecognized).toBe(1)
  })

  it("tags takes and clips as media, so the report can tell them from originals", () => {
    const selected = selectReferencedObjects(
      PROJECT,
      [obj("projects/p1/files/f1/audio/take-a.webm"), obj("projects/p1/voices/clip-1.webm")],
      refs(),
    )
    expect(selected.referenced.map((o) => o.kind)).toEqual(["media", "media"])
  })

  it("never claims another project's original, even when a row of ours names it", () => {
    const foreign = "artifacts/p2/art-1/original.idml"
    const selected = selectReferencedObjects(PROJECT, [obj(foreign)], refs({ original: new Set([foreign]) }))
    expect(selected.referenced).toEqual([])
    expect(selected.skippedUnrecognized).toBe(1)
  })

  it("accepts a key whose id differs from the row only in case", () => {
    const selected = selectReferencedObjects(
      PROJECT,
      [obj("projects/p1/files/F1-UPPER/audio/Take-C.webm")],
      refs({ audio: new Set(["f1-upper/take-c.webm"]) }),
    )
    expect(selected.referenced).toHaveLength(1)
  })

  it("never claims another project's object", () => {
    const selected = selectReferencedObjects(
      PROJECT,
      [obj("projects/p2/files/f1/audio/take-a.webm")],
      refs(),
    )
    expect(selected.referenced).toEqual([])
    expect(selected.skippedUnrecognized).toBe(1)
  })
})

describe("missingInDev", () => {
  it("is the referenced set minus what dev already holds", () => {
    const referenced = [obj("a"), obj("b"), obj("c")]
    expect(missingInDev(referenced, new Set(["b"])).map((o) => o.key)).toEqual(["a", "c"])
  })
})

interface Harness {
  deps: DevAudioCopyDeps
  copies: Array<{ sourceBucket: string; key: string; destBucket: string; destKey: string }>
}

function harness(
  prod: ListedObject[],
  dev: ListedObject[],
  options: { refs?: ProjectMediaRefs; failOn?: string } = {},
): Harness {
  const copies: Harness["copies"] = []
  return {
    copies,
    deps: {
      // Prefix-scoped, as R2's listing is: the copy lists two prefixes per
      // bucket and must not see an object twice.
      listObjects: async (bucket, prefix) =>
        (bucket === PROD_MEDIA_BUCKET ? prod : dev).filter((o) => o.key.startsWith(prefix)),
      copyObject: async (sourceBucket, sourceKey, destBucket, destKey) => {
        if (options.failOn === sourceKey) throw new Error("CopyObject 500: boom")
        copies.push({ sourceBucket, key: sourceKey, destBucket, destKey })
      },
      loadRefs: async () => options.refs ?? refs(),
    },
  }
}

describe("copyProjectAudio", () => {
  const take = "projects/p1/files/f1/audio/take-a.webm"
  const peaks = `${take}.peaks`
  const other = "projects/p1/files/f1/audio/take-b.webm"
  const clip = "projects/p1/voices/clip-1.webm"

  it("copies the missing keys under the same key and reports the run", async () => {
    const { deps, copies } = harness(
      [obj(take, 100), obj(peaks, 5), obj(other, 200), obj(clip, 50)],
      [],
    )
    const report = await copyProjectAudio(deps, { projectId: PROJECT, target: "dev" })
    expect(report.referenced).toBe(4)
    expect(report.referencedBytes).toBe(355)
    expect(report.copied).toBe(4)
    expect(report.copiedBytes).toBe(355)
    expect(report.failed).toEqual([])
    expect(copies.map((c) => c.key)).toEqual([take, peaks, other, clip])
    for (const copy of copies) {
      expect(copy.sourceBucket).toBe(PROD_MEDIA_BUCKET)
      expect(copy.destBucket).toBe(DEV_MEDIA_BUCKET)
      expect(copy.destKey).toBe(copy.key)
    }
  })

  it("never overwrites an object dev already holds, and re-runs copy nothing", async () => {
    const { deps, copies } = harness([obj(take), obj(other), obj(clip)], [obj(take), obj(other), obj(clip)])
    const report = await copyProjectAudio(deps, { projectId: PROJECT, target: "dev" })
    expect(report.alreadyInDev).toBe(3)
    expect(report.copied).toBe(0)
    expect(copies).toEqual([])
  })

  it("leaves a dev-only take alone — it is simply not in the copy set", async () => {
    const devOnly = "projects/p1/files/f1/audio/recorded-on-dev.webm"
    const { deps, copies } = harness([obj(take)], [obj(devOnly)])
    const report = await copyProjectAudio(deps, { projectId: PROJECT, target: "dev" })
    expect(copies.map((c) => c.key)).toEqual([take])
    expect(report.copied).toBe(1)
  })

  it("reports a row whose object is missing in prod too, and still finishes", async () => {
    const { deps } = harness([obj(take), obj(clip)], [])
    const report = await copyProjectAudio(deps, { projectId: PROJECT, target: "dev" })
    expect(report.missingInProd).toEqual([other])
    expect(report.copied).toBe(2)
    expect(report.failed).toEqual([])
  })

  it("records a failed copy and carries on with the rest", async () => {
    const { deps, copies } = harness([obj(take), obj(other), obj(clip)], [], { failOn: other })
    const report = await copyProjectAudio(deps, { projectId: PROJECT, target: "dev" })
    expect(report.failed).toEqual([{ key: other, error: "CopyObject 500: boom" }])
    expect(report.copied).toBe(2)
    expect(copies.map((c) => c.key)).toEqual([take, clip])
  })

  it("writes nothing on a dry run but reports what it would copy", async () => {
    const { deps, copies } = harness([obj(take, 100), obj(other, 200)], [obj(other, 200)])
    const report = await copyProjectAudio(deps, { projectId: PROJECT, target: "dev", dryRun: true })
    expect(report.dryRun).toBe(true)
    expect(report.referenced).toBe(2)
    expect(report.alreadyInDev).toBe(1)
    expect(report.copied).toBe(0)
    expect(report.samples).toEqual([take])
    expect(copies).toEqual([])
  })

  it("copies the originals the rows name alongside the takes, and counts them apart", async () => {
    const legacy = "projects/p1/files/f2/source/original.usfm"
    const artifact = "artifacts/p1/art-1/original.idml"
    const present = "artifacts/p1/art-2/original.docx"
    const abandoned = "artifacts/p1/art-gone/original.idml"
    const { deps, copies } = harness(
      [obj(take, 100), obj(legacy, 10), obj(artifact, 20), obj(present, 30), obj(abandoned, 40)],
      [obj(present, 30)],
      { refs: refs({ original: new Set([legacy, artifact, present]) }) },
    )
    const report = await copyProjectAudio(deps, { projectId: PROJECT, target: "dev" })
    expect(copies.map((c) => c.key)).toEqual([take, legacy, artifact])
    expect(report.referenced).toBe(4)
    expect(report.copied).toBe(3)
    expect(report.copiedBytes).toBe(130)
    expect(report.originals).toEqual({ referenced: 3, alreadyInDev: 1, copied: 2, outsidePrefix: 0 })
    expect(report.skippedUnreferenced).toBe(1)
    // The take and clip rows still expect their bytes, and prod has neither
    // `other` nor the clip; the originals that exist are not missing.
    expect(report.missingInProd).toEqual([other, clip])
  })

  it("would select the Portuguese EBL IDML that 404ed on dev", async () => {
    const { deps, copies } = harness([obj(EBL_IDML_KEY, 304_028)], [], {
      refs: refs({ audio: new Set(), voice: new Set(), original: new Set([EBL_IDML_KEY]) }),
    })
    const report = await copyProjectAudio(deps, { projectId: EBL_PROJECT, target: "dev", dryRun: true })
    expect(report.samples).toEqual([EBL_IDML_KEY])
    expect(report.originals).toEqual({ referenced: 1, alreadyInDev: 0, copied: 0, outsidePrefix: 0 })
    expect(report.missingInProd).toEqual([])
    expect(copies).toEqual([])
  })

  it("reports an original a row names under another project's prefix, without copying or missing it", async () => {
    const foreign = "artifacts/p2/art-1/original.idml"
    const { deps, copies } = harness([obj(take)], [], {
      refs: refs({ original: new Set([foreign]) }),
    })
    const report = await copyProjectAudio(deps, { projectId: PROJECT, target: "dev" })
    expect(copies.map((c) => c.key)).toEqual([take])
    expect(report.originals).toEqual({ referenced: 0, alreadyInDev: 0, copied: 0, outsidePrefix: 1 })
    expect(report.missingInProd).not.toContain(foreign)
  })

  it("counts an original whose copy failed as not copied", async () => {
    const artifact = "artifacts/p1/art-1/original.idml"
    const { deps } = harness([obj(take), obj(artifact)], [], {
      refs: refs({ original: new Set([artifact]) }),
      failOn: artifact,
    })
    const report = await copyProjectAudio(deps, { projectId: PROJECT, target: "dev" })
    expect(report.originals.copied).toBe(0)
    expect(report.failed.map((f) => f.key)).toEqual([artifact])
  })

  it.each([
    ["the destination is not the dev bucket", { target: "dev", destination: PROD_MEDIA_BUCKET }, /destination must be/],
    ["the database is production", { target: "production" }, /refusing to read production/],
  ])("refuses before the first read when %s", async (_label, overrides, expected) => {
    const { deps, copies } = harness([obj(take)], [])
    let listed = false
    const watched: DevAudioCopyDeps = {
      ...deps,
      listObjects: async (...args) => {
        listed = true
        return deps.listObjects(...args)
      },
    }
    await expect(
      copyProjectAudio(watched, { projectId: PROJECT, ...overrides }),
    ).rejects.toThrow(expected)
    expect(listed).toBe(false)
    expect(copies).toEqual([])
  })

  it("requires a project id", async () => {
    const { deps } = harness([], [])
    await expect(copyProjectAudio(deps, { projectId: "  ", target: "dev" })).rejects.toThrow(
      /project id is required/,
    )
  })

  it("scopes every read and write to the one project's two prefixes", async () => {
    const listed: string[] = []
    const { deps } = harness([obj(take)], [])
    const watched: DevAudioCopyDeps = {
      ...deps,
      listObjects: async (bucket, prefix) => {
        listed.push(`${bucket} ${prefix}`)
        return deps.listObjects(bucket, prefix)
      },
    }
    await copyProjectAudio(watched, { projectId: PROJECT, target: "dev" })
    expect(listed.sort()).toEqual(
      [
        `${PROD_MEDIA_BUCKET} projects/p1/`,
        `${PROD_MEDIA_BUCKET} artifacts/p1/`,
        `${DEV_MEDIA_BUCKET} projects/p1/`,
        `${DEV_MEDIA_BUCKET} artifacts/p1/`,
      ].sort(),
    )
  })
})

/** A db double that records the query this module issues and replays rows. */
function fakeDb(rows: Record<string, unknown>[]): { db: AquillaDb; queries: string[]; binds: unknown[][] } {
  const queries: string[] = []
  const binds: unknown[][] = []
  const statement = (query: string): AquillaStatement => ({
    bind: (...args: unknown[]) => {
      binds.push(args)
      return statement(query)
    },
    all: async () => ({ results: rows }) as never,
    run: async () => ({ results: [] }) as never,
    first: async () => null,
    raw: async () => [],
  })
  return {
    queries,
    binds,
    db: {
      prepare: (query: string) => {
        queries.push(query)
        return statement(query)
      },
      batch: async () => [],
      exec: async () => ({ count: 0, duration: 0 }),
      close: async () => {},
    },
  }
}

describe("loadOriginalRefs", () => {
  it("reads both tables an export can resolve an original through, for the one project", async () => {
    const { db, queries, binds } = fakeDb([])
    await loadOriginalRefs(db, PROJECT)
    expect(queries).toHaveLength(1)
    expect(queries[0]).toMatch(/FROM file_source_blobs WHERE project_id = \? AND r2_key IS NOT NULL/)
    expect(queries[0]).toMatch(/FROM artifacts WHERE project_id = \? AND r2_key IS NOT NULL/)
    expect(binds).toEqual([[PROJECT, PROJECT]])
  })

  it("keeps original keys of either shape and leaves takes to the audio rules", async () => {
    const { db } = fakeDb([
      { r2_key: EBL_IDML_KEY },
      { r2_key: "projects/p1/files/f1/source/original.usfm" },
      { r2_key: "artifacts/p1/art-agent" },
      // A browser media import registers its recording as its own original:
      // the cell_audio row, not this one, says whether it is live.
      { r2_key: "projects/p1/files/f1/audio/take-a.webm" },
      { r2_key: "projects/p1/voices/clip-1.webm" },
      { r2_key: null },
      { r2_key: "  " },
    ])
    expect([...(await loadOriginalRefs(db, PROJECT))].sort()).toEqual([
      EBL_IDML_KEY,
      "artifacts/p1/art-agent",
      "projects/p1/files/f1/source/original.usfm",
    ])
  })
})

describe("formatCopyReport", () => {
  it("reports a dry run as what it would copy, not as copied", async () => {
    const { deps } = harness([obj("projects/p1/files/f1/audio/take-a.webm", 1_000_000)], [])
    const report = await copyProjectAudio(deps, { projectId: PROJECT, target: "dev", dryRun: true })
    const text = formatCopyReport(report)
    expect(text).toContain("would copy: 1")
    expect(text).not.toMatch(/^ {2}copied:/m)
    expect(text).toContain("1.0 MB")
    expect(text).toContain("source originals: 0 referenced, 0 already in dev, would copy 0")
  })

  it("says how many originals were copied, were already there, and belong to another project", async () => {
    const artifact = "artifacts/p1/art-1/original.idml"
    const present = "artifacts/p1/art-2/original.docx"
    const { deps } = harness([obj(artifact), obj(present)], [obj(present)], {
      refs: refs({ original: new Set([artifact, present, "artifacts/p2/art-9/original.idml"]) }),
    })
    const report = await copyProjectAudio(deps, { projectId: PROJECT, target: "dev" })
    expect(formatCopyReport(report)).toContain(
      "source originals: 2 referenced, 1 already in dev, copied 1, 1 under another project's prefix",
    )
  })
})
