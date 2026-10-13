// Ghost-text next-word suggestions (BIA forecasting) for the target editor.
//
// The suggestion is a ProseMirror widget DECORATION at the caret — it is never
// part of the document, so it can never reach getHTML()/getText(), a snapshot,
// or a commit. Only an explicit accept (Tab = all; → at the end = one word, ← in RTL text)
// writes it, as an ordinary text insertion that then flows through the editor's
// normal idle/blur commit path like typed text. Esc dismisses.
//
// Queries go to the forecast client (a Web Worker) on a short debounce after
// any doc or caret change; a result is dropped if the doc or caret moved while
// it was in flight.

import { Extension } from "@tiptap/core"
import { Plugin, PluginKey, TextSelection, type EditorState } from "@tiptap/pm/state"
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view"
import type { ForecastClient } from "@/lib/forecast/forecast-client"
import { isSpaceless, segmentWords } from "@/lib/forecast/forecast-tokenize"

export interface GhostText {
  pos: number
  text: string
}

export const ghostTextPluginKey = new PluginKey<GhostText | null>("ghostText")

export const GHOST_TEXT_DEBOUNCE_MS = 120

export interface GhostTextOptions {
  /** Null turns suggestions off (setting disabled, no corpus, IDML cell). */
  getClient: () => ForecastClient | null
  getCellId: () => string
  debounceMs?: number
  /** Focus probe; defaults to `view.hasFocus()` (overridable for tests). */
  hasFocus?: (view: EditorView) => boolean
}

/** Plain text on both sides of an empty selection, or null. */
export function caretContext(state: EditorState): { left: string; right: string; pos: number } | null {
  const { selection, doc } = state
  if (!selection.empty) return null
  const pos = selection.head
  return {
    left: doc.textBetween(0, pos, " ", " "),
    right: doc.textBetween(pos, doc.content.size, " ", " "),
    pos,
  }
}

export function getGhostText(state: EditorState): GhostText | null {
  return ghostTextPluginKey.getState(state) ?? null
}

function setGhost(view: EditorView, ghost: GhostText | null): void {
  view.dispatch(view.state.tr.setMeta(ghostTextPluginKey, ghost).setMeta("addToHistory", false))
}

export function dismissGhostText(view: EditorView): boolean {
  if (!getGhostText(view.state)) return false
  setGhost(view, null)
  return true
}

/** Insert `text` at the ghost position; keep `rest` showing after it. */
/**
 * Caret position right after an accept, per view. An accepted suggestion ends
 * on a whole word, so the next suggestion there is the NEXT word (with a
 * leading space), not a completion of the word just accepted.
 */
const acceptedAt = new WeakMap<EditorView, number>()

function insertGhost(view: EditorView, ghost: GhostText, text: string, rest: string): void {
  const end = ghost.pos + text.length
  const tr = view.state.tr.insertText(text, ghost.pos)
  tr.setSelection(TextSelection.create(tr.doc, end))
  tr.setMeta(ghostTextPluginKey, rest ? { pos: end, text: rest } : null)
  acceptedAt.set(view, end)
  view.dispatch(tr)
}

/** Accept the whole suggestion (Tab). */
export function acceptGhostText(view: EditorView): boolean {
  const ghost = getGhostText(view.state)
  if (!ghost) return false
  insertGhost(view, ghost, ghost.text, "")
  return true
}

/** Accept up to the end of the next word (→). */
export function acceptGhostWord(view: EditorView): boolean {
  const ghost = getGhostText(view.state)
  if (!ghost) return false
  // Up to the end of the first WORD (segmented, so it works without spaces).
  const first = segmentWords(ghost.text)[0]
  const word = first ? ghost.text.slice(0, first.end) : ghost.text
  insertGhost(view, ghost, word, ghost.text.slice(word.length))
  return true
}

function forwardArrow(view: EditorView): "ArrowRight" | "ArrowLeft" {
  const dom = view.dom as HTMLElement
  const direction = dom.closest("[dir]")?.getAttribute("dir")
    ?? (typeof getComputedStyle === "function" ? getComputedStyle(dom).direction : "ltr")
  return direction === "rtl" ? "ArrowLeft" : "ArrowRight"
}

