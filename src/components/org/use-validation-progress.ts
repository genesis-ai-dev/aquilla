// AQU-1969: a Validate assignment's progress, in words — the one renderer the
// plan inspector, the Team card and the org's Team workload share, so "6 left"
// on one and "6 to go" on another can never happen.
//
//   "Validated 34 of 40 · 6 left · 2 changed since · waiting on translation (5)"
//
// One line per medium. The audio line appears only when the caller says the
// scope has recordings to judge; with it, the text line names itself so the
// two "Validated" can be told apart.

import { useT, useI18n } from "@/lib/i18n/I18nProvider"
import { formatNumber } from "@/lib/i18n/format"
import type { MessageKey } from "@/lib/i18n/messages/en"
import { validationLeft } from "@/lib/assignments/validation-progress"
import type { ValidationCounts, ValidationProgress } from "@/lib/sync/assignments"

export function useValidationProgressLines(): (
  validation: ValidationProgress,
  showAudio: boolean,
) => { text: string; audio: string | null } {
  const t = useT()
  const { locale } = useI18n()
  return (validation, showAudio) => {
    const n = (v: number) => formatNumber(v, locale)
    const line = (c: ValidationCounts, headKey: MessageKey, waitingKey: MessageKey) => {
      const left = validationLeft(c)
      return [
        t(headKey, { validated: n(c.validated), total: n(c.total) }),
        // Plural-governed terms take the number itself, which also picks the form.
        left > 0 ? t("org.validationProgress.left", { count: left }) : null,
        c.changed > 0 ? t("org.validationProgress.changedSince", { count: c.changed }) : null,
        c.waiting > 0 ? t(waitingKey, { count: c.waiting }) : null,
      ]
        .filter((part): part is string => part !== null)
        .join(" · ")
    }
    return {
      text: line(
        validation.text,
        showAudio ? "org.validationProgress.textValidated" : "org.validationProgress.validated",
        "org.validationProgress.waitingOnTranslation",
      ),
      audio: showAudio
        ? line(validation.audio, "org.validationProgress.audioValidated", "org.validationProgress.waitingOnRecording")
        : null,
    }
  }
}
