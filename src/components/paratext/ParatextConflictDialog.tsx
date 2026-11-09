import { Button } from "@/components/ui/button"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { useT } from "@/lib/i18n/I18nProvider"
import type { ClassifiedUnit } from "@/lib/paratext-bridge/classify"

/** Mine-or-theirs choice for units both Aquilla and Paratext changed, or that
 *  Paratext reverted from a stale copy. Shared by the per-book page and the
 *  mirrored-project editor; open while there is anything to decide. */
export function ParatextConflictDialog({ conflicts, onResolve, onResolveAll }: {
  conflicts: ClassifiedUnit[]
  onResolve: (unitId: string, choice: "mine" | "theirs") => void
  onResolveAll: (choice: "mine" | "theirs") => void
}) {
  const t = useT()
  const stale = conflicts.filter((c) => c.case === "stale-revert").length
  return (
    <AlertDialog open={conflicts.length > 0}>
      <AlertDialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl" data-testid="paratext-conflicts">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("paratextBridge.book.conflict.title")}</AlertDialogTitle>
          <AlertDialogDescription>
            {stale > 0 ? t("paratextBridge.book.conflict.stale", { count: stale }) : t("paratextBridge.book.conflict.description")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-4 text-sm">
          {conflicts.map((c) => (
            <div key={c.unitId} className="space-y-2 rounded-md border border-border p-3">
              <div className="flex items-center justify-between gap-2">
                <code className="text-xs">{c.unitId}</code>
                <div className="flex gap-2">
                  <Button size="sm" variant={c.case === "stale-revert" ? "default" : "outline"} onClick={() => onResolve(c.unitId, "mine")}>{t("paratextBridge.book.conflict.keepMine")}</Button>
                  <Button size="sm" variant="outline" onClick={() => onResolve(c.unitId, "theirs")}>{t("paratextBridge.book.conflict.takeTheirs")}</Button>
                </div>
              </div>
              <dl className="grid gap-1 text-xs">
                <dt className="text-muted-foreground">{t("paratextBridge.book.conflict.base")}</dt><dd className="whitespace-pre-wrap">{c.base?.text ?? ""}</dd>
                <dt className="text-muted-foreground">{t("paratextBridge.book.conflict.theirs")}</dt><dd className="whitespace-pre-wrap">{c.theirs?.text ?? t("paratextBridge.book.conflict.missing")}</dd>
                <dt className="text-muted-foreground">{t("paratextBridge.book.conflict.mine")}</dt><dd className="whitespace-pre-wrap font-medium">{c.mine ?? ""}</dd>
              </dl>
            </div>
          ))}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => onResolveAll("theirs")}>{t("paratextBridge.book.conflict.takeAllTheirs")}</AlertDialogCancel>
          <AlertDialogAction onClick={() => onResolveAll("mine")}>{t("paratextBridge.book.conflict.keepAllMine")}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