/**
 * Key handling for the editor's own `handleKeyDown` prop, which runs before
 * plugin key handlers — call this first there. True when the key was used.
 */
export function handleGhostKeyDown(view: EditorView, event: KeyboardEvent): boolean {
  if (!getGhostText(view.state) || event.isComposing) return false
  const plain = !event.shiftKey && !event.metaKey && !event.altKey && !event.ctrlKey
  if (!plain) return false
  if (event.key === "Tab") {
    event.preventDefault()
    return acceptGhostText(view)
  }
  // "Accept one word" is the arrow that moves FORWARD in reading order: → in
  // left-to-right text, ← in right-to-left (Hebrew, Arabic) text.
  if (event.key === forwardArrow(view) && view.endOfTextblock("forward")) {
    event.preventDefault()
    return acceptGhostWord(view)
  }
  if (event.key === "Escape") {
    event.preventDefault()
    return dismissGhostText(view)
  }
  return false
}

function ghostWidget(text: string): HTMLElement {
  const span = document.createElement("span")
  span.className = "ghost-text pointer-events-none select-none text-muted-foreground/60"
  span.setAttribute("data-testid", "ghost-text")
  span.setAttribute("aria-hidden", "true")
  span.contentEditable = "false"
  span.textContent = text
  return span
}

export function createGhostTextExtension(options: GhostTextOptions) {
  const debounceMs = options.debounceMs ?? GHOST_TEXT_DEBOUNCE_MS
  const hasFocus = options.hasFocus ?? ((view: EditorView) => view.hasFocus())
  return Extension.create({
    name: "ghostText",
    addProseMirrorPlugins() {
      let timer: ReturnType<typeof setTimeout> | null = null
      const cancel = () => {
        if (timer !== null) clearTimeout(timer)
        timer = null
      }
      const schedule = (view: EditorView) => {
        cancel()
        const client = options.getClient()
        if (!client || view.composing || !hasFocus(view)) return
        timer = setTimeout(() => {
          timer = null
          const asked = view.state
          const context = caretContext(asked)
          // An empty cell is asked too: with a source verse the worker can
          // offer the first word; without one it answers nothing.
          if (!context) return
          const continuing = acceptedAt.get(view) === context.pos && !/\s$/u.test(context.left)
          // Scripts written without spaces continue with no space.
          const lead = continuing && !isSpaceless(context.left.at(-1)) ? " " : ""
          void client
            .suggest(context.left + lead, context.right, { excludeCellId: options.getCellId(), limit: 1 })
            .then(([best]) => {
              // Not a closure flag: TipTap reconfigures plugins (e.g. when the
              // bubble menu registers), which destroys one plugin view and
              // creates another for the same, still-live editor view.
              if (view.isDestroyed || !best) return
              const now = view.state
              if (now.doc !== asked.doc || !now.selection.eq(asked.selection) || !hasFocus(view)) return
              setGhost(view, { pos: context.pos, text: lead + best.insert })
            })
            .catch(() => undefined)
        }, debounceMs)
      }
      return [
        new Plugin<GhostText | null>({
          key: ghostTextPluginKey,
          state: {
            init: () => null,
            apply(tr, value) {
              const meta = tr.getMeta(ghostTextPluginKey) as GhostText | null | undefined
              if (meta !== undefined) return meta
              return tr.docChanged || tr.selectionSet ? null : value
            },
          },
          props: {
            decorations(state) {
              const ghost = ghostTextPluginKey.getState(state)
              if (!ghost) return DecorationSet.empty
              return DecorationSet.create(state.doc, [
                Decoration.widget(ghost.pos, () => ghostWidget(ghost.text), {
                  side: 1,
                  key: `ghost:${ghost.pos}:${ghost.text}`,
                  ignoreSelection: true,
                }),
              ])
            },
            handleDOMEvents: {
              focus(view) {
                schedule(view)
                return false
              },
              blur(view) {
                cancel()
                if (getGhostText(view.state)) setGhost(view, null)
                return false
              },
            },
          },
          view() {
            return {
              update(view, prev) {
                if (view.state.doc !== prev.doc || !view.state.selection.eq(prev.selection)) schedule(view)
              },
              destroy() {
                cancel()
              },
            }
          },
        }),
      ]
    },
  })
}
