/**
 * Org data egress orchestrator — builds the single org zip + manifest from the
 * user's file selection. Sequential per project (memory-friendly), with a
 * per-project IndexedDB export cache keyed on freshness + options + account.
 *
 * Failure policy is "complete with what succeeded, fail loud in the manifest":
 * per-file failures land as skips inside buildProjectExport, per-project
 * failures (token mint denied, file list unreachable) land in report.errors —
 * only an abort rejects the whole run.
 *
 * See src/lib/egress/types.ts for the contract shared with the UI.
 */

import JSZip from "jszip"
import { fetchSyncToken, SyncTokenError } from "@/lib/sync/sync-token"
import { fetchProjectFiles } from "@/lib/sync/cells-read"
import { fetchProjectSettings } from "@/lib/sync/project-settings"
import { fetchFileAudioAttachments } from "@/lib/sync/cell-audio-read"
import type { FileAudioAttachmentsResponse } from "@/lib/sync/cell-audio-read-types"
import type {
  EgressManifest,
  EgressProgressUpdate,
  EgressProjectReport,
  RunOrgEgressArgs,
  RunOrgEgressResult,
} from "./types"
import {
  combineFreshness,
  computeAudioFreshness,
  computeProjectFreshness,
  computeSettingsFreshness,
} from "./freshness"
import { computeOptionsHash } from "./options-hash"
import { readEgressCache, writeEgressCache } from "./export-cache"
import { buildProjectExport, egressSlug } from "./build-project-export"

export interface RunOrgEgressDeps {
  fetchToken?: typeof fetchSyncToken
  fetchFiles?: typeof fetchProjectFiles
  fetchSettings?: typeof fetchProjectSettings
  fetchAudioAttachments?: typeof fetchFileAudioAttachments
  buildExport?: typeof buildProjectExport
  readCache?: typeof readEgressCache
  writeCache?: typeof writeEgressCache
  now?: () => Date
}

/** Mirror makeSyncTokenMinter's refresh window (sync-token.ts). */
const REFRESH_SAFETY_MS = 30_000

/**
 * Project-level failure copy. A sync-token 403 does NOT always mean org
 * policy — the server's body carries the actual reason (frozen, archived, no
 * access) as `{error}` JSON, so surface that; the fixed org-policy copy is
 * reserved for file-level SourceExportError 403s in build-project-export.
 */
function projectErrorMessage(err: unknown): string {
  if (err instanceof SyncTokenError) {
    try {
      const parsed = JSON.parse(err.body) as { error?: unknown }
      if (typeof parsed.error === "string" && parsed.error) return parsed.error
    } catch {
      /* non-JSON body — fall through to the generic message */
    }
    return err.message
  }
  return err instanceof Error ? err.message : String(err)
}

