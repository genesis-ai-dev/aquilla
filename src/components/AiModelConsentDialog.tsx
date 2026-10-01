// Mount once near the app root. Subscribes to the global ai-consent service
// and renders a single dialog whenever any AI feature (TTS, ASR) is about to
// kick off its first model download for this browser.

import { useEffect, useId, useRef, useState } from "react"
import { ChevronDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
import {
  Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { storeAllFeaturesConsent, usePendingAiConsent } from "@/lib/audio/ai-consent"
import { prefetchAiModels, type ModelId } from "@/lib/audio/prefetch"
import { DEFAULT_MMS_LANGUAGE } from "@/lib/audio/tts-providers"
import { RichMessage } from "@/lib/i18n/RichMessage"
import { useT } from "@/lib/i18n/I18nProvider"
import { altClickModifierLabel, isApplePlatform } from "@/lib/platform"
import { cn } from "@/lib/utils"

const SHORT_LABELS = {
  whisper: "Whisper",
  mms: "MMS",
} as const

/** User-initiated dismisses. Focus-out / imperative close fire when an action
 *  button is pressed and must not cancel the in-flight generate. */
const DISMISS_REASONS: ReadonlySet<string> = new Set(["escape-key", "outside-press", "close-press"])

function AltClickModifierKbd() {
  const apple = isApplePlatform()
  return (
    <kbd
      data-slot="kbd"
      className="inline-flex h-[1.15em] min-w-[1.15em] items-center justify-center rounded-sm border border-border/80 bg-muted px-1 align-baseline font-sans text-[0.7rem] font-medium text-foreground"
      aria-label={altClickModifierLabel()}
    >
      {apple ? "⌥" : "Alt"}
    </kbd>
  )
}

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
  const [learnMoreOpen, setLearnMoreOpen] = useState(false)
  const learnMoreId = useId()
  // Focus the dialog surface, not the first button. A pointer-opened prompt
  // focuses without a visible ring, so the first Tab would otherwise skip
  // Learn more and highlight Cancel.
  const surfaceRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setLearnMoreOpen(false)
  }, [pending?.model.id])

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
  const justThisLabel = pending
    ? t("workspace.aiConsent.justThisButton", { model: SHORT_LABELS[pending.model.id] })
    : t("workspace.aiConsent.justThisButton", { model: t("workspace.aiConsent.genericModelName") })

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
      <DialogContent ref={surfaceRef} initialFocus={surfaceRef} className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t("workspace.aiConsent.downloadTitle", {
              model: pending ? t(pending.model.labelKey) : t("workspace.aiConsent.genericModelName"),
            })}
          </DialogTitle>
          <DialogDescription>
            {pending
              ? `${t(pending.model.shortKey)} ${t("workspace.aiConsent.sizeNote", { size: pending.model.sizeMb })}`
              : ""}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-2 py-2 text-sm text-muted-foreground">
          <p className="flex items-center gap-2">
            <Spinner className="size-3.5 opacity-60" />
            <span>
              {t("workspace.aiConsent.downloadProgressNote")}
            </span>
          </p>
          <p>{t("workspace.aiConsent.oncePerBrowser")}</p>
          {pending && (
            <div>
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto gap-1 px-0 text-foreground"
                aria-expanded={learnMoreOpen}
                aria-controls={learnMoreId}
                onClick={() => setLearnMoreOpen((v) => !v)}
              >
                {t("workspace.aiConsent.learnMore")}
                <ChevronDown className={cn("size-3.5 transition-transform", learnMoreOpen && "rotate-180")} />
              </Button>
              {learnMoreOpen && (
                <div
                  id={learnMoreId}
                  role="region"
                  className="mt-2 whitespace-pre-line text-sm text-muted-foreground"
                >
                  <RichMessage
                    k={pending.model.learnMoreKey}
                    values={{ modifier: <AltClickModifierKbd /> }}
                  />
                </div>
              )}
            </div>
          )}
        </DialogBody>
        <DialogFooter className="flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
          <Button
            type="button"
            variant="outline"
            className="w-full sm:w-auto"
            onPointerDown={(event) => {
              // Same race as Just Whisper: pointer-down settles the decline
              // before Base UI treats the press as a focus-out dismiss and
              // swallows the click, which left the prompt on screen.
              event.preventDefault()
              handleCancel()
            }}
            onClick={handleCancel}
          >
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
