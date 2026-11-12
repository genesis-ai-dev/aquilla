/**
 * How an overflow menu's flat item list becomes the labelled groups its
 * `label` items announce (AQU-358). Its own module rather than a second export
 * from `OverflowMenu.tsx`, which must export only its component for fast
 * refresh — the same split as `editor-surface-toolbar.ts`.
 */

import type { OverflowMenuItem } from "@/components/OverflowMenu"

export interface MenuSection {
  id: string
  /** Absent for the leading, unnamed run of items (a menu with no headings
   *  at all is a single such section and renders exactly as it always has). */
  heading?: string
  items: OverflowMenuItem[]
  dividerAbove: boolean
}

/**
 * Split a flat item list into the groups its `label` items announce, so each
 * heading labels its own `DropdownMenuGroup` rather than floating inside one
 * flat group (AQU-358). A separator the caller already put at the end of a run
 * is hoisted to sit ABOVE the next heading instead of dangling under the last
 * item of the group it closed — callers keep writing the separators they always
 * wrote, and adding a heading does not double the spacing.
 */
export function toSections(items: OverflowMenuItem[]): MenuSection[] {
  const sections: MenuSection[] = []
  for (const item of items) {
    if (item.type === "label") {
      sections.push({ id: item.id, heading: item.label ?? "", items: [], dividerAbove: false })
      continue
    }
    if (sections.length === 0) sections.push({ id: "overflow-menu-lead", items: [], dividerAbove: false })
    sections[sections.length - 1]!.items.push(item)
  }
  const isSeparator = (item?: OverflowMenuItem) => item?.type === "separator"
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i]!
    // Trailing separators move ABOVE the next heading — and there can be more
    // than one, since the run of items often arrives as several callers'
    // lists concatenated, each ending in its own divider.
    let hoisted = false
    while (isSeparator(section.items[section.items.length - 1])) {
      section.items.pop()
      hoisted = true
    }
    if (hoisted && sections[i + 1]) sections[i + 1]!.dividerAbove = true
    // A heading immediately followed by a rule is a line with nothing to
    // divide, and two rules in a row are one rule drawn twice.
    while (isSeparator(section.items[0])) section.items.shift()
    section.items = section.items.filter(
      (item, index) => !(isSeparator(item) && isSeparator(section.items[index - 1])),
    )
  }
  // A heading with nothing under it (every item in that run was filtered out
  // upstream) would name an empty group — drop it. Nothing opens a menu with a
  // divider, so whatever survives first never draws one.
  const rendered = sections.filter((section) => section.items.length > 0)
  if (rendered[0]) rendered[0].dividerAbove = false
  return rendered
}
