/**
 * ChatComposer.tsx — shared composer for the AI agent dock.
 *
 * Built on the shadcn InputGroup pattern (InputGroup + InputGroupTextarea +
 * InputGroupAddon): the textarea and the send/stop control share one bordered
 * group, with the keyboard hint and action button in a block-end addon.
 *
 *  - Enter sends; Shift+Enter inserts a newline; ⌘/Ctrl+Enter still sends.
 *  - Auto-growing textarea (1 → ~8 rows, then internal scroll).
 *  - While streaming, typing stays enabled and Send is replaced by Stop.
 */

import { useEffect, useRef, useState, type KeyboardEvent, type FormEvent } from "react"
import { ArrowUp, Sparkles, Square } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupText,
  InputGroupTextarea,
} from "@/components/ui/input-group"
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

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    handleSend()
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
                className={cn(compact ? "h-6 text-[10px]" : "h-7 text-xs")}
              >
                <Sparkles data-icon="inline-start" />
                {action.label}
              </Button>
            ))}
          </div>
        )}
        <form onSubmit={handleSubmit}>
          <InputGroup>
            <InputGroupTextarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask the agent…"
              rows={1}
              disabled={!isConfigured}
              className={cn("min-h-9", compact ? "text-xs" : "text-sm")}
            />
            <InputGroupAddon align="block-end">
              <InputGroupText className={cn(compact ? "text-[9px]" : "text-[10px]")}>
                Enter to send · Shift+Enter for newline
              </InputGroupText>
              {isStreaming ? (
                <InputGroupButton
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  onClick={onStop}
                  className="ml-auto"
                  aria-label="Stop"
                  title="Stop"
                >
                  <Square />
                </InputGroupButton>
              ) : (
                <InputGroupButton
                  type="submit"
                  variant="default"
                  size="icon-sm"
                  disabled={!draft.trim() || !isConfigured}
                  className="ml-auto"
                  aria-label="Send"
                  title="Send"
                >
                  <ArrowUp />
                </InputGroupButton>
              )}
            </InputGroupAddon>
          </InputGroup>
        </form>
      </div>
    </div>
  )
}
