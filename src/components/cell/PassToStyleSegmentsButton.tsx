import { ArrowRight } from "lucide-react"
import { AppTooltip } from "@/components/ui/tooltip"
import { useT } from "@/lib/i18n/I18nProvider"

interface PassToStyleSegmentsButtonProps {
  aligning: boolean
  busy: boolean
  editable: boolean
  hasText: boolean
  isAnonymous: boolean
  /** Several style runs: the model places the preview. One run is placed locally. */
  needsModel: boolean
  isCompletionConfigured: boolean
  isCompletionAvailable: boolean
  onPass: () => unknown
  onAiSetupNeeded?: () => void
}

/**
 * Bottom corner of an IDML cell whose translation is still one unstyled
 * preview. The arrow asks for that sentence to be placed into the source's
 * style runs. Always available; the visible-style-segments toggle only hides
 * the runs after they exist.
 */
export function PassToStyleSegmentsButton({
  aligning,
  busy,
  editable,
  hasText,
  isAnonymous,
  needsModel,
  isCompletionConfigured,
  isCompletionAvailable,
  onPass,
  onAiSetupNeeded,
}: PassToStyleSegmentsButtonProps) {
  const t = useT()
  const needsSetup = needsModel && !isCompletionConfigured && editable && !isAnonymous
  const label = aligning ? t("editor.ai.aligningStyles") : t("editor.ai.passToStyleSegments")

  return (
    <AppTooltip content={label} side="top" align="end">
      <button
        type="button"
        data-testid="pass-to-style-segments"
        aria-label={label}
        className="absolute bottom-1 end-1 z-10 inline-flex size-5 items-center justify-center rounded-sm text-foreground/70 hover:bg-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation()
          event.preventDefault()
          if (busy) return
          if (needsSetup) {
            onAiSetupNeeded?.()
            return
          }
          if (!hasText || !editable || isAnonymous) return
          if (needsModel && (!isCompletionAvailable || !isCompletionConfigured)) return
          void Promise.resolve(onPass())
        }}
      >
        <ArrowRight className="size-3.5 rtl:-scale-x-100" aria-hidden />
      </button>
    </AppTooltip>
  )
}
