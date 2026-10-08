/**
 * Smart Extensions sharing: copy an extension into another project as an
 * OWNED copy (origin "copy", upstream_tool_id → the original, same code hash,
 * no grants), and the code-review stub a copy shows until someone has read it.
 */

import { useEffect, useState } from "react"
import { Copy, FileCode2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useT } from "@/lib/i18n/I18nProvider"
import { fetchProjectList } from "@/lib/sync/projects-read"
import { copyTool, fetchToolSource, type ToolSummary } from "@/lib/tools/tools-api"

export function CopyExtension({ projectId, tool, jwt }: { projectId: string; tool: ToolSummary; jwt: string }) {
  const t = useT()
  const [projects, setProjects] = useState<{ id: string; name: string }[] | null>(null)
  const [target, setTarget] = useState("")
  const [status, setStatus] = useState<string | null>(null)

  useEffect(() => {
    if (projects !== null) return
    let cancelled = false
    fetchProjectList(jwt)
      .then((list) => {
        if (!cancelled) setProjects(list.filter((p) => p.id !== projectId).map((p) => ({ id: p.id, name: p.name })))
      })
      .catch(() => {
        if (!cancelled) setProjects([])
      })
    return () => {
      cancelled = true
    }
  }, [jwt, projectId, projects])

  if (!projects || projects.length === 0) return null
  return (
    <span className="inline-flex items-center gap-1">
      <select
        aria-label={t("extensions.copy.pick")}
        className="rounded border bg-background px-1 py-0.5 text-xs"
        value={target}
        onChange={(e) => setTarget(e.target.value)}
      >
        <option value="">{t("extensions.copy.pick")}</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <Button
        size="xs"
        variant="outline"
        disabled={!target}
        onClick={() => {
          const name = projects.find((p) => p.id === target)?.name ?? target
          void copyTool(jwt, projectId, tool.id, target)
            .then(() => setStatus(t("extensions.copy.done", { project: name })))
            .catch((err: unknown) => setStatus(err instanceof Error ? err.message : String(err)))
        }}
      >
        <Copy className="size-3" aria-hidden />
        {t("extensions.copy.button")}
      </Button>
      {status && <span role="status" className="text-xs text-muted-foreground">{status}</span>}
    </span>
  )
}

export function ReviewCopiedExtension({ projectId, tool, jwt }: { projectId: string; tool: ToolSummary; jwt: string }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [source, setSource] = useState<string | null>(null)
  if (!tool.upstreamToolId) return null
  const show = () => {
    setOpen(true)
    if (source === null) {
      void fetchToolSource(jwt, projectId, tool.id)
        .then((s) => setSource(s.source))
        .catch((err: unknown) => setSource(err instanceof Error ? err.message : String(err)))
    }
  }
  return (
    <>
      <Badge variant="outline" className="gap-1 text-amber-700">
        {t("extensions.review.badge")}
      </Badge>
      <Button size="xs" variant="ghost" onClick={show}>
        <FileCode2 className="size-3" aria-hidden />
        {t("extensions.review.button")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t("extensions.review.title", { name: tool.name })}</DialogTitle>
            <DialogDescription>{t("extensions.review.note")}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <p className="mb-2 font-mono text-xs">{t("extensions.review.hash", { hash: tool.codeHash })}</p>
            <pre className="max-h-[60vh] overflow-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap">{source ?? "…"}</pre>
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  )
}
