/**
 * Aquilla Tools panel + inline mounts.
 *
 * - ToolsDockPanel: the editor's left-dock "Tools" tab; mounts any tool whose
 *   manifest lists the `panel` mount, beside the editor.
 * - InlineToolsTab: a cell-expansion tab; mounts an `inline` tool under one
 *   cell, which the tool receives as `aquilla.context.cell`.
 */

import { useState } from "react"
import { Link } from "react-router-dom"
import { ExternalLink, Settings2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { useProject } from "@/hooks/useProject"
import { useT } from "@/lib/i18n/I18nProvider"
import type { ToolSummary } from "@/lib/tools/tools-api"
import type { ToolMount } from "../../../shared/tools/manifest"
import { ToolFrame } from "./ToolFrame"
import { useMountedTool, useToolsMount } from "./ToolsMountContext"
import { useEditTool } from "./useEditTool"

function toolsFor(tools: ToolSummary[], mount: ToolMount): ToolSummary[] {
  return tools.filter((t) => t.manifest.mounts.includes(mount))
}

export function MountedTool({
  toolId,
  mount,
  cell,
  file,
  className,
}: {
  toolId: string
  mount: "panel" | "inline" | "editor"
  cell?: { fileId: string; cellId: string }
  file?: { fileId: string; name: string }
  className?: string
}) {
  const ctx = useToolsMount()
  const { project, roleLevel } = useProject(ctx?.projectId ?? "")
  const { tool, error } = useMountedTool(toolId)
  const edit = useEditTool(ctx?.projectId ?? "", ctx?.session?.jwt ?? null)
  if (error) return <p role="alert" className="p-2 text-xs text-destructive">{error}</p>
  if (!ctx?.session || !tool || !project) return <Spinner className="m-3" />
  return (
    <ToolFrame
      project={{ id: project.id, name: project.name }}
      tool={tool}
      session={ctx.session}
      roleLevel={roleLevel ?? null}
      mount={mount}
      {...(cell ? { cell } : {})}
      {...(file ? { file } : {})}
      onGrantChange={() => ctx.refresh()}
      onHeal={(request) => {
        void edit.run(tool, request).then((next) => {
          if (next) ctx.refresh()
        })
      }}
      healing={edit.busy}
      className={className}
    />
  )
}

function ToolPicker({ tools, value, onChange }: { tools: ToolSummary[]; value: string | null; onChange: (id: string) => void }) {
  const t = useT()
  return (
    <select
      aria-label={t("extensions.dock.pick")}
      className="min-w-0 flex-1 rounded border bg-background px-1.5 py-1 text-xs"
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
    >
      {tools.map((tool) => (
        <option key={tool.id} value={tool.id}>
          {tool.name}
        </option>
      ))}
    </select>
  )
}

export function ToolsDockPanel() {
  const t = useT()
  const ctx = useToolsMount()
  const panelTools = toolsFor(ctx?.tools ?? [], "panel")
  const picked = ctx?.dockSelection ?? null
  const setPicked = (id: string) => ctx?.setDockSelection(id)
  const selected = panelTools.find((tool) => tool.id === picked)?.id ?? panelTools[0]?.id ?? null
  if (!ctx) return null
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="tools-dock-panel">
      <div className="flex items-center gap-1 border-b p-2">
        {panelTools.length > 0 && <ToolPicker tools={panelTools} value={selected} onChange={setPicked} />}
        {selected && (
          <Button size="icon-xs" variant="ghost" aria-label={t("extensions.open")} render={<Link to={`/project/${ctx.projectId}/extensions/${selected}`} />}>
            <ExternalLink className="size-3.5" />
          </Button>
        )}
        <Button size="icon-xs" variant="ghost" aria-label={t("extensions.dock.manage")} render={<Link to={`/project/${ctx.projectId}/extensions`} />}>
          <Settings2 className="size-3.5" />
        </Button>
      </div>
      {selected ? (
        <MountedTool key={selected} toolId={selected} mount="panel" className="flex min-h-0 flex-1 flex-col" />
      ) : (
        <p className="p-3 text-xs text-muted-foreground">{t("extensions.dock.empty")}</p>
      )}
    </div>
  )
}

export function InlineToolsTab({ fileId, cellId }: { fileId: string; cellId: string }) {
  const t = useT()
  const ctx = useToolsMount()
  const inlineTools = toolsFor(ctx?.tools ?? [], "inline")
  const [picked, setPicked] = useState<string | null>(null)
  const selected = inlineTools.find((tool) => tool.id === picked)?.id ?? inlineTools[0]?.id ?? null
  if (!selected) return <p className="text-xs text-muted-foreground">{t("extensions.inline.empty")}</p>
  return (
    <div className="flex flex-col gap-2" data-testid="tools-inline-tab">
      {inlineTools.length > 1 && <ToolPicker tools={inlineTools} value={selected} onChange={setPicked} />}
      <MountedTool key={`${selected}:${cellId}`} toolId={selected} mount="inline" cell={{ fileId, cellId }} className="flex h-72 flex-col overflow-hidden rounded border" />
    </div>
  )
}

/** Whether the inline tab should be offered at all (keeps rows unchanged for
 *  projects with no inline tool). */
export function useHasInlineTools(): boolean {
  const ctx = useToolsMount()
  return (ctx?.tools ?? []).some((t) => t.manifest.mounts.includes("inline"))
}
