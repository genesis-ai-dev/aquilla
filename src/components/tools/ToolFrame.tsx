/**
 * Mounts one tool in a sandboxed iframe: `sandbox="allow-scripts allow-forms"` (no
 * allow-same-origin → opaque origin), srcdoc carrying a no-network CSP, the
 * bridge runtime and the app theme. See src/lib/tools/srcdoc.ts for the
 * production hosting plan (dedicated tools origin).
 */

import { useMemo, useRef } from "react"
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
import { useToolHost } from "./useToolHost"

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
}

export function ToolFrame({ project, tool, session, roleLevel, mount = "page", cell, file, onGrantChange, onHeal, healing = false, className }: ToolFrameProps) {
  const t = useT()
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const { prompt, errors, clearErrors, removedApi, messages, dismissMessage } = useToolHost({ frameRef, projectId: project.id, tool, session, roleLevel, onGrantChange })

  // Built once per tool version: re-rendering the srcdoc would reload the tool.
  const srcdoc = useMemo(
    () =>
      buildToolSrcdoc(tool.source, {
        tool: { id: tool.id, name: tool.name, version: tool.currentVersion },
        project: { id: project.id, name: project.name },
        user: { username: session.username, roleLevel },
        mount,
        ...(cell ? { cell } : {}),
        ...(file ? { file } : {}),
        theme: readThemeVars(),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload only on a new version, not on role/theme changes (pushed live)
    [tool.id, tool.currentVersion, tool.source, project.id, cell?.fileId, cell?.cellId, file?.fileId],
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
      <iframe
        ref={frameRef}
        title={t("extensions.frame.title", { name: tool.name })}
        sandbox={TOOL_SANDBOX}
        referrerPolicy="no-referrer"
        srcDoc={srcdoc}
        className="min-h-0 w-full flex-1 border-0 bg-background"
      />
    </div>
  )
}
