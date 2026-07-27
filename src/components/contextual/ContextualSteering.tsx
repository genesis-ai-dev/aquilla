// "Direct the run" popover for the contextual drafting pill (steering channel,
// design §8 of the contextual-translation-pipeline spec). The human types a
// free-text direction ("keep the tone formal in dialogue"); the agent reads it
// between passages and applies it to the NEXT passage it drafts, then the
// direction is used up — so the chips here mean "queued for the next passage"
// and disappear on the snapshot refresh after the agent consumes them. There
// is deliberately no per-chip dismiss: queued directions have no client-visible
// identity in v1.
//
// All strings are plain user words (ui-jargon-guard.test.ts bans spec ids).

import { useState } from "react"
import { MessageSquarePlus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  attachContextualRun,
  noteContextualDirectionQueued,
} from "@/lib/contextual/run-store"
import { ContextualAuthError, sendContextualSteering } from "@/lib/contextual/transport"

/** UI cap — well under the server's hard limit on a steering entry. */
export const MAX_DIRECTION_LENGTH = 2000

interface SteeringProps {
  projectId: string
  fileId: string
  runId: string
  /** Directions queued for the next passage (store `activeDirections`). */
  directions: string[]
}

export function ContextualSteering({ projectId, fileId, runId, directions }: SteeringProps) {
  const [text, setText] = useState("")
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const trimmed = text.trim()
  const canSend = trimmed.length > 0 && !sending

  const handleSend = async () => {
    if (!canSend) return
    setSending(true)
    setError(null)
    try {
      await sendContextualSteering(runId, trimmed)
      // The server accepted the direction — it is queued now; show the chip
      // immediately and let the snapshot refresh reconcile.
      noteContextualDirectionQueued(trimmed)
      setText("")
      void attachContextualRun(projectId, fileId)
    } catch (err) {
      setError(
        err instanceof ContextualAuthError
          ? err.message
          : "That direction didn't reach the agent. Try again.",
      )
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
            aria-label="Direct the run"
            className="relative"
          >
            <MessageSquarePlus className="h-3.5 w-3.5" />
            {directions.length > 0 && (
              <span
                data-testid="contextual-steering-count"
                className="absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-0.5 text-[9px] leading-none tabular-nums text-primary-foreground"
              >
                {directions.length}
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
          Directions apply to the next passage the agent drafts.
        </p>
        {directions.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {directions.map((direction, i) => (
              <span
                key={`${direction}-${i}`}
                data-testid="contextual-steering-chip"
                className="max-w-full truncate rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                title={direction}
              >
                {direction}
              </span>
            ))}
          </div>
        )}
        <Textarea
          aria-label="Direction for the agent"
          placeholder="e.g. Keep the tone formal in dialogue"
          value={text}
          maxLength={MAX_DIRECTION_LENGTH}
          onChange={(e) => {
            setText(e.target.value)
            if (error) setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              void handleSend()
            }
          }}
          className="min-h-14 text-xs"
        />
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end">
          <Button
            type="button"
            size="sm"
            disabled={!canSend}
            onClick={() => void handleSend()}
          >
            {sending ? "Sending…" : "Send"}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
