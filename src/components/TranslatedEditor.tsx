import { useEditor, EditorContent } from "@tiptap/react"
import { BubbleMenu } from "@tiptap/react/menus"
import StarterKit from "@tiptap/starter-kit"
import Collaboration from "@tiptap/extension-collaboration"
import { Extension } from "@tiptap/core"
import { yCursorPlugin } from "@tiptap/y-tiptap"
import * as Y from "yjs"
import type YProvider from "y-partyserver/provider"
import { Bold, Italic, Underline as UnderlineIcon, Strikethrough, Code } from "lucide-react"
import { cn } from "@/lib/utils"
import { useRef, useEffect } from "react"
import type { RuleInfraction } from "@/lib/parsers/types"
import { createViolationDecorationExtension, violationPluginKey } from "@/lib/richtext/violation-decoration-plugin"

interface TranslatedEditorProps {
  fragment: Y.XmlFragment
  onBlur?: () => void
  placeholder?: string
  className?: string
  // When provided, remote cursors from other peers in this provider's awareness
  // are rendered inline with the given user's name and color for their local cursor.
  syncProvider?: YProvider | null
  user?: { name: string; color: string }
  editable?: boolean
  infractions?: RuleInfraction[]
  ruleSeverity?: Map<string, "major" | "minor">
  waivedRuleIds?: Set<string>
  onRuleClick?: (ruleId: string, anchor: HTMLElement) => void
}

export function TranslatedEditor({ fragment, onBlur, placeholder, className, syncProvider, user, editable = true, infractions, ruleSeverity, waivedRuleIds, onRuleClick }: TranslatedEditorProps) {
  const latestViolationStateRef = useRef({
    infractions: infractions ?? [],
    ruleSeverity: ruleSeverity ?? new Map<string, "major" | "minor">(),
    waivedRuleIds: waivedRuleIds ?? new Set<string>(),
  })

  const editor = useEditor({
    editable,
    extensions: [
      StarterKit.configure({
        // Turn off TipTap's own history — Yjs manages undo/redo via the collab plugin
        undoRedo: false,
        // Disable node types we don't support in cells
        heading: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        blockquote: false,
        codeBlock: false,
        horizontalRule: false,
      }),
      Collaboration.configure({
        fragment,
      }),
      ...(syncProvider && user
        ? [createCollabCursorExtension(syncProvider, user)]
        : []),
      // The callback is invoked by the PM plugin, not during React render —
      // the lint rule is overly conservative here.
      // eslint-disable-next-line react-hooks/refs
      createViolationDecorationExtension(() => latestViolationStateRef.current),
    ],
    editorProps: {
      attributes: {
        class: cn(
          "prose prose-sm max-w-none min-h-[40px] px-2 py-1 text-sm focus:outline-none",
          "border rounded bg-background",
          "focus:ring-1 focus:ring-ring",
          className
        ),
      },
      // Transform pasted HTML to strip anything outside our allowed marks
      transformPastedHTML(html: string) {
        return stripToAllowedHtml(html)
      },
    },
    onBlur: onBlur,
  }, [fragment, syncProvider, user?.name, user?.color])

  // Reset editor when fragment identity changes (switching cells)
  const prevFragmentRef = useRef(fragment)
  useEffect(() => {
    prevFragmentRef.current = fragment
  }, [fragment])

  useEffect(() => {
    editor?.setEditable(editable)
  }, [editor, editable])

  useEffect(() => {
    latestViolationStateRef.current = {
      infractions: infractions ?? [],
      ruleSeverity: ruleSeverity ?? new Map<string, "major" | "minor">(),
      waivedRuleIds: waivedRuleIds ?? new Set<string>(),
    }
    if (editor) {
      const tr = editor.state.tr.setMeta(violationPluginKey, "rebuild")
      editor.view.dispatch(tr)
    }
  }, [editor, infractions, ruleSeverity, waivedRuleIds])

  if (!editor) {
    return <div className={cn("min-h-[40px] px-2 py-1 text-sm border rounded bg-background", className)}>{placeholder}</div>
  }

  return (
    <div className="relative">
      <BubbleMenu
        editor={editor}
        shouldShow={({ editor, from, to }) => {
          // Only show when there's a non-empty text selection
          return editor.isFocused && from !== to
        }}
        options={{
          placement: "top",
        }}
      >
        <div className="flex gap-0.5 rounded border bg-background p-0.5 shadow-sm">
          <button
            type="button"
            onClick={() => editor.chain().focus().toggleBold().run()}
            className={cn(
              "flex h-6 w-6 items-center justify-center rounded text-xs hover:bg-accent",
              editor.isActive("bold") && "bg-accent"
            )}
            title="Bold (Cmd+B)"
          >
            <Bold className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={() => editor.chain().focus().toggleItalic().run()}
            className={cn(
              "flex h-6 w-6 items-center justify-center rounded text-xs hover:bg-accent",
              editor.isActive("italic") && "bg-accent"
            )}
            title="Italic (Cmd+I)"
          >
            <Italic className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={() => editor.chain().focus().toggleUnderline().run()}
            className={cn(
              "flex h-6 w-6 items-center justify-center rounded text-xs hover:bg-accent",
              editor.isActive("underline") && "bg-accent"
            )}
            title="Underline (Cmd+U)"
          >
            <UnderlineIcon className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={() => editor.chain().focus().toggleStrike().run()}
            className={cn(
              "flex h-6 w-6 items-center justify-center rounded text-xs hover:bg-accent",
              editor.isActive("strike") && "bg-accent"
            )}
            title="Strikethrough"
          >
            <Strikethrough className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={() => editor.chain().focus().toggleCode().run()}
            className={cn(
              "flex h-6 w-6 items-center justify-center rounded text-xs hover:bg-accent",
              editor.isActive("code") && "bg-accent"
            )}
            title="Inline code"
          >
            <Code className="h-3 w-3" />
          </button>
        </div>
      </BubbleMenu>
      <div
        onClick={(e) => {
          if (!onRuleClick) return
          const target = e.target as HTMLElement
          const blot = target.closest("[data-rule-id]")
          if (blot) {
            onRuleClick(blot.getAttribute("data-rule-id")!, blot as HTMLElement)
          }
        }}
      >
        <EditorContent editor={editor} />
      </div>
    </div>
  )
}

