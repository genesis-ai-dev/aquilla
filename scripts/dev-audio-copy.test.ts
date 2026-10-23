// AQU-2114 — the dev audio copy's decisions: which objects dev needs, which it
// is missing, that it never overwrites, and the two guards that keep the job off
// production. The job moves user media between buckets, so every one of those is
// locked here rather than left to a live run to discover.
import { describe, it, expect } from "vitest"
import {
  copyProjectAudio,
  copyRefusal,
  expectedMediaKeys,
  formatCopyReport,
  missingInDev,
  selectReferencedObjects,
  DEV_MEDIA_BUCKET,
  PROD_MEDIA_BUCKET,
  type DevAudioCopyDeps,
  type ListedObject,
  type ProjectMediaRefs,
} from "./dev-audio-copy"

const PROJECT = "p1"

/** A project with: a live take, the piece a cut left behind, a voice clip. */
function refs(overrides: Partial<ProjectMediaRefs> = {}): ProjectMediaRefs {
  return {
    audio: new Set(["f1/take-a.webm", "f1/take-b.webm"]),
    voice: new Set(["clip-1.webm"]),
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

  it("skips everything that is not swept media", () => {
    const selected = selectReferencedObjects(
      PROJECT,
      [
        obj("projects/p1/files/f1/tail/0001"),
        obj("projects/p1/files/f1/checkpoints/0001"),
        obj("projects/p1/files/f1/attachments/shot.png"),
        obj("projects/p1/files/f1/source/original.usfm"),
        obj("artifacts/p1/art-1"),
      ],
      refs(),
    )
    expect(selected.referenced).toEqual([])
    expect(selected.skippedUnrecognized).toBe(5)
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
      listObjects: async (bucket) => (bucket === PROD_MEDIA_BUCKET ? prod : dev),
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

  it("scopes every read and write to the one project's prefix", async () => {
    const prefixes: string[] = []
    const { deps } = harness([obj(take)], [])
    const watched: DevAudioCopyDeps = {
      ...deps,
      listObjects: async (bucket, prefix) => {
        prefixes.push(prefix)
        return deps.listObjects(bucket, prefix)
      },
    }
    await copyProjectAudio(watched, { projectId: PROJECT, target: "dev" })
    expect(prefixes).toEqual(["projects/p1/", "projects/p1/"])
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
  })
})
