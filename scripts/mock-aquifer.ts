// Scripted Bible Aquifer mock for the dev/e2e stack.
//
// Speaks just enough of bibletranslation.org's agent API
// (/api/search, /api/page, /api/answers) so the shared client
// (auth-worker/src/lib/aquifer/client.ts), the agent execute.aquifer branch,
// the Search-dock Bible-resources mode, and the publish proposal all run for
// real against deterministic data — no network to the live site. Point the
// worker at it with:
//
//   AQUIFER_BASE_URL=http://127.0.0.1:9457
//
// Run: npx tsx scripts/mock-aquifer.ts [port]

import http from "node:http"

const PORT = Number(process.argv[2]) || 9457

interface Hit {
  title: string
  url: string
  kind: string
  description: string
}

const PEOPLE: Record<string, { title: string; text: string }> = {
  "/en/people/abraham/": {
    title: "Abraham — Bible Translation Guide | mock",
    text: "Abraham\nThe first patriarch of Israel, originally named Abram. Husband of Sarah, Hagar, and Keturah.\nGender: male Roles: Shepherd, Patriarch\nFamily\nFather: Terah\nChildren: Ishmael, Isaac\nBible References:\nGenesis 11:29-30, Genesis 21:4, Matthew 1:2",
  },
}

const PASSAGES: Record<string, { title: string; text: string }> = {
  "/en/passages/RUT/1/8/": {
    title: "Ruth 1:8 — Translation Notes & Study Guide | mock",
    text: 'Ruth 1:8\nTranslation notes and study guidance from 9 scholarly sources.\nVerse Text\nKJV\nAnd Naomi said unto her two daughters in law, Go, return each to her mother\'s house.\nTranslation Notes\nRuth 1:8 (#1)\nFrom UWTranslationNotes\n"to her two daughters-in-law"\nAlternate translation: "to her two sons\' wives"',
  },
}

function searchResults(q: string): Hit[] {
  const query = q.toLowerCase()
  const all: Hit[] = [
    {
      title: "Abraham",
      url: "https://bibletranslation.org/en/people/abraham/",
      kind: "person",
      description: "The first patriarch of Israel, originally named Abram.",
    },
    {
      title: "Ruth 1:8",
      url: "https://bibletranslation.org/en/passages/RUT/1/8/",
      kind: "translator-question",
      description: "Translation notes and study guidance for Ruth 1:8.",
    },
    {
      title: "chesed (covenant faithfulness)",
      url: "https://bibletranslation.org/en/terms/chesed/",
      kind: "term",
      description: "Hebrew term for steadfast love / covenant loyalty.",
    },
  ]
  const matched = all.filter(
    (h) => h.title.toLowerCase().includes(query) || h.description.toLowerCase().includes(query),
  )
  return (matched.length ? matched : all).slice(0, 5)
}

function pageFor(path: string): { title: string; text: string } | null {
  return PEOPLE[path] ?? PASSAGES[path] ?? null
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(body))
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`)

  if (req.method === "GET" && url.pathname === "/api/search") {
    const q = url.searchParams.get("q") ?? ""
    const lang = url.searchParams.get("lang") ?? "en"
    const limit = Number(url.searchParams.get("limit") ?? 5)
    const results = searchResults(q).slice(0, limit)
    sendJson(res, 200, {
      query: q,
      lang,
      count: results.length,
      results,
      hints: { read_page: "/api/page?path=<url path>", publish: "/api/answers" },
    })
    return
  }

  if (req.method === "GET" && url.pathname === "/api/page") {
    const path = url.searchParams.get("path") ?? ""
    const maxChars = Number(url.searchParams.get("max_chars") ?? 15000)
    const page = pageFor(path)
    if (!page) {
      sendJson(res, 404, { error: "not found", path })
      return
    }
    const text = page.text.slice(0, maxChars)
    sendJson(res, 200, {
      path,
      url: `https://bibletranslation.org${path}`,
      title: page.title,
      truncated: text.length < page.text.length,
      text,
    })
    return
  }

  if (req.method === "POST" && url.pathname === "/api/answers") {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      try {
        const payload = JSON.parse(body) as { question?: string; citations?: unknown[] }
        if (!payload.question || !Array.isArray(payload.citations) || payload.citations.length < 1) {
          sendJson(res, 400, { error: "question and >=1 citation required" })
          return
        }
        const slug = payload.question
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 60)
        sendJson(res, 200, { url: `https://bibletranslation.org/qa/${slug}/`, slug, status: "created" })
      } catch (err) {
        sendJson(res, 400, { error: String(err) })
      }
    })
    return
  }

  res.writeHead(404).end("not found")
})

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock-aquifer] listening on http://127.0.0.1:${PORT} (/api/search, /api/page, /api/answers)`)
})
