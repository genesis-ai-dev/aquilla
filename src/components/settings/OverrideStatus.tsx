// AQU-1771: the line under an org default on Project defaults that says who
// follows it. Without it the page is silent in two different situations: no
// project overrides the default (so changing it asks nothing), and some do but
// the person already said "Leave unchanged" once. Both looked the same; this
// says which one it is, and keeps the reset reachable at any time instead of
// only in the moment right after a change.
//
// The Reset link does not reset by itself. It opens the section's existing
// confirmation, so there is one place that explains what a reset does.

import { useI18n } from "@/lib/i18n/I18nProvider"

interface OverrideStatusProps {
  /** How many of the org's projects set their own value for this default. */
  count: number
  /** "number" for counts (approvals needed), "setting" for switches and choices. */
  kind: "number" | "setting"
  /** Opens the section's reset confirmation. Omitted below the edit gate. */
  onReset?: () => void
  disabled?: boolean
}

export function OverrideStatus({ count, kind, onReset, disabled }: OverrideStatusProps) {
  const { t } = useI18n()
  if (count <= 0) {
    return (
      <span className="mt-1 block" data-testid="override-status">
        {t("settings.overrideStatus.allFollow")}
      </span>
    )
  }
  return (
    <span className="mt-1 block" data-testid="override-status">
      {kind === "number"
        ? t("settings.overrideStatus.someOwnNumber", { count })
        : t("settings.overrideStatus.someOwnSetting", { count })}
      {onReset ? (
        <>
          {" · "}
          <button
            type="button"
            className="text-foreground underline underline-offset-2 hover:text-primary disabled:no-underline disabled:opacity-60"
            onClick={onReset}
            disabled={disabled}
          >
            {t("settings.overrideStatus.reset")}
          </button>
        </>
      ) : null}
    </span>
  )
}
