/**
 * Per-project egress builder — turns one project's selected files into
 * PROJECT-RELATIVE zip entries plus the transparency report. The orchestrator
 * (org-egress) prefixes the project slug, so the entry set can be cached and
 * replayed into a later org zip regardless of sibling-project slug dedupe.
 *
 * `deps` members default to the real implementations (same pattern as
 * loadProjectCellFiles' loadRows param) so tests inject fakes — no network,
 * no Web Audio.
 */

import type { CellData } from "@/hooks/useCells"
import { loadProjectCellFiles } from "@/hooks/useProjectCells"
import { mergeCellsWithAudio } from "@/hooks/useFileAudioAttachments"
import { fetchFileAudioAttachments } from "@/lib/sync/cell-audio-read"
import type { FileAudioAttachmentsResponse } from "@/lib/sync/cell-audio-read-types"
import type { ProjectTtsSettings } from "@/lib/parsers/types"
import {
  fetchInjectedSourceText,
  fetchRawOriginalSource,
  fetchSourceSidecar,
  SourceExportError,
} from "@/lib/sync/source-export"
import { exportFileCells, type TextExportFormat } from "@/lib/export/project-zip-export"
import { exportVttStructured } from "@/lib/export/exporters/vtt-structured"
import {
  assembleAudioEntries,
  type AudioAssemblyArgs,
  type AudioAssemblyMode,
} from "@/lib/export/audio-assembly"
import { audioCacheGet, audioCachePut } from "@/lib/audio/bytes-cache"
import { fetchCellAudio } from "@/lib/audio/upload"
import type {
  EgressFileRef,
  EgressFileReport,
  EgressOptions,
  EgressProjectReport,
  EgressProjectSelection,
} from "./types"

export interface EgressZipEntry {
  /** Project-relative zip path — org-egress prefixes `<project-slug>/`. */
  path: string
  data: Blob | ArrayBuffer | Uint8Array | string
}

export interface BuildProjectExportResult {
  entries: EgressZipEntry[]
  report: EgressProjectReport
  /** True when at least one skip came from a possibly-retryable failure
   *  (network, 5xx, decode) rather than a stable project state (404 no
   *  sidecar, 403 policy, no audio). The orchestrator must not cache a zip
   *  built with transient holes — a retry could fill them. */
  hadTransientFailures: boolean
}

/** Injected exporters use the structural minimum of the real result shapes. */
type SidecarInjector = (rawBytes: ArrayBuffer, cells: CellData[]) => Promise<{ blob: Blob }>

export interface BuildProjectExportDeps {
  jwt: string
  /** Per-file sync token mint — the sync-worker's /audio and cells reads
   *  verify the token's fileId claim, so tokens can't be shared across files. */
  getToken: (fileId: string) => Promise<string | null>
  /** Freshness digest the orchestrator computed (files + settings + audio). */
  freshnessKey: string
  /** TTS cast settings the orchestrator fetched (voice names for audio entry
   *  naming). Undefined degrades to preset voices — never fatal. */
  ttsSettings?: ProjectTtsSettings
  /** Audio-attachments listings the orchestrator pre-fetched for its
   *  freshness digest, keyed by fileId — files absent here are fetched via
   *  fetchAudioAttachments so standalone callers still work. */
  audioListings?: ReadonlyMap<string, FileAudioAttachmentsResponse>
  onProgress?: (phase: "text" | "audio", done: number, total: number) => void
  signal?: AbortSignal
  loadCellFiles?: typeof loadProjectCellFiles
  fetchAudioAttachments?: typeof fetchFileAudioAttachments
  fetchSidecar?: typeof fetchSourceSidecar
  fetchRawSource?: typeof fetchRawOriginalSource
  fetchInjectedText?: typeof fetchInjectedSourceText
  assembleAudio?: typeof assembleAudioEntries
  fetchAudioBytes?: AudioAssemblyArgs["fetchBytes"]
  decodeAudio?: AudioAssemblyArgs["decode"]
  exportDocxFn?: SidecarInjector
  exportPptxFn?: SidecarInjector
  exportIdmlFn?: SidecarInjector
}

/** FileType → native round-trip plan (mirrors ExportDialog's
 *  NATIVE_EXPORT_BY_FILE_TYPE). Types absent here (ebible, helloao, obs,
 *  sdbh, audio, video, …) fall back to options.convertFormat with a note. */
