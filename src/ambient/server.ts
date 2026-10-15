/**
 * `ambient serve` — the "inspectable on demand" surface.
 *
 *   /                    inspector UI (review, edit, approve, decide)
 *   /api/*               JSON API used by the UI (and anything else)
 *   /files/<locale>/<doc> download any source document in any language,
 *                        translated on demand
 *   /dav/                read-only WebDAV: mount it in Finder/Explorer and
 *                        browse /dav/<any-locale>/ — folders for languages you
 *                        never configured appear when you open them
 *
 * Binds to 127.0.0.1 only. There is no authentication: this is a local
 * research tool, not a hosted service.
 */
import { createServer } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import { readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { addTerm, approve, decideCorrection, docView, edit, LOCALE_RE, materialize, status } from "./ops.ts"
import type { Workspace } from "./workspace.ts"
import { INSPECTOR_HTML } from "./inspector-html.ts"

const json = (res: ServerResponse, code: number, body: unknown): void => {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" })
  res.end(JSON.stringify(body))
}

const readBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  const s = Buffer.concat(chunks).toString("utf8")
  return s ? (JSON.parse(s) as Record<string, unknown>) : {}
}

const str = (v: unknown, name: string): string => {
  if (typeof v !== "string" || v === "") throw new Error(`missing ${name}`)
  return v
}

const xmlEsc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!)

const MIME: Record<string, string> = {
  ".idml": "application/vnd.adobe.indesign-idml-package",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json; charset=utf-8",
}
const mimeOf = (p: string): string => Object.entries(MIME).find(([ext]) => p.endsWith(ext))?.[1] ?? "application/octet-stream"

