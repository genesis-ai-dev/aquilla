/**
 * ChatComposer.tsx — chat UX improvements
 *
 * Shared composer for the chat sheet and dock panels.
 *  - Enter sends; Shift+Enter inserts a newline; ⌘/Ctrl+Enter still sends.
 *  - Auto-growing textarea (1 → ~8 rows, then internal scroll).
 *  - While streaming, typing stays enabled and Send is replaced by Stop.
 */

import { useEffect, useRef, useState, type KeyboardEvent } from "react"
import { Sparkles, Square } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/** A one-tap prompt offered above the textarea (e.g. "Summarize book"). */
export interface SuggestedAction {
  label: string
  onClick: () => void
  /** Disabled with this reason as a tooltip (e.g. no chapter focused yet). */
  disabled?: boolean
  /** Native tooltip text. */
  title?: string
}

export interface ChatComposerProps {
  isStreaming: boolean
  isConfigured: boolean
  onSend: (text: string) => void
  onStop: () => void
  compact?: boolean
  /** One-tap prompts rendered as a chip row above the input. Hidden when empty. */
  suggestedActions?: SuggestedAction[]
}

export function ChatComposer({
  isStreaming,
  isConfigured,
  onSend,
  onStop,
  compact,
  suggestedActions,
}: ChatComposerProps) {
  const [draft, setDraft] = useState("")
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // ~8 rows before internal scroll kicks in.
  const maxHeightPx = compact ? 128 : 160

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, maxHeightPx)}px`
  }, [draft, maxHeightPx])

  // Focus on mount without scrolling ancestors (dock rail / sheet open).
  useEffect(() => {
    const t = setTimeout(() => textareaRef.current?.focus({ preventScroll: true }), 50)
    return () => clearTimeout(t)
  }, [])

  function handleSend() {
    if (!draft.trim() || isStreaming || !isConfigured) return
    const text = draft
    setDraft("")
    onSend(text)
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== "Enter") return
    if (e.shiftKey) return // Shift+Enter → newline
    e.preventDefault() // plain Enter and ⌘/Ctrl+Enter both send
    handleSend()
  }

  return (
    <div className={cn("border-t", compact ? "p-2" : "p-3")}>
      <div className={cn("flex flex-col", compact ? "gap-1.5" : "gap-2")}>
        {suggestedActions && suggestedActions.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {suggestedActions.map((action) => (
              <Button
                key={action.label}
                type="button"
                variant="outline"
                size="sm"
                disabled={action.disabled || !isConfigured || isStreaming}
                title={action.title}
                onClick={action.onClick}
                className={cn("gap-1", compact ? "h-6 text-[10px]" : "h-7 text-xs")}
              >
                <Sparkles className={compact ? "h-2.5 w-2.5" : "h-3 w-3"} />
                {action.label}
              </Button>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask a question… (Enter to send)"
          rows={1}
          disabled={!isConfigured}
          className={cn(
            "w-full resize-none overflow-y-auto rounded-md border bg-background",
            compact ? "px-2.5 py-1.5 text-xs" : "px-3 py-2 text-sm",
            "placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring",
            "disabled:opacity-50",
          )}
        />
        <div className="flex items-center justify-between">
          <span className={cn("text-muted-foreground", compact ? "text-[9px]" : "text-[10px]")}>
            Enter to send · Shift+Enter for newline
          </span>
          <div className={cn("flex items-center", compact ? "gap-1" : "gap-1.5")}>
            {isStreaming ? (
              <Button
                variant="outline"
                size="sm"
                onClick={onStop}
                className={compact ? "h-6 gap-1 text-[10px]" : "h-7 gap-1 text-xs"}
              >
                <Square className={compact ? "h-2.5 w-2.5" : "h-3 w-3"} />
                Stop
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={handleSend}
                disabled={!draft.trim() || !isConfigured}
                className={compact ? "h-6 text-[10px]" : "h-7 text-xs"}
              >
                Send
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
