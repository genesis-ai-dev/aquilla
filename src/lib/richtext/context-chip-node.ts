// Atomic inline node for an AI-chat context chip. Pure-DOM NodeView (mirrors
// footnote-node.ts): renders a compact Badge-styled pill showing the canonical
// ref, with the full selection as a native hover tooltip and an × to delete.
// renderText emits ⟦chip:<chipId>⟧ so the serializer can map it to a ctx token.
import { Node, mergeAttributes } from "@tiptap/core"

export const CONTEXT_CHIP_NODE_NAME = "contextChip"

const ATTR_KEYS = [
  "chipId", "fileId", "cellId", "canonicalRef", "side", "selection", "preview", "fileName",
] as const

export const ContextChipNode = Node.create({
  name: CONTEXT_CHIP_NODE_NAME,
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    const attrs: Record<string, { default: unknown }> = {}
    for (const key of ATTR_KEYS) attrs[key] = { default: key === "side" ? "source" : "" }
    return attrs
  },

  parseHTML() {
    return [{ tag: "span[data-context-chip]" }]
  },

  renderHTML({ HTMLAttributes, node }) {
    // Serialize attrs into data-* so getHTML round-trips (not used on the wire).
    const data: Record<string, string> = { "data-context-chip": "" }
    for (const key of ATTR_KEYS) data[`data-${key.toLowerCase()}`] = String(node.attrs[key] ?? "")
    return [
      "span",
      mergeAttributes(HTMLAttributes, data, { class: "context-chip" }),
      (node.attrs.canonicalRef as string) || "source",
    ]
  },

  renderText({ node }) {
    return `⟦chip:${node.attrs.chipId as string}⟧`
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      const dom = document.createElement("span")
      // Match Badge variant="secondary": rounded pill, muted surface.
      dom.className =
        "context-chip inline-flex items-center gap-1 rounded-md border border-transparent " +
        "bg-muted px-1.5 py-0.5 align-baseline text-xs font-medium text-muted-foreground"
      dom.setAttribute("contenteditable", "false")
      const label = (node.attrs.canonicalRef as string) || "source"
      const full = (node.attrs.selection as string) || label
      dom.title = full // native hover tooltip
      dom.setAttribute("data-tooltip", full) // test hook

      const text = document.createElement("span")
      text.textContent = label
      dom.append(text)

      const close = document.createElement("button")
      close.type = "button"
      close.setAttribute("aria-label", `Remove ${label}`)
      close.className = "ml-0.5 rounded-sm text-muted-foreground/60 hover:text-foreground"
      close.textContent = "×"
      close.addEventListener("mousedown", (e) => e.preventDefault())
      close.addEventListener("click", (e) => {
        e.preventDefault()
        if (typeof getPos !== "function") return
        const from = getPos()
        if (from == null) return
        editor.chain().focus().deleteRange({ from, to: from + node.nodeSize }).run()
      })
      dom.append(close)

      return { dom, ignoreMutation: () => true }
    }
  },
})
