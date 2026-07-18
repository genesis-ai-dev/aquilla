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
//   * read   (default)            : read tool → answer quoting the result
//   * draft  ("draft"/"translate"): draft tool → closing prose (the draft
//                                   tool's INTERNAL model call is answered
//                                   here too — strict [{i,t}] JSON)
//   * check/validate/aquifer      : legacy execute flows (sql/emit/aquifer)
//
// Run: npx tsx scripts/mock-openrouter.ts [port]

import http from "node:http"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const PORT = Number(process.argv[2]) || 9456

interface ChatMessage {
  role: string
  content?: string | null
  tool_calls?: { id: string; function: { name: string; arguments: string } }[]
}

interface MockToolCall {
  id: string
  type: "function"
  function: { name: string; arguments: string }
}

let callSeq = 0

function toolCall(args: Record<string, unknown>): MockToolCall {
  return {
    id: `mock-call-${++callSeq}`,
    type: "function",
    function: { name: "execute", arguments: JSON.stringify(args) },
  }
}

/** A v2 semantic-tool call (read / draft / search / propose …). */
function namedToolCall(name: string, args: Record<string, unknown>): MockToolCall {
  return {
    id: `mock-call-${++callSeq}`,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  }
}

function respond(content: string | null, tool_calls?: MockToolCall[]) {
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

export function scriptMockResponse(messages: ChatMessage[]) {
  const lastUserIndex = messages.findLastIndex((message) => message.role === "user")
  const lastUser = lastUserIndex >= 0 ? messages[lastUserIndex]?.content ?? "" : ""
  const userText = typeof lastUser === "string" ? lastUser : ""

  // The draft tool's INTERNAL model call: numbered source segments in, strict
  // [{i,t}] JSON out. Detected by the user-turn shape the tool builds.
  const translateMatch = userText.match(/^Translate these \d+ segments:/)
  if (translateMatch) {
    const drafts: { i: number; t: string }[] = []
    for (const line of userText.split("\n")) {
      const m = line.match(/^(\d+)\.\s*(?:\[[^\]]*\]\s*)?(.+)$/)
      if (m) drafts.push({ i: Number(m[1]), t: `[bozza] ${m[2].trim()}` })
    }
    return respond(JSON.stringify(drafts))
  }
  // Match action words, not status adjectives: "translated" and "validated"
  // appear in the expanded /status prompt and must not trigger write flows.
  const wantsDraft = /\b(?:draft|translate)\b/i.test(userText)
  const wantsComment = /\b(?:check|comment|review)\b/i.test(userText)
  const wantsValidate = /\bvalidate\b/i.test(userText)
  const wantsAquifer = /aquifer|bible resource|look up|reference data|abraham|chesed/i.test(userText)
  // Only tool results produced for THIS user turn belong to the current loop.
  // Counting the full conversation made a later "hello" reuse the previous
  // turn's read result and print the same working-set dump again.
  const toolResults = messages.slice(lastUserIndex + 1).filter((m) => m.role === "tool")
  const lastTool = toolResults[toolResults.length - 1]
  const lastToolContent = typeof lastTool?.content === "string" ? lastTool.content : ""

  if (/^\s*(?:hi|hello|hey|howdy|good\s+(?:morning|afternoon|evening))[!.?\s]*$/i.test(userText)) {
    return respond(
      "Hi! The local Aquilla agent is ready. Try asking me to draft untranslated cells, review a translation, find something, or show status.",
    )
  }

  if (/^\s*(?:help|what can you do|how do i use (?:this|the agent))[?.!\s]*$/i.test(userText)) {
    return respond(
      "In local scripted mode I can exercise the real read, draft, review, validate, search, and proposal flows. Try `/draft`, `/check`, `/find grace`, or `/status`.",
    )
  }

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

  const wantsRead = /(?:\/status\b|\bstatus\b|\bcurrent state\b|\bworking set\b|\bprogress\b|\bshow\b|\blist\b|\bread\b|\bfind\b|open file|what(?:'s| is).*(?:file|cell|translated|untranslated))/i.test(userText)

  if (!wantsDraft && wantsRead) {
    // Default read flow — exercises the semantic read tool and its typed
    // working-set payload.
    if (toolResults.length === 0) {
      return respond("Let me look at the open file.", [
        namedToolCall("read", { filter: "all", limit: 30 }),
      ])
    }
    return respond(
      `Here's the current state (status untranslated = still needs work):\n\n\`\`\`\n${lastToolContent.slice(0, 1500)}\n\`\`\``,
    )
  }

  if (!wantsDraft) {
    return respond(
      "I'm running in deterministic local mode, so open-ended conversation is limited. Try `/draft`, `/check`, `/find …`, or `/status` to exercise the agent tools; configure a real OpenRouter key for unrestricted conversation.",
    )
  }

  // Draft flow — one call to the drafting pipeline; the tool's internal model
  // call loops back to this mock (the Translate-these branch above).
  if (toolResults.length === 0) {
    return respond("Drafting the untranslated cells with the project's own patterns.", [
      namedToolCall("draft", {}),
    ])
  }
  return respond(
    "I staged the drafts — review them in the proposal card (or the workbench working set) and apply the ones you want.",
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
      const out = scriptMockResponse(parsed.messages ?? [])
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify(out))
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: String(err) }))
    }
  })
})

const isDirectRun = process.argv[1]
  ? resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
  : false

if (isDirectRun) {
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`[mock-openrouter] listening on http://127.0.0.1:${PORT}/api/v1/chat/completions`)
  })
}
