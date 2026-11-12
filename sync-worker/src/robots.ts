/**
 * robots.txt for the API host (`api.aquilla.app`, `api.dev.aquilla.app`).
 *
 * Agent fetch tools read the host's robots.txt before calling the Agent API.
 * The API host has no origin of its own, so without this route Cloudflare
 * answered 522 — and RFC 9309 tells crawlers to treat a 5xx robots.txt as
 * "disallow everything", which made agents refuse to connect. The API is
 * meant for agents, so allow everything.
 */
const ROBOTS_TXT = "User-agent: *\nAllow: /\n"

export function handleRobotsTxt(request: Request): Response | null {
  if (request.method !== "GET" && request.method !== "HEAD") return null
  if (new URL(request.url).pathname !== "/robots.txt") return null
  return new Response(request.method === "HEAD" ? null : ROBOTS_TXT, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  })
}