type NativeTextPlan =
  | { kind: "usfm"; ext: "usfm" }
  | { kind: "sidecar"; format: "docx" | "pptx" | "idml"; ext: string }
  | { kind: "structured"; format: TextExportFormat; ext: string }
  | { kind: "vtt"; ext: "vtt" }

const NATIVE_TEXT_BY_FILE_TYPE: Partial<Record<string, NativeTextPlan>> = {
  usfm: { kind: "usfm", ext: "usfm" },
  docx: { kind: "sidecar", format: "docx", ext: "docx" },
  pptx: { kind: "sidecar", format: "pptx", ext: "pptx" },
  idml: { kind: "sidecar", format: "idml", ext: "idml" },
  md: { kind: "structured", format: "md", ext: "md" },
  txt: { kind: "structured", format: "txt", ext: "txt" },
  vtt: { kind: "vtt", ext: "vtt" },
  srt: { kind: "structured", format: "srt", ext: "srt" },
  xliff: { kind: "structured", format: "xlf", ext: "xlf" },
  tmx: { kind: "structured", format: "tmx", ext: "tmx" },
  csv: { kind: "structured", format: "csv", ext: "csv" },
  tsv: { kind: "structured", format: "tsv", ext: "tsv" },
}

/** Shared slug convention: path-hostile runs → "-", trimmed. Dots survive the
 *  charset filter, so all-dot results ("."/"..") — which would escape their
 *  zip folder as path segments — take the fallback too. */
export function egressSlug(raw: string, fallback: string): string {
  const slug = raw.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "")
  return !slug || /^\.+$/.test(slug) ? fallback : slug
}

const fileBaseSlug = (name: string): string =>
  egressSlug(name.replace(/\.[^.]+$/, ""), "file")

/** Human reason for a failed /source fetch — the two policy-relevant statuses
 *  get the design's fixed copy, everything else surfaces the error verbatim. */
function sourceFetchReason(err: unknown): string {
  if (err instanceof SourceExportError) {
    if (err.status === 404) {
      return "no sidecar stored (imported before round-trip support); re-import to enable"
    }
    if (err.status === 403) return "export blocked by org policy (HTTP 403)"
  }
  return err instanceof Error ? err.message : String(err)
}

const defaultFetchAudioBytes = (
  getToken: (fileId: string) => Promise<string | null>,
): AudioAssemblyArgs["fetchBytes"] =>
  async ({ projectId, fileId, audioId, ext }) => {
    // Cache-first like batch-audio: a take's bytes may live in the OPFS cache.
    const cached = await audioCacheGet(audioId, ext)
    if (cached) return cached
    const bytes = await fetchCellAudio({
      projectId,
      fileId,
      audioId,
      ext,
      getSyncToken: (_pid, fid) => getToken(fid),
    })
    void audioCachePut(audioId, ext, bytes)
    return bytes
  }

const defaultDecodeAudio: AudioAssemblyArgs["decode"] = async (bytes) =>
  (await import("@/lib/audio/decode-mono")).decodeToMono48k(bytes)

/** File×lane text/audio units in flight at once. Each unit is one lane of one
 *  file. A small cap cuts the sequential round-trips that dominate export
 *  latency without fanning out unbounded against sync-worker. */
const FILE_LANE_FETCH_CONCURRENCY = 4

type PlannedEntry = { path: string; data: EgressZipEntry["data"] }
type PlannedSkip = { scope: string; reason: string }

interface FileLaneOutcome {
  file: EgressFileRef
  notes: string[]
  textEntries: PlannedEntry[]
  textSkips: PlannedSkip[]
  textTransient: boolean
  audioEntries: PlannedEntry[]
  audioSkips: PlannedSkip[]
  audioTransient: boolean
}

