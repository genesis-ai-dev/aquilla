/**
 * ChatClearButton.tsx — chat UX improvements
 *
 * "Clear conversation" header button with a confirm dialog, shared by the
 * chat sheet and dock panels.
 */

import { useState } from "react"
import { Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ChatConfirmDialog } from "./ChatConfirmDialog"

export function ChatClearButton({ onClear, compact }: { onClear: () => void; compact?: boolean }) {
  const [confirmOpen, setConfirmOpen] = useState(false)
  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => setConfirmOpen(true)}
        title="Clear conversation"
        aria-label="Clear conversation"
      >
        <Trash2 className={compact ? "h-3 w-3" : "h-3.5 w-3.5"} />
      </Button>
      <ChatConfirmDialog
        open={confirmOpen}
        title="Clear conversation?"
        description="This removes the chat history for this project. This cannot be undone."
        confirmLabel="Clear conversation"
        variant="destructive"
        onConfirm={() => {
          onClear()
          setConfirmOpen(false)
        }}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  )
}
