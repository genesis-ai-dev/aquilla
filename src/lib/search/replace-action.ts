import * as Y from "yjs"
import {
  getFragmentHtml,
  getPlainText,
  setFragmentFromHtml,
  setPlainText,
} from "@/lib/richtext/translated-xml"
import { commitCellEdit } from "@/lib/codex-editor/edits/commit-cell-edit"
import { appendCellHistory, toggleCellValidation } from "@/hooks/useCellHistory"
import { loadFileDoc, destroyFileDoc } from "@/lib/store/file-doc"

export interface ReplaceOptions {
  find: string
  replace: string
  caseSensitive?: boolean
  /**
   * When false, the cell's validatedBy entries are cleared after replace
   * (matches codex-editor's "Retain Validations" unchecked behavior). Default
   * true because the user explicitly authored the replacement.
   */
  retainValidations?: boolean
}

export interface ReplaceTarget {
  fileId: string
  cellId: string
}

export interface ReplaceResult extends ReplaceTarget {
  success: boolean
  before: string
  after: string
  error?: string
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Literal case-(in)sensitive replace in a string, returning [newText, occurrences].
 */
export function replacePlain(
  text: string,
  find: string,
  replace: string,
  caseSensitive: boolean,
): { text: string; count: number } {
  if (!find) return { text, count: 0 }
  const flags = caseSensitive ? "g" : "gi"
  const re = new RegExp(escapeRegex(find), flags)
  let count = 0
  const next = text.replace(re, () => {
    count++
    return replace
  })
  return { text: next, count }
}

/**
 * Replace matches only inside text nodes of an HTML fragment, preserving
 * element markup (bold/italic/etc). Mirrors codex-editor's
 * replaceTextPreservingHtml. Falls back to plain replace if DOM parsing
 * fails.
 */
export function replaceInHtmlTextNodes(
  html: string,
  find: string,
  replace: string,
  caseSensitive: boolean,
): { html: string; count: number } {
  if (!find) return { html, count: 0 }
  if (typeof DOMParser === "undefined") {
    const r = replacePlain(html, find, replace, caseSensitive)
    return { html: r.text, count: r.count }
  }
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html")
  let count = 0
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
  let node: Node | null = walker.nextNode()
  const flags = caseSensitive ? "g" : "gi"
  const re = new RegExp(escapeRegex(find), flags)
  while (node) {
    const text = node.nodeValue ?? ""
    if (text) {
      const next = text.replace(re, () => {
        count++
        return replace
      })
      if (next !== text) node.nodeValue = next
    }
    node = walker.nextNode()
  }
  return { html: doc.body.innerHTML, count }
}

/**
 * Preview-only plain-text replace for a single cell's translated text.
 * Returns what the text would look like after replacement, plus the count.
 */
export function previewCellReplace(
  translated: string,
  opts: ReplaceOptions,
): { after: string; count: number } {
  const { text, count } = replacePlain(
    translated,
    opts.find,
    opts.replace,
    Boolean(opts.caseSensitive),
  )
  return { after: text, count }
}

/**
 * Apply the replacement to a single cell's target text and record history.
 * If the cell has a translatedXml fragment, the replacement runs HTML-aware
 * so formatting marks survive; otherwise it falls back to plain text.
 */
export function applyReplaceToCell(
  doc: Y.Doc,
  cellId: string,
  opts: ReplaceOptions,
  username: string,
): ReplaceResult {
  const cells = doc.getMap("cells")
  const cell = cells.get(cellId) as Y.Map<unknown> | undefined
  if (!cell) {
    return {
      fileId: "",
      cellId,
      success: false,
      before: "",
      after: "",
      error: "Cell not found",
    }
  }
  const frag = cell.get("translatedXml") as Y.XmlFragment | undefined
  const before = frag ? getPlainText(frag) : ((cell.get("translated") as string) ?? "")
  const caseSensitive = Boolean(opts.caseSensitive)

  try {
    let after = before
    if (frag) {
      const html = getFragmentHtml(frag)
      const { html: nextHtml, count } = replaceInHtmlTextNodes(
        html,
        opts.find,
        opts.replace,
        caseSensitive,
      )
      if (count === 0) {
        return { fileId: "", cellId, success: false, before, after: before, error: "No match" }
      }
      doc.transact(() => {
        setFragmentFromHtml(frag, nextHtml)
      })
      // Re-extract plain text so history + ledger reflect the new value
      after = getPlainText(frag)
    } else {
      const { text, count } = replacePlain(before, opts.find, opts.replace, caseSensitive)
      if (count === 0) {
        return { fileId: "", cellId, success: false, before, after: before, error: "No match" }
      }
      doc.transact(() => {
        const f2 = cell.get("translatedXml") as Y.XmlFragment | undefined
        if (f2) setPlainText(f2, text)
        else cell.set("translated", text)
      })
      after = text
    }

    // Ledger entry (user-edit, value editMap). commitCellEdit auto-validates
    // the author. We strip that validation immediately if retainValidations
    // is false to preserve the "cleared validations" UX.
    commitCellEdit(doc, cellId, username, ["value"], after, "human")
    appendCellHistory(doc, cellId, {
      value: after,
      source: "human",
      author: username,
      validated: false,
    })
    if (opts.retainValidations === false) {
      toggleCellValidation(doc, cellId, username, false)
    }
    return { fileId: "", cellId, success: true, before, after }
  } catch (err) {
    return {
      fileId: "",
      cellId,
      success: false,
      before,
      after: before,
      error: err instanceof Error ? err.message : "Replace failed",
    }
  }
}

/**
 * Apply replacement across a set of (fileId, cellId) targets. The active
 * file's Y.Doc should be passed as `activeDoc` to avoid a second ref-count
 * round-trip through the registry; other files are loaded on demand.
 */
export async function applyReplaceBatch(
  targets: ReplaceTarget[],
  opts: ReplaceOptions,
  username: string,
  context: { activeFileId: string | null; activeDoc: Y.Doc | null },
  onProgress?: (done: number, total: number) => void,
): Promise<ReplaceResult[]> {
  const byFile = new Map<string, string[]>()
  for (const t of targets) {
    const list = byFile.get(t.fileId) ?? []
    list.push(t.cellId)
    byFile.set(t.fileId, list)
  }

  const out: ReplaceResult[] = []
  let done = 0
  const total = targets.length

  for (const [fileId, cellIds] of byFile) {
    const isActive = fileId === context.activeFileId && !!context.activeDoc
    const handle = isActive ? null : loadFileDoc(fileId)
    const doc = isActive ? context.activeDoc! : handle!.doc
    try {
      if (!isActive && handle) {
        await new Promise<void>((resolve) => {
          if (handle.persistence.synced) resolve()
          else handle.persistence.once("synced", () => resolve())
        })
      }
      for (const cellId of cellIds) {
        const res = applyReplaceToCell(doc, cellId, opts, username)
        out.push({ ...res, fileId })
        done++
        onProgress?.(done, total)
      }
    } finally {
      if (handle) destroyFileDoc(handle)
    }
  }
  return out
}
