/**
 * ChatPanel.tsx — FRO-175
 *
 * Right-side chat drawer for the workspace AI copilot.
 *
 * Composes the shared chat components (src/components/chat/) — the Sheet
 * shell stays distinct from ChatDockPanel's dock layout.
 *
 * UI: shadcn Sheet + base-nova primitives, lucide icons, no toast lib.
 */

import { MessageSquare, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import type { UseChatReturn, CellContext } from "@/hooks/useChat"
import { ChatContextPin } from "./chat/ChatContextPin"
import { ChatMessageList } from "./chat/ChatMessageList"
import { ChatComposer } from "./chat/ChatComposer"
import { ChatClearButton } from "./chat/ChatClearButton"

export interface ChatPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  chat: UseChatReturn
  /** The currently focused cell; wired in ProjectWorkspace via focusedCellIdRef */
  currentCell: CellContext | null
  /** Commit plain text into the focused cell via the AI-completion commit path. */
  onInsertIntoCell?: (text: string) => void | Promise<void>
}

export function ChatPanel({ open, onOpenChange, chat, currentCell, onInsertIntoCell }: ChatPanelProps) {
  const {
    messages,
    streamingText,
    isStreaming,
    includeCellContext,
    setIncludeCellContext,
    isConfigured,
    sendMessage,
    retryMessage,
    dismissMessage,
    regenerate,
    stopStreaming,
    clearHistory,
  } = chat

  const hasHistory = messages.length > 0 || isStreaming

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-96 max-w-full flex-col p-0"
        showCloseButton={false}
      >
        {/* Header */}
        <SheetHeader className="flex-row items-center justify-between border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-muted-foreground" />
            <SheetTitle className="text-sm">AI Chat</SheetTitle>
          </div>
          <div className="flex items-center gap-1">
            {hasHistory && <ChatClearButton onClear={clearHistory} />}
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => onOpenChange(false)}
              aria-label="Close chat"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </SheetHeader>

        <ChatContextPin
          includeCellContext={includeCellContext}
          onToggle={setIncludeCellContext}
          currentCell={currentCell}
        />

        <ChatMessageList
          messages={messages}
          streamingText={streamingText}
          isStreaming={isStreaming}
          isConfigured={isConfigured}
          includeCellContext={includeCellContext}
          currentCell={currentCell}
          onInsertIntoCell={onInsertIntoCell}
          onRegenerate={() => void regenerate(currentCell)}
          onRetry={(msg) => void retryMessage(msg.id, currentCell)}
          onDismiss={(msg) => dismissMessage(msg.id)}
        />

        <ChatComposer
          isStreaming={isStreaming}
          isConfigured={isConfigured}
          onSend={(text) => void sendMessage(text, currentCell)}
          onStop={stopStreaming}
        />
      </SheetContent>
    </Sheet>
  )
}
