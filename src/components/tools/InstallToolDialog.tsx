/**
 * Install = approve the standing grant once. Reads are pre-checked; writes
 * start unchecked so the tool asks the first time it needs them. Scopes above
 * the user's role cannot be granted at all.
 */

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useT } from "@/lib/i18n/I18nProvider"
import { grantableAtInstall } from "@/lib/tools/permissions"
import type { ToolManifest, ToolScope } from "../../../shared/tools/manifest"
import { useScopeLabel } from "./scope-label"

export function InstallToolDialog({
  manifest,
  roleLevel,
  busy,
  onInstall,
  onCancel,
}: {
  manifest: ToolManifest
  roleLevel: number | null
  busy: boolean
  onInstall: (grant: ToolScope[]) => void
  onCancel: () => void
}) {
  const t = useT()
  const scopeLabel = useScopeLabel()
  const { grantable, blocked } = grantableAtInstall(manifest.scopes, roleLevel)
  const [checked, setChecked] = useState<Set<ToolScope>>(() => new Set(grantable.filter((s) => s.startsWith("read:"))))

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onCancel() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("tools.installDialog.title", { name: manifest.name })}</DialogTitle>
          <DialogDescription>{t("tools.installDialog.body")}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <ul className="space-y-2">
            {grantable.map((scope) => (
              <li key={scope}>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={checked.has(scope)}
                    onCheckedChange={(on) =>
                      setChecked((prev) => {
                        const next = new Set(prev)
                        if (on) next.add(scope)
                        else next.delete(scope)
                        return next
                      })
                    }
                  />
                  {scopeLabel(scope)}
                </label>
              </li>
            ))}
            {blocked.map((scope) => (
              <li key={scope} className="flex items-center gap-2 text-sm text-muted-foreground">
                <Checkbox checked={false} disabled />
                {scopeLabel(scope)} · {t("tools.installDialog.blocked")}
              </li>
            ))}
          </ul>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => onInstall([...checked])} disabled={busy}>
            {t("tools.install")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
