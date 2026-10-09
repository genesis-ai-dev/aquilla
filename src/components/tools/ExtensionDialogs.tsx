/**
 * The Smart Extensions page's secondary surfaces, each behind the row's "…"
 * menu: permissions (plain sentences with switches), activity + revert, copy
 * to another project, and the code review of a copied extension.
 */

import { useEffect, useState } from "react"
import { Copy } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Switch } from "@/components/ui/switch"
import { useT } from "@/lib/i18n/I18nProvider"
import { fetchProjectList } from "@/lib/sync/projects-read"
import { grantableAtInstall } from "@/lib/tools/permissions"
import { copyTool, fetchToolSource, type ToolSummary } from "@/lib/tools/tools-api"
import type { ToolScope } from "../../../shared/tools/manifest"
import { useScopeLabel } from "./scope-label"
import { ToolActivityPanel } from "./ToolActivityPanel"

/** "Can edit translations" — a scope as a short, plain sentence. */
export function useScopeSentence(): (scope: ToolScope) => string {
  const t = useT()
  const label = useScopeLabel()
  return (scope) => t("extensions.can", { scope: label(scope) })
}

export function PermissionsDialog({
  tool,
  roleLevel,
  onChange,
  onClose,
}: {
  tool: ToolSummary
  roleLevel: number | null
  onChange: (scopes: ToolScope[]) => Promise<void>
  onClose: () => void
}) {
  const t = useT()
  const sentence = useScopeSentence()
  const { grantable, blocked } = grantableAtInstall(tool.manifest.scopes, roleLevel)
  const [busy, setBusy] = useState(false)
  const toggle = async (scope: ToolScope, on: boolean) => {
    setBusy(true)
    try {
      await onChange(on ? [...new Set([...tool.grantedScopes, scope])] : tool.grantedScopes.filter((s) => s !== scope))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("extensions.permissions.title", { name: tool.name })}</DialogTitle>
          <DialogDescription>{t("extensions.permissions.hint")}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <ul className="divide-y rounded-lg border" data-testid="tool-grants">
            {grantable.map((scope) => (
              <li key={scope} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                <span className="min-w-0 flex-1" data-testid={tool.grantedScopes.includes(scope) ? "tool-grant" : "tool-ask"}>
                  {sentence(scope)}
                </span>
                <Switch
                  aria-label={sentence(scope)}
                  checked={tool.grantedScopes.includes(scope)}
                  disabled={busy}
                  onCheckedChange={(on) => void toggle(scope, on)}
                />
              </li>
            ))}
            {blocked.map((scope) => (
              <li key={scope} className="flex items-center gap-3 px-3 py-2.5 text-sm text-muted-foreground">
                <span className="min-w-0 flex-1">{sentence(scope)}</span>
                <span className="text-xs">{t("extensions.installDialog.blocked")}</span>
              </li>
            ))}
          </ul>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

export function ActivityDialog({ projectId, tool, jwt, author, onClose }: { projectId: string; tool: ToolSummary; jwt: string; author: string; onClose: () => void }) {
  const t = useT()
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("extensions.activity.title", { name: tool.name })}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <ToolActivityPanel projectId={projectId} tool={tool} jwt={jwt} author={author} />
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

export function CopyDialog({ projectId, tool, jwt, onClose }: { projectId: string; tool: ToolSummary; jwt: string; onClose: () => void }) {
  const t = useT()
  const [projects, setProjects] = useState<{ id: string; name: string }[] | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  useEffect(() => {
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
  }, [jwt, projectId])
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("extensions.copy.title", { name: tool.name })}</DialogTitle>
          <DialogDescription>{t("extensions.copy.hint")}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {projects === null ? null : projects.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("extensions.copy.none")}</p>
          ) : (
            <ul className="max-h-72 divide-y overflow-y-auto rounded-lg border">
              {projects.map((p) => (
                <li key={p.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => {
                      setBusy(p.id)
                      void copyTool(jwt, projectId, tool.id, p.id)
                        .then(() => setStatus(t("extensions.copy.done", { project: p.name })))
                        .catch((err: unknown) => setStatus(err instanceof Error ? err.message : String(err)))
                        .finally(() => setBusy(null))
                    }}
                  >
                    <Copy className="size-3" aria-hidden />
                    {t("extensions.copy.button")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {status && <p role="status" className="mt-2 text-sm text-muted-foreground">{status}</p>}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

export function ReviewCodeDialog({ projectId, tool, jwt, onClose }: { projectId: string; tool: ToolSummary; jwt: string; onClose: () => void }) {
  const t = useT()
  const [source, setSource] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    fetchToolSource(jwt, projectId, tool.id)
      .then((s) => {
        if (!cancelled) setSource(s.source)
      })
      .catch((err: unknown) => {
        if (!cancelled) setSource(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [jwt, projectId, tool.id])
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("extensions.review.title", { name: tool.name })}</DialogTitle>
          <DialogDescription>{t("extensions.review.note")}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <p className="mb-2 font-mono text-xs text-muted-foreground">{t("extensions.review.hash", { hash: tool.codeHash })}</p>
          <pre className="max-h-[60vh] overflow-auto rounded-lg bg-muted p-3 text-xs whitespace-pre-wrap">{source ?? "…"}</pre>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
