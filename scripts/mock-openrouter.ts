// Scripted OpenRouter mock for the translation agent dev/e2e loop.
//
// Speaks just enough of the OpenAI chat-completions protocol (non-streaming,
// tool calls) for auth-worker/src/routes/agent.ts: the worker loop, SQL guard,
// compression, emit staging, proposals, and the client UI all run for real —
// only the model's "brain" is a deterministic script keyed on the user's
// message. Point the worker at it with:
//
//   OPENROUTER_BASE_URL=http://127.0.0.1:9456/api/v1
//   OPENROUTER_API_KEY=mock
//
// Flows:
//   * read   (default)            : sql → answer quoting the result block
//   * draft  ("draft"/"translate"): sql for untranslated cells → emit drafts
//                                   → closing prose
//
// Run: npx tsx scripts/mock-openrouter.ts [port]

import http from "node:http"

const PORT = Number(process.argv[2]) || 9456

interface ChatMessage {
  role: string
  content?: string | null
  tool_calls?: { id: string; function: { name: string; arguments: string } }[]
}

let callSeq = 0

function toolCall(args: Record<string, unknown>) {
  return {
    id: `mock-call-${++callSeq}`,
    type: "function",
    function: { name: "execute", arguments: JSON.stringify(args) },
  }
}

function respond(content: string | null, tool_calls?: unknown[]) {
  return {
    id: `mock-${Date.now()}-${callSeq}`,
    choices: [
      {
        message: { role: "assistant", content, ...(tool_calls ? { tool_calls } : {}) },
        finish_reason: tool_calls ? "tool_calls" : "stop",
      },
    ],
    usage: { prompt_tokens: 1200, completion_tokens: 180, cost: 0.0004 },
  }
}

const READ_SQL = `SELECT s.cell_id, s.canonical_ref, s.value AS source_text, t.value AS target_text
FROM cells s
JOIN files f ON f.id = s.file_id
LEFT JOIN cells t
  ON t.project_id = s.project_id AND t.file_id = s.file_id
 AND t.cell_id = s.cell_id AND t.side = 'target'
WHERE s.project_id = :project AND s.side = 'source' AND f.name = 'Ruth'
ORDER BY s.canonical_ref`

const DRAFT_SQL = `SELECT s.cell_id, s.file_id, s.canonical_ref, s.value AS source_text
FROM cells s
JOIN files f ON f.id = s.file_id
LEFT JOIN cells t
  ON t.project_id = s.project_id AND t.file_id = s.file_id
 AND t.cell_id = s.cell_id AND t.side = 'target'
WHERE s.project_id = :project AND s.side = 'source' AND f.name = 'Ruth'
  AND s.canonical_ref IS NOT NULL
  AND (t.value IS NULL OR t.value = '')
ORDER BY s.canonical_ref`

/** Parse the compressed pipe table: header row with named columns, then rows. */
function parseTable(block: string): Record<string, string>[] {
  const lines = block.split("\n").map((l) => l.trim()).filter(Boolean)
  const headerIdx = lines.findIndex((l) => l.includes("cell_id"))
  if (headerIdx < 0) return []
  const cols = lines[headerIdx].split("|").map((c) => c.trim())
  const rows: Record<string, string>[] = []
  for (const line of lines.slice(headerIdx + 1)) {
    if (!line.includes("|")) continue
    const cells = line.split("|").map((c) => c.trim())
    if (cells.length !== cols.length) continue
    const row: Record<string, string> = {}
    cols.forEach((c, i) => (row[c] = cells[i]))
    rows.push(row)
  }
  return rows
}

const TRANSLATED_SQL = `SELECT s.cell_id, s.file_id, s.canonical_ref, s.value AS source_text, t.value AS target_text
FROM cells s
JOIN files f ON f.id = s.file_id
JOIN cells t
  ON t.project_id = s.project_id AND t.file_id = s.file_id
 AND t.cell_id = s.cell_id AND t.side = 'target'
WHERE s.project_id = :project AND s.side = 'source' AND f.name = 'Ruth'
  AND t.value <> ''
ORDER BY s.canonical_ref`

