/**
 * apiRev 7: extensions that run HEADLESS — a manifest action ("Import
 * resources", "Check for updates") or a manifest export ("Aligned USFM").
 *
 * A job mounts the extension in an off-screen sandboxed frame (same sandbox,
 * CSP, bridge, permission gate and event path as any mount), with
 * `aquilla.context.mount` = "action" | "export" and the action/export in the
 * boot data. The extension reports with aquilla.action.progress / done, or
 * hands files back with aquilla.export.deliver (downloaded here — one file as
 * itself, several as a zip). A job that never reports is stopped after its
 * time limit. A permission the user has not granted yet still asks, in a
 * floating card (headless runs have no frame to draw it in).
 */

import { useEffect, useMemo, useRef, useState } from "react"
import JSZip from "jszip"
import { toast } from "@/components/ui/toast"
import { useT } from "@/lib/i18n/I18nProvider"
import type { FrontierSession } from "@/lib/frontier/types"
import { downloadBlob } from "@/lib/export/export-service"
import { TOOL_SANDBOX, buildToolSrcdoc, readThemeVars } from "@/lib/tools/srcdoc"
import type { ToolDetail } from "@/lib/tools/tools-api"
import type { ToolDeliveredFile } from "@/lib/tools/host-handlers-files"
import type { HeadlessCallbacks } from "@/lib/tools/live-data-files"
import { PermissionPrompt } from "./PermissionPrompt"
import { useToolHost } from "./useToolHost"

export type HeadlessOutcome =
  | { ok: true; files?: number; message?: string | null; choices?: { value: string; label: string }[] }
  | { ok: false; error: string }

export interface HeadlessJob {
  key: string
  toolId: string
  kind: "action" | "export" | "import"
  label: string
  /** AQU-1937, import jobs. */
  importerId?: string
  phase?: "run" | "refresh" | "choices"
  options?: Record<string, unknown>
  field?: string
  /** Live progress for the Import dialog. */
  onProgress?: (message: string, fraction: number | null) => void
  actionId?: string
  trigger?: "click" | "open"
  exportId?: string
  fileIds?: string[]
  lane?: string
  /** Export: the file extension the format produces (for a single file without one). */
  extension?: string
  /** Export: settles when the extension delivered (or failed); import: done / choices. */
  settle?: (outcome: HeadlessOutcome) => void
}

export const ACTION_TIME_LIMIT_MS = 15 * 60 * 1000
export const EXPORT_TIME_LIMIT_MS = 5 * 60 * 1000
/** An import of a whole Bible's resources book by book can take a while. */
export const IMPORT_TIME_LIMIT_MS = 30 * 60 * 1000
const CHOICES_TIME_LIMIT_MS = 60 * 1000

/** Turn delivered files into one download: a single file as itself, several as a zip. */
export async function deliverDownload(files: ToolDeliveredFile[], zipName: string): Promise<void> {
  const blobOf = (f: ToolDeliveredFile) => new Blob([f.text !== undefined ? f.text : (f.bytes ?? new ArrayBuffer(0))], { type: f.mime })
  if (files.length === 1) {
    downloadBlob(blobOf(files[0]), files[0].name.split("/").pop() ?? files[0].name)
    return
  }
  const zip = new JSZip()
  for (const f of files) zip.file(f.name, f.text !== undefined ? f.text : (f.bytes ?? new ArrayBuffer(0)))
  downloadBlob(await zip.generateAsync({ type: "blob" }), zipName)
}

