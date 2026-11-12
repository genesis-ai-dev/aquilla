// Workspace-header badge on a project that mirrors a Paratext project (desktop
// only). Opens a panel with "Write to Paratext", the clobber hold, and any
// write refusals; conflicts open the shared mine-or-theirs dialog. Renders
// nothing in the browser, on an unlinked project, or on a file that is not a
// mirrored book. Mounting it is what keeps the file following Paratext.

import { Save } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "@/components/ui/toast"
import { useT } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"
import { useParatextMirror, type MirrorHost } from "@/lib/paratext-bridge/use-paratext-mirror"
import { ParatextConflictDialog } from "./ParatextConflictDialog"

export function ParatextBridgeBadge(host: MirrorHost) {
  const t = useT()
  const [m, act] = useParatextMirror(host)
  if (!m.link || !m.book) return null

  const doWrite = async (allowMarkerChanges?: Set<string>) => {
    const r = await act.write({ allowMarkerChanges })
    if ("refused" in r) {
      const reason = r.refused.startsWith("proof:")
        ? t("paratextBridge.book.refused.proof", { details: r.refused.slice(6) })
        : r.refused === "hash" ? t("paratextBridge.book.refused.hash")
        : r.refused === "hold" ? t("paratextBridge.book.onHold")
        : r.refused
      toast.add({ type: "error", title: t("paratextBridge.book.refused", { reason }) })
    } else if (r.written > 0) {
      toast.add({ type: "success", title: t("paratextBridge.book.written", { count: r.written, file: r.file }), description: t("paratextBridge.book.backup") })
    } else {
      toast.add({ type: "info", title: t("paratextBridge.book.nothingToWrite") })
    }
  }

  const busy = m.busy !== null
  const hasPending = m.pending > 0
  const badgeLabel = t("paratextBridge.mirror.badge", { book: m.book.code })
  const pendingLabel = t("paratextBridge.book.pending", { count: m.pending })
  return (
    <>
      <Popover>
        {/* Same outline icon button as the header's Settings cog; the dot says
            this file has edits the Paratext file does not hold yet. */}
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="relative bg-card shadow-xs"
              aria-label={hasPending ? `${t("paratextBridge.mirror.badgeAria")}: ${pendingLabel}` : t("paratextBridge.mirror.badgeAria")}
              title={hasPending ? pendingLabel : badgeLabel}
              data-testid="paratext-badge"
              data-pending={m.pending}
            />
          }
        >
          {busy ? <Spinner className="h-4 w-4" /> : <Save className="h-4 w-4" aria-hidden />}
          {hasPending ? (
            <span
              aria-hidden
              data-testid="paratext-unsaved-dot"
              className="absolute -top-1 -end-1 size-2.5 rounded-full bg-primary ring-2 ring-background"
            />
          ) : null}
        </PopoverTrigger>
        <PopoverContent align="end" side="bottom" sideOffset={6} className="w-80 space-y-3 p-3 text-sm">
          <PopoverHeader>
            <PopoverTitle>{t("paratextBridge.mirror.title")}</PopoverTitle>
            <PopoverDescription>{t("paratextBridge.mirror.description", { file: m.book.fileName })}</PopoverDescription>
          </PopoverHeader>
          {m.onHold ? (
            <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2">
              <p>{t("paratextBridge.book.onHold")}</p>
              <Button size="sm" variant="outline" onClick={() => void act.releaseHold()}>{t("paratextBridge.book.releaseHold")}</Button>
            </div>
          ) : null}
          {hasPending ? <p className="font-medium" data-testid="paratext-pending">{pendingLabel}</p> : null}
          {m.unmapped > 0 ? <p className="text-muted-foreground">{t("paratextBridge.mirror.unmapped", { count: m.unmapped })}</p> : null}
          {m.refusals.length > 0 ? (
            <div className="space-y-2 rounded-md border border-border p-2">
              {m.refusals.map((r) => (
                <div key={r.unitId} className="flex flex-wrap items-center gap-2">
                  <code className="text-xs">{r.unitId}</code>
                  <span>{r.reason === "marker-integrity" ? t("paratextBridge.book.conflict.markers") : r.reason === "unit-missing" ? t("paratextBridge.book.conflict.missing") : t("paratextBridge.book.refused.hash")}</span>
                  {r.reason === "marker-integrity" ? (
                    <Button size="sm" variant="outline" onClick={() => void doWrite(new Set([r.unitId]))}>{t("paratextBridge.book.conflict.allowMarkers")}</Button>
                  ) : null}
                </div>
              ))}
              <Button size="sm" variant="ghost" onClick={act.dismissRefusals}>{t("common.dismiss" as MessageKey)}</Button>
            </div>
          ) : null}
          {m.error ? <p className="text-destructive">{m.error}</p> : null}
          <Button size="sm" className="w-full" onClick={() => void doWrite()} disabled={busy || m.onHold} data-testid="paratext-write">
            {m.busy === "write" ? <Spinner /> : <Save />}
            {m.busy === "write" ? t("paratextBridge.book.writing") : t("paratextBridge.book.write")}
          </Button>
        </PopoverContent>
      </Popover>
      <ParatextConflictDialog
        conflicts={m.conflicts}
        onResolve={(id, choice) => void act.resolve(id, choice)}
        onResolveAll={(choice) => void act.resolveAll(choice)}
      />
    </>
  )
}
