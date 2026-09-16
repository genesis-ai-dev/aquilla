// runOrgEgress is the "export always completes with what succeeded" gate:
// one archived project, one deleted file, or one flaky build must degrade to
// a manifest entry — never a lost zip. It also owns the cache economics: an
// unchanged project must replay from IndexedDB without rebuilding.

import { beforeEach, describe, expect, it, vi } from "vitest"
import JSZip from "jszip"
import type { FileSummary } from "@/lib/sync/cells-read-types"
import type { FileAudioAttachmentsResponse } from "@/lib/sync/cell-audio-read-types"
import { SyncTokenError, type fetchSyncToken } from "@/lib/sync/sync-token"
import type { fetchProjectSettings } from "@/lib/sync/project-settings"
import { purgeEgressExportCache, readEgressCache } from "./export-cache"
import type { buildProjectExport } from "./build-project-export"
import { runOrgEgress, type RunOrgEgressDeps } from "./org-egress"
import type {
  EgressManifest,
  EgressOptions,
  EgressProgressUpdate,
  EgressProjectSelection,
  RunOrgEgressArgs,
} from "./types"

const fileSummary = (fileId: string, over: Partial<FileSummary> = {}): FileSummary => ({
  fileId,
  projectId: "p1",
  name: `${fileId}.SFM`,
  fileType: "usfm",
  sourceLanguage: "en",
  targetLanguage: "fr",
  cellCount: 10,
  approvedCount: 0,
  filledCount: 5,
  wordCount: 100,
  lastEditAt: 1111,
  ...over,
})

const sel = (
  projectId: string,
  projectName: string,
  fileIds: string[],
): EgressProjectSelection => ({
  projectId,
  projectName,
  sourceLanguage: "en",
  targetLanguage: "fr",
  files: fileIds.map((id) => ({ id, name: `${id}.SFM`, type: "usfm" })),
})

const options: EgressOptions = {
  textMode: "convert",
  convertFormat: "txt",
  lanes: [""],
  includeSourceDocs: false,
  audioMode: "none",
  useCache: true,
}

const tokenOk: typeof fetchSyncToken = async () => ({
  token: "sync-tok",
  expiresIn: 900,
  role: { level: 600, name: "maintainer", source: "org" },
})

/** Fake per-project builder: one text entry per selected file. */
const makeBuildExport = (hadTransientFailures = false) =>
  vi.fn<typeof buildProjectExport>(async (selection, _opts, deps) => ({
    entries: selection.files.map((f) => ({ path: `fr/${f.id}.txt`, data: `text-${f.id}` })),
    report: {
      projectId: selection.projectId,
      projectName: selection.projectName,
      freshnessKey: deps.freshnessKey,
      fromCache: false,
      files: selection.files.map((f) => ({
        fileId: f.id,
        fileName: f.name,
        entries: [`fr/${f.id}.txt`],
        skipped: [],
      })),
      errors: [],
    },
    hadTransientFailures,
  }))

const settingsNone: typeof fetchProjectSettings = async () => null

const makeDeps = (over: Partial<RunOrgEgressDeps> = {}): RunOrgEgressDeps => ({
  fetchToken: tokenOk,
  fetchFiles: async (projectId) => [fileSummary("f1", { projectId })],
  fetchSettings: settingsNone,
  fetchAudioAttachments: async () => ({ cells: {} }),
  buildExport: makeBuildExport(),
  now: () => new Date(2026, 7, 13),
  ...over,
})

const args = (over: Partial<RunOrgEgressArgs> = {}): RunOrgEgressArgs => ({
  org: { id: 7, name: "Acme Org" },
  selections: [sel("p1", "Project One", ["f1"])],
  options,
  jwt: "jwt",
  ...over,
})

const loadZip = async (blob: Blob) => JSZip.loadAsync(await blob.arrayBuffer())

beforeEach(async () => {
  await purgeEgressExportCache()
})