function HeadlessRun({
  job,
  tool,
  project,
  session,
  roleLevel,
  onFinish,
}: {
  job: HeadlessJob
  tool: ToolDetail
  project: { id: string; name: string }
  session: FrontierSession
  roleLevel: number | null
  onFinish: () => void
}) {
  const t = useT()
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const toastId = `headless:${job.key}`
  const toastShown = useRef(false)
  const finished = useRef(false)
  const vars = useMemo(() => ({ extension: tool.name, action: job.label }), [tool.name, job.label])

  const finish = useRef<(ok: boolean, message: string | null) => void>(() => {})
  finish.current = (ok, message) => {
    if (finished.current) return
    finished.current = true
    if (toastShown.current) toast.close(toastId)
    if (ok && job.kind === "import") job.settle?.({ ok: true, message })
    if (job.kind === "action") {
      toast.add({
        title: t(ok ? "extensions.action.done" : "extensions.action.failed", vars),
        ...(message ? { description: message } : {}),
      })
    }
    if (!ok) job.settle?.({ ok: false, error: message ?? t("extensions.export.empty", vars) })
    onFinish()
  }

  const headless: HeadlessCallbacks = useMemo(
    () => ({
      ...(job.kind === "import" && job.phase !== "choices" && job.importerId
        ? { importContext: { toolId: tool.id, importerId: job.importerId, options: job.options ?? {} } }
        : {}),
      choices: (choices) => {
        job.settle?.({ ok: true, choices })
        finish.current(true, null)
      },
      progress: (message, fraction) => {
        job.onProgress?.(message, fraction)
        if (job.kind === "import") return
        const title = t(job.kind === "action" ? "extensions.action.running" : "extensions.export.running", vars)
        const description = fraction != null ? `${message} (${Math.round(fraction * 100)}%)` : message
        if (toastShown.current) toast.update(toastId, { title, description })
        else {
          toast.add({ id: toastId, title, description, timeout: 0 })
          toastShown.current = true
        }
      },
      done: (message, ok) => finish.current(ok, message),
      deliver: (files) => {
        void deliverDownload(files, `${tool.name}-${job.exportId ?? "export"}.zip`)
          .then(() => {
            job.settle?.({ ok: true, files: files.length })
            finish.current(true, null)
          })
          .catch((err: unknown) => finish.current(false, err instanceof Error ? err.message : String(err)))
      },
    }),
    [job, tool.name, t, vars, toastId],
  )

  const { prompt, errors } = useToolHost({ frameRef, projectId: project.id, tool, session, roleLevel, headless })

  // Cancelled (the job was removed before it reported): say so to the waiter.
  useEffect(() => () => {
    if (!finished.current) {
      finished.current = true
      job.settle?.({ ok: false, error: "cancelled" })
    }
  }, [job])

  // An uncaught error before the extension reported = the run failed.
  useEffect(() => {
    if (errors.length > 0) finish.current(false, errors[errors.length - 1].message)
  }, [errors])

  useEffect(() => {
    const limit = job.kind === "action" ? ACTION_TIME_LIMIT_MS : job.kind === "import" ? (job.phase === "choices" ? CHOICES_TIME_LIMIT_MS : IMPORT_TIME_LIMIT_MS) : EXPORT_TIME_LIMIT_MS
    const timer = setTimeout(() => finish.current(false, t("extensions.action.timedOut", { ...vars, minutes: Math.round(limit / 60000) })), limit)
    return () => clearTimeout(timer)
  }, [job.kind, t, vars])

  useEffect(() => {
    if (job.kind !== "action" || toastShown.current) return
    toast.add({ id: toastId, title: t("extensions.action.running", vars), timeout: 0 })
    toastShown.current = true
  }, [job.kind, t, vars, toastId])

  const srcdoc = useMemo(
    () =>
      buildToolSrcdoc(tool.source, {
        tool: { id: tool.id, name: tool.name, version: tool.currentVersion, scopes: tool.manifest.scopes },
        project,
        user: { username: session.username, roleLevel },
        mount: job.kind,
        ...(job.kind === "action" ? { action: { id: job.actionId ?? "", trigger: job.trigger ?? "click" } } : {}),
        ...(job.kind === "export" ? { export: { id: job.exportId ?? "", fileIds: job.fileIds ?? [], lane: job.lane ?? "" } } : {}),
        ...(job.kind === "import"
          ? { import: { importerId: job.importerId ?? "", phase: job.phase ?? "run", options: job.options ?? {}, ...(job.fileIds ? { fileIds: job.fileIds } : {}), ...(job.field ? { field: job.field } : {}) } }
          : {}),
        theme: readThemeVars(),
      }, { sdk: tool.manifest.sdk }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one frame per job
    [job.key, tool.id, tool.currentVersion],
  )

  return (
    <>
      {prompt && (
        <div className="fixed bottom-4 end-4 z-50 w-96 max-w-[calc(100vw-2rem)] rounded-lg border bg-background shadow-lg" data-testid="headless-permission">
          <PermissionPrompt toolName={tool.name} prompt={prompt} web={tool.manifest.web} />
        </div>
      )}
      <iframe
        ref={frameRef}
        title={`${tool.name} (${job.label})`}
        sandbox={TOOL_SANDBOX}
        referrerPolicy="no-referrer"
        srcDoc={srcdoc}
        aria-hidden="true"
        tabIndex={-1}
        data-testid="headless-frame"
        data-tool-id={tool.id}
        data-job-kind={job.kind}
        style={{ position: "fixed", left: "-10000px", top: 0, width: "1024px", height: "768px", border: 0 }}
      />
    </>
  )
}

/** Renders every running job (inside ToolsMountProvider). */
export function HeadlessRuns({
  jobs,
  loadTool,
  project,
  session,
  roleLevel,
  onFinish,
}: {
  jobs: HeadlessJob[]
  loadTool: (toolId: string) => Promise<ToolDetail>
  project: { id: string; name: string } | null
  session: FrontierSession | null
  roleLevel: number | null
  onFinish: (key: string) => void
}) {
  const [loaded, setLoaded] = useState<Record<string, ToolDetail>>({})
  useEffect(() => {
    for (const job of jobs) {
      if (loaded[job.toolId]) continue
      loadTool(job.toolId)
        .then((tool) => setLoaded((prev) => ({ ...prev, [job.toolId]: tool })))
        .catch((err: unknown) => {
          job.settle?.({ ok: false, error: err instanceof Error ? err.message : String(err) })
          onFinish(job.key)
        })
    }
  }, [jobs, loaded, loadTool, onFinish])
  if (!project || !session) return null
  return (
    <>
      {jobs.map((job) => {
        const tool = loaded[job.toolId]
        return tool ? (
          <HeadlessRun key={job.key} job={job} tool={tool} project={project} session={session} roleLevel={roleLevel} onFinish={() => onFinish(job.key)} />
        ) : null
      })}
    </>
  )
}
