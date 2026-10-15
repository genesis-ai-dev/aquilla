/**
 * `ambient mcp` — the agent surface. Any MCP client (Claude Desktop, Claude
 * Code, an email agent…) can inspect and steer a localization folder in plain
 * conversation: "why is paragraph 3 different in French?", "always translate
 * 'church hall' as 'salle paroissiale'", "give me the brochure in Swahili".
 *
 * `ambient_view` is the "generate the UI you need" idea in its smallest form:
 * the agent asks for a focused, self-contained HTML view of exactly the units
 * it is discussing, instead of the user learning a TMS screen.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { addTerm, approve, decideCorrection, docView, edit, materialize, status } from "./ops.ts"
import type { UnitView } from "./ops.ts"
import { Workspace } from "./workspace.ts"

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] })

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!)

export const renderView = (title: string, targets: readonly string[], units: readonly UnitView[]): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>:root{--bg:#fbfaf7;--fg:#1d1c1a;--muted:#6b6862;--line:#e7e3da;--h:#7a4fb3;--a:#2f6f5e}@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecebe6;--muted:#a3a097;--line:#2e2d2a;--h:#c3a3f0;--a:#7cc4ad}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif}main{max-width:1000px;margin:0 auto;padding:24px 16px}h1{font-size:18px}
table{width:100%;border-collapse:collapse}td,th{border-bottom:1px solid var(--line);padding:8px;vertical-align:top;text-align:left}th{color:var(--muted);font-size:12px;text-transform:uppercase}
.au{font-size:11px;color:var(--muted)}.au.human{color:var(--h)}.au.approved{color:var(--a)}@media (max-width:640px){table,tr,td,th{display:block}th{display:none}}</style></head>
<body><main><h1>${esc(title)}</h1><table><tr><th>Source</th>${targets.map((l) => `<th>${esc(l)}</th>`).join("")}</tr>${units
    .map(
      (u) =>
        `<tr><td>${esc(u.source)}<div class="au">${esc(u.kind)} · ${esc(u.logicalId)}</div></td>${targets
          .map((l) => {
            const t = u.targets[l]
            return `<td>${t ? esc(t.text) : "—"}<div class="au ${t?.authority ?? ""}">${t ? `${t.authority}${t.stale ? " · source changed" : ""}` : "missing"}</div></td>`
          })
          .join("")}</tr>`,
    )
    .join("")}</table></main></body></html>`

export const buildMcpServer = (root: string): McpServer => {
  const ws = (): Workspace => Workspace.open(root, process.env.AMBIENT_ACTOR ?? "agent")
  const server = new McpServer({ name: "aquilla-ambient", version: "0.1.0" })

  server.registerTool(
    "ambient_status",
    { description: "Overview of the localization folder: documents, target languages, open conflicts, suggested corrections, glossary.", inputSchema: {} },
    async () => text(status(ws())),
  )
  server.registerTool(
    "ambient_sync",
    { description: "Bring every translated file up to date with its source. Only changed content is retranslated; human edits are preserved.", inputSchema: {} },
    async () => {
      const s = await ws().sync()
      return text({ written: s.written, docs: s.docs.map((d) => ({ docId: d.docId, identity: d.identity, locales: d.locales.map((l) => ({ locale: l.locale, translated: l.translated, reused: l.reused, review: l.review.length, conflicts: l.conflicts.length, humanEditsCaptured: l.humanEditsCaptured })) })) })
    },
  )
  server.registerTool(
    "ambient_units",
    {
      description: "List a document's units with source text and every target translation, including who authored each (agent, human, approved). Use `query` to filter by text.",
      inputSchema: { doc: z.string().describe("Document path relative to the folder, e.g. brochure.idml"), query: z.string().optional() },
    },
    async ({ doc, query }) => {
      const units = docView(ws(), doc).filter((u) => !query || JSON.stringify(u).toLowerCase().includes(query.toLowerCase()))
      return text(units.slice(0, 200))
    },
  )
  server.registerTool(
    "ambient_edit",
    {
      description: "Record a human-authored translation for one unit. It becomes authoritative: later model output will not overwrite it. Inline tags like <g1>…</g1> and <x1/> from the source must be kept.",
      inputSchema: { doc: z.string(), unit: z.string().describe("logical id, 1-based number, or a fragment of the source text"), locale: z.string(), text: z.string() },
    },
    async ({ doc, unit, locale, text: t }) => text({ recorded: edit(ws(), doc, unit, locale, t, "agent-tool"), note: "Run ambient_sync to publish." }),
  )
  server.registerTool(
    "ambient_approve",
    { description: "Approve the current translation of one unit, or of a whole document when `unit` is omitted.", inputSchema: { doc: z.string(), locale: z.string(), unit: z.string().optional() } },
    async ({ doc, locale, unit }) => text({ approved: approve(ws(), doc, locale, unit) }),
  )
  server.registerTool(
    "ambient_add_term",
    { description: "Add an organisation glossary decision. Only units containing the term are retranslated on the next sync.", inputSchema: { source: z.string(), target: z.string(), locale: z.string(), note: z.string().optional() } },
    async ({ source, target, locale, note }) => text({ id: addTerm(ws(), source, target, locale, note) }),
  )
  server.registerTool(
    "ambient_correction",
    { description: "Accept or reject a correction suggested from a human edit. Accepted corrections propagate to every machine translation in that language.", inputSchema: { id: z.string(), accept: z.boolean() } },
    async ({ id, accept }) => {
      decideCorrection(ws(), id, accept)
      return text({ ok: true })
    },
  )
  server.registerTool(
    "ambient_open",
    { description: "Produce any document in any language on demand (even languages not configured) and return the file path.", inputSchema: { doc: z.string(), locale: z.string() } },
    async ({ doc, locale }) => text({ path: await materialize(ws(), doc, locale) }),
  )
  server.registerTool(
    "ambient_view",
    {
      description: "Generate a focused, self-contained HTML review page for the units under discussion and return its path. Use it when a person wants to see rather than read.",
      inputSchema: { doc: z.string(), query: z.string().optional(), title: z.string().optional() },
    },
    async ({ doc, query, title }) => {
      const w = ws()
      const units = docView(w, doc).filter((u) => !query || JSON.stringify(u).toLowerCase().includes(query.toLowerCase()))
      const dir = join(w.root, ".ambient", "views")
      mkdirSync(dir, { recursive: true })
      const path = join(dir, `${doc.replace(/[^\w.-]+/g, "_")}${query ? `-${query.replace(/[^\w]+/g, "_").slice(0, 30)}` : ""}.html`)
      writeFileSync(path, renderView(title ?? `${doc}${query ? ` — “${query}”` : ""}`, w.config.targets, units))
      return text({ path, units: units.length })
    },
  )
  return server
}

export const runMcp = async (root: string): Promise<void> => {
  await buildMcpServer(root).connect(new StdioServerTransport())
}
