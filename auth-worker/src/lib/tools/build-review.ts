// Aquilla Tools builder — the self-review pass (AQU-1793). After a candidate
// passes the gates, the same model reads it against the requirements checklist
// and the UI bar (UI_CHECKS), re-marks every requirement, and — when a must is
// missing/partial or a UI check fails — writes concrete fix instructions. The
// builder then applies them once (a normal edit_tool call). Cheap: the review
// replies with JSON only.

import { normalizeRequirements, type ToolRequirement } from "../../../../shared/tools/requirements"
import { UI_CHECKS } from "./build-prompt-guide"
import { TOOLS_DOMAIN_PROMPT } from "./build-prompt-guide"

export interface UiCheck {
  check: string
  ok: boolean
  note?: string
}

export interface BuildReview {
  requirements: ToolRequirement[]
  ui: UiCheck[]
  /** Concrete instructions for one fix pass, or null when nothing needs fixing. */
  fix: string | null
}

export const TOOLS_REVIEW_SYSTEM_PROMPT = `You review an Aquilla extension (one HTML document running in a sandboxed
iframe, talking to the app through \`aquilla\` / the \`aq\` SDK) before the user sees it. Be strict and concrete.

1. For each numbered requirement, decide from the CODE (not the plan) whether it is "covered", "partial" or
   "missing". Keep "not_possible" when the bridge truly cannot support it (and keep its reason); change a
   "not_possible" to "missing" if the bridge could support it after all. Something that works only when the
   project has imported that data as a file (originals, TN, TW, ULT/UST) is "partial", and the note says so.
   One short "note" per row.
2. Check the code against each UI check below; ok=false with a short note when it fails.
3. If any "must" is missing/partial (and possible) or any UI check fails, write "fix": numbered, concrete
   instructions a developer can apply in one pass (what to remove, what to add, which aq component to use).
   Otherwise "fix": null. Never ask for anything the bridge cannot do.
Keep it short: each "note" at most 12 words, "fix" at most 10 numbered lines.

UI checks:
${UI_CHECKS.map((c, i) => `${i + 1}. ${c}`).join("\n")}

${TOOLS_DOMAIN_PROMPT}

Reply with ONE fenced block and nothing else:
\`\`\`review
{ "requirements": [{ "id": 1, "status": "covered", "note": "…" }], "ui": [{ "check": "no-duplicate-header", "ok": true }], "fix": null }
\`\`\``

/** Deterministic findings the review should not miss (cheap string checks, fed in as hints). */
export function staticUiFindings(source: string, manifest: { name?: string; description?: string; mounts?: string[] }): string[] {
  const out: string[] = []
  const name = (manifest.name ?? "").trim()
  const lower = source.toLowerCase()
  if (name) {
    const n = name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    if (new RegExp(`<h[1-3][^>]*>\\s*${n}\\s*</h[1-3]>`, "i").test(source) || new RegExp(`title:\\s*["'\`]${n}["'\`]`, "i").test(source)) {
      out.push(`no-duplicate-header: the code draws the extension's own name ("${name}") as a heading`)
    }
  }
  if (/save(s|d)? automatically|autosave|no save button/i.test(source) && /(>|label:\s*["'`])\s*(save|done)\s*(<|["'`])/i.test(source)) {
    out.push("honest-copy: the copy says edits save automatically, but the UI also has a Save/Done button")
  }
  const body = /<body[^>]*>([\s\S]*?)<script/i.exec(source)?.[1] ?? ""
  if (!/skel|loading|spinner/i.test(body) && !/aq\.ui\.spinner/i.test(lower)) {
    out.push("loading-skeleton: no loading placeholder in the static HTML")
  }
  if (/aquilla\.cells\.(list|page|commit)/.test(source) && !/aq\.(celllist|cellrow|targeteditor)/i.test(lower)) {
    out.push("sdk-components: cells are read/edited with hand-rolled UI instead of aq.CellList / aq.CellRow / aq.TargetEditor")
  }
  return out
}

export function buildReviewMessage(input: {
  request: string
  requirements: ToolRequirement[]
  manifestJson: string
  source: string
  findings: string[]
}): string {
  return [
    `The user's request:\n\n${input.request}`,
    `Requirements (the coder's plan):\n\`\`\`json\n${JSON.stringify(input.requirements, null, 2)}\n\`\`\``,
    input.findings.length ? `Automatic checks flagged (confirm or dismiss each):\n${input.findings.map((f) => `- ${f}`).join("\n")}` : "",
    `Manifest:\n\`\`\`json\n${input.manifestJson}\n\`\`\``,
    `Source:\n\`\`\`html\n${input.source}\n\`\`\``,
  ].filter(Boolean).join("\n\n")
}

/** The review block → a normalized review (null when unreadable: the build proceeds unreviewed). */
export function parseReview(text: string): BuildReview | null {
  const m = /```(?:review|json)\s*\n([\s\S]*?)\n```/i.exec(text)
  if (!m) return null
  let raw: unknown
  try {
    raw = JSON.parse(m[1])
  } catch {
    return null
  }
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  const ui: UiCheck[] = Array.isArray(r.ui)
    ? r.ui.flatMap((u) => {
        if (!u || typeof u !== "object") return []
        const x = u as Record<string, unknown>
        if (typeof x.check !== "string") return []
        return [{ check: x.check.slice(0, 60), ok: x.ok !== false, ...(typeof x.note === "string" && x.note ? { note: x.note.slice(0, 200) } : {}) }]
      })
    : []
  // Review rows carry only id/status/note; give them a placeholder text so normalize keeps them.
  const rows = Array.isArray(r.requirements)
    ? r.requirements.map((x) => (x && typeof x === "object" ? { text: "·", ...(x as object) } : x))
    : []
  const fix = typeof r.fix === "string" && r.fix.trim() ? r.fix.trim().slice(0, 4000) : null
  return { requirements: normalizeRequirements(rows), ui, fix }
}

export function buildFixMessage(request: string, fix: string): string {
  return [
    `Original request:\n\n${request}`,
    `A review of your build found these problems. Fix all of them in one pass, keep everything that works:\n\n${fix}`,
    `Return the complete tool in the same three-block format; the requirements block carries the final status of every row ("covered", "partial", "not_possible" + note).`,
  ].join("\n\n")
}
