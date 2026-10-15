import type { ReactNode } from "react"
import { AppTooltip } from "@/components/ui/tooltip"
import { useT } from "@/lib/i18n/I18nProvider"
import { cn } from "@/lib/utils"

/**
 * The find-widget toggles from the search input: match case, whole word,
 * and regular expression. Glyphs stay in the field; the accessible name is
 * the tooltip. mousedown is swallowed so the caret stays in the input.
 */
export function FindOptionToggles({
  matchCase,
  wholeWord,
  useRegexp,
  onMatchCaseChange,
  onWholeWordChange,
  onUseRegexpChange,
}: {
  matchCase: boolean
  wholeWord: boolean
  useRegexp: boolean
  onMatchCaseChange: (next: boolean) => void
  onWholeWordChange: (next: boolean) => void
  onUseRegexpChange: (next: boolean) => void
}) {
  const t = useT()
  return (
    <>
      <FindToggle
        pressed={matchCase}
        label={t("search.find.matchCase")}
        onPressedChange={onMatchCaseChange}
      >
        Aa
      </FindToggle>
      <FindToggle
        pressed={wholeWord}
        label={t("search.find.wholeWord")}
        onPressedChange={onWholeWordChange}
      >
        <span className="underline decoration-1 underline-offset-[3px]">ab</span>
      </FindToggle>
      <FindToggle
        pressed={useRegexp}
        label={t("search.find.useRegexp")}
        onPressedChange={onUseRegexpChange}
      >
        <span className="font-mono text-[13px] leading-none">*</span>
      </FindToggle>
    </>
  )
}

/** Preserve-case toggle for the replacement field. */
export function PreserveCaseToggle({
  pressed,
  disabled,
  onPressedChange,
}: {
  pressed: boolean
  disabled?: boolean
  onPressedChange: (next: boolean) => void
}) {
  const t = useT()
  return (
    <FindToggle
      pressed={pressed}
      disabled={disabled}
      label={t("search.replace.preserveCase")}
      onPressedChange={onPressedChange}
    >
      AB
    </FindToggle>
  )
}

function FindToggle({
  pressed,
  disabled,
  label,
  onPressedChange,
  children,
}: {
  pressed: boolean
  disabled?: boolean
  label: string
  onPressedChange: (next: boolean) => void
  children: ReactNode
}) {
  return (
    <AppTooltip content={label}>
      <button
        type="button"
        aria-pressed={pressed}
        aria-label={label}
        disabled={disabled}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onPressedChange(!pressed)}
        className={cn(
          "inline-flex h-5 min-w-5 items-center justify-center rounded-md px-1 text-[11px] font-medium leading-none text-muted-foreground",
          "hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50",
          pressed && "bg-accent text-foreground",
        )}
      >
        {children}
      </button>
    </AppTooltip>
  )
}