/** Run `fn` over `items` with at most `concurrency` calls in flight. Results
 *  are returned in input order. The first rejection aborts scheduling; in-flight
 *  calls settle, then that error is rethrown. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  let failed = false
  let failure: unknown

  const worker = async (): Promise<void> => {
    for (;;) {
      if (failed) return
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      try {
        results[index] = await fn(items[index], index)
      } catch (err) {
        failed = true
        failure ??= err
        return
      }
    }
  }

  const workerCount = Math.min(concurrency, items.length)
  if (workerCount > 0) {
    await Promise.all(Array.from({ length: workerCount }, () => worker()))
  }
  if (failed) throw failure
  return results
}

export async function buildProjectExport(
  selection: EgressProjectSelection,
  options: EgressOptions,
  deps: BuildProjectExportDeps,
): Promise<BuildProjectExportResult> {
  const loadCellFiles = deps.loadCellFiles ?? loadProjectCellFiles
  const fetchAudioAttachments = deps.fetchAudioAttachments ?? fetchFileAudioAttachments
  const fetchSidecar = deps.fetchSidecar ?? fetchSourceSidecar
  const fetchRawSource = deps.fetchRawSource ?? fetchRawOriginalSource
  const fetchInjectedText = deps.fetchInjectedText ?? fetchInjectedSourceText
  const assembleAudio = deps.assembleAudio ?? assembleAudioEntries
  const fetchAudioBytes = deps.fetchAudioBytes ?? defaultFetchAudioBytes(deps.getToken)
  const decodeAudio = deps.decodeAudio ?? defaultDecodeAudio
  // Sidecar injectors dynamic-import by default, like ExportDialog — the
  // docx/pptx/idml engines are heavy and most egress runs never need them.
  const exportDocxFn: SidecarInjector =
    deps.exportDocxFn ??
    (async (raw, cells) => (await import("@/lib/export/exporters/docx")).exportDocx(raw, cells))
  const exportPptxFn: SidecarInjector =
    deps.exportPptxFn ??
    (async (raw, cells) => (await import("@/lib/export/exporters/pptx")).exportPptx(raw, cells))
  const exportIdmlFn: SidecarInjector =
    deps.exportIdmlFn ??
    (async (raw, cells) => (await import("@/lib/export/exporters/idml")).exportIdml(raw, cells))

  const throwIfAborted = (): void => {
    if (deps.signal?.aborted) {
      const reason: unknown = deps.signal.reason
      throw reason ?? new DOMException("Aborted", "AbortError")
    }
  }
  /** Aborts must propagate (cancel the run), everything else becomes a skip. */
  const rethrowIfAborted = (err: unknown): void => {
    if (deps.signal?.aborted) throw err
    if (err instanceof DOMException && err.name === "AbortError") throw err
  }

  const entries: EgressZipEntry[] = []
  const errors: string[] = []
  /** Fix-9 classifier: 404/403 skips are stable project states (no sidecar,
   *  org policy); anything else could succeed on retry, so a zip containing
   *  it must not be cached (see BuildProjectExportResult). */
  let hadTransientFailures = false
  const isTransientFailure = (err: unknown): boolean =>
    !(err instanceof SourceExportError && (err.status === 404 || err.status === 403))
  const fileReports = new Map<string, EgressFileReport>()
  for (const file of selection.files) {
    fileReports.set(file.id, { fileId: file.id, fileName: file.name, entries: [], skipped: [] })
  }
  const reportFor = (file: EgressFileRef): EgressFileReport => fileReports.get(file.id)!

  // Path dedupe within the project — same _2/_3 convention as audio-assembly.
  const usedPaths = new Map<string, number>()
  const claimPath = (path: string): string => {
    const seen = usedPaths.get(path) ?? 0
    usedPaths.set(path, seen + 1)
    if (seen === 0) return path
    const dot = path.lastIndexOf(".")
    const slash = path.lastIndexOf("/")
    return dot > slash
      ? `${path.slice(0, dot)}_${seen + 1}${path.slice(dot)}`
      : `${path}_${seen + 1}`
  }
  const pushEntry = (report: EgressFileReport, path: string, data: EgressZipEntry["data"]): void => {
    const claimed = claimPath(path)
    entries.push({ path: claimed, data })
    report.entries.push(claimed)
  }

  const audioMode: AudioAssemblyMode | null =
    options.audioMode === "none" ? null : options.audioMode
  const wantText = options.textMode !== "none"

  // Cells from loadProjectCellFiles NEVER carry attachments/selected slots
  // (buildCellData doesn't populate them — the workspace merges the per-file
  // audio read separately), so audio modes must fetch the listings and fold
  // them in with mergeCellsWithAudio or every cell reads as "no audio".
  // Listings are lane-independent → memoized per file, pre-fetched ones from
  // the orchestrator (its freshness digest) are reused, not fetched twice.
  const listingByFile = new Map<string, Promise<FileAudioAttachmentsResponse>>()
  const getAudioListing = (file: EgressFileRef): Promise<FileAudioAttachmentsResponse> => {
    let promise = listingByFile.get(file.id)
    if (!promise) {
      const prefetched = deps.audioListings?.get(file.id)
      promise = prefetched
        ? Promise.resolve(prefetched)
        : (async () => {
            const token = await deps.getToken(file.id)
            if (!token) throw new Error(`Couldn't get a read token for ${file.name}.`)
            return fetchAudioAttachments(selection.projectId, file.id, token)
          })()
      listingByFile.set(file.id, promise)
    }
    return promise
  }

  const lanes = wantText || audioMode !== null ? options.lanes : []
  const unitTotal = lanes.length * selection.files.length
  let textDone = 0
  let audioDone = 0

  const units: Array<{ lane: string; file: EgressFileRef }> = []
  for (const lane of lanes) {
    for (const file of selection.files) units.push({ lane, file })
  }

  // Fetches run FILE_LANE_FETCH_CONCURRENCY at a time. Outcomes stay in
  // lane/file order and are committed afterwards so path dedupe and archive
  // entry order match the sequential walk.
  const outcomes = await mapWithConcurrency(units, FILE_LANE_FETCH_CONCURRENCY, async ({ lane, file }) => {
    throwIfAborted()
    const laneSlug = egressSlug(lane || selection.targetLanguage, "target")
    const laneLang = lane || selection.targetLanguage || "und"
    const fileBase = fileBaseSlug(file.name)
    const outcome: FileLaneOutcome = {
      file,
      notes: [],
      textEntries: [],
      textSkips: [],
      textTransient: false,
      audioEntries: [],
      audioSkips: [],
      audioTransient: false,
    }

    // Cells load lazily and once per (lane, file): usfm-only text runs never
    // pay for them; text + audio share one load.
    let cellsPromise: Promise<CellData[]> | null = null
    const getCells = (): Promise<CellData[]> => {
      cellsPromise ??= loadCellFiles({
        projectId: selection.projectId,
        projectFiles: [file],
        getToken: deps.getToken,
        lane,
      }).then(([loaded]) => loaded.cells)
      return cellsPromise
    }

    if (wantText) {
      let plan: NativeTextPlan | undefined =
        options.textMode === "original" ? NATIVE_TEXT_BY_FILE_TYPE[file.type] : undefined
      if (!plan) {
        if (options.textMode === "original") {
          outcome.notes.push(
            `no native round-trip exporter for type "${file.type}" — converted to ${options.convertFormat}`,
          )
        }
        plan = { kind: "structured", format: options.convertFormat, ext: options.convertFormat }
      }
      const path = `${laneSlug}/${fileBase}.${plan.ext}`
      try {
        if (plan.kind === "usfm") {
          const text = await fetchInjectedText({
            projectId: selection.projectId,
            fileId: file.id,
            getToken: deps.getToken,
            targetLang: lane || undefined,
          })
          outcome.textEntries.push({ path, data: text })
        } else if (plan.kind === "sidecar") {
          const raw = await fetchSidecar({
            projectId: selection.projectId,
            fileId: file.id,
            getToken: deps.getToken,
            targetLang: lane || undefined,
          })
          const cells = await getCells()
          const inject =
            plan.format === "docx" ? exportDocxFn : plan.format === "pptx" ? exportPptxFn : exportIdmlFn
          const result = await inject(raw, cells)
          outcome.textEntries.push({ path, data: result.blob })
        } else if (plan.kind === "vtt") {
          outcome.textEntries.push({ path, data: exportVttStructured(await getCells()) })
        } else {
          const blob = exportFileCells(
            await getCells(),
            plan.format,
            selection.sourceLanguage || "und",
            laneLang,
          )
          outcome.textEntries.push({ path, data: blob })
        }
      } catch (err) {
        rethrowIfAborted(err)
        if (isTransientFailure(err)) outcome.textTransient = true
        outcome.textSkips.push({
          scope: `${file.name} (${laneSlug})`,
          reason: sourceFetchReason(err),
        })
      }
      textDone++
      deps.onProgress?.("text", textDone, unitTotal)
    }

    if (audioMode !== null) {
      try {
        const [bareCells, listing] = await Promise.all([getCells(), getAudioListing(file)])
        const cells = mergeCellsWithAudio(bareCells, new Map(Object.entries(listing.cells)))
        const result = await assembleAudio({
          cells,
          settings: deps.ttsSettings,
          projectId: selection.projectId,
          fileSlug: fileBase,
          langCode: laneLang,
          mode: audioMode,
          fetchBytes: fetchAudioBytes,
          decode: decodeAudio,
          signal: deps.signal,
        })
        for (const e of result.entries) {
          outcome.audioEntries.push({ path: `audio/${laneSlug}/${fileBase}/${e.name}`, data: e.data })
        }
        const allSilent =
          result.entries.length === 0 &&
          result.skipped.length > 0 &&
          result.skipped.every((s) => s.reason === "no audio")
        if (allSilent) {
          // Collapse the per-cell "no audio" noise for audio-less files.
          outcome.audioSkips.push({
            scope: `${file.name} (audio, ${laneSlug})`,
            reason: "no audio on this file",
          })
        } else {
          for (const s of result.skipped) {
            outcome.audioSkips.push({ scope: `cell ${s.cellId} (audio, ${laneSlug})`, reason: s.reason })
          }
        }
        // Per-clip fetch/decode failures inside the assembler surface as
        // "audio failed: …" skips (its failReason) — retryable, so they
        // must poison the cache like any other transient failure.
        if (result.skipped.some((s) => s.reason.startsWith("audio failed:"))) {
          outcome.audioTransient = true
        }
      } catch (err) {
        rethrowIfAborted(err)
        // Listing fetch / cell load / assembly crashes are all retryable.
        outcome.audioTransient = true
        outcome.audioSkips.push({
          scope: `${file.name} (audio, ${laneSlug})`,
          reason: err instanceof Error ? err.message : String(err),
        })
      }
      audioDone++
      deps.onProgress?.("audio", audioDone, unitTotal)
    }

    return outcome
  })

  for (const outcome of outcomes) {
    const report = reportFor(outcome.file)
    if (outcome.notes.length > 0) {
      ;(report.notes ??= []).push(...outcome.notes)
    }
    for (const entry of outcome.textEntries) pushEntry(report, entry.path, entry.data)
    report.skipped.push(...outcome.textSkips)
    if (outcome.textTransient) hadTransientFailures = true
    for (const entry of outcome.audioEntries) pushEntry(report, entry.path, entry.data)
    report.skipped.push(...outcome.audioSkips)
    if (outcome.audioTransient) hadTransientFailures = true
  }

  // Source documents once per file, not per lane — the raw upload bytes are
  // lane-independent.
  if (options.includeSourceDocs) {
    for (const file of selection.files) {
      throwIfAborted()
      const report = reportFor(file)
      try {
        const fetchArgs = {
          projectId: selection.projectId,
          fileId: file.id,
          getToken: deps.getToken,
        }
        if (file.type === "usfm") {
          // AQU-907: ?mode=raw returns the byte-exact original upload. A
          // sync-worker that predates the mode ignores the param and injects
          // current default-lane translations — the manifest must say so
          // rather than present the entry as the original.
          const { bytes, rawOriginal } = await fetchRawSource(fetchArgs)
          pushEntry(report, `source-documents/${egressSlug(file.name, "file")}`, bytes)
          if (!rawOriginal) {
            ;(report.notes ??= []).push(
              "source document is the original USFM re-serialized with current default-lane translations injected — the server does not support raw mode yet",
            )
          }
        } else {
          const raw = await fetchSidecar(fetchArgs)
          pushEntry(report, `source-documents/${egressSlug(file.name, "file")}`, raw)
        }
      } catch (err) {
        rethrowIfAborted(err)
        if (isTransientFailure(err)) hadTransientFailures = true
        report.skipped.push({
          scope: `${file.name} (source document)`,
          reason: sourceFetchReason(err),
        })
      }
    }
  }

  const report: EgressProjectReport = {
    projectId: selection.projectId,
    projectName: selection.projectName,
    freshnessKey: deps.freshnessKey,
    fromCache: false,
    files: selection.files.map((f) => fileReports.get(f.id)!),
    errors,
  }
  return { entries, report, hadTransientFailures }
}
