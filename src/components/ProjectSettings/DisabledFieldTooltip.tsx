import type { ReactNode } from "react"
import { ArrowRight, ArrowUpRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { LockedControl, useLockPlacement } from "@/components/ui/locked-note"
import { useT } from "@/lib/i18n/I18nProvider"

/**
 * Who can change a locked setting, and a next step: open the list of those
 * people, or the permission docs. Drawn inline in a lock line (AQU-2260): atop
 * a locked section it reads "Only Maintainers can change these settings.",
 * beneath a single control "Only Maintainers can change this.". `role` is the
 * role's plural name, already translated.
 */
export function PermissionLockHint({
  role,
  title,
  onView,
  href,
  linkLabel,
}: {
  role?: string
  /** A sentence of its own, for a reason that is not a role. */
  title?: string
  onView?: () => void
  href?: string
  linkLabel: string
}) {
  const t = useT()
  const placement = useLockPlacement()
  const sentence =
    title ??
    (placement === "section"
      ? t("settings.locked.section", { role: role ?? "" })
      : t("settings.locked.control", { role: role ?? "" }))
  const actionClassName =
    "h-auto px-0 py-0 text-xs font-medium text-foreground/80 underline-offset-2 hover:bg-transparent hover:underline has-data-[icon=inline-end]:pe-0"
  const link = onView ? (
    <Button type="button" variant="ghost" size="xs" className={actionClassName} onClick={onView}>
      {linkLabel}
      <ArrowRight data-icon="inline-end" aria-hidden />
    </Button>
  ) : href ? (
    <Button
      variant="ghost"
      size="xs"
      className={actionClassName}
      nativeButton={false}
      render={<a href={href} target="_blank" rel="noopener noreferrer" />}
    >
      {linkLabel}
      <ArrowUpRight data-icon="inline-end" aria-hidden />
    </Button>
  ) : null

  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5">
      <span>{sentence}</span>
      {link}
    </span>
  )
}

/**
 * A control that may be locked for you, with why beneath it — one short line,
 * never a hover (AQU-2260). Editable, it is the control and nothing more.
 * Inside a section whose top line already says why, it stays quiet. (The name
 * is from when this was a tooltip; every locked setting still comes through
 * here.)
 */
export function DisabledFieldTooltip({
  disabled,
  tooltip,
  children,
  align = "end",
  noteClassName,
}: {
  disabled: boolean
  tooltip: ReactNode
  children: ReactNode
  /** Under a control at the right of a settings row by default. */
  align?: "start" | "end"
  noteClassName?: string
}) {
  return (
    <LockedControl locked={disabled} reason={tooltip} align={align} noteClassName={noteClassName}>
      {children}
    </LockedControl>
  )
}