function script(messages: ChatMessage[]) {
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? ""
  const userText = typeof lastUser === "string" ? lastUser : ""
  const wantsDraft = /draft|translate/i.test(userText)
  const wantsComment = /check|comment|review/i.test(userText)
  const wantsValidate = /validate/i.test(userText)
  const wantsAquifer = /aquifer|bible resource|look up|reference data|abraham|chesed/i.test(userText)
  const toolResults = messages.filter((m) => m.role === "tool")
  const lastTool = toolResults[toolResults.length - 1]
  const lastToolContent = typeof lastTool?.content === "string" ? lastTool.content : ""

  // Bible-resources flow: search → read the top hit → stage a publish proposal.
  // Exercises the execute.aquifer branch + the aquifer_publish proposal card.
  if (wantsAquifer) {
    if (toolResults.length === 0) {
      return respond("Searching the Bible reference data.", [toolCall({ aquifer: { op: "search", q: "abraham" } })])
    }
    if (toolResults.length === 1) {
      const m = lastToolContent.match(/—\s*(\/\S+)\s*—/)
      const path = m ? m[1] : "/en/people/abraham/"
      return respond("Reading the top result.", [toolCall({ aquifer: { op: "read", path } })])
    }
    if (toolResults.length === 2) {
      return respond("Publishing what I found.", [
        toolCall({
          aquifer: {
            op: "publish",
            question: "Who was Abraham in the biblical narrative?",
            answer:
              "Abraham (originally Abram) is the first patriarch of Israel, husband of Sarah, and father of Isaac and Ishmael.",
            status: "answered",
            citations: [{ url: "https://bibletranslation.org/en/people/abraham/", quote: "first patriarch of Israel" }],
          },
        }),
      ])
    }
    return respond("I staged a Q&A to publish — review the card and click Apply to post it to the wiki.")
  }

  // Reviewer flows: stage a comment finding, or validate translated cells.
  if (wantsComment || wantsValidate) {
    if (toolResults.length === 0) {
      return respond("Reading the translated cells.", [toolCall({ sql: TRANSLATED_SQL })])
    }
    if (toolResults.length === 1) {
      const rows = parseTable(lastToolContent).slice(0, 2)
      if (rows.length === 0) return respond("No translated cells to review yet.")
      const events = wantsValidate
        ? rows.map((r) => ({ kind: "cell.validate", fileId: r.file_id, cellId: r.cell_id, payload: {} }))
        : rows.slice(0, 1).map((r) => ({
            kind: "comment.create",
            fileId: r.file_id,
            cellId: r.cell_id,
            payload: {
              scope: { kind: "cell", fileId: r.file_id, cellId: r.cell_id },
              body: `Mock finding on ${r.canonical_ref}: draft reads literally; consider a more natural rendering.`,
            },
          }))
      return respond(wantsValidate ? "Validating the drafts." : "Leaving a review note.", [
        toolCall({ emit: events }),
      ])
    }
    return respond("Staged — review and apply.")
  }

  if (!wantsDraft) {
    if (toolResults.length === 0) {
      return respond("Let me check the cells in this file.", [toolCall({ sql: READ_SQL })])
    }
    return respond(
      `Here's the current state of Ruth (rows with target_text ∅ still need translation):\n\n\`\`\`\n${lastToolContent.slice(0, 1500)}\n\`\`\``,
    )
  }

  // Draft flow.
  if (toolResults.length === 0) {
    return respond("Reading the untranslated cells first.", [toolCall({ sql: DRAFT_SQL })])
  }
  if (toolResults.length === 1) {
    const rows = parseTable(lastToolContent).slice(0, 10)
    if (rows.length === 0) {
      return respond("Every cell in Ruth already has a translation — nothing to draft.")
    }
    const events = rows.map((r) => ({
      kind: "target.cell.commit",
      fileId: r.file_id,
      cellId: r.cell_id,
      payload: { value: `[bozza] ${r.source_text.replace(/…$/, "")}` },
    }))
    return respond(`Drafting ${events.length} cells.`, [toolCall({ emit: events })])
  }
  return respond(
    "I staged the drafts — review them in the proposal card and click Apply to commit.",
  )
}

const server = http.createServer((req, res) => {
  if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
    res.writeHead(404).end("not found")
    return
  }
  let body = ""
  req.on("data", (c) => (body += c))
  req.on("end", () => {
    try {
      const parsed = JSON.parse(body) as { messages: ChatMessage[] }
      const out = script(parsed.messages ?? [])
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify(out))
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: String(err) }))
    }
  })
})

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock-openrouter] listening on http://127.0.0.1:${PORT}/api/v1/chat/completions`)
})
