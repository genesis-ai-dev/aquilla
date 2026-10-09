/**
 * Mounts one tool in a sandboxed iframe: `sandbox="allow-scripts allow-forms"` (no
 * allow-same-origin → opaque origin), srcdoc carrying a no-network CSP, the
 * bridge runtime and the app theme. See src/lib/tools/srcdoc.ts for the
 * production hosting plan (dedicated tools origin).
 */

import { useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from "react"
import { AlertTriangle, Wand2, X } from "lucide-react"
import { isToolStale, rebuildRequest } from "../../../shared/tools/api-rev"
import { healRequest } from "./useEditTool"
import { Button } from "@/components/ui/button"
import { useT } from "@/lib/i18n/I18nProvider"
import type { FrontierSession } from "@/lib/frontier/types"
import { TOOL_SANDBOX, buildToolSrcdoc, readThemeVars } from "@/lib/tools/srcdoc"
import type { ToolDetail } from "@/lib/tools/tools-api"
import type { ToolScope } from "../../../shared/tools/manifest"
import { PermissionPrompt } from "./PermissionPrompt"
import type { ToolHostServices } from "@/lib/tools/live-data"
import { HOST_SHORTCUTS } from "@/lib/tools/host-keys"
import { useToolHost, type ToolFrameControl } from "./useToolHost"

export interface ToolFrameProps {
  project: { id: string; name: string }
  tool: ToolDetail
  session: FrontierSession
  roleLevel: number | null
  mount?: "page" | "panel" | "inline" | "editor"
  /** Editor mounts: the file being edited. */
  file?: { fileId: string; name: string }
  /** Inline mounts: the cell this tool sits under. */
  cell?: { fileId: string; cellId: string }
  onGrantChange?: (scopes: ToolScope[]) => void
  /** "Heal it" / "Rebuild": run edit_tool with this request (see useEditTool). */
  onHeal?: (request: string) => void
  healing?: boolean
  className?: string
  /** apiRev 2: workspace services (editor mounts: presence, comments). */
  services?: ToolHostServices
  /** apiRev 2: deep-linked cell to show (initial + live). */
  revealCellId?: string | null
  /** apiRev 3: host chrome drawn over the frame's top-right corner (the
   *  editor's own file toolbar). Its size is pushed to the extension as
   *  `editor.chrome` so the extension keeps that corner clear. */
  frameOverlay?: ReactNode
  /** apiRev 3: host → frame commands (the editor handle adapter). */
  controlRef?: MutableRefObject<ToolFrameControl | null>
}

export function ToolFrame({ project, tool, session, roleLevel, mount = "page", cell, file, onGrantChange, onHeal, healing = false, className, services, revealCellId = null, frameOverlay, controlRef }: ToolFrameProps) {
  const t = useT()
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const [chrome, setChrome] = useState<{ trailingWidth: number; trailingHeight: number } | null>(null)
  useEffect(() => {
    const el = overlayRef.current
    if (!el || typeof ResizeObserver === "undefined") return
    const measure = () => setChrome({ trailingWidth: Math.ceil(el.offsetWidth), trailingHeight: Math.ceil(el.offsetHeight) })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [frameOverlay])
  const { prompt, errors, clearErrors, removedApi, messages, dismissMessage, blank } = useToolHost({ frameRef, projectId: project.id, tool, session, roleLevel, onGrantChange, services, revealCellId, chrome, controlRef })
  // The first reveal rides in the boot data (so the editor opens there); later
  // ones are pushed live. Read once per frame load.
  const [initialReveal] = useState(revealCellId)

  // Built once per tool version: re-rendering the srcdoc would reload the tool.
  const srcdoc = useMemo(
    () =>
      buildToolSrcdoc(tool.source, {
        tool: { id: tool.id, name: tool.name, version: tool.currentVersion, scopes: tool.manifest.scopes },
        project: { id: project.id, name: project.name },
        user: { username: session.username, roleLevel },
        mount,
        ...(cell ? { cell } : {}),
        ...(file ? { file: { ...file, revealCellId: initialReveal } } : {}),
        theme: readThemeVars(),
        hostShortcuts: HOST_SHORTCUTS,
      }, { sdk: tool.manifest.sdk }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload only on a new version, not on role/theme changes (pushed live)
    [tool.id, tool.currentVersion, tool.source, tool.manifest.sdk, project.id, cell?.fileId, cell?.cellId, file?.fileId],
  )

  return (
    <div className={className ?? "flex h-full min-h-0 flex-col"} data-testid="tool-frame" data-tool-id={tool.id}>
      {prompt && <PermissionPrompt toolName={tool.name} prompt={prompt} />}
      {(isToolStale(tool.apiRev) || removedApi) && (
        <div role="alert" className="flex flex-wrap items-center gap-2 border-b bg-amber-50 px-4 py-2 text-sm dark:bg-amber-950/40" data-testid="extension-stale">
          <span className="min-w-0 flex-1">{t("extensions.stale.message")}</span>
          {onHeal && (
            <Button size="sm" variant="outline" disabled={healing} onClick={() => onHeal(rebuildRequest(tool.apiRev, removedApi ?? undefined))}>
              <Wand2 className="size-3.5" aria-hidden />
              {healing ? t("extensions.heal.running") : t("extensions.stale.rebuild")}
            </Button>
          )}
        </div>
      )}
      {blank && errors.length === 0 && !prompt && (
        <div role="status" className="flex items-center gap-2 border-b bg-muted/40 px-4 py-2 text-sm" data-testid="extension-blank">
          <span className="min-w-0 flex-1 text-muted-foreground">{t("extensions.frame.blank")}</span>
          {onHeal && (
            <Button size="xs" variant="outline" disabled={healing} onClick={() => onHeal(healRequest(`It renders nothing on screen in the "${mount}" mount: the page stays blank. Always show the UI (heading, data or an empty state).`))}>
              <Wand2 className="size-3" aria-hidden />
              {healing ? t("extensions.heal.running") : t("extensions.heal.button")}
            </Button>
          )}
        </div>
      )}
      {messages.map((m, i) => (
        <div key={`${i}:${m}`} role="status" className="flex items-start gap-2 border-b bg-sky-50 px-4 py-2 text-sm dark:bg-sky-950/40" data-testid="extension-message">
          <span className="min-w-0 flex-1 break-words">
            <span className="font-medium">{t("extensions.tell.label", { name: tool.name })}: </span>
            {m}
          </span>
          <Button size="icon-xs" variant="ghost" onClick={() => dismissMessage(i)} aria-label={t("common.dismiss")}>
            <X className="size-3.5" />
          </Button>
        </div>
      ))}
      {errors.length > 0 && (
        <div role="alert" className="flex items-start gap-2 border-b bg-destructive/10 px-4 py-2 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 break-words">{t("extensions.frame.error", { message: errors[errors.length - 1].message })}</span>
          {onHeal && (
            <Button size="xs" variant="outline" disabled={healing} onClick={() => onHeal(healRequest(errors[errors.length - 1].message))}>
              <Wand2 className="size-3" aria-hidden />
              {healing ? t("extensions.heal.running") : t("extensions.heal.button")}
            </Button>
          )}
          <Button size="icon-xs" variant="ghost" onClick={clearErrors} aria-label={t("common.dismiss")}>
            <X className="size-3.5" />
          </Button>
        </div>
      )}
      <div className="relative flex min-h-0 w-full flex-1 flex-col">
        <iframe
          ref={frameRef}
          title={t("extensions.frame.title", { name: tool.name })}
          sandbox={TOOL_SANDBOX}
          referrerPolicy="no-referrer"
          srcDoc={srcdoc}
          className="min-h-0 w-full flex-1 border-0 bg-background"
        />
        {frameOverlay && (
          <div
            ref={overlayRef}
            data-testid="extension-frame-chrome"
            className="absolute end-0 top-0 z-10 flex h-12 items-center pe-2"
          >
            {frameOverlay}
          </div>
        )}
      </div>
    </div>
  )
}
