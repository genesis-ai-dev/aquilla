// Mount once near the app root. Subscribes to the global ai-consent service
// and renders a single dialog whenever any AI feature (TTS, ASR) is about to
// kick off its first model download for this browser.

import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { storeAllFeaturesConsent, usePendingAiConsent } from "@/lib/audio/ai-consent"
import { prefetchAiModels, type ModelId } from "@/lib/audio/prefetch"
import { DEFAULT_MMS_LANGUAGE } from "@/lib/audio/tts-providers"
import { useT } from "@/lib/i18n/I18nProvider"

const SHORT_LABELS = {
  whisper: "Whisper",
  mms: "MMS",
} as const

/** User-initiated dismisses. Focus-out / imperative close fire when an action
 *  button is pressed and must not cancel the in-flight generate. */
const DISMISS_REASONS: ReadonlySet<string> = new Set(["escape-key", "outside-press", "close-press"])

function prefetchModels(models: ModelId[]): void {
  void prefetchAiModels({
    models,
    mmsLanguage: DEFAULT_MMS_LANGUAGE,
  }).catch(() => undefined)
}

export function AiModelConsentDialog() {
  const t = useT()
  const pending = usePendingAiConsent()
  const open = pending !== null

  const handleCancel = () => pending?.resolve(false)
  const handleAccept = () => {
    const model = pending?.model
    pending?.resolve(true)
    // Start this model's download even if the original synth was already
    // cancelled by a dialog-close race — Enable all was doing this extra
    // prefetch, which is why it appeared to "work" after a reload.
    if (model) prefetchModels([model.id])
  }
  const handleAcceptAll = () => {
    const first = pending?.model.id
    storeAllFeaturesConsent()
    pending?.resolve(true)
    const rest = (["whisper", "mms"] as const).filter((id) => id !== first)
    // Download the requested model first so the in-flight generate can share
    // that worker; the others follow. Loading all local models at once plus a
    // second worker was enough to OOM-reload the tab.
    void (async () => {
      try {
        if (first) await prefetchAiModels({ models: [first], mmsLanguage: DEFAULT_MMS_LANGUAGE })
        if (rest.length > 0) await prefetchAiModels({ models: [...rest], mmsLanguage: DEFAULT_MMS_LANGUAGE })
      } catch {
        /* Errors surface on next use. */
      }
    })()
  }
  const justThisLabel = pending ? `Just ${SHORT_LABELS[pending.model.id]}` : "Just this model"

  return (
    <Dialog
      open={open}
      onOpenChange={(next, details) => {
        if (next) return
        if (details?.reason && !DISMISS_REASONS.has(details.reason)) {
          details.cancel?.()
          return
        }
        pending?.resolve(false)
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t("workspace.aiConsent.downloadTitle", {
              model: pending ? t(pending.model.labelKey) : "AI model",
            })}
          </DialogTitle>
          <DialogDescription>
            {pending
              ? `${pending.model.rationale} The model is roughly ${pending.model.sizeMb} MB and is cached after the first download.`
              : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 py-2 text-sm text-muted-foreground">
          <p className="flex items-center gap-2">
            <Spinner className="size-3.5 opacity-60" />
            <span>
              {t("workspace.aiConsent.downloadProgressNote")}
            </span>
          </p>
          <p>{t("workspace.aiConsent.oncePerBrowser")}</p>
        </div>
        <DialogFooter className="flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
          <Button type="button" variant="outline" onClick={handleCancel} className="w-full sm:w-auto">
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="w-full sm:w-auto"
            onPointerDown={(event) => {
              // Pointer-down settles consent before Base UI can treat the same
              // press as a dismiss (focus-out / outside-press).
              event.preventDefault()
              handleAccept()
            }}
            onClick={handleAccept}
          >
            {justThisLabel}
          </Button>
          <AppTooltip content={t("workspace.aiConsent.enableAllTooltip")}>
            <Button
              type="button"
              className="w-full sm:w-auto"
              onPointerDown={(event) => {
                event.preventDefault()
                handleAcceptAll()
              }}
              onClick={handleAcceptAll}
            >
              {t("workspace.aiConsent.enableAllButton")}
            </Button>
          </AppTooltip>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
