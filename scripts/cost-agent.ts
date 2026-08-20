// cost-agent — drive the tool-calling agent so its ACU cost can be measured.
// DEV TOOLING for the pricing exercise (companion to cost-run.ts / cost-report.ts).
//
//   npx tsx scripts/cost-agent.ts <projectId> [--only 1,3] [--list]
//
// Why this exists: the autopilot is a FIXED graph — same nodes every span, so
// its cost has low variance. The agent is the tool-calling surface (read,
// search, draft, propose, sql, docs, run_code, …), where the model decides what
// to do next. That decision is where agent compute actually varies, so it can't
// be extrapolated from autopilot numbers — it has to be exercised.
//
// Each task below runs as its own agent run and lands in agent_cost_meter with
// surface='agent': one row per orchestrator turn, one per tool call (wall-clock
// = the infra half of an ACU), and one per tool-internal model call.

const IDENTITY = process.env.DEV_IDENTITY_URL ?? "http://127.0.0.1:8788"

/** Tasks chosen to exercise DIFFERENT tools and different amounts of
 *  exploration — a cheap lookup and an open-ended analysis cost very different
 *  amounts, and that spread is the number we're trying to find. */
const TASKS: { name: string; prompt: string }[] = [
  {
    name: "lookup",
    prompt: "How many verses in this project still have no translation? Give me the number and which files they're in.",
  },
  {
    name: "search",
    prompt: "Find every verse in this project whose Greek contains εὐαγγέλιον. Show the reference and the Greek text for each.",
  },
  {
    name: "consistency",
    prompt: "Look at how the Greek word ἄγγελος has been rendered in the Armenian drafts so far. Is it consistent? If not, show me the variants and say which you'd standardise on.",
  },
  {
    name: "draft",
    prompt: "Draft Armenian translations for the first 5 untranslated verses of Mark. Follow the project's translation brief.",
  },
  {
    name: "terminology",
    prompt: "Propose key-term renderings for the three most frequent theological terms in Mark chapter 1, with a short rationale for each.",
  },
  {
    name: "analysis",
    prompt: "Compute the distribution of verse lengths (in words) across the Greek source in this project — min, median, p90, max — and tell me which verses are outliers.",
  },
]

const argv = process.argv.slice(2)
const projectId = argv.find((a) => !a.startsWith("--"))
if (argv.includes("--list")) {
  TASKS.forEach((t, i) => console.log(`${i + 1}. ${t.name}: ${t.prompt}`))
  process.exit(0)
}
if (!projectId) {
  console.error("usage: npx tsx scripts/cost-agent.ts <projectId> [--only 1,3] [--list]")
  process.exit(1)
}
const onlyArg = argv[argv.indexOf("--only") + 1]
const only = argv.includes("--only")
  ? new Set(onlyArg.split(",").map((n) => Number(n.trim())))
  : null

async function login(): Promise<string> {
  const res = await fetch(`${IDENTITY}/__dev__/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  })
  if (!res.ok) throw new Error(`dev login failed: ${res.status} ${await res.text()}`)
  return ((await res.json()) as { access_token: string }).access_token
}

interface RunSummary {
  task: string
  runId: string
  status: string
  steps: number
  tools: string[]
  promptTokens: number
  completionTokens: number
  ms: number
  error?: string
}

async function runAgent(token: string, task: { name: string; prompt: string }): Promise<RunSummary> {
  const startedAt = Date.now()
  const summary: RunSummary = {
    task: task.name, runId: "", status: "unknown", steps: 0,
    tools: [], promptTokens: 0, completionTokens: 0, ms: 0,
  }

  const res = await fetch(`${IDENTITY}/api/v1/ai/agent/run`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId,
      messages: [{ role: "user", content: task.prompt }],
    }),
  })
  if (!res.ok || !res.body) {
    summary.status = "http_error"
    summary.error = `${res.status}: ${(await res.text()).slice(0, 300)}`
    summary.ms = Date.now() - startedAt
    return summary
  }

  // SSE: frames are `data: {...}` lines. Buffer across chunk boundaries — a
  // frame can be split mid-JSON, and a torn frame silently drops a tool call.
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let prose = 0

  const handle = (frame: Record<string, unknown>): void => {
    switch (frame.type) {
      case "run_start":
        summary.runId = String(frame.runId ?? "")
        break
      case "assistant_delta":
        prose += String(frame.text ?? "").length
        break
      case "code_start": {
        summary.steps++
        const kind = String(frame.kind ?? "?")
        summary.tools.push(kind)
        process.stdout.write(`    → ${kind}: ${String(frame.summary ?? "").slice(0, 70)}\n`)
        break
      }
      case "code_result":
        if (frame.ok === false) {
          process.stdout.write(`      ✗ ${String(frame.summary ?? "").slice(0, 90)}\n`)
        }
        break
      case "usage":
        summary.promptTokens = Number(frame.promptTokens ?? 0)
        summary.completionTokens = Number(frame.completionTokens ?? 0)
        break
      case "done":
        summary.status = String(frame.status ?? "unknown")
        break
      case "error":
        summary.error = String(frame.message ?? "").slice(0, 300)
        break
    }
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).replace(/\r$/, "")
      buffer = buffer.slice(nl + 1)
      if (!line.startsWith("data:")) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === "[DONE]") continue
      try {
        handle(JSON.parse(payload) as Record<string, unknown>)
      } catch {
        /* keep-alive or partial frame — the buffer loop reassembles real ones */
      }
    }
  }

  summary.ms = Date.now() - startedAt
  process.stdout.write(`    (${prose} chars of prose)\n`)
  return summary
}

async function main(): Promise<void> {
  const token = await login()
  const chosen = TASKS.filter((_, i) => !only || only.has(i + 1))
  console.log(`running ${chosen.length} agent task(s) against ${projectId}\n`)

  const results: RunSummary[] = []
  for (const [i, task] of chosen.entries()) {
    console.log(`[${i + 1}/${chosen.length}] ${task.name}`)
    try {
      const r = await runAgent(token, task)
      results.push(r)
      console.log(
        `    ${r.status}  steps=${r.steps}  tokens=${r.promptTokens}/${r.completionTokens}  ${(r.ms / 1000).toFixed(0)}s` +
        (r.error ? `\n    error: ${r.error}` : ""),
      )
    } catch (err) {
      console.log(`    threw: ${String(err).slice(0, 200)}`)
    }
    console.log()
  }

  console.log("── summary ─────────────────────────────────────────────")
  console.log(`${"task".padEnd(14)}${"status".padEnd(9)}${"steps".padStart(6)}${"in".padStart(9)}${"out".padStart(8)}${"sec".padStart(7)}   tools`)
  for (const r of results) {
    console.log(
      r.task.padEnd(14) + r.status.padEnd(9) + String(r.steps).padStart(6) +
      String(r.promptTokens).padStart(9) + String(r.completionTokens).padStart(8) +
      (r.ms / 1000).toFixed(0).padStart(7) + "   " + [...new Set(r.tools)].join(","),
    )
  }
  console.log(`\nNow run: npx tsx scripts/cost-report.ts --project ${projectId}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
