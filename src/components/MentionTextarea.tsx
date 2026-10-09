import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { InitialsAvatar } from "@/components/InitialsAvatar"
import { MENTION_CHIP_CLASS, mentionTokenRegex } from "@/lib/comments/comment-helpers"
import { cn } from "@/lib/utils"
import { useT } from "@/lib/i18n/I18nProvider"
import {
  applyMention,
  mentionTokenAt,
  rankMentionSuggestions,
  type MentionCandidate,
} from "@/lib/comments/mention-suggest"

const VISIBLE_SUGGESTIONS = 8

interface MentionTextareaProps {
  value: string
  onChange: (value: string) => void
  /** Project members who can be mentioned. The composer does not fetch them. */
  candidates?: readonly MentionCandidate[]
  /** Signed-in username, excluded from the list. */
  currentUsername?: string | null
  placeholder?: string
  rows?: number
  /** Let the text set the height instead of reserving `rows` of space. */
  autoHeight?: boolean
  /** Place the caret after the last character when the field mounts. */
  caretAtEnd?: boolean
  className?: string
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void
  "aria-label"?: string
  "aria-labelledby"?: string
}

/**
 * Comment composer with a project-roster @mention picker.
 *
 * Calls no data hooks: the caller already has the roster (the editor loads it
 * for the assignee picker; the comments page receives the same list). Enter
 * and Tab pick a row only while the list is open and has something to pick,
 * so Cmd/Ctrl+Enter still submits. Escape closes the list and leaves the
 * typed `@name` as plain text. Only Enter, Tab, or a click stores a mention.
 */
export function MentionTextarea({
  value,
  onChange,
  candidates = [],
  currentUsername,
  placeholder,
  rows = 2,
  autoHeight = false,
  caretAtEnd = false,
  className,
  onKeyDown,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
}: MentionTextareaProps) {
  const t = useT()
  const listId = useId()
  const fieldRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [listBox, setListBox] = useState<{
    left: number
    width: number
    top?: number
    bottom?: number
  } | null>(null)
  const [cursor, setCursor] = useState(value.length)
  const [dismissed, setDismissed] = useState<string | null>(null)

  const token = mentionTokenAt(value, cursor)
  const tokenKey = token ? `${token.start}:${token.query}` : null
  const query = token?.query ?? ""
  const suggestions = token
    ? rankMentionSuggestions(candidates, token.query, currentUsername).slice(0, VISIBLE_SUGGESTIONS)
    : []
  const open = token !== null && tokenKey !== dismissed
  const [highlightState, setHighlightState] = useState({ query: "", index: 0 })
  const highlight = highlightState.query === query ? highlightState.index : 0
  const activeIndex = suggestions.length === 0 ? -1 : Math.min(highlight, suggestions.length - 1)

  function setHighlight(index: number) {
    setHighlightState({ query, index })
  }

  useLayoutEffect(() => {
    if (!open) return
    function place() {
      const el = fieldRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const above = rect.top > 160
      setListBox({
        left: rect.left,
        width: rect.width,
        ...(above
          ? { bottom: window.innerHeight - rect.top + 4 }
          : { top: rect.bottom + 4 }),
      })
    }
    place()
    window.addEventListener("resize", place)
    window.addEventListener("scroll", place, true)
    return () => {
      window.removeEventListener("resize", place)
      window.removeEventListener("scroll", place, true)
    }
  }, [open, value, suggestions.length])

  useEffect(() => {
    if (!open) return
    function onDocMouseDown(event: MouseEvent) {
      const target = event.target as Node
      if (containerRef.current?.contains(target) || listRef.current?.contains(target)) return
      setDismissed(tokenKey)
    }
    document.addEventListener("mousedown", onDocMouseDown)
    return () => document.removeEventListener("mousedown", onDocMouseDown)
  }, [open, tokenKey])

  useLayoutEffect(() => {
    const el = fieldRef.current
    if (!el || readField(el) === value) return
    writeField(el, value)
  }, [value])

  useEffect(() => {
    if (!caretAtEnd) return
    const el = fieldRef.current
    if (!el) return
    el.focus()
    placeCaret(el, readField(el).length)
  }, [caretAtEnd])

  useEffect(() => {
    function onSelection() {
      const el = fieldRef.current
      const anchor = window.getSelection()?.anchorNode
      if (!el || !anchor || !el.contains(anchor)) return
      setCursor(caretOffset(el))
    }
    document.addEventListener("selectionchange", onSelection)
    return () => document.removeEventListener("selectionchange", onSelection)
  }, [])

  function insert(username: string) {
    if (!token) return
    const next = applyMention(value, token, username)
    onChange(next.value)
    setDismissed(`${token.start}:picked`)
    const caret = next.caret
    requestAnimationFrame(() => {
      const el = fieldRef.current
      if (!el) return
      writeField(el, next.value)
      placeCaret(el, caret)
      el.focus()
      setCursor(caret)
    })
  }

  function handleInput() {
    const el = fieldRef.current
    if (!el) return
    const next = readField(el)
    setCursor(caretOffset(el))
    if (next !== value) onChange(next)
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const canPick = open && suggestions.length > 0 && activeIndex >= 0
    if (canPick && event.key === "ArrowDown") {
      event.preventDefault()
      setHighlight((activeIndex + 1) % suggestions.length)
      return
    }
    if (canPick && event.key === "ArrowUp") {
      event.preventDefault()
      setHighlight((activeIndex - 1 + suggestions.length) % suggestions.length)
      return
    }
    if (canPick && (event.key === "Enter" || event.key === "Tab") && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault()
      const pick = suggestions[activeIndex]
      if (pick) insert(pick.username)
      return
    }
    if (open && event.key === "Escape") {
      event.preventDefault()
      setDismissed(tokenKey)
      return
    }
    onKeyDown?.(event)
  }

  return (
    <div ref={containerRef} className="relative">
      <div
        ref={fieldRef}
        role="textbox"
        aria-multiline="true"
        contentEditable
        suppressContentEditableWarning
        data-empty={value.length === 0 ? "true" : "false"}
        // The empty hint is a real placeholder attribute. Div typings omit it.
        {...{ placeholder } as React.HTMLAttributes<HTMLDivElement>}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={
          open && activeIndex >= 0 ? `${listId}-opt-${activeIndex}` : undefined
        }
        style={autoHeight ? undefined : { minHeight: `${Math.max(rows, 1) * 1.5}rem` }}
        className={cn(
          "relative w-full whitespace-pre-wrap rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring",
          "data-[empty=true]:before:pointer-events-none data-[empty=true]:before:absolute data-[empty=true]:before:start-2.5 data-[empty=true]:before:top-2 data-[empty=true]:before:text-muted-foreground data-[empty=true]:before:content-[attr(placeholder)]",
          className,
        )}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
      />
      {open && listBox && createPortal(
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={t("comments.mention.suggestionsAria")}
          style={{
            position: "fixed",
            left: listBox.left,
            width: listBox.width,
            top: listBox.top,
            bottom: listBox.bottom,
            zIndex: 60,
          }}
          className="max-h-48 overflow-y-auto rounded-lg bg-popover p-1 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10"
        >
          {suggestions.length === 0 ? (
            <p className="px-1.5 py-1 text-sm text-muted-foreground">
              {candidates.length === 0
                ? t("comments.mention.noMembers")
                : t("comments.mention.noResults")}
            </p>
          ) : (
            <ul>
              {suggestions.map((member, index) => (
                <li key={member.username} role="presentation">
                  <button
                    type="button"
                    id={`${listId}-opt-${index}`}
                    role="option"
                    aria-selected={index === activeIndex}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-start text-sm",
                      index === activeIndex ? "bg-accent/40 text-accent-foreground" : "hover:bg-accent/40",
                    )}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setHighlight(index)}
                    onClick={() => insert(member.username)}
                  >
                    <span aria-hidden className="shrink-0">
                      <InitialsAvatar name={member.username} size="xs" menuSafe />
                    </span>
                    @{member.username}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>,
        document.body,
      )}
    </div>
  )
}

function readField(root: HTMLElement): string {
  let out = ""
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += (node.textContent ?? "").replace(/\u00a0/g, " ")
      return
    }
    if (!(node instanceof HTMLElement)) return
    if (node.dataset.mention) {
      out += `@[${node.dataset.mention}]`
      return
    }
    if (node.tagName === "BR") {
      out += "\n"
      return
    }
    const block = node !== root && (node.tagName === "DIV" || node.tagName === "P")
    if (block && out.length > 0 && !out.endsWith("\n")) out += "\n"
    node.childNodes.forEach(visit)
  }
  root.childNodes.forEach(visit)
  return out === "\n" ? "" : out
}

