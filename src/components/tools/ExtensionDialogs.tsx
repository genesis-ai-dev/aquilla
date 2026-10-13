/**
 * An extension's secondary surfaces: permissions (plain sentences with
 * switches), changes + undo, copy to another project, and the code review of
 * a copied extension. Each body is exported on its own so the extension's
 * page can show it as a tab; the dialogs wrap them for the list's "…" menu.
 */

import { useEffect, useState } from "react"
import { Check, Copy, FolderOpen } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { useT } from "@/lib/i18n/I18nProvider"
import { fetchProjectList } from "@/lib/sync/projects-read"
import { grantableAtInstall } from "@/lib/tools/permissions"
import { copyTool, fetchToolSource, type ToolSummary } from "@/lib/tools/tools-api"
import type { ToolScope } from "../../../shared/tools/manifest"
import { useScopeLabel } from "./scope-label"
import { ToolActivityPanel } from "./ToolActivityPanel"
import { PERM, usePermLabel } from "./builder/ExtensionFacts"

/** "Can edit translations" — a scope as a short, plain sentence. */
export function useScopeSentence(): (scope: ToolScope) => string {
  const t = useT()
  const label = useScopeLabel()
  return (scope) => t("extensions.can", { scope: label(scope) })
}

/** The permission switches (dialog, and the page's Permissions tab). */
export function PermissionsList({
  tool,
  roleLevel,
  onChange,
}: {
  tool: ToolSummary
  roleLevel: number | null
  onChange: (scopes: ToolScope[]) => Promise<void>
}) {
  const t = useT()
  const permLabel = usePermLabel()
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
  if (grantable.length === 0 && blocked.length === 0) return <p className="text-sm text-muted-foreground">{t("extensions.perm.none")}</p>
  return (
    <ul className="divide-y overflow-hidden rounded-xl border bg-card dark:bg-transparent" data-testid="tool-grants">
      {grantable.map((scope) => {
        const on = tool.grantedScopes.includes(scope)
        const p = PERM[scope]
        return (
          <li key={scope} className="flex items-center gap-3 px-3.5 py-3 text-sm">
            <p.icon className={p.kind === "write" ? "size-4 shrink-0 text-amber-600 dark:text-amber-400" : "size-4 shrink-0 text-muted-foreground"} aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block font-medium" data-testid={on ? "tool-grant" : "tool-ask"}>{permLabel(scope, tool.manifest.web)}</span>
              {scope === "read:web" && <span className="block text-xs text-muted-foreground">{t("extensions.perm.webNote")}</span>}
              <span className={on ? "block text-xs text-emerald-700 dark:text-emerald-400" : "block text-xs text-muted-foreground"}>
                {on ? t("extensions.permissions.allowed") : t("extensions.permissions.asks")}
              </span>
            </span>
            <Switch aria-label={permLabel(scope, tool.manifest.web)} checked={on} disabled={busy} onCheckedChange={(next) => void toggle(scope, next)} />
          </li>
        )
      })}
      {blocked.map((scope) => (
        <li key={scope} className="flex items-center gap-3 px-3.5 py-3 text-sm text-muted-foreground">
          {(() => {
            const Icon = PERM[scope].icon
            return <Icon className="size-4 shrink-0" aria-hidden />
          })()}
          <span className="min-w-0 flex-1">{t(PERM[scope].label)}</span>
          <span className="text-xs">{t("extensions.installDialog.blocked")}</span>
        </li>
      ))}
    </ul>
  )
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
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="solid-primary max-w-md">
        <DialogHeader>
          <DialogTitle>{t("extensions.permissions.title", { name: tool.name })}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <PermissionsList tool={tool} roleLevel={roleLevel} onChange={onChange} />
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

export function ActivityDialog({ projectId, tool, jwt, author, onClose }: { projectId: string; tool: ToolSummary; jwt: string; author: string; onClose: () => void }) {
  const t = useT()
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="solid-primary sm:max-w-2xl">
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

/** Pick another project to copy an extension into (dialog, and the Share tab). */
export function CopyList({ projectId, tool, jwt }: { projectId: string; tool: ToolSummary; jwt: string }) {
  const t = useT()
  const [projects, setProjects] = useState<{ id: string; name: string }[] | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [done, setDone] = useState<string[]>([])
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
  if (projects === null) return <Spinner />
  if (projects.length === 0) return <p className="text-sm text-muted-foreground">{t("extensions.copy.none")}</p>
  const copy = (p: { id: string; name: string }) => {
    setBusy(p.id)
    void copyTool(jwt, projectId, tool.id, p.id)
      .then(() => {
        setDone((prev) => [...prev, p.id])
        setStatus(t("extensions.copy.done", { project: p.name }))
      })
      .catch((err: unknown) => setStatus(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(null))
  }
  return (
    <div className="flex flex-col gap-2">
      <ul className="max-h-72 divide-y overflow-y-auto rounded-xl border bg-card">
        {projects.map((p) => (
          <li key={p.id} className="flex items-center gap-3 px-3.5 py-2.5 text-sm">
            <FolderOpen className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0 flex-1 truncate">{p.name}</span>
            {done.includes(p.id) ? (
              <span className="inline-flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400">
                <Check className="size-3.5" aria-hidden />
                {t("extensions.copy.copied")}
              </span>
            ) : (
              <Button size="xs" variant="outline" disabled={busy !== null} onClick={() => copy(p)}>
                {busy === p.id ? <Spinner className="size-3" /> : <Copy className="size-3" aria-hidden />}
                {t("extensions.copy.button")}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {status && <p role="status" className="text-sm text-muted-foreground">{status}</p>}
    </div>
  )
}

export function CopyDialog({ projectId, tool, jwt, onClose }: { projectId: string; tool: ToolSummary; jwt: string; onClose: () => void }) {
  const t = useT()
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="solid-primary max-w-md">
        <DialogHeader>
          <DialogTitle>{t("extensions.copy.title", { name: tool.name })}</DialogTitle>
          <DialogDescription>{t("extensions.copy.hint")}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <CopyList projectId={projectId} tool={tool} jwt={jwt} />
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
      <DialogContent className="solid-primary sm:max-w-3xl">
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