export const createHandler = (ws: Workspace) => {
  let busy: Promise<unknown> = Promise.resolve()
  /** Serialise writes: one sync/decision at a time. */
  const exclusive = <T>(fn: () => Promise<T> | T): Promise<T> => {
    const run = busy.then(fn, fn)
    busy = run.catch(() => undefined)
    return run
  }

  const davEntry = (href: string, isDir: boolean, size = 0, mtime = new Date()): string =>
    `<d:response><d:href>${xmlEsc(encodeURI(href))}</d:href><d:propstat><d:prop><d:displayname>${xmlEsc(decodeURIComponent(href.replace(/\/$/, "").split("/").pop() ?? ""))}</d:displayname>${
      isDir ? "<d:resourcetype><d:collection/></d:resourcetype>" : `<d:resourcetype/><d:getcontentlength>${size}</d:getcontentlength><d:getcontenttype>${mimeOf(href)}</d:getcontenttype>`
    }<d:getlastmodified>${mtime.toUTCString()}</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`

  const dav = async (req: IncomingMessage, res: ServerResponse, path: string): Promise<void> => {
    const method = req.method ?? "GET"
    if (method === "OPTIONS") {
      res.writeHead(200, { DAV: "1", Allow: "OPTIONS, GET, HEAD, PROPFIND", "MS-Author-Via": "DAV" })
      res.end()
      return
    }
    const parts = path.split("/").filter(Boolean).map(decodeURIComponent)
    const docs = ws.sources()
    if (method === "PROPFIND") {
      const depth = req.headers.depth ?? "1"
      const out: string[] = []
      if (parts.length === 0) {
        out.push(davEntry("/dav/", true))
        if (depth !== "0") for (const l of [ws.config.sourceLocale, ...ws.config.targets]) out.push(davEntry(`/dav/${l}/`, true))
      } else if (LOCALE_RE.test(parts[0]!)) {
        const locale = parts[0]!
        const rest = parts.slice(1).join("/")
        if (rest === "") {
          out.push(davEntry(`/dav/${locale}/`, true))
          if (depth !== "0") for (const d of docs) out.push(davEntry(`/dav/${locale}/${d}`, false, statSync(join(ws.root, d)).size))
        } else if (docs.includes(rest)) out.push(davEntry(`/dav/${locale}/${rest}`, false, statSync(join(ws.root, rest)).size))
        else if (docs.some((d) => d.startsWith(`${rest}/`))) out.push(davEntry(`/dav/${locale}/${rest}/`, true))
        else {
          res.writeHead(404)
          res.end()
          return
        }
      } else {
        res.writeHead(404)
        res.end()
        return
      }
      res.writeHead(207, { "content-type": 'application/xml; charset="utf-8"' })
      res.end(`<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">${out.join("")}</d:multistatus>`)
      return
    }
    if (method === "GET" || method === "HEAD") {
      const [locale, ...rest] = parts
      const docId = rest.join("/")
      if (!locale || !LOCALE_RE.test(locale) || !docs.includes(docId)) {
        res.writeHead(404)
        res.end()
        return
      }
      const p = locale === ws.config.sourceLocale ? join(ws.root, docId) : await exclusive(() => materialize(ws, docId, locale))
      const bytes = readFileSync(p)
      res.writeHead(200, { "content-type": mimeOf(docId), "content-length": bytes.length })
      res.end(method === "HEAD" ? undefined : bytes)
      return
    }
    res.writeHead(405, { Allow: "OPTIONS, GET, HEAD, PROPFIND" })
    res.end()
  }

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost")
    const path = url.pathname
    try {
      if (path === "/" || path === "/index.html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
        res.end(INSPECTOR_HTML)
        return
      }
      if (path === "/dav" || path.startsWith("/dav/")) return await dav(req, res, path.slice(4))
      if (path.startsWith("/files/")) {
        const [, , locale, ...rest] = path.split("/").map(decodeURIComponent)
        const docId = rest.join("/")
        if (!locale || !LOCALE_RE.test(locale)) return json(res, 400, { error: "bad locale" })
        const p = await exclusive(() => materialize(ws, docId, locale))
        const bytes = readFileSync(p)
        res.writeHead(200, {
          "content-type": mimeOf(docId),
          "content-disposition": `attachment; filename="${encodeURIComponent(docId.split("/").pop()!.replace(/(\.[^.]+)$/, `.${locale}$1`))}"`,
        })
        res.end(bytes)
        return
      }
      if (path === "/api/status") return json(res, 200, status(ws))
      if (path === "/api/doc") return json(res, 200, { docId: url.searchParams.get("doc"), targets: ws.config.targets, units: docView(ws, str(url.searchParams.get("doc"), "doc")) })
      if (path === "/api/report") {
        try {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
          res.end(readFileSync(join(ws.root, "ambient-report.html")))
        } catch {
          res.end("<p>No report yet — run a sync.</p>")
        }
        return
      }
      if (req.method !== "POST") return json(res, 404, { error: "not found" })
      const body = await readBody(req)
      switch (path) {
        case "/api/sync":
          return json(res, 200, await exclusive(() => ws.sync()))
        case "/api/edit":
          return json(res, 200, { logicalId: await exclusive(() => edit(ws, str(body.doc, "doc"), str(body.unit, "unit"), str(body.locale, "locale"), String(body.text ?? ""), "ui")) })
        case "/api/approve":
          return json(res, 200, { approved: await exclusive(() => approve(ws, str(body.doc, "doc"), str(body.locale, "locale"), typeof body.unit === "string" ? body.unit : undefined)) })
        case "/api/term":
          return json(res, 200, { id: await exclusive(() => addTerm(ws, str(body.source, "source"), str(body.target, "target"), str(body.locale, "locale"), typeof body.note === "string" ? body.note : undefined)) })
        case "/api/correction":
          await exclusive(() => decideCorrection(ws, str(body.id, "id"), body.accept === true))
          return json(res, 200, { ok: true })
        default:
          return json(res, 404, { error: "not found" })
      }
    } catch (e) {
      json(res, 400, { error: (e as Error).message })
    }
  }
}

export const serve = async (ws: Workspace, port = 4477): Promise<void> => {
  const handle = createHandler(ws)
  const server = createServer((req, res) => void handle(req, res))
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve))
  console.log(`ambient inspector  http://127.0.0.1:${port}/`)
  console.log(`any-language drive http://127.0.0.1:${port}/dav/   (Finder: Go → Connect to Server)`)
  console.log(`download on demand http://127.0.0.1:${port}/files/<locale>/<file>`)
  await new Promise(() => {})
}
