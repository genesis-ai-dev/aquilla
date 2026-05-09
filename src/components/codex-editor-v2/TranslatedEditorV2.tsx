/**
 * Cell editor for the new architecture: TipTap stays, but we stop binding
 * it to a Y.XmlFragment as the persistent CRDT. Instead the editor's content
 * is initialized from `translation_text` + `tag_dictionary` on mount, and
 * edits are debounced through `onCommit(serializedText, jsonDoc)` — the
 * caller is responsible for upserting to local-store and enqueuing the
 * outbox `cell.set_translation` mutation.
 *
 * See DATA_PERSISTENCE_PLAN.md §6 (cell content) and the editor refactor
 * checklist Phase E.
 */

import { useEditor, EditorContent } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import { useEffect, useRef } from "react"
import {
  parseTranslationText,
  serializeProseMirrorDoc,
  placeholderExtensions,
  type PMDoc,
  type TagDictionary,
} from "@/lib/codex-editor-v2"

export interface TranslatedEditorV2Props {
  /** Stable identifier for the cell — used as a key by the parent to remount on switch. */
  cellId: string
  /** Plain text with placeholder tokens. Source of initial editor content. */
  translationText: string
  /** Per-cell tag dictionary; classifies each placeholder token. */
  tagDictionary: TagDictionary
  /**
   * Called after the user has stopped typing for `debounceMs` (default 400).
   * Receives the serialized plain text *and* the ProseMirror JSON in case
   * the caller wants to persist both forms.
   */
  onCommit: (text: string, doc: PMDoc) => void
  /** Disable the editor surface. */
  editable?: boolean
  /** Override the typing-quiesce debounce. */
  debounceMs?: number
  className?: string
}

export function TranslatedEditorV2({
  cellId,
  translationText,
  tagDictionary,
  onCommit,
  editable = true,
  debounceMs = 400,
  className,
}: TranslatedEditorV2Props) {
  // Keep the latest commit callback in a ref so the editor's onUpdate
  // closure doesn't go stale across renders.
  const commitRef = useRef(onCommit)
  useEffect(() => {
    commitRef.current = onCommit
  }, [onCommit])

  // Track the last text we committed so debounced re-emits with no real
  // change are skipped.
  const lastCommittedRef = useRef(translationText)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const editor = useEditor(
    {
      editable,
      extensions: [
        StarterKit.configure({
          heading: false,
          bulletList: false,
          orderedList: false,
          listItem: false,
          blockquote: false,
          codeBlock: false,
          horizontalRule: false,
        }),
        ...placeholderExtensions,
      ],
      content: parseTranslationText(translationText, tagDictionary),
      onUpdate({ editor }) {
        if (debounceTimerRef.current) {
          clearTimeout(debounceTimerRef.current)
        }
        debounceTimerRef.current = setTimeout(() => {
          const doc = editor.getJSON() as PMDoc
          const text = serializeProseMirrorDoc(doc)
          if (text === lastCommittedRef.current) return
          lastCommittedRef.current = text
          commitRef.current(text, doc)
        }, debounceMs)
      },
    },
    [cellId],
  )

  useEffect(() => {
    if (editor) editor.setEditable(editable)
  }, [editor, editable])

  // If the upstream cell text changes from outside (e.g. server broadcast
  // applied to local-store), reset the editor — but only when the change
  // is foreign (we just committed text won't loop).
  useEffect(() => {
    if (!editor) return
    if (translationText === lastCommittedRef.current) return
    lastCommittedRef.current = translationText
    const json = parseTranslationText(translationText, tagDictionary)
    editor.commands.setContent(json, { emitUpdate: false })
  }, [editor, translationText, tagDictionary])

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)
    }
  }, [])

  return (
    <EditorContent
      editor={editor}
      data-testid={`editor-v2-${cellId}`}
      className={className}
    />
  )
}
