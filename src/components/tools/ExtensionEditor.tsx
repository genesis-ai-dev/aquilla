/**
 * Smart Extensions: custom editors. An extension whose manifest declares the
 * `editor` mount can REPLACE the standard editor for a file — a full
 * alternative editing surface with the same read/write power through the
 * bridge, live-updated as others edit. The switcher sits above whichever
 * editor is showing; the choice is remembered per user, project and file
 * (or project-wide), see src/lib/tools/editor-choice.ts.
 */

import { EditWithMenu } from "./EditWithMenu"
import { useCallback, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref } from "react"
import type { EditorTableHandle } from "@/components/EditorTable"
import type { ToolFrameControl } from "./useToolHost"
import { Button } from "@/components/ui/button"
import { NoteOnClick } from "@/components/ui/info-note"
import type { ToolHostServices } from "@/lib/tools/live-data"
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
  /** The editor every file of this project opens with for this user (their
   *  "Set as default for this project", else the default editor extension,
   *  else the native one). Marked "Default" in the Edit with menu. */
  projectDefault: string
  /** The extension editor failed to load (load error, blank render, or an
   *  error before it drew anything): the native editor stands in for it this
   *  session. Reported by the surface; `retry` clears it. */
  failure: { toolId: string; name: string; reason: string } | null
  reportFailure: (toolId: string, reason: string) => void
  retry: () => void
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
  const [failures, setFailures] = useState<ReadonlyMap<string, string>>(() => new Map())
  const failedIds = useMemo(() => new Set(failures.keys()), [failures])
  const selected = fileId ? resolveEditor(state, fileId, editors.map((e) => e.id), failedIds) : STANDARD_EDITOR
  // What the user would have had without the failure (the failed editor).
  const intended = fileId && failedIds.size > 0 ? resolveEditor(state, fileId, editors.map((e) => e.id)) : null
  const failure = intended && failures.has(intended)
    ? { toolId: intended, name: editors.find((e) => e.id === intended)?.name ?? intended, reason: failures.get(intended) ?? "" }
    : null
  const reportFailure = useCallback((toolId: string, reason: string) => {
    console.warn(`[extensions] editor ${toolId} failed to load; using the original Aquilla editor:`, reason)
    setFailures((prev) => (prev.has(toolId) ? prev : new Map(prev).set(toolId, reason)))
  }, [])
  const retry = useCallback(() => setFailures(new Map()), [])
  const projectDefault = resolveEditor({ project: state.project, files: {} }, "", editors.map((e) => e.id), failedIds)
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
  // Native Aquilla editor is always the default, so there is no wait for
  // extensions before rendering the editor unless the user explicitly saved a
  // custom extension editor for this file or project.
  const savedCustom = Boolean(fileId && ((state.files[fileId] && state.files[fileId] !== STANDARD_EDITOR) || (!state.files[fileId] && state.project && state.project !== STANDARD_EDITOR)))
  const pending = Boolean(savedCustom && ctx?.session && !ctx.toolsReady)
  return { editors, selected, choose, pending, projectDefault, failure, reportFailure, retry }
}

/** The "Edit with" menu above the editor (EditWithMenu.tsx). */
export function ExtensionEditorSwitcher({ choice, fileId }: { choice: ExtensionEditorChoice; fileId?: string | null }) {
  return <EditWithMenu choice={choice} fileId={fileId} />
}

/** The extension editor failed to load, so the original editor is open. */
export function ExtensionEditorFallbackNotice({ choice }: { choice: ExtensionEditorChoice }) {
  const t = useT()
  if (!choice.failure) return null
  return (
    <div role="status" data-testid="extension-editor-fallback" className="flex items-center gap-2 border-b bg-amber-50 px-3 py-1.5 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
      {/* AQU-2260: why it failed opens on click, not as a hover title. */}
      <NoteOnClick note={choice.failure.reason} className="min-w-0 flex-1" align="start">
        <span className="min-w-0 truncate">{t("extensions.editor.fallback", { name: choice.failure.name })}</span>
      </NoteOnClick>
      <Button size="xs" variant="ghost" onClick={choice.retry}>{t("common.retry")}</Button>
    </div>
  )
}

export function ExtensionEditorSurface({
  choice,
  file,
  bar,
  services,
  revealCellId,
  toolbarTrailing,
  handleRef,
}: {
  choice: ExtensionEditorChoice
  file: { fileId: string; name: string }
  /** The extensions bar (switcher, pins, palette) shown above the editor. */
  bar: ReactNode
  /** apiRev 2: the workspace's live focus locks, comments, … for this file. */
  services?: ToolHostServices
  /** apiRev 2: a deep-linked cell (?cellId=) to show. */
  revealCellId?: string | null
  /** apiRev 3: the workspace's file toolbar (lens switch, view settings, file
   *  options), drawn by the host over the extension's chapter row — the same
   *  component the built-in editor shows there. */
  toolbarTrailing?: ReactNode
  /** The workspace's EditorTable handle, served by the extension instead
   *  (timeline chips, search results, cue drawers scroll it the same way). */
  handleRef?: Ref<EditorTableHandle | null>
}) {
  const controlRef = useRef<ToolFrameControl | null>(null)
  const ids = services?.editor?.store
  useImperativeHandle(handleRef, () => {
    const reveal = (cellId: string, focus: boolean) => {
      controlRef.current?.push({ type: "editor.reveal", fileId: file.fileId, cellId, focus })
      return Boolean(controlRef.current)
    }
    return {
      scrollToCellId: (cellId) => reveal(cellId, false),
      setMediaFollow: () => {},
      focusCellEditorIndex: (index) => {
        const id = ids?.getCellIds()[index]
        if (id) reveal(id, true)
      },
      focusCellEditorId: (cellId) => reveal(cellId, true),
      getCurrentIndex: () => -1,
      // AQU-2153: the host cannot see inside the extension's own list, so a
      // lens switch has no row to remember and the view opens at the top, as
      // it did before. apiRev would have to carry it for a resume to work.
      getTopVisibleCellId: () => null,
      flashCell: (cellId) => {
        reveal(cellId, false)
      },
      pulseCells: (cellIds) => {
        if (cellIds[0]) reveal(cellIds[0], false)
      },
    }
  }, [file.fileId, ids])
  return (
    <div className="flex h-full min-h-0 w-full flex-col" data-testid="extension-editor-surface">
      {bar}
      <MountedTool
        key={`${choice.selected}:${file.fileId}`}
        toolId={choice.selected}
        mount="editor"
        file={file}
        className="flex min-h-0 flex-1 flex-col"
        {...(services ? { services } : {})}
        {...(revealCellId !== undefined ? { revealCellId } : {})}
        {...(toolbarTrailing ? { frameOverlay: toolbarTrailing } : {})}
        controlRef={controlRef}
        // The original editor is the fallback whenever the extension fails to load.
        onFailure={(reason) => choice.reportFailure(choice.selected, reason)}
      />
    </div>
  )
}
