/**
 * Change reports (spec §5: "produce a reviewable change report"). One sync,
 * one report: what changed in the source, what was reused vs translated,
 * what needs a human, what the layout check found.
 */
import type { AmbientConfig, SyncSummary } from "../ambient/workspace.ts"
import type { LedgerState } from "../core/ledger.ts"
import { humanConflicts, openConflicts } from "../core/ledger.ts"
import type { LocaleReport } from "./pipeline.ts"

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!)
const clip = (s: string, n = 140): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const pct = (a: number, b: number): string => (b === 0 ? "—" : `${Math.round((100 * a) / b)}%`)

export const renderMarkdownReport = (summary: SyncSummary, state: LedgerState, config: AmbientConfig): string => {
  const lines: string[] = []
  lines.push(`# Ambient sync report`, ``, `${summary.startedAt} · ${summary.durationMs} ms · ${config.sourceLocale} → ${config.targets.join(", ")}`, ``)
  const totals = summary.docs.flatMap((d) => d.locales)
  const units = totals.reduce((n, l) => n + l.total, 0)
  const translated = totals.reduce((n, l) => n + l.translated, 0)
  const review = totals.reduce((n, l) => n + l.review.length, 0)
  const edits = totals.reduce((n, l) => n + l.humanEditsCaptured, 0)
  lines.push(
    `**${summary.docs.length}** document(s) · **${translated}** of ${units} unit-translations produced this run (${pct(units - translated, units)} reused) · **${edits}** human edit(s) captured · **${review}** item(s) for review · **${summary.written.length}** file(s) written`,
    ``,
  )
  for (const d of summary.docs) {
    lines.push(`## ${d.docId}`, ``)
    const id = Object.entries(d.identity).map(([k, v]) => `${v} ${k}`).join(", ")
    lines.push(d.sourceChanged ? `Source changed (rev \`${d.revision}\`): ${id}${d.deleted ? `, ${d.deleted} deleted` : ""}.` : `Source unchanged.`, ``)
    for (const x of d.diagnostics.filter((x) => x.severity !== "info")) lines.push(`- ⚠️ ${x.code}: ${x.message}`)
    for (const l of d.locales) lines.push(...localeSection(l))
  }
  const hc = humanConflicts(state)
  const oc = openConflicts(state)
  if (hc.length || oc.length) {
    lines.push(`## Needs a decision`, ``)
    for (const c of oc) lines.push(`- **${c.kind}** \`${c.id}\` (${c.docId}${c.locale ? ` · ${c.locale}` : ""}): ${c.detail}`)
    for (const c of hc) lines.push(`- **concurrent human edits** on \`${c.logicalId}\` (${c.docId} · ${c.locale}): ${c.versions.map((v) => `${v.actor}: "${clip(v.content, 60)}"`).join(" vs ")}`)
    lines.push(``)
  }
  return lines.join("\n")
}

const localeSection = (l: LocaleReport): string[] => {
  const out: string[] = []
  const reasons = Object.entries(l.byReason).map(([k, v]) => `${k} ${v}`).join(" · ")
  out.push(`### → ${l.locale}`, ``)
  out.push(`${l.total} units: ${reasons}. Translated ${l.translated}; patches applied ${l.patch.applied}, skipped ${l.patch.skipped}, rejected ${l.patch.rejected}.${l.published ? " Published." : ""}${l.besideTarget ? " **Written beside the existing file (not overwritten).**" : ""}`, ``)
  if (l.humanEditsCaptured) out.push(`- ✍️ ${l.humanEditsCaptured} edit(s) made directly in the ${l.locale} file were recorded as human decisions and will be preserved.`)
  if (l.correctionsApplied) out.push(`- 🔁 Accepted corrections were propagated to ${l.correctionsApplied} other unit(s).`)
  for (const s of l.suggestions) {
    out.push(`- 💡 Suggested correction \`${s.id}\`: "${s.from}" → "${s.to}"${s.otherUnits ? ` (appears in ${s.otherUnits} other machine-translated unit(s))` : ""}. Accept with \`ambient correction accept ${s.id}\`.`)
  }
  for (const r of l.review) out.push(`- 👀 **Review** \`${r.logicalId}\` — ${r.reason}\n  - source: ${clip(r.source)}\n  - target: ${clip(r.target)}`)
  for (const f of l.layout.filter((f) => f.severity !== "ok")) {
    out.push(`- 📐 Layout ${f.severity === "overset" ? "**overset risk**" : "tight"} in ${f.scope}: ${f.detail}${f.repair ? `; suggested repair: ${f.repair}` : ""}`)
  }
  for (const d of l.diagnostics.filter((d) => d.severity !== "info")) out.push(`- ${d.severity === "error" ? "❌" : "⚠️"} ${d.code}: ${d.message}${d.unitId ? ` (${d.unitId})` : ""}`)
  out.push(``)
  return out
}

export const renderHtmlReport = (summary: SyncSummary, state: LedgerState, config: AmbientConfig): string => {
  const md = renderMarkdownReport(summary, state, config)
  // A tiny markdown-to-HTML pass is enough for this report's constructs.
  const body = md
    .split("\n")
    .map((line) => {
      const inline = (s: string): string =>
        esc(s)
          .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
          .replace(/`([^`]+)`/g, "<code>$1</code>")
      if (line.startsWith("### ")) return `<h3>${inline(line.slice(4))}</h3>`
      if (line.startsWith("## ")) return `<h2>${inline(line.slice(3))}</h2>`
      if (line.startsWith("# ")) return `<h1>${inline(line.slice(2))}</h1>`
      if (line.startsWith("  - ")) return `<div class="sub">${inline(line.slice(4))}</div>`
      if (line.startsWith("- ")) return `<div class="item">${inline(line.slice(2))}</div>`
      return line.trim() ? `<p>${inline(line)}</p>` : ""
    })
    .join("\n")
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ambient report</title>
<style>
:root{--bg:#fbfaf7;--fg:#1d1c1a;--muted:#6b6862;--card:#fff;--line:#e7e3da;--accent:#2f6f5e}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecebe6;--muted:#a3a097;--card:#1d1c1a;--line:#2e2d2a;--accent:#7cc4ad}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:860px;margin:0 auto;padding:32px 16px 64px}
h1{font-size:26px;margin:0 0 4px}h2{font-size:19px;margin:32px 0 8px;padding-top:16px;border-top:1px solid var(--line)}h3{font-size:16px;margin:20px 0 6px;color:var(--accent)}
p{margin:6px 0;color:var(--muted)}.item{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:6px 0}
.sub{margin:2px 0 2px 24px;color:var(--muted);font-size:14px}code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--line);padding:1px 5px;border-radius:5px}
</style></head><body><main>${body}</main></body></html>`
}
