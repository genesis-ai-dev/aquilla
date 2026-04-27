// Mount once near the app root. Subscribes to the global ai-consent service
// and renders a single dialog whenever any AI feature (TTS, ASR) is about to
// kick off its first model download for this browser.

import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog"
import { storeAllFeaturesConsent, usePendingAiConsent } from "@/lib/audio/ai-consent"
import { prefetchAiModels } from "@/lib/audio/prefetch"

export function AiModelConsentDialog() {
  const pending = usePendingAiConsent()
  const open = pending !== null

  const handleCancel = () => pending?.resolve(false)
  const handleAccept = () => pending?.resolve(true)
  const handleAcceptAll = () => {
    storeAllFeaturesConsent()
    // Kick off the other model's download in the background while the
    // current one runs. Errors here are non-fatal — they surface on next use.
    void prefetchAiModels().catch(() => undefined)
    pending?.resolve(true)
  }
  // The complementary model the user could enable in one click.
  const otherLabel = pending?.model.id === "whisper" ? "Kokoro (TTS)" : "Whisper (transcription)"
  const justThisLabel = pending?.model.id === "whisper" ? "Just Whisper" : "Just Kokoro"

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) pending?.resolve(false) }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Download {pending?.model.label ?? "AI model"}?
          </DialogTitle>
          <DialogDescription>
            {pending
              ? `${pending.model.rationale} The model is roughly ${pending.model.sizeMb} MB and is cached after the first download.`
              : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 py-2 text-sm text-muted-foreground">
          <p className="flex items-center gap-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin opacity-60" />
            <span>
              While the model downloads, you'll see a progress percentage on
              the cell. The page won't reload.
            </span>
          </p>
          <p>You'll only see this prompt once per browser.</p>
        </div>
        <DialogFooter className="flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
          <Button variant="outline" onClick={handleCancel} className="w-full sm:w-auto">
            Cancel
          </Button>
          <Button variant="outline" onClick={handleAccept} className="w-full sm:w-auto">
            {justThisLabel}
          </Button>
          <Button
            onClick={handleAcceptAll}
            title={`Also pre-download ${otherLabel} so it's ready next time`}
            className="w-full sm:w-auto"
          >
            Enable both
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
