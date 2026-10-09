/**
 * Smart Extensions: custom editors. An extension whose manifest declares the
 * `editor` mount can REPLACE the standard editor for a file — a full
 * alternative editing surface with the same read/write power through the
 * bridge, live-updated as others edit. The switcher sits above whichever
 * editor is showing; the choice is remembered per user, project and file
 * (or project-wide), see src/lib/tools/editor-choice.ts.
 */

import { useCallback, useMemo, useState, type ReactNode } from "react"
import { Link } from "react-router-dom"
import { ShieldCheck } from "lucide-react"
import type { ToolHostServices } from "@/lib/tools/live-data"
import { useScopeLabel } from "./scope-label"
import { useT } from "@/lib/i18n/I18nProvider"
import {
  STANDARD_EDITOR,
  chooseEditor,
  readEditorChoice,
  resolveEditor,
  writeEditorChoice,
} from "@/lib/tools/editor-choice"
import type { ToolSummary } from "@/lib/tools/tools-api"
import { MountedTool } from "./ToolMounts"
import { useToolsMount } from "./ToolsMountContext"

export interface ExtensionEditorChoice {
  editors: ToolSummary[]
  /** STANDARD_EDITOR or an extension id. */
  selected: string
  choose: (editorId: string, wholeProject: boolean) => void
  /** The default may be an extension but the project's extensions have not
   *  loaded yet: show a placeholder, not a flash of the built-in editor. */
  pending: boolean
}

export function useExtensionEditorChoice(username: string, projectId: string, fileId: string | null): ExtensionEditorChoice {
  const ctx = useToolsMount()
  const editors = useMemo(() => (ctx?.tools ?? []).filter((t) => t.manifest.mounts.includes("editor")), [ctx?.tools])
  const [state, setState] = useState(() => readEditorChoice(username, projectId))
  const [stateKey, setStateKey] = useState(`${username}:${projectId}`)
  // Re-read on a project/user switch (render-time reset, no effect needed).
  if (stateKey !== `${username}:${projectId}`) {
    setStateKey(`${username}:${projectId}`)
    setState(readEditorChoice(username, projectId))
  }
  const selected = fileId ? resolveEditor(state, fileId, editors.map((e) => e.id), ctx?.defaultEditorId ?? null) : STANDARD_EDITOR
  const choose = useCallback(
    (editorId: string, wholeProject: boolean) => {
      if (!fileId) return
      setState((prev) => {
        const next = chooseEditor(prev, fileId, editorId, wholeProject)
        writeEditorChoice(username, projectId, next)
        return next
      })
    },
    [fileId, username, projectId],
  )
  const explicitStandard = fileId ? (state.files[fileId] ?? state.project) === STANDARD_EDITOR : false
  const pending = Boolean(fileId && ctx?.defaultEditorEnabled && ctx.session && !ctx.toolsReady && !explicitStandard)
  return { editors, selected, choose, pending }
}

export function ExtensionEditorSwitcher({ choice }: { choice: ExtensionEditorChoice }) {
  const t = useT()
  const [wholeProject, setWholeProject] = useState(false)
  if (choice.editors.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="extension-editor-switcher">
      <label className="flex items-center gap-2">
        <span className="text-muted-foreground">{t("extensions.editor.label")}</span>
        <select
          aria-label={t("extensions.editor.label")}
          className="rounded border bg-background px-1.5 py-0.5"
          value={choice.selected}
          onChange={(e) => choice.choose(e.target.value, wholeProject)}
        >
          <option value={STANDARD_EDITOR}>{t("extensions.editor.standard")}</option>
          {choice.editors.map((ed) => (
            <option key={ed.id} value={ed.id}>
              {ed.firstParty ? t("extensions.editor.firstPartyOption", { name: ed.name }) : ed.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1 text-muted-foreground">
        <input type="checkbox" checked={wholeProject} onChange={(e) => setWholeProject(e.target.checked)} />
        {t("extensions.editor.wholeProject")}
      </label>
    </div>
  )
}

export function ExtensionEditorSurface({
  choice,
  file,
  bar,
  services,
  revealCellId,
}: {
  choice: ExtensionEditorChoice
  file: { fileId: string; name: string }
  /** The extensions bar (switcher, pins, palette) shown above the editor. */
  bar: ReactNode
  /** apiRev 2: the workspace's live focus locks, comments, … for this file. */
  services?: ToolHostServices
  /** apiRev 2: a deep-linked cell (?cellId=) to show. */
  revealCellId?: string | null
}) {
  return (
    <div className="flex h-full min-h-0 w-full flex-col" data-testid="extension-editor-surface">
      {bar}
      <FirstPartyNotice toolId={choice.selected} />
      <MountedTool
        key={`${choice.selected}:${file.fileId}`}
        toolId={choice.selected}
        mount="editor"
        file={file}
        className="flex min-h-0 flex-1 flex-col"
        {...(services ? { services } : {})}
        {...(revealCellId !== undefined ? { revealCellId } : {})}
      />
    </div>
  )
}

/** Explicit, visible auto-grant: a first-party extension is granted its
 *  scopes without the install dialog, so the editor says so (and links to
 *  where it can be revoked). */
function FirstPartyNotice({ toolId }: { toolId: string }) {
  const t = useT()
  const scopeLabel = useScopeLabel()
  const ctx = useToolsMount()
  const tool = ctx?.tools.find((x) => x.id === toolId)
  if (!ctx || !tool?.firstParty) return null
  const scopes = tool.grantedScopes.map(scopeLabel).join(", ")
  const fresh = ctx.autoGranted.length > 0
  return (
    <div
      className="flex items-start gap-2 border-b bg-muted/20 px-3 py-1 text-[11px] leading-4 text-muted-foreground"
      data-testid="first-party-notice"
      role="note"
    >
      <ShieldCheck className="mt-px size-3.5 shrink-0 text-emerald-600" aria-hidden />
      <p className="min-w-0 flex-1">
        {t(fresh ? "extensions.firstParty.autoGranted" : "extensions.firstParty.granted", {
          name: tool.name,
          scopes: scopes || t("extensions.firstParty.none"),
        })}{" "}
        <Link className="underline" to={`/project/${ctx.projectId}/extensions`}>
          {t("extensions.firstParty.manage")}
        </Link>
      </p>
    </div>
  )
}
