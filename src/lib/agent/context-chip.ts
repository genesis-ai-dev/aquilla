/**
 * Client-only model + serialization for AI-chat context chips.
 *
 * A ContextChip is a highlighted SOURCE selection the user attached to an
 * agent message. Chips live in the TipTap composer as atomic nodes; at send
 * time the doc is serialized to ONE user-message string: prose with inline
 * ⟦ctx:N⟧ tokens plus a self-describing "Context" legend. The agent reads the
 * truncated preview inline, or expands a chip to full text via its existing
 * read-only SQL tool keyed by file_id/cell_id. No protocol/server change.
 */

export interface ContextChip {
  chipId: string
  fileId: string
  cellId: string
  canonicalRef?: string
  side: "source"
  selection: string
  preview: string
  fileName?: string
}

export const CHIP_PLACEHOLDER_RE = /⟦chip:([^⟧]+)⟧/g
export const FULL_INLINE_MAX = 280
export const PREVIEW_MAX = 200
export const MAX_CHIPS = 8
export const LEGEND_MAX = 1500
/** Words of the selection a chip shows before "…" (full text on hover). */
export const LABEL_WORDS = 6
const LABEL_CHARS = 48

/**
 * The human-readable name of a chip: the opening words of the selected
 * wording, so the composer pill and the sent bubble both say WHAT was asked
 * about. The verse ref alone was often empty (cells without a context), which
 * rendered as a bare "source" pill and a "[]" in chat history.
 */
export function chipLabel(chip: Pick<ContextChip, "selection" | "canonicalRef">): string {
  const words = chip.selection.replace(/\s+/g, " ").trim().split(" ").filter(Boolean)
  if (words.length === 0) return chip.canonicalRef || "source"
  let label = words.slice(0, LABEL_WORDS).join(" ")
  let cut = words.length > LABEL_WORDS
  if (label.length > LABEL_CHARS) {
    label = label.slice(0, LABEL_CHARS).trimEnd()
    cut = true
  }
  return cut ? `${label}…` : label
}

function capPreview(selection: string): string {
  const s = selection.replace(/\s+/g, " ").trim()
  return s.length <= PREVIEW_MAX ? s : s.slice(0, PREVIEW_MAX) + "…"
}

export function buildSourceChip(input: {
  chipId: string
  fileId: string
  cellId: string
  canonicalRef?: string
  selection: string
  fileName?: string
}): ContextChip {
  return {
    chipId: input.chipId,
    fileId: input.fileId,
    cellId: input.cellId,
    canonicalRef: input.canonicalRef,
    side: "source",
    selection: input.selection,
    preview: capPreview(input.selection),
    fileName: input.fileName,
  }
}

interface JsonNode {
  type?: string
  text?: string
  attrs?: Record<string, unknown>
  content?: JsonNode[]
}

export function serializeDocJSON(doc: { type?: string; content?: unknown[] }): {
  text: string
  chips: ContextChip[]
} {
  const blocks: string[] = []
  const chips: ContextChip[] = []
  const seen = new Set<string>()

  const walkInline = (nodes: JsonNode[] | undefined): string => {
    if (!nodes) return ""
    let out = ""
    for (const n of nodes) {
      if (n.type === "contextChip" && n.attrs) {
        const chip = n.attrs as unknown as ContextChip
        out += `⟦chip:${chip.chipId}⟧`
        if (!seen.has(chip.chipId)) {
          seen.add(chip.chipId)
          chips.push(chip)
        }
      } else if (n.type === "text" && typeof n.text === "string") {
        out += n.text
      } else if (n.content) {
        out += walkInline(n.content)
      }
    }
    return out
  }

  for (const block of (doc.content as JsonNode[] | undefined) ?? []) {
    blocks.push(walkInline(block.content))
  }
  return { text: blocks.join("\n"), chips }
}

export function serializeWithChips(
  text: string,
  chips: ContextChip[],
): { wire: string; display: string } {
  if (chips.length === 0) return { wire: text, display: text }

  const kept = chips.slice(0, MAX_CHIPS)
  const overflow = chips.length - kept.length
  const indexById = new Map(kept.map((c, i) => [c.chipId, i + 1]))

  const replace = (render: (chip: ContextChip, n: number) => string) =>
    text.replace(CHIP_PLACEHOLDER_RE, (_m, id: string) => {
      const n = indexById.get(id)
      const chip = kept.find((c) => c.chipId === id)
      // Dropped (overflow) or unknown chip: leave a readable marker.
      if (!n || !chip) return chip ? `“${chipLabel(chip)}”` : ""
      return render(chip, n)
    })

  const wireText = replace((_c, n) => `⟦ctx:${n}⟧`)
  const display = replace((c) => `“${chipLabel(c)}”`)

  const lines: string[] = [
    "## Context (attached cells — previews truncated; read full text with one SQL query on file_id+cell_id if needed)",
  ]
  for (const c of kept) {
    const n = indexById.get(c.chipId)!
    const quoted = c.selection.length <= FULL_INLINE_MAX ? c.selection : c.preview
    lines.push(`⟦ctx:${n}⟧ ${c.canonicalRef || "source"} · file_id=${c.fileId} cell_id=${c.cellId} · source`)
    lines.push(`   "${quoted}"`)
  }
  if (overflow > 0) lines.push(`…+${overflow} more`)

  let legend = lines.join("\n")
  if (legend.length > LEGEND_MAX) legend = legend.slice(0, LEGEND_MAX) + "\n…"

  return { wire: `${wireText}\n\n${legend}`, display }
}