describe("runOrgEgress", () => {
  it("produces one org zip: manifest.json at root + project-slug-prefixed entries, dated filename", async () => {
    const progress: EgressProgressUpdate[] = []
    const result = await runOrgEgress(
      args({ onProgress: (p) => progress.push(p) }),
      makeDeps(),
    )

    const zip = await loadZip(result.blob)
    expect(zip.files["manifest.json"]).toBeTruthy()
    expect(zip.files["Project-One/fr/f1.txt"]).toBeTruthy()
    expect(await zip.files["Project-One/fr/f1.txt"].async("string")).toBe("text-f1")

    const manifest = JSON.parse(await zip.files["manifest.json"].async("string")) as EgressManifest
    expect(manifest.org).toEqual({ id: 7, name: "Acme Org" })
    expect(manifest.options).toEqual(options)
    expect(manifest.projects[0].fromCache).toBe(false)
    // The manifest names the zip folder so reports stay mappable even when
    // two projects share a (deduped) name.
    expect(manifest.projects[0].folder).toBe("Project-One")
    expect(manifest.projects[0].files[0].entries).toEqual(["fr/f1.txt"])
    // The in-memory manifest and the zipped one are the same record.
    expect(result.manifest).toEqual(manifest)

    expect(result.filename).toBe("Acme-Org-egress-20260813.zip")
    expect(progress[0]?.phase).toBe("preparing")
    expect(progress[progress.length - 1]?.phase).toBe("done")
    // The per-project zipping tick is one whole unit — a 0/N update here
    // would walk the overall bar backwards a project width.
    const zipTick = progress.find((p) => p.phase === "zipping" && p.projectName === "Project One")
    expect(zipTick).toMatchObject({ done: 1, total: 1 })
  })

  it("replays an unchanged project from the cache without rebuilding", async () => {
    const buildExport = makeBuildExport()
    const deps = makeDeps({ buildExport })

    const first = await runOrgEgress(args(), deps)
    expect(first.manifest.projects[0].fromCache).toBe(false)

    const second = await runOrgEgress(args(), deps)
    // Same freshness + same options → the cached zip is unpacked verbatim.
    expect(buildExport).toHaveBeenCalledTimes(1)
    expect(second.manifest.projects[0].fromCache).toBe(true)
    // The replayed report still names THIS run's folder, not a stale one.
    expect(second.manifest.projects[0].folder).toBe("Project-One")
    const zip = await loadZip(second.blob)
    expect(await zip.files["Project-One/fr/f1.txt"].async("string")).toBe("text-f1")
  })

  it("rebuilds when the project changed (freshness) — a stale replay would ship old content", async () => {
    const buildExport = makeBuildExport()
    await runOrgEgress(args(), makeDeps({ buildExport }))
    const second = await runOrgEgress(
      args(),
      makeDeps({
        buildExport,
        fetchFiles: async (projectId) => [fileSummary("f1", { projectId, lastEditAt: 9999 })],
      }),
    )
    expect(buildExport).toHaveBeenCalledTimes(2)
    expect(second.manifest.projects[0].fromCache).toBe(false)
  })

  it("a denied project surfaces the SERVER'S 403 reason while the rest still exports", async () => {
    // A sync-token 403 can mean frozen, archived, or no access — labeling
    // them all "org policy" sends admins hunting for a policy that isn't the
    // problem. The server's {error} body is the truth; surface it.
    const result = await runOrgEgress(
      args({
        selections: [sel("p1", "Frozen", ["f1"]), sel("p2", "Open", ["f2"])],
      }),
      makeDeps({
        fetchToken: async (_jwt, projectId) => {
          if (projectId === "p1") {
            throw new SyncTokenError(403, JSON.stringify({ error: "project is frozen" }))
          }
          return tokenOk("jwt", projectId, "f")
        },
        fetchFiles: async (projectId) => [fileSummary("f2", { projectId })],
      }),
    )
    const [frozen, open] = result.manifest.projects
    expect(frozen.errors).toEqual(["project is frozen"])
    expect(frozen.files).toEqual([])
    expect(frozen.folder).toBeUndefined() // nothing was written under a folder
    expect(open.errors).toEqual([])
    const zip = await loadZip(result.blob)
    expect(zip.files["Open/fr/f2.txt"]).toBeTruthy()
    expect(Object.keys(zip.files).some((n) => n.startsWith("Frozen/"))).toBe(false)
  })

  it("a non-JSON sync-token failure body falls back to the error message", async () => {
    const result = await runOrgEgress(
      args(),
      makeDeps({
        fetchToken: async () => {
          throw new SyncTokenError(500, "<html>Bad gateway</html>")
        },
      }),
    )
    expect(result.manifest.projects[0].errors).toEqual([
      "sync-token fetch failed: HTTP 500 — <html>Bad gateway</html>",
    ])
  })

  it("reports selected files that no longer exist instead of dropping them silently", async () => {
    const buildExport = makeBuildExport()
    const result = await runOrgEgress(
      args({ selections: [sel("p1", "Project One", ["f1", "gone"])] }),
      makeDeps({ buildExport }),
    )
    // The builder only sees the files that still exist…
    expect(buildExport.mock.calls[0][0].files.map((f) => f.id)).toEqual(["f1"])
    // …and the vanished one is on the record.
    const gone = result.manifest.projects[0].files.find((f) => f.fileId === "gone")!
    expect(gone.skipped).toEqual([
      { scope: "gone.SFM", reason: "file no longer exists in this project" },
    ])
  })

  it("dedupes identical project names into distinct folders — and the manifest records which is which", async () => {
    const result = await runOrgEgress(
      args({ selections: [sel("p1", "Alpha", ["f1"]), sel("p2", "Alpha", ["f2"])] }),
      makeDeps({ fetchFiles: async (projectId) => [fileSummary(projectId === "p1" ? "f1" : "f2", { projectId })] }),
    )
    const zip = await loadZip(result.blob)
    expect(zip.files["Alpha/fr/f1.txt"]).toBeTruthy()
    expect(zip.files["Alpha_2/fr/f2.txt"]).toBeTruthy()
    // Without folder attribution, two same-named reports are indistinguishable.
    expect(result.manifest.projects.map((p) => p.folder)).toEqual(["Alpha", "Alpha_2"])
  })

  it("an abort cancels the run instead of being swallowed as a project error", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      runOrgEgress(args({ signal: controller.signal }), makeDeps()),
    ).rejects.toThrow()
  })

  it("a cancel during final org-zip packaging still rejects — not a phantom 'done'", async () => {
    const controller = new AbortController()
    await expect(
      runOrgEgress(
        args({
          signal: controller.signal,
          onProgress: (p) => {
            // The final zipping update fires after the project loop, right
            // before orgZip.generateAsync — the last cancellable moment.
            if (p.phase === "zipping" && p.projectName === "") controller.abort()
          },
        }),
        makeDeps(),
      ),
    ).rejects.toThrow()
  })

  it("misses the cache when the SAME project is exported by a DIFFERENT account (AQU-616)", async () => {
    const buildExport = makeBuildExport()
    const deps = makeDeps({ buildExport })

    await runOrgEgress(args({ username: "alice" }), deps)
    // Bob's in-place account switch must not replay Alice's zip — it holds
    // everything ALICE could read, which may exceed Bob's access.
    const bob = await runOrgEgress(args({ username: "bob" }), deps)
    expect(buildExport).toHaveBeenCalledTimes(2)
    expect(bob.manifest.projects[0].fromCache).toBe(false)
    // Same account again → the partition still replays for its owner.
    const bob2 = await runOrgEgress(args({ username: "bob" }), deps)
    expect(buildExport).toHaveBeenCalledTimes(2)
    expect(bob2.manifest.projects[0].fromCache).toBe(true)
  })

  it("mints per-file sync tokens, memoized per fileId — /audio rejects tokens minted for another file", async () => {
    const fetchToken = vi.fn<typeof fetchSyncToken>(async (_jwt, _pid, fileId) => ({
      token: `tok-${fileId}`,
      expiresIn: 900,
      role: { level: 600, name: "maintainer", source: "org" },
    }))
    const buildExport = vi.fn<typeof buildProjectExport>(async (selection, _o, deps) => {
      // Each file must get ITS OWN token: the sync-worker verifies the
      // token's fileId claim, so one frozen token 403s every file after the
      // first when fetching audio bytes.
      expect(await deps.getToken("f1")).toBe("tok-f1")
      expect(await deps.getToken("f2")).toBe("tok-f2")
      expect(await deps.getToken("f2")).toBe("tok-f2") // memoized — no re-mint
      return {
        entries: [],
        report: {
          projectId: selection.projectId,
          projectName: selection.projectName,
          freshnessKey: deps.freshnessKey,
          fromCache: false,
          files: [],
          errors: [],
        },
        hadTransientFailures: false,
      }
    })
    await runOrgEgress(
      args({ selections: [sel("p1", "Project One", ["f1", "f2"])] }),
      makeDeps({
        fetchToken,
        buildExport,
        fetchFiles: async (projectId) => [
          fileSummary("f1", { projectId }),
          fileSummary("f2", { projectId }),
        ],
      }),
    )
    expect(buildExport).toHaveBeenCalledTimes(1)
    // Eager f1 mint (reused from cache by the builder) + one f2 mint.
    expect(fetchToken.mock.calls.map((c) => c[2])).toEqual(["f1", "f2"])
  })

  it("re-mints a token inside the 30s refresh margin — a >15-min project pass must not 401 mid-run", async () => {
    const fetchToken = vi.fn<typeof fetchSyncToken>(async () => ({
      token: "short-lived",
      expiresIn: 20, // whole lifetime sits inside the refresh safety margin
      role: { level: 600, name: "maintainer", source: "org" },
    }))
    const buildExport = vi.fn<typeof buildProjectExport>(async (selection, _o, deps) => {
      await deps.getToken("f1") // must re-mint, not serve the expiring token
      return {
        entries: [],
        report: {
          projectId: selection.projectId,
          projectName: selection.projectName,
          freshnessKey: deps.freshnessKey,
          fromCache: false,
          files: [],
          errors: [],
        },
        hadTransientFailures: false,
      }
    })
    await runOrgEgress(args(), makeDeps({ fetchToken, buildExport }))
    expect(fetchToken.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it("does NOT cache a build with transient failures — a retry could fill the holes", async () => {
    const buildExport = makeBuildExport(true) // network-shaped skip inside
    const deps = makeDeps({ buildExport })
    await runOrgEgress(args(), deps)
    // Nothing was cached, so an identical re-run rebuilds instead of
    // replaying the zip with the transient gap baked in.
    expect(await readEgressCache("p1")).toBeNull()
    const second = await runOrgEgress(args(), deps)
    expect(buildExport).toHaveBeenCalledTimes(2)
    expect(second.manifest.projects[0].fromCache).toBe(false)
  })
})

describe("runOrgEgress — audio + settings freshness (files projection is blind to both)", () => {
  const audioOptions: EgressOptions = { ...options, audioMode: "separate-clips" }
  const listing = (selected: string): FileAudioAttachmentsResponse => ({
    cells: {
      c1: {
        attachments: {
          [selected]: {
            audioId: selected,
            url: `frontier-audio://${selected}.wav`,
            slot: "recording",
            mimeType: "audio/wav",
            voiceId: null,
            referenceAudioId: null,
            durationMs: 1000,
            trimStartMs: null,
            trimEndMs: null,
          },
        },
        selectedAudioId: selected,
        selectedGeneratedVoiceAudioId: null,
        audioTimings: {},
      },
    },
  })

  it("rebuilds when a take changes even though no files-projection field moved", async () => {
    const buildExport = makeBuildExport()
    // Identical file summaries across runs: audio mutations never bump
    // lastEditAt/counts, which is exactly the pre-fix blind spot.
    await runOrgEgress(
      args({ options: audioOptions }),
      makeDeps({ buildExport, fetchAudioAttachments: async () => listing("a1") }),
    )
    const same = await runOrgEgress(
      args({ options: audioOptions }),
      makeDeps({ buildExport, fetchAudioAttachments: async () => listing("a1") }),
    )
    expect(buildExport).toHaveBeenCalledTimes(1)
    expect(same.manifest.projects[0].fromCache).toBe(true)

    const changed = await runOrgEgress(
      args({ options: audioOptions }),
      makeDeps({ buildExport, fetchAudioAttachments: async () => listing("a2") }),
    )
    expect(buildExport).toHaveBeenCalledTimes(2)
    expect(changed.manifest.projects[0].fromCache).toBe(false)
  })

  it("passes the pre-probe listings down to the builder instead of fetching twice", async () => {
    const fetchAudioAttachments = vi.fn<
      NonNullable<RunOrgEgressDeps["fetchAudioAttachments"]>
    >(async () => listing("a1"))
    const buildExport = makeBuildExport()
    await runOrgEgress(
      args({ options: audioOptions }),
      makeDeps({ buildExport, fetchAudioAttachments }),
    )
    expect(fetchAudioAttachments).toHaveBeenCalledTimes(1)
    const deps = buildExport.mock.calls[0][2]
    expect(deps.audioListings?.get("f1")).toEqual(listing("a1"))
  })

  it("bypasses the cache entirely (no read, no write) when a listing fetch fails, and says so", async () => {
    const buildExport = makeBuildExport()
    const t1 = new Date(2026, 7, 13)
    await runOrgEgress(
      args({ options: audioOptions }),
      makeDeps({ buildExport, fetchAudioAttachments: async () => listing("a1"), now: () => t1 }),
    )
    expect((await readEgressCache("p1"))?.cachedAt).toBe(t1.getTime())

    // Listing unreachable: the freshness digest can't see audio state, so a
    // replay could ship stale audio and a write could poison later runs.
    const failed = await runOrgEgress(
      args({ options: audioOptions }),
      makeDeps({
        buildExport,
        fetchAudioAttachments: async () => {
          throw new Error("HTTP 502")
        },
        now: () => new Date(2026, 7, 14),
      }),
    )
    expect(buildExport).toHaveBeenCalledTimes(2)
    expect(failed.manifest.projects[0].fromCache).toBe(false)
    expect(failed.manifest.projects[0].errors).toEqual([
      "audio attachments for f1.SFM couldn't be listed (cache bypassed this run): HTTP 502",
    ])
    // The healthy first-run entry is untouched — the failed run didn't write.
    expect((await readEgressCache("p1"))?.cachedAt).toBe(t1.getTime())
  })

  it("rebuilds when ttsSettings change — voice names shape audio entry names, not the files projection", async () => {
    const buildExport = makeBuildExport()
    const settingsWith = (voiceName: string): typeof fetchProjectSettings =>
      async () => ({
        version: 1,
        updatedAt: "2026-08-13T00:00:00Z",
        updatedBy: null,
        settings: {
          ttsSettings: { voices: [{ id: "v1", name: voiceName, color: "#000", prompt: "" }] },
        },
      })
    await runOrgEgress(
      args({ options: audioOptions }),
      makeDeps({
        buildExport,
        fetchSettings: settingsWith("Mary"),
        fetchAudioAttachments: async () => listing("a1"),
      }),
    )
    const renamed = await runOrgEgress(
      args({ options: audioOptions }),
      makeDeps({
        buildExport,
        fetchSettings: settingsWith("Martha"),
        fetchAudioAttachments: async () => listing("a1"),
      }),
    )
    expect(buildExport).toHaveBeenCalledTimes(2)
    expect(renamed.manifest.projects[0].fromCache).toBe(false)
  })
})
