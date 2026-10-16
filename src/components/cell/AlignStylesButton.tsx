import { Baseline } from "lucide-react"
import { RailButton } from "@/components/CellActionRail"
import { useT } from "@/lib/i18n/I18nProvider"

interface AlignStylesButtonProps {
  hasText: boolean
  editable: boolean
  isAnonymous: boolean
  isCompletionConfigured: boolean
  isCompletionAvailable: boolean
  /** This cell's align request is the one in flight. */
  aligning: boolean
  /** Any AI request is in flight for this cell, including a draft. */
  busy: boolean
  onAlign: () => unknown
  onAiSetupNeeded?: () => void
}

/**
 * Last action in the cell overflow. Icon only, like the rest of the rail;
 * "Align styles" is the hover tooltip. Asks the model to move the existing
 * translation into the source cell's style runs without rewriting the words.
 */
export function AlignStylesButton({
  hasText,
  editable,
  isAnonymous,
  isCompletionConfigured,
  isCompletionAvailable,
  aligning,
  busy,
  onAlign,
  onAiSetupNeeded,
}: AlignStylesButtonProps) {
  const t = useT()
  const needsSetup = !isCompletionConfigured && editable && !isAnonymous
  const tooltip = isAnonymous
    ? t("editor.ai.signInForTranslations")
    : !editable
      ? t("common.readOnly")
      : !isCompletionConfigured
        ? t("editor.ai.setUpToEnable")
        : !isCompletionAvailable
          ? t("editor.ai.serviceUnavailable")
          : !hasText
            ? t("editor.ai.alignStylesNeedsText")
            : aligning
              ? t("editor.ai.aligningStyles")
              : busy
                ? t("editor.ai.generating")
                : t("editor.ai.alignStyles")

  return (
    <RailButton
      icon={<Baseline className="h-3.5 w-3.5" />}
      tooltip={tooltip}
      pulsing={aligning}
      disabled={
        busy
        || !hasText
        || !editable
        || isAnonymous
        || !isCompletionAvailable
        || (!isCompletionConfigured && !onAiSetupNeeded)
      }
      onClick={() => {
        if (busy) return
        if (needsSetup) {
          onAiSetupNeeded?.()
          return
        }
        if (!hasText || !editable || isAnonymous || !isCompletionAvailable || !isCompletionConfigured) return
        void Promise.resolve(onAlign())
      }}
    />
  )
}
