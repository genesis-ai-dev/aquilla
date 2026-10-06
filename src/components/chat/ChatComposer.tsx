/**
 * ChatComposer.tsx — chip-aware composer for the AI agent dock.
 *
 * A minimal single-paragraph TipTap editor: plain prose interleaved with
 * atomic `contextChip` nodes (a highlighted source selection the user attached
 * via "Ask AI"). On send it serializes the doc to `{ text, chips }` — text with
 * `⟦chip:<id>⟧` placeholders — which AgentDockView turns into the wire message.
 *
 *  - Enter sends; Shift+Enter inserts a newline.
 *  - While streaming, typing stays enabled and Send is replaced by Stop —
 *    unless `queueWhileStreaming`, where Send stays live (the session store
 *    queues the prompt behind the in-flight run) next to Stop.
 *  - `insertChip` (imperative handle) inserts a chip at the caret, de-duped.
 *  - Scoped drafts preserve the document across navigation/reload; a successful
 *    handoff consumes only the submitted revision. Mounting never takes focus.
 *
 * Send is driven off the ProseMirror `view` (not a captured `editor` closure)
 * so the latest props are read via refs and there is no stale-closure hazard.
 */

import {
  forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode,
} from "react"
import { useEditor, EditorContent } from "@tiptap/react"
import type { EditorView } from "@tiptap/pm/view"
import StarterKit from "@tiptap/starter-kit"
import { ArrowUp, Sparkles, Square } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  InputGroup, InputGroupAddon, InputGroupButton,
} from "@/components/ui/input-group"
import { AppTooltip } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { ContextChipNode } from "@/lib/richtext/context-chip-node"
import { serializeDocJSON, type ContextChip } from "@/lib/agent/context-chip"
import {
  composerDraftKey, composerDraftStore, createComposerDraftStore, useComposerDraft,
  type ComposerDraftScope,
} from "@/lib/agent/composer-drafts"
import { useT } from "@/lib/i18n/I18nProvider"

export interface SuggestedAction {
  label: string
  onClick: () => void
  disabled?: boolean
  title?: string
}

export interface ChatComposerHandle {
  insertChip: (chip: ContextChip) => void
  /** Prefill the composer with plain text (e.g. an example prompt) and focus it. */
  insertText: (text: string) => void
}

export interface ChatComposerProps {
  isStreaming: boolean
  isConfigured: boolean
  /** Resolving/returning false retains the draft (the caller reports why).
   *  Rejecting/throwing also retains it and shows a fallback inline error. */
  onSend: (payload: { text: string; chips: ContextChip[] }) => void | boolean | Promise<void | boolean>
  /** Omit for an ephemeral composer; agent destinations must provide a scope. */
  draftScope?: ComposerDraftScope
  onStop: () => void
  compact?: boolean
  suggestedActions?: SuggestedAction[]
  /** Keep Send live during a run — the caller queues the prompt (agent mode). */
  queueWhileStreaming?: boolean
  /** Empty-state hint; defaults to "Ask the agent…". */
  placeholder?: string
  /** Agent-mode attach-file affordance. `attachmentBar` renders full-width
   *  above the input (attached-file pills); `attachAction` renders at the start
   *  of the block-end action row (the attach button + its hidden file input).
   *  Chat mode passes neither, so the composer stays unchanged there. */
  attachmentBar?: ReactNode
  attachAction?: ReactNode
}

export const ChatComposer = forwardRef<ChatComposerHandle, ChatComposerProps>(function ChatComposer(
  props,
  ref,
) {
  // Key the editor itself, not an effect that can persist the previous document
  // under the next destination before hydration completes.
  return <ScopedChatComposer key={props.draftScope ? composerDraftKey(props.draftScope) : "ephemeral"} {...props} ref={ref} />
})