function caretOffset(root: HTMLElement): number {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || !sel.anchorNode || !root.contains(sel.anchorNode)) {
    return readField(root).length
  }
  const range = document.createRange()
  range.selectNodeContents(root)
  range.setEnd(sel.anchorNode, sel.anchorOffset)
  const holder = document.createElement("div")
  holder.append(range.cloneContents())
  return readField(holder).length
}

function placeCaret(root: HTMLElement, target: number) {
  const sel = window.getSelection()
  if (!sel) return
  let left = target
  const range = document.createRange()
  const visit = (node: Node): boolean => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent ?? "").replace(/\u00a0/g, " ")
      if (left <= text.length) {
        range.setStart(node, left)
        range.collapse(true)
        return true
      }
      left -= text.length
      return false
    }
    if (!(node instanceof HTMLElement)) return false
    if (node.dataset.mention) {
      const len = `@[${node.dataset.mention}]`.length
      if (left <= len) {
        range.setStartAfter(node)
        range.collapse(true)
        return true
      }
      left -= len
      return false
    }
    if (node.tagName === "BR") {
      left -= 1
      return left < 0
    }
    for (const child of node.childNodes) {
      if (visit(child)) return true
    }
    return false
  }
  if (!visit(root)) {
    range.selectNodeContents(root)
    range.collapse(false)
  }
  sel.removeAllRanges()
  sel.addRange(range)
}

function writeField(root: HTMLElement, value: string) {
  root.replaceChildren()
  const re = mentionTokenRegex()
  let last = 0
  let match: RegExpExecArray | null
  while ((match = re.exec(value)) !== null) {
    appendText(root, value.slice(last, match.index))
    root.append(mentionChip(match[1]))
    last = match.index + match[0].length
  }
  appendText(root, value.slice(last))
}

function appendText(root: HTMLElement, text: string) {
  if (!text) return
  const parts = text.split("\n")
  parts.forEach((part, index) => {
    if (index > 0) root.append(document.createElement("br"))
    if (part) root.append(document.createTextNode(part))
  })
}

function mentionChip(username: string): HTMLSpanElement {
  const span = document.createElement("span")
  span.dataset.mention = username
  span.contentEditable = "false"
  span.className = MENTION_CHIP_CLASS
  span.textContent = `@${username}`
  return span
}
