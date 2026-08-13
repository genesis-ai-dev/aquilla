// Google Drive import panel: connect → pick (files or folders) → pre-import
// summary (accepted + loudly-listed skips) → download → hand File[] to the
// dialog's normal handleFiles path. No import logic lives here — routing and
// fetching are in src/lib/import/google-drive.ts (unit-tested), and the
// popup/script layer is in google-drive-picker.ts.

import { useCallback, useState } from "react"
import { AlertTriangle, CloudDownload, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useT } from "@/lib/i18n/I18nProvider"
import {
  planDriveImport,
  expandDriveFolders,
  fetchDriveFile,
  driveOrigin,
  type DriveImportPlan,
} from "@/lib/import/google-drive"
import {
  googleDriveConfig,
  requestDriveAccessToken,
  openDrivePicker,
  listDriveChildren,
} from "@/lib/import/google-drive-picker"

type Stage =
  | { kind: "idle" }
  | { kind: "picking" }
  | { kind: "summary"; plan: DriveImportPlan; accessToken: string }
  | { kind: "downloading"; done: number; total: number }

export function GoogleDrivePanel({
  onFiles,
}: {
  /** Hands downloaded files plus per-file provenance to the dialog's
   *  standard import path. Origin keys are normalized file names. */
  onFiles: (files: File[], origins: Map<string, Record<string, unknown>>) => void | Promise<void>
}) {
  const t = useT()
  const config = googleDriveConfig()
  const [stage, setStage] = useState<Stage>({ kind: "idle" })
  const [error, setError] = useState<string | null>(null)

  const pick = useCallback(async () => {
    if (!config) return
    setError(null)
    setStage({ kind: "picking" })
    try {
      const accessToken = await requestDriveAccessToken(config.clientId)
      const picked = await openDrivePicker({
        accessToken,
        apiKey: config.apiKey,
        clientId: config.clientId,
      })
      if (picked.length === 0) {
        setStage({ kind: "idle" })
        return
      }
      const expanded = await expandDriveFolders(picked, listDriveChildren(accessToken))
      setStage({ kind: "summary", plan: planDriveImport(expanded), accessToken })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStage({ kind: "idle" })
    }
  }, [config])

  const confirm = useCallback(async () => {
    if (stage.kind !== "summary") return
    const { plan, accessToken } = stage
    setError(null)
    setStage({ kind: "downloading", done: 0, total: plan.accepted.length })
    try {
      const files: File[] = []
      const origins = new Map<string, Record<string, unknown>>()
      for (const task of plan.accepted) {
        const file = await fetchDriveFile(task, accessToken)
        files.push(file)
        origins.set(file.name.trim().toLowerCase(), { ...driveOrigin(task) })
        setStage({ kind: "downloading", done: files.length, total: plan.accepted.length })
      }
      await onFiles(files, origins)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStage({ kind: "summary", plan, accessToken })
    }
  }, [stage, onFiles])

  if (!config) {
    return (
      <div className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">
        {t("importExport.googleDrive.notConfigured")}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {error && (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
        >
          {error}
        </div>
      )}

      {(stage.kind === "idle" || stage.kind === "picking") && (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm text-muted-foreground">
            {t("importExport.googleDrive.description")}
          </p>
          <Button onClick={pick} disabled={stage.kind === "picking"}>
            {stage.kind === "picking" ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" /> {t("importExport.googleDrive.waiting")}
              </>
            ) : (
              <>
                <CloudDownload className="mr-2 size-4" /> {t("importExport.googleDrive.chooseButton")}
              </>
            )}
          </Button>
        </div>
      )}

      {stage.kind === "summary" && (
        <div className="space-y-3">
          <div>
            <h4 className="text-sm font-medium">
              {t("importExport.googleDrive.willImportCount", { count: stage.plan.accepted.length })}
            </h4>
            <ul className="mt-1 max-h-40 overflow-y-auto text-sm text-muted-foreground">
              {stage.plan.accepted.map((task) => (
                <li key={task.id}>{task.name}</li>
              ))}
            </ul>
          </div>
          {stage.plan.skipped.length > 0 && (
            <div role="alert">
              <h4 className="flex items-center gap-1.5 text-sm font-medium text-amber-600 dark:text-amber-400">
                <AlertTriangle className="size-4" />{" "}
                {t("importExport.googleDrive.skippedCount", { count: stage.plan.skipped.length })}
              </h4>
              <ul className="mt-1 max-h-40 overflow-y-auto text-sm text-muted-foreground">
                {stage.plan.skipped.map((s) => (
                  <li key={s.name}>
                    <span className="font-medium">{s.name}</span> — {s.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex gap-2">
            <Button onClick={confirm} disabled={stage.plan.accepted.length === 0}>
              {t("importExport.googleDrive.importButton", { count: stage.plan.accepted.length })}
            </Button>
            <Button variant="outline" onClick={() => setStage({ kind: "idle" })}>
              {t("common.back")}
            </Button>
          </div>
        </div>
      )}

      {stage.kind === "downloading" && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t("importExport.googleDrive.downloadingProgress", { done: stage.done, total: stage.total })}
        </p>
      )}
    </div>
  )
}