// Remote-cursor extension. Wraps y-tiptap's yCursorPlugin (TipTap v3 renamed the
// old CollaborationCursor extension; this restores equivalent behavior).
// Publishes the local user's cursor position to the provider's awareness under
// `user: { name, color }`, and renders other peers' cursors as colored carets.
function createCollabCursorExtension(
  provider: YProvider,
  user: { name: string; color: string }
) {
  return Extension.create({
    name: "collaborationCursor",
    onCreate() {
      provider.awareness.setLocalStateField("user", user)
    },
    onDestroy() {
      const current = provider.awareness.getLocalState()
      if (current && current.user) {
        const { user: _removed, ...rest } = current
        void _removed
        provider.awareness.setLocalState(rest)
      }
    },
    addProseMirrorPlugins() {
      return [yCursorPlugin(provider.awareness as unknown as Parameters<typeof yCursorPlugin>[0])]
    },
  })
}

// Strip pasted HTML to only the marks we support.
// Allowed tags: b, strong, i, em, u, s, strike, del, code, p, br
// Everything else is removed (content preserved).
function stripToAllowedHtml(html: string): string {
  const parser = new DOMParser()
  const doc = parser.parseFromString(`<body>${html}</body>`, "text/html")
  walkAndStrip(doc.body)
  return doc.body.innerHTML
}

const ALLOWED_TAGS = new Set(["B", "STRONG", "I", "EM", "U", "S", "STRIKE", "DEL", "CODE", "P", "BR"])

function walkAndStrip(el: Element): void {
  // Walk children (snapshot array since we mutate during iteration)
  const children = Array.from(el.childNodes)
  for (const child of children) {
    if (child.nodeType === 1) {
      const elChild = child as Element
      walkAndStrip(elChild)
      if (!ALLOWED_TAGS.has(elChild.tagName)) {
        // Replace element with its contents
        const parent = elChild.parentNode
        if (parent) {
          while (elChild.firstChild) parent.insertBefore(elChild.firstChild, elChild)
          parent.removeChild(elChild)
        }
      } else {
        // Strip all attributes except none (we don't allow any attributes)
        const attrs = Array.from(elChild.attributes)
        for (const attr of attrs) elChild.removeAttribute(attr.name)
      }
    }
  }
}
