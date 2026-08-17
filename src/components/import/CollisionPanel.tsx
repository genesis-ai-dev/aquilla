import { useState } from "react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { type CollisionResult } from "@/lib/import-collision"
import { useT } from "@/lib/i18n/I18nProvider"
import type { CollisionResolution } from "./import-dialog-types"

type CollisionChoice = "update" | "skip" | "duplicate"

interface CollisionPanelProps {
  collisions: CollisionResult[]
  onResolve: (resolution: CollisionResolution) => void | Promise<void>
  onCancel: () => void
}

/** Per-collision prompt with apply-to-all toggle. */
export function CollisionPanel({ collisions, onResolve, onCancel }: CollisionPanelProps) {
  const t = useT()
  // Updating preserves logical cell ids and is the safe default when the
  // existing project listing supplied an id. Legacy name-only callers fall
  // back to Skip because they cannot address an existing file safely.
  const [choices, setChoices] = useState<Map<string, CollisionChoice>>(() => {
    const m = new Map<string, CollisionChoice>()
    for (const c of collisions) m.set(c.name, c.existingId ? "update" : "skip")
    return m
  })
  const [resolving, setResolving] = useState(false)

  function setAll(choice: CollisionChoice) {
    setChoices((prev) => {
      const next = new Map(prev)
      for (const key of next.keys()) next.set(key, choice)
      return next
    })
  }

  function setChoice(name: string, choice: CollisionChoice) {
    setChoices((prev) => {
      const next = new Map(prev)
      next.set(name, choice)
      return next
    })
  }

  async function handleConfirm() {
    if (resolving) return
    setResolving(true)
    try {
      // Build skipKeys: normalized keys for every item the user chose to skip.
      const skipKeys = new Set<string>()
      const reimportFileIds = new Map<string, string>()
      for (const [name, choice] of choices) {
        const collision = collisions.find((c) => c.name === name)
        const key = collision?.bookCode
          ? collision.bookCode.toUpperCase()
          : name.trim().toLowerCase()
        if (choice === "skip") {
          // Key must match what importFile / importParatextProject checks.
          // bookCode (uppercase) or normalized name (lowercase trimmed).
          skipKeys.add(key)
        } else if (choice === "update" && collision?.existingId) {
          reimportFileIds.set(key, collision.existingId)
        }
      }
      await onResolve({ skipKeys, reimportFileIds })
    } finally {
      setResolving(false)
    }
  }

  const allSkip = [...choices.values()].every((v) => v === "skip")
  const allDup = [...choices.values()].every((v) => v === "duplicate")
  const allUpdate = [...choices.values()].every((v) => v === "update")
  const canUpdateAll = collisions.every((collision) => collision.existingId)

  return (
    <div className="flex flex-col gap-4 py-2">
      <p className="text-sm text-muted-foreground">
        {t("importExport.collision.intro", { count: collisions.length })}
      </p>
      <p className="text-xs text-muted-foreground">
        {t("importExport.collision.updateHint")}
      </p>
      {collisions.some((collision) => collision.ambiguous) && (
        <p role="alert" className="text-xs text-amber-700 dark:text-amber-300">
          {t("importExport.collision.ambiguousWarning")}
        </p>
      )}

      {/* Apply-to-all row */}
      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground">{t("importExport.collision.applyToAll")}</span>
        <button
          type="button"
          onClick={() => setAll("update")}
          disabled={!canUpdateAll}
          className={cn(
            "rounded border px-2 py-0.5 transition-colors disabled:cursor-not-allowed disabled:opacity-40",
            allUpdate ? "border-primary bg-primary/10 text-primary" : "border-muted text-muted-foreground hover:border-foreground/40",
          )}
        >
          {t("importExport.collision.updateAll")}
        </button>
        <button
          type="button"
          onClick={() => setAll("skip")}
          className={cn(
            "rounded border px-2 py-0.5 transition-colors",
            allSkip ? "border-primary bg-primary/10 text-primary" : "border-muted text-muted-foreground hover:border-foreground/40",
          )}
        >
          {t("importExport.collision.skipAll")}
        </button>
        <button
          type="button"
          onClick={() => setAll("duplicate")}
          className={cn(
            "rounded border px-2 py-0.5 transition-colors",
            allDup ? "border-primary bg-primary/10 text-primary" : "border-muted text-muted-foreground hover:border-foreground/40",
          )}
        >
          {t("importExport.collision.duplicateAll")}
        </button>
      </div>

      {/* Per-collision rows. Native overflow scroll — see PreviewPanel note on
          the ScrollArea max-h footgun. */}
      <div className="max-h-64 overflow-y-auto rounded-md border">
        <ul className="divide-y">
          {collisions.map((c) => {
            const choice = choices.get(c.name) ?? "skip"
            return (
              <li key={c.name} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{c.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {t("importExport.collision.existing", { name: c.existingName })}
                    {c.bookCode ? ` (${c.bookCode})` : ""}
                  </p>
                </div>
                {/* Explicit three-way resolution; update never replaces target data. */}
                <div className="flex shrink-0 gap-1 text-xs">
                  <button
                    type="button"
                    disabled={!c.existingId}
                    onClick={() => setChoice(c.name, "update")}
                    className={cn(
                      "rounded border px-2 py-0.5 transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                      choice === "update"
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-muted text-muted-foreground hover:border-foreground/40",
                    )}
                  >
                    {t("importExport.collision.updateExisting")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setChoice(c.name, "skip")}
                    className={cn(
                      "rounded border px-2 py-0.5 transition-colors",
                      choice === "skip"
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-muted text-muted-foreground hover:border-foreground/40",
                    )}
                  >
                    {t("importExport.collision.skip")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setChoice(c.name, "duplicate")}
                    className={cn(
                      "rounded border px-2 py-0.5 transition-colors",
                      choice === "duplicate"
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-muted text-muted-foreground hover:border-foreground/40",
                    )}
                  >
                    {t("importExport.collision.duplicate")}
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={resolving}>
          {t("common.cancel")}
        </Button>
        <Button size="sm" onClick={handleConfirm} disabled={resolving}>
          {resolving ? t("importExport.collision.continuing") : t("onboarding.common.continue")}
        </Button>
      </div>
    </div>
  )
}
