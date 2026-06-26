/**
 * ChatComposer.tsx — chip-aware composer for the AI agent dock.
 *
 * A minimal single-paragraph TipTap editor: plain prose interleaved with
 * atomic `contextChip` nodes (a highlighted source selection the user attached
 * via "Ask AI"). On send it serializes the doc to `{ text, chips }` — text with
 * `⟦chip:<id>⟧` placeholders — which AgentDockView turns into the wire message.
 *
 *  - Enter sends; Shift+Enter inserts a newline.
 *  - While streaming, typing stays enabled and Send is replaced by Stop.
 *  - `insertChip` (imperative handle) inserts a chip at the caret, de-duped.
 *
 * Send is driven off the ProseMirror `view` (not a captured `editor` closure)
 * so the latest props are read via refs and there is no stale-closure hazard.
 */

import {
  forwardRef, useEffect, useImperativeHandle, useRef, useState,
} from "react"
import { useEditor, EditorContent } from "@tiptap/react"
import type { EditorView } from "@tiptap/pm/view"
import StarterKit from "@tiptap/starter-kit"
import { ArrowUp, Sparkles, Square } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  InputGroup, InputGroupAddon, InputGroupButton, InputGroupText,
} from "@/components/ui/input-group"
import { cn } from "@/lib/utils"
import { ContextChipNode } from "@/lib/richtext/context-chip-node"
import { serializeDocJSON, type ContextChip } from "@/lib/agent/context-chip"

export interface SuggestedAction {
  label: string
  onClick: () => void
  disabled?: boolean
  title?: string
}

export interface ChatComposerHandle {
  insertChip: (chip: ContextChip) => void
}

export interface ChatComposerProps {
  isStreaming: boolean
  isConfigured: boolean
  onSend: (payload: { text: string; chips: ContextChip[] }) => void
  onStop: () => void
  compact?: boolean
  suggestedActions?: SuggestedAction[]
}

export const ChatComposer = forwardRef<ChatComposerHandle, ChatComposerProps>(function ChatComposer(
  { isStreaming, isConfigured, onSend, onStop, compact, suggestedActions },
  ref,
) {
  const [isEmpty, setIsEmpty] = useState(true)

  // Latest props for the view-driven send path (avoids stale closures in the
  // editor's keydown handler, which is bound once at editor creation).
  const onSendRef = useRef(onSend)
  onSendRef.current = onSend
  const flagsRef = useRef({ isStreaming, isConfigured })
  flagsRef.current = { isStreaming, isConfigured }

  function sendFromView(view: EditorView) {
    const { isStreaming, isConfigured } = flagsRef.current
    if (isStreaming || !isConfigured) return
    const { text, chips } = serializeDocJSON(view.state.doc.toJSON() as { type?: string; content?: unknown[] })
    if (!text.trim() && chips.length === 0) return
    onSendRef.current({ text, chips })
    view.dispatch(view.state.tr.delete(0, view.state.doc.content.size))
    setIsEmpty(true)
  }

  const editor = useEditor({
    editable: isConfigured,
    extensions: [
      StarterKit.configure({
        heading: false, bulletList: false, orderedList: false, listItem: false,
        blockquote: false, codeBlock: false, horizontalRule: false,
      }),
      ContextChipNode,
    ],
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-label": "Ask the agent",
        class: cn(
          "max-h-32 min-h-9 overflow-y-auto px-3 py-2 focus:outline-none",
          compact ? "text-xs" : "text-sm",
        ),
      },
      handleKeyDown(view, event) {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault()
          sendFromView(view)
          return true
        }
        return false
      },
    },
    onUpdate({ editor }) {
      setIsEmpty(editor.isEmpty)
    },
  })

  // Keep editability in sync with configuration changes.
  useEffect(() => {
    editor?.setEditable(isConfigured)
  }, [editor, isConfigured])

  // Focus on mount once configured.
  useEffect(() => {
    if (editor && isConfigured) editor.commands.focus()
  }, [editor, isConfigured])

  useImperativeHandle(ref, () => ({
    insertChip(chip: ContextChip) {
      if (!editor) return
      // De-dupe on (fileId, cellId, selection): re-tapping the same selection is a no-op.
      let exists = false
      editor.state.doc.descendants((node) => {
        if (
          node.type.name === "contextChip" &&
          node.attrs.fileId === chip.fileId &&
          node.attrs.cellId === chip.cellId &&
          node.attrs.selection === chip.selection
        ) exists = true
      })
      if (exists) { editor.commands.focus(); return }
      editor
        .chain()
        .focus()
        .insertContent([{ type: "contextChip", attrs: chip }, { type: "text", text: " " }])
        .run()
      setIsEmpty(editor.isEmpty)
    },
  }), [editor])

  function handleSendClick() {
    if (editor) sendFromView(editor.view)
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
        <InputGroup>
          <div className="relative flex-1">
            <EditorContent editor={editor} />
            {isEmpty && (
              <span
                className={cn(
                  "pointer-events-none absolute left-3 top-2 text-muted-foreground",
                  compact ? "text-xs" : "text-sm",
                )}
                aria-hidden
              >
                Ask the agent…
              </span>
            )}
          </div>
          <InputGroupAddon align="block-end">
            <InputGroupText className={cn(compact ? "text-[9px]" : "text-[10px]")}>
              Enter to send · Shift+Enter for newline
            </InputGroupText>
            {isStreaming ? (
              <InputGroupButton
                type="button" variant="outline" size="icon-sm" onClick={onStop}
                className="ml-auto" aria-label="Stop" title="Stop"
              >
                <Square />
              </InputGroupButton>
            ) : (
              <InputGroupButton
                type="button" variant="default" size="icon-sm" onClick={handleSendClick}
                disabled={isEmpty || !isConfigured} className="ml-auto" aria-label="Send" title="Send"
              >
                <ArrowUp />
              </InputGroupButton>
            )}
          </InputGroupAddon>
        </InputGroup>
      </div>
    </div>
  )
})