export async function runOrgEgress(
  args: RunOrgEgressArgs,
  deps: RunOrgEgressDeps = {},
): Promise<RunOrgEgressResult> {
  const fetchToken = deps.fetchToken ?? fetchSyncToken
  const fetchFiles = deps.fetchFiles ?? fetchProjectFiles
  const fetchSettings = deps.fetchSettings ?? fetchProjectSettings
  const fetchAudioAttachments = deps.fetchAudioAttachments ?? fetchFileAudioAttachments
  const buildExport = deps.buildExport ?? buildProjectExport
  const readCache = deps.readCache ?? readEgressCache
  const writeCache = deps.writeCache ?? writeEgressCache
  const now = deps.now ?? (() => new Date())

  const throwIfAborted = (): void => {
    if (args.signal?.aborted) {
      const reason: unknown = args.signal.reason
      throw reason ?? new DOMException("Aborted", "AbortError")
    }
  }
  const rethrowIfAborted = (err: unknown): void => {
    if (args.signal?.aborted) throw err
    if (err instanceof DOMException && err.name === "AbortError") throw err
  }

  const selections = args.selections.filter((s) => s.files.length > 0)
  const projectCount = selections.length
  const progress = (p: Omit<EgressProgressUpdate, "projectCount">): void =>
    args.onProgress?.({ ...p, projectCount })

  const orgZip = new JSZip()
  const reports: EgressProjectReport[] = []
  // Project folder names dedupe with _2/_3 like every other egress slug.
  const usedSlugs = new Map<string, number>()
  const claimSlug = (name: string): string => {
    const base = egressSlug(name, "project")
    const seen = usedSlugs.get(base) ?? 0
    usedSlugs.set(base, seen + 1)
    return seen === 0 ? base : `${base}_${seen + 1}`
  }

  for (let i = 0; i < selections.length; i++) {
    const selection = selections[i]
    throwIfAborted()
    progress({ phase: "preparing", projectName: selection.projectName, projectIndex: i, done: 0, total: 0 })
    const projectSlug = claimSlug(selection.projectName)

    try {
      // Per-file, expiry-aware token minting: the sync-worker's /audio and
      // cells routes verify the token's fileId claim against the URL, so ONE
      // frozen token cannot cover a whole project — and a >15-min project
      // pass would outlive it anyway. Mirrors makeSyncTokenMinter's cache.
      const tokenCache = new Map<string, { token: string; mintedAtMs: number; expiresInS: number }>()
      const mintToken = async (fileId: string): Promise<string> => {
        const cached = tokenCache.get(fileId)
        const nowMs = Date.now()
        if (cached && cached.mintedAtMs + cached.expiresInS * 1000 > nowMs + REFRESH_SAFETY_MS) {
          return cached.token
        }
        const res = await fetchToken(args.jwt, selection.projectId, fileId)
        tokenCache.set(fileId, { token: res.token, mintedAtMs: nowMs, expiresInS: res.expiresIn })
        return res.token
      }
      const getToken = async (fileId: string): Promise<string | null> => mintToken(fileId)

      // Eager first mint: a project-level denial (frozen/archived/no access)
      // fails loud here instead of surfacing as N per-file skips.
      const firstToken = await mintToken(selection.files[0].id)
      const files = await fetchFiles(selection.projectId, firstToken)

      // Existence check before any fetching keyed on selected files: files
      // deleted since the table loaded are reported, not silently dropped.
      const present = new Set(files.map((f) => f.fileId))
      const missing = selection.files.filter((f) => !present.has(f.id))
      const exportable = selection.files.filter((f) => present.has(f.id))

      // Settings BEFORE the cache probe: ttsSettings (cast/voice names) and
      // lane config shape output bytes but never touch the files projection,
      // so they must be part of the freshness key. A miss degrades to null —
      // consistently, so the digest stays stable for callers without access.
      const settings = await fetchSettings(args.jwt, selection.projectId)
      const settingsDigest = await computeSettingsFreshness({
        ttsSettings: settings?.settings.ttsSettings ?? null,
        targetLanes: settings?.settings.targetLanes ?? null,
        sourceLanguage: selection.sourceLanguage,
        targetLanguage: selection.targetLanguage,
      })

      // Audio-attachments listings BEFORE the cache probe: audio mutations
      // (attach, trim, take select) move no files-projection field, so the
      // listings themselves are the only freshness signal audio exports have.
      // A failed listing poisons the digest → bypass the cache entirely for
      // this project (no read, no write) and say so in the manifest.
      const audioListings =
        args.options.audioMode !== "none" ? new Map<string, FileAudioAttachmentsResponse>() : null
      const projectErrors: string[] = []
      let cacheBypassed = false
      if (audioListings) {
        for (const f of exportable) {
          throwIfAborted()
          try {
            audioListings.set(f.id, await fetchAudioAttachments(selection.projectId, f.id, await mintToken(f.id)))
          } catch (err) {
            rethrowIfAborted(err)
            cacheBypassed = true
            projectErrors.push(
              `audio attachments for ${f.name} couldn't be listed (cache bypassed this run): ${
                err instanceof Error ? err.message : String(err)
              }`,
            )
          }
        }
      }

      const freshnessKey = await combineFreshness([
        await computeProjectFreshness(files),
        settingsDigest,
        ...(audioListings ? [await computeAudioFreshness(audioListings)] : []),
      ])
      const optionsHash = await computeOptionsHash(
        args.options,
        selection.files.map((f) => f.id),
      )

      if (args.options.useCache && !cacheBypassed) {
        const cached = await readCache(selection.projectId)
        if (
          cached &&
          cached.freshnessKey === freshnessKey &&
          cached.optionsHash === optionsHash &&
          // Account partition: the zip holds what ITS user could read. Purge
          // covers sign-out; this covers in-place account switch (AQU-616).
          cached.username === args.username
        ) {
          // Replay the cached per-project zip into the org zip verbatim.
          const projZip = await JSZip.loadAsync(await cached.zipBlob.arrayBuffer())
          const names = Object.keys(projZip.files).filter((n) => !projZip.files[n].dir)
          for (const name of names) {
            orgZip.file(`${projectSlug}/${name}`, await projZip.files[name].async("uint8array"))
          }
          reports.push({ ...cached.report, fromCache: true, folder: projectSlug })
          progress({
            phase: "zipping",
            projectName: selection.projectName,
            projectIndex: i,
            done: names.length,
            total: names.length,
            fromCache: true,
          })
          continue
        }
      }

      const { entries, report, hadTransientFailures } = await buildExport(
        { ...selection, files: exportable },
        args.options,
        {
          jwt: args.jwt,
          getToken,
          freshnessKey,
          ttsSettings: settings?.settings.ttsSettings,
          audioListings: audioListings ?? undefined,
          signal: args.signal,
          onProgress: (phase, done, total) =>
            progress({ phase, projectName: selection.projectName, projectIndex: i, done, total }),
        },
      )
      for (const m of missing) {
        report.files.push({
          fileId: m.id,
          fileName: m.name,
          entries: [],
          skipped: [{ scope: m.name, reason: "file no longer exists in this project" }],
        })
      }
      report.errors.push(...projectErrors)

      // One "this project is zipped" tick — a fractional 0/N here would walk
      // the overall bar BACKWARDS a project width right after the build phase.
      progress({
        phase: "zipping",
        projectName: selection.projectName,
        projectIndex: i,
        done: 1,
        total: 1,
      })
      for (const entry of entries) {
        orgZip.file(`${projectSlug}/${entry.path}`, entry.data)
      }
      // Cache only complete builds: transient holes (network/5xx/decode) could
      // fill on retry, so caching them would replay the gaps until the project
      // happens to change. Persistent skips (404 no sidecar, policy 403,
      // no-audio files) are stable states and cache fine.
      if (!cacheBypassed && !hadTransientFailures) {
        const projZip = new JSZip()
        for (const entry of entries) {
          projZip.file(entry.path, entry.data)
        }
        const zipBlob = await projZip.generateAsync({ type: "blob", compression: "DEFLATE" })
        await writeCache({
          projectId: selection.projectId,
          username: args.username,
          freshnessKey,
          optionsHash,
          zipBlob,
          report,
          sizeBytes: zipBlob.size,
          cachedAt: now().getTime(),
        })
      }
      reports.push({ ...report, folder: projectSlug })
    } catch (err) {
      // Aborts cancel the whole run; anything else is a per-project failure
      // recorded in the manifest so the export completes with what succeeded.
      if (args.signal?.aborted || (err instanceof DOMException && err.name === "AbortError")) {
        throw err
      }
      reports.push({
        projectId: selection.projectId,
        projectName: selection.projectName,
        freshnessKey: "",
        fromCache: false,
        files: [],
        errors: [projectErrorMessage(err)],
      })
    }
  }
  // A cancel during the last project's tail must still reject, not "finish".
  throwIfAborted()

  const generatedAt = now()
  const manifest: EgressManifest = {
    generatedAt: generatedAt.toISOString(),
    org: args.org,
    options: args.options,
    projects: reports,
  }
  orgZip.file("manifest.json", JSON.stringify(manifest, null, 2))

  progress({ phase: "zipping", projectName: "", projectIndex: projectCount, done: 0, total: 0 })
  const blob = await orgZip.generateAsync({ type: "blob", compression: "DEFLATE" })
  // Final packaging can take seconds on big orgs — cancel must win over it.
  throwIfAborted()

  const pad = (n: number): string => String(n).padStart(2, "0")
  const yyyymmdd = `${generatedAt.getFullYear()}${pad(generatedAt.getMonth() + 1)}${pad(generatedAt.getDate())}`
  const filename = `${egressSlug(args.org.name, "org")}-egress-${yyyymmdd}.zip`

  progress({
    phase: "done",
    projectName: "",
    projectIndex: projectCount,
    done: projectCount,
    total: projectCount,
  })
  return { blob, manifest, filename }
}
