/**
 * TipTap extensions that map the placeholder-tokens schema (`phRef` atomic
 * node, `phStyle` inline mark) into the editor.
 *
 * `PhStyleMark` wraps editable text in a styling tag (the ProseMirror
 * equivalent of bold or italic, but tied to a tagId from the cell's
 * tag_dictionary). The text inside is freely editable; the mark is a
 * decoration that survives round-trip serialization.
 *
 * `PhRefNode` is an atomic, non-editable inline chip representing a
 * reference (footnote, anchor) whose content lives in another cell.
 * Users can delete it as a unit but cannot type into it.
 */

import { Mark, mergeAttributes, Node } from "@tiptap/core"

export const PhStyleMark = Mark.create({
  name: "phStyle",
  inclusive: false,
  addAttributes() {
    return {
      tagId: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-ph-style") ?? "",
        renderHTML: (attrs) => ({
          "data-ph-style": attrs.tagId as string,
        }),
      },
    }
  },
  parseHTML() {
    return [{ tag: "span[data-ph-style]" }]
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, { class: "ph-style" }),
      0,
    ]
  },
})

export const PhRefNode = Node.create({
  name: "phRef",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes() {
    return {
      tagId: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-ph-ref") ?? "",
        renderHTML: (attrs) => ({
          "data-ph-ref": attrs.tagId as string,
        }),
      },
    }
  },
  parseHTML() {
    return [{ tag: "span[data-ph-ref]" }]
  },
  renderHTML({ HTMLAttributes, node }) {
    const tagId = (node.attrs.tagId as string) || ""
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        class: "ph-ref",
        contenteditable: "false",
      }),
      `{${tagId}}`,
    ]
  },
})

/** All v2 placeholder extensions, ready to spread into a TipTap editor's extensions array. */
export const placeholderExtensions = [PhStyleMark, PhRefNode] as const
