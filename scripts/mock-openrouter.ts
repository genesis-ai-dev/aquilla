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

// ── Contextual pipeline nodes (auth-worker/src/lib/contextual/*) ────────────
// Each node's system prompt carries a routing marker ([[ctx:construe]],
// [[ctx:summarize]], [[ctx:draft]], [[ctx:verify:<stance>]]) so the mock can
// return a VALID canned JSON body per node without sniffing prompt copy.

/** Cell ids referenced as "[<id>]" in the construe window block. */
function extractBracketIds(text: string): string[] {
  const ids: string[] = []
  for (const m of text.matchAll(/^\[([^\]]+)\]/gm)) ids.push(m[1])
  return ids
}

/** Numbered lines "N. text" (draft input / verifier draft block). */
function extractNumberedLines(text: string): { i: number; body: string }[] {
  const out: { i: number; body: string }[] = []
  for (const line of text.split("\n")) {
    const m = line.match(/^(\d+)\.\s*(?:\[[^\]]*\]\s*)?(.*)$/)
    if (m) out.push({ i: Number(m[1]), body: m[2].trim() })
  }
  return out
}

function contextualMockResponse(marker: string, userText: string) {
  if (marker.startsWith("construe")) {
    // Closed minimal construal echoing the window's cell ids as evidence.
    return respond(JSON.stringify({
      situation: "A mock narrator relates the span's events to the reader.",
      participants: ["narrator", "reader"],
      tenor: "neutral, informative",
      moves: ["relate", "conclude"],
      closed: true,
      openQuestions: [],
      evidenceCellIds: extractBracketIds(userText),
    }))
  }
  if (marker.startsWith("summarize")) {
    return respond("Mock scene brief: a narrator relates the span's events to the reader in a neutral, informative tenor.")
  }
  if (marker.startsWith("draft")) {
    const lines = extractNumberedLines(userText)
    return respond(JSON.stringify(lines.map(({ i, body }) => ({ i, t: `MOCK ${body}` }))))
  }
  if (marker.startsWith("verify")) {
    const count = Number(userText.match(/Verify these (\d+) drafted cells/)?.[1] ?? 0)
    const cells = Array.from({ length: count }, (_, idx) => ({ i: idx + 1, approve: true }))
    return respond(JSON.stringify({ approve: true, reason: "mock: no failure found", cells }))
  }
  return respond(`[mock] unknown contextual marker: ${marker}`)
}

export function scriptMockResponse(messages: ChatMessage[]) {
  // (Manual reverse scan — .findLastIndex needs lib es2023, which the
  // auth-worker tsconfig, whose tests import this module, doesn't target.)
  let lastUserIndex = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIndex = i
      break
    }
  }
  const lastUser = lastUserIndex >= 0 ? messages[lastUserIndex]?.content ?? "" : ""
  const userText = typeof lastUser === "string" ? lastUser : ""

  // Contextual pipeline node? Route on the [[ctx:*]] system-prompt marker
  // (server-owned contract — adversarial file content cannot select this).
  for (const message of messages) {
    if (message.role !== "system" || typeof message.content !== "string") continue
    const ctx = message.content.match(/\[\[ctx:([a-z:]+)\]\]/)
    if (ctx) return contextualMockResponse(ctx[1], userText)
  }

  const importerSystemPrompt = messages.some((message) =>
    message.role === "system"
      && typeof message.content === "string"
      && message.content.includes("You classify file structure for a translation import pipeline."),
  )

  // Unified importer classification: the browser sends a sample and asks for
  // a constrained declarative recipe. Return data only; the client validates
  // and applies it locally to the complete file. Route on the server-owned
  // system contract, not sample/user wording, so adversarial file contents
  // cannot select mock behavior and harmless prompt copy edits do not break
  // this E2E boundary.
  if (importerSystemPrompt && userText.includes("<file-sample>")) {
    return respond(JSON.stringify({
      category: "scripture",
      confidence: 0.98,
      explanation: "Pipe-delimited bilingual Scripture records with explicit structural types.",
      recipe: {
        name: "Pipe-delimited Scripture records",
        inputFormat: "legacy-pipe-records",
        config: {
          recordMode: "delimited",
          delimiter: "pipe",
          hasHeader: true,
          sourceField: "source",
          targetField: "target",
          referenceField: "reference",
          typeField: "kind",
        },
      },
    }))
  }

  // Copilot single-cell draft (buildPrompt in completion-service.ts): the user
  // message ends with "Source: <text>\nTranslation:" awaiting the completion.
  // Answer deterministically so the editor sparkle/Replace flow works end-to-end.
  const copilotMatch = /(?:^|\n)Source: (.*)\nTranslation:$/.exec(userText.trimEnd())
  if (copilotMatch) {
    return respond(`[mock] ${copilotMatch[1].trim()}`)
  }

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
      const parsed = JSON.parse(body) as { messages: ChatMessage[]; stream?: boolean }
      const out = scriptMockResponse(parsed.messages ?? [])
      // The copilot editor requests SSE (stream: true). Replay the scripted
      // message as a couple of OpenAI-style delta frames + [DONE] so the
      // SPA's consumeStream sees real content instead of an unparsed JSON body.
      // Tool-call responses stay non-streaming (the agent loop never streams).
      if (parsed.stream && !out.choices[0].message.tool_calls) {
        res.writeHead(200, { "Content-Type": "text/event-stream" })
        const content = out.choices[0].message.content ?? ""
        const mid = Math.ceil(content.length / 2)
        for (const chunk of [content.slice(0, mid), content.slice(mid)]) {
          if (!chunk) continue
          res.write(`data: ${JSON.stringify({ id: out.id, choices: [{ delta: { content: chunk } }] })}\n\n`)
        }
        res.write("data: [DONE]\n\n")
        res.end()
        return
      }
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
