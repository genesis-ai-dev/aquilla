import { AlertTriangle } from "lucide-react"
import { AppTooltip } from "@/components/ui/tooltip"
import { useT } from "@/lib/i18n/I18nProvider"

interface StyleAlignWarningProps {
  aligning: boolean
  busy: boolean
  editable: boolean
  hasText: boolean
  isAnonymous: boolean
  isCompletionConfigured: boolean
  isCompletionAvailable: boolean
  onAlign: () => unknown
  onAiSetupNeeded?: () => void
}

/**
 * Bottom-corner warning for a cell whose merged plain run was typed as one
 * piece of text and no longer fills the source's runs. The hover names Align
 * styles; the click runs that same action.
 */
export function StyleAlignWarning({
  aligning,
  busy,
  editable,
  hasText,
  isAnonymous,
  isCompletionConfigured,
  isCompletionAvailable,
  onAlign,
  onAiSetupNeeded,
}: StyleAlignWarningProps) {
  const t = useT()
  const label = aligning ? t("editor.ai.aligningStyles") : t("editor.ai.alignStylesNeeded")
  const needsSetup = !isCompletionConfigured && editable && !isAnonymous

  return (
    <AppTooltip content={label} side="top" align="end">
      <button
        type="button"
        data-testid="style-align-warning"
        aria-label={label}
        className="absolute bottom-1 end-1 z-10 inline-flex size-5 items-center justify-center rounded-sm text-yellow-500 hover:bg-yellow-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow-500/40 dark:text-yellow-400"
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation()
          event.preventDefault()
          if (busy) return
          if (needsSetup) {
            onAiSetupNeeded?.()
            return
          }
          if (!hasText || !editable || isAnonymous || !isCompletionAvailable || !isCompletionConfigured) return
          void Promise.resolve(onAlign())
        }}
      >
        <AlertTriangle className="size-3.5" aria-hidden />
      </button>
    </AppTooltip>
  )
}
