"use client"

import { useLayoutEffect, useRef } from "react"

/**
 * A menu, select, or combobox row stays visually plain until the keyboard
 * moves the highlight — the same rule as the notification inbox
 * (`NotificationsInbox`, active index starts at -1).
 *
 * Opening paints nothing. The pointer still gets a hover wash (CSS), and it
 * does not count as the highlight (`highlightItemOnHover` is off on the
 * shared roots). The first ArrowDown / ArrowUp / Home / End / typeahead is
 * what reveals the highlight Base UI already computes: a menu with nothing
 * active starts at an end of the list, and a list that already has a
 * selection moves on from that row.
 *
 * Keyboard-opened popups (ArrowDown on the trigger, Enter, Space) are not
 * held plain — the key that opened them is the keyboard use.
 */

const POPUP_ATTR = "data-keyboard-popup"
const PLAIN_ATTR = "data-plain-until-key"

type OpenIntent = "pointer" | "keyboard"

let openIntent: OpenIntent = "pointer"

if (typeof document !== "undefined") {
  document.addEventListener(
    "pointerdown",
    () => {
      openIntent = "pointer"
    },
    true,
  )
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (isKeyboardOpenKey(event.key)) openIntent = "keyboard"
    },
    true,
  )
}

function isKeyboardOpenKey(key: string): boolean {
  return (
    key === "ArrowDown" ||
    key === "ArrowUp" ||
    key === "Home" ||
    key === "End" ||
    key === "Enter" ||
    key === " "
  )
}

function isRevealKey(key: string): boolean {
  return (
    key === "ArrowDown" ||
    key === "ArrowUp" ||
    key === "Home" ||
    key === "End" ||
    key === "PageDown" ||
    key === "PageUp" ||
    key === "Enter" ||
    key === " " ||
    key === "Backspace" ||
    key === "Delete" ||
    key.length === 1
  )
}

function closestKeyboardPopup(target: EventTarget | null): HTMLElement | null {
  const element =
    target instanceof Element
      ? target
      : target instanceof Node
        ? target.parentElement
        : null
  return element?.closest<HTMLElement>(`[${POPUP_ATTR}]`) ?? null
}

function attachPlainUntilKeyboard(popup: HTMLElement): () => void {
  popup.setAttribute(POPUP_ATTR, "")
  let plain = false
  let sawClosed = false

  const arm = () => {
    plain = openIntent === "pointer"
    if (plain) popup.setAttribute(PLAIN_ATTR, "")
    else popup.removeAttribute(PLAIN_ATTR)
  }

  const disarm = () => {
    if (!plain) return
    plain = false
    popup.removeAttribute(PLAIN_ATTR)
  }

  const belongsHere = (target: EventTarget | null) =>
    closestKeyboardPopup(target) === popup

  const onKeyDown = (event: KeyboardEvent) => {
    if (!plain || event.metaKey || event.ctrlKey || event.altKey) return
    if (!belongsHere(event.target) || !isRevealKey(event.key)) return
    disarm()
  }

  const onInput = (event: Event) => {
    if (!plain || !belongsHere(event.target)) return
    disarm()
  }

  arm()
  popup.addEventListener("keydown", onKeyDown)
  popup.addEventListener("input", onInput)

  // A popup that stays mounted across close/open has to arm again. The
  // close is `data-closed` (exit) or the open attribute leaving.
  const observer = new MutationObserver(() => {
    const open = popup.hasAttribute("data-open")
    if (!open) {
      sawClosed = true
      return
    }
    if (sawClosed) {
      sawClosed = false
      arm()
    }
  })
  observer.observe(popup, { attributes: true, attributeFilter: ["data-open", "data-closed"] })

  return () => {
    observer.disconnect()
    popup.removeEventListener("keydown", onKeyDown)
    popup.removeEventListener("input", onInput)
    popup.removeAttribute(PLAIN_ATTR)
    popup.removeAttribute(POPUP_ATTR)
  }
}

/** Sits inside a popup and arms that popup. Renders nothing visible. */
export function PlainUntilKeyboard() {
  const ref = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const popup = ref.current?.parentElement
    if (!popup) return
    return attachPlainUntilKeyboard(popup)
  }, [])
  return <span ref={ref} hidden aria-hidden data-plain-until-keyboard-anchor="" />
}
