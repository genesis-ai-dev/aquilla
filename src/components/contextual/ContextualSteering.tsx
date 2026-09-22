// "Direct the run" popover for the contextual drafting pill (steering channel,
// design §8 of the contextual-translation-pipeline spec). The human types a
// free-text direction ("keep the tone formal in dialogue"); the agent reads it
// between passages and applies it to the NEXT passage it drafts, then the
// direction is used up — so the chips here mean "queued for the next passage"
// and disappear on the snapshot refresh after the agent consumes them. There
// is deliberately no per-chip dismiss: queued directions have no client-visible
// identity in v1.
//
// AQU-1299: a short imperative ("stop", "pause", "@Coordinator halt") is NOT a
// direction — it controls the run, routing to the same server commands the
// Pause/Stop buttons use. The classifier below is the same module the server
// runs, so the optimistic feedback here can never disagree with what the server
// actually did; the response is still what we report.
//
// All strings are plain user words (ui-jargon-guard.test.ts bans spec ids).

import { useState } from "react"
import { MessageSquarePlus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  attachContextualRun,
  getContextualRunState,
  noteContextualDirectionQueued,
} from "@/lib/contextual/run-store"
import { ContextualAuthError, sendContextualSteering } from "@/lib/contextual/transport"
import { AppTooltip } from "@/components/ui/tooltip"
import { useT } from "@/lib/i18n/I18nProvider"
import { classifyRunCommandIntent } from "../../../shared/run-command-intent"

/** UI cap — well under the server's hard limit on a steering entry. */
export const MAX_DIRECTION_LENGTH = 2000

interface SteeringProps {
  projectId: string
  fileId: string
  runId: string
  /** Empty string is Project default. Must match the attached editor lane. */
  targetLang?: string
  /** Directions queued for the next passage (store `activeDirections`). */
  directions: string[]
}

export function ContextualSteering({ projectId, fileId, runId, targetLang = "", directions }: SteeringProps) {
  const t = useT()
  const [text, setText] = useState("")
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<"auth" | "failed" | null>(null)
  const [commandResult, setCommandResult] = useState<
    { command: "pause" | "stop"; applied: boolean } | null
  >(null)

  const trimmed = text.trim()
  const canSend = trimmed.length > 0 && !sending
  // Drives the send label only — the server's answer is what we report.
  const pendingIntent = classifyRunCommandIntent(trimmed)

  const handleSend = async () => {
    if (!canSend) return
    setSending(true)
    setSendError(null)
    setCommandResult(null)
    try {
      const result = await sendContextualSteering(runId, trimmed)
      const current = getContextualRunState()
      if (
        current.projectId !== projectId ||
        current.fileId !== fileId ||
        current.runId !== runId
      ) {
        // The server accepted the old run's direction, but the editor moved
        // on while the request was in flight. Never inject that direction or
        // reattach the abandoned file into the current editor mirror.
        return
      }
      setText("")
      if (result.intent !== "direction") {
        // A run command, not steering: never show a queued-direction chip for
        // it. The refresh below is what surfaces the new run status.
        setCommandResult({ command: result.intent, applied: result.applied })
      } else {
        // The server accepted the direction — it is queued now; show the chip
        // immediately and let the snapshot refresh reconcile.
        noteContextualDirectionQueued(trimmed)
      }
      void attachContextualRun(projectId, fileId, targetLang)
    } catch (error) {
      setSendError(error instanceof ContextualAuthError ? "auth" : "failed")
    } finally {
      setSending(false)
    }
  }

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={t("autopilot.steering.direct")}
            className="relative"
          >
            <MessageSquarePlus className="h-3.5 w-3.5" />
            {directions.length > 0 && (
              <span
                data-testid="contextual-steering-count"
                className="absolute -top-0.5 -end-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-lg bg-primary px-0.5 text-[9px] leading-none tabular-nums text-primary-foreground"
                aria-label={t("autopilot.steering.queuedDirections", { count: directions.length })}
              >
                <span aria-hidden>{directions.length}</span>
              </span>
            )}
          </Button>
        }
      />
      <PopoverContent
        align="end"
        side="top"
        sideOffset={8}
        data-testid="contextual-steering-popover"
      >
        <p className="text-xs text-muted-foreground">
          {t("autopilot.steering.appliesNext")}
        </p>
        <p className="text-xs text-muted-foreground">
          {t("autopilot.steering.commandHint")}
        </p>
        {directions.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {directions.map((direction, i) => (
              // Chips truncate, so the tooltip is how the full direction is read.
              <AppTooltip key={`${direction}-${i}`} content={direction}>
                <span
                  data-testid="contextual-steering-chip"
                  className="max-w-full truncate rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                >
                  {direction}
                </span>
              </AppTooltip>
            ))}
          </div>
        )}
        <Textarea
          aria-label={t("autopilot.steering.directionLabel")}
          placeholder={t("autopilot.steering.placeholder")}
          value={text}
          maxLength={MAX_DIRECTION_LENGTH}
          onChange={(e) => {
            setText(e.target.value)
            if (sendError) setSendError(null)
            if (commandResult) setCommandResult(null)
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              void handleSend()
            }
          }}
          className="min-h-14 text-xs"
        />
        {sendError && (
          <p role="alert" className="text-xs text-destructive">
            {sendError === "auth"
              ? t("autopilot.error.authRequired")
              : t("autopilot.steering.sendFailed")}
          </p>
        )}
        {commandResult && (
          <p
            role="status"
            data-testid="contextual-steering-command-result"
            className="text-xs text-muted-foreground"
          >
            {!commandResult.applied
              ? t("autopilot.steering.commandNothingRunning")
              : commandResult.command === "stop"
                ? t("autopilot.feedback.stopped")
                : t("autopilot.feedback.pauseRequested")}
          </p>
        )}
        <div className="flex justify-end">
          <Button
            type="button"
            disabled={!canSend}
            onClick={() => void handleSend()}
          >
            {sending
              ? t("autopilot.steering.sending")
              : pendingIntent === "stop"
                ? t("autopilot.steering.sendStop")
                : pendingIntent === "pause"
                  ? t("autopilot.steering.sendPause")
                  : t("autopilot.steering.send")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