const ScopedChatComposer = forwardRef<ChatComposerHandle, ChatComposerProps>(function ScopedChatComposer(
  { isStreaming, isConfigured, onSend, onStop, compact, suggestedActions, queueWhileStreaming, placeholder, attachmentBar, attachAction, draftScope },
  ref,
) {
  const t = useT()
  const [draftStore] = useState(() => draftScope ? composerDraftStore(draftScope) : createComposerDraftStore())
  const draft = useComposerDraft(draftStore)
  const { text: draftText, chips: draftChips } = serializeDocJSON(draft.document)
  const isEmpty = !draftText.trim() && draftChips.length === 0

  // Latest props for the view-driven send path (avoids stale closures in the
  // editor's keydown handler, which is bound once at editor creation).
  const onSendRef = useRef(onSend)
  const flagsRef = useRef({ isStreaming, isConfigured, queueWhileStreaming })
  useLayoutEffect(() => {
    onSendRef.current = onSend
    flagsRef.current = { isStreaming, isConfigured, queueWhileStreaming }
  }, [onSend, isStreaming, isConfigured, queueWhileStreaming])

  function sendFromView(view: EditorView) {
    const { isStreaming, isConfigured, queueWhileStreaming } = flagsRef.current
    if (draftStore.getSnapshot().isSending || (isStreaming && !queueWhileStreaming) || !isConfigured) return
    const { text, chips } = serializeDocJSON(view.state.doc.toJSON())
    if (!text.trim() && chips.length === 0) return
    const revision = draftStore.getSnapshot().documentRevision
    draftStore.setSending(true)
    draftStore.setSendError(null)
    const finish = (accepted: void | boolean) => {
      if (accepted !== false) draftStore.consumeDocument(revision)
      draftStore.setSending(false)
    }
    const fail = () => {
      finish(false)
      draftStore.setSendError("Could not send your message. Your draft has been kept; try again.")
    }
    try {
      const result = onSendRef.current({ text, chips })
      if (result && typeof result === "object" && "then" in result) {
        void result.then(finish, fail)
      } else {
        finish(result)
      }
    } catch {
      fail()
    }
  }

  const editor = useEditor({
    content: draft.document,
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
        "data-slot": "input-group-control",
        class: cn(
          "w-full max-h-32 min-h-9 overflow-y-auto px-3 py-2 focus:outline-none",
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
      draftStore.setDocument(editor.getJSON())
    },
  })

  // Keep editability in sync with configuration changes.
  useEffect(() => {
    editor?.setEditable(isConfigured)
  }, [editor, isConfigured])

  useLayoutEffect(() => {
    if (!editor) return
    if (JSON.stringify(editor.getJSON()) !== JSON.stringify(draft.document)) {
      editor.commands.setContent(draft.document, { emitUpdate: false })
    }
  }, [editor, draft.document])

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
    },
    insertText(text: string) {
      if (!editor) return
      editor.chain().focus().insertContent({ type: "text", text }).run()
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
              <AppTooltip key={action.label} content={action.title} disabled={!action.title}>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={action.disabled || !isConfigured || isStreaming}
                  onClick={action.onClick}
                  className={cn(compact ? "h-6 text-[10px]" : "h-7 text-xs")}
                >
                  <Sparkles data-icon="inline-start" />
                  {action.label}
                </Button>
              </AppTooltip>
            ))}
          </div>
        )}
        {attachmentBar}
        {draft.persistenceError && (
          <p role="alert" className="text-xs text-destructive">
            {draft.persistenceError}
          </p>
        )}
        {draft.sendError && (
          <p role="alert" className="text-xs text-destructive">
            {draft.sendError}
          </p>
        )}
        <InputGroup>
          <div className="relative w-full min-w-0 flex-1">
            <EditorContent editor={editor} />
            {isEmpty && (
              <span
                className={cn(
                  "pointer-events-none absolute start-3 top-2 text-muted-foreground",
                  compact ? "text-xs" : "text-sm",
                )}
                aria-hidden
              >
                {placeholder ?? "Ask the agent…"}
              </span>
            )}
          </div>
          <InputGroupAddon align="block-end">
            {attachAction}
            {isStreaming ? (
              <span className="ms-auto flex items-center gap-1">
                {queueWhileStreaming && (
                  <AppTooltip content={t("workspace.chatComposer.queueTooltip")}>
                    <InputGroupButton
                      type="button" variant="default" size="icon-sm" onClick={handleSendClick}
                      disabled={isEmpty || draft.isSending || !isConfigured} aria-label={t("workspace.chatComposer.queueMessage")}
                    >
                      <ArrowUp />
                    </InputGroupButton>
                  </AppTooltip>
                )}
                <AppTooltip content={t("common.stop")}>
                  <InputGroupButton
                    type="button" variant="outline" size="icon-sm" onClick={onStop}
                    aria-label={t("common.stop")}
                  >
                    <Square />
                  </InputGroupButton>
                </AppTooltip>
              </span>
            ) : (
              <AppTooltip content={t("autopilot.steering.send")}>
                <InputGroupButton
                  type="button" variant="default" size="icon-sm" onClick={handleSendClick}
                  disabled={isEmpty || draft.isSending || !isConfigured} className="ms-auto" aria-label={t("autopilot.steering.send")}
                >
                  <ArrowUp />
                </InputGroupButton>
              </AppTooltip>
            )}
          </InputGroupAddon>
        </InputGroup>
      </div>
    </div>
  )
})
