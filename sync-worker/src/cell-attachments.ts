// AQU-777: per-cell file attachments (primarily screenshots) backed by the
// same R2 bucket as audio and snapshots.
//
// R2 layout:
//   {prefix}projects/{projectId}/files/{fileId}/attachments/{objectName}
//
// A sibling of audio.ts rather than a generalisation of it. The two differ on
// exactly the things that matter here — what content types are allowed
// (audio.ts deny-lists browser-renderable types and keeps everything else;
// this one ALLOW-lists raster images, because the whole point is that the
// browser renders them), how big an upload may be, and whether Range matters
// (it does for a 40-minute dub, not for a screenshot) — so folding them
// together would mean a handler that is two handlers behind one flag.
// The security-relevant primitives (`isPathSafeId`, the admin bearer compare,
// the token verification) are imported, not re-implemented.
//
// Auth mirrors audio.ts: PUT/GET/DELETE take the same file-scoped sync-token
// JWT, and GET additionally accepts it as `?t=` so an `<img src>` can load the
// bytes directly (image elements cannot attach an Authorization header). Writes
// stay header-only — a URL leaks into logs and history too easily to let one
// authorize a mutation.
//
// The DELETE handler in admin.ts enumerates everything under
// projects/{pid}/files/{fid}/, so wiping a file wipes its attachments too.

import { verifyTokenForFile, WRITE_ROLE_LEVEL } from "./auth"
import { adminBearerMatches } from "./lib/admin-secret"
import { r2KeyPrefix } from "./audio"

export interface CellAttachmentsEnv {
  SNAPSHOTS: R2Bucket
  /** OPS-2: dedicated admin bearer; preferred over SYNC_SECRET_KEY. */
  ADMIN_SECRET?: string
  SYNC_SECRET_KEY?: string
  R2_KEY_PREFIX?: string
}

/** Build the R2 key for one cell attachment object. `objectName` is the full
 *  filename the client chose (`<attachmentId>.<ext>`). */
export function attachmentObjectKey(
  env: Pick<CellAttachmentsEnv, "R2_KEY_PREFIX">,
  projectId: string,
  fileId: string,
  objectName: string,
): string {
  return `${r2KeyPrefix(env)}projects/${projectId}/files/${fileId}/attachments/${objectName}`
}

const ATTACHMENT_PATH_RE = /^\/attachments\/([^/]+)\/([^/]+)\/([^/]+)$/

/**
 * Content types this endpoint will store and serve back verbatim.
 *
 * An ALLOW-list, not audio.ts's deny-list, and that inversion is the point.
 * Audio can afford to say "anything but these" because `<audio src>` does not
 * care about the declared subtype, so degrading an unknown type to
 * `application/octet-stream` costs nothing. An attachment is displayed, so the
 * stored type decides what the browser *does* with the bytes — and the
 * endpoint hands out first-party api.aquilla.app URLs that need no session
 * (the `?t=` token is the whole gate). A deny-list there is one new image
 * format away from serving active content: `image/svg+xml` is a document that
 * executes script, which is why it is absent below and why SVG is refused
 * rather than downgraded.
 */
export const ALLOWED_ATTACHMENT_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/tiff",
  "application/pdf",
])

/** Normalise a Content-Type header to its bare type for the allow-list check. */
export function normalizeAttachmentContentType(raw: string | null | undefined): string {
  return (raw ?? "").split(";")[0].trim().toLowerCase()
}

// 25 MB. Screenshots and photos of source material land well under this; the
// cap exists so one pick cannot turn into a multi-minute upload with no
// progress UI behind it. Mirrored client-side as MAX_ATTACHMENT_UPLOAD_BYTES
// in src/lib/attachments/upload.ts — keep the two in sync.
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Expose-Headers": "Content-Length",
  "Access-Control-Max-Age": "86400",
  Vary: "Origin",
}

function withAttachmentCors(res: Response): Response {
  const headers = new Headers(res.headers)
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v)
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  })
}

/**
 * Routes /attachments/:projectId/:fileId/:objectName.
 *  - OPTIONS → CORS preflight
 *  - PUT     → store body as the attachment object (contributor+ sync-token)
 *  - GET     → return raw bytes (sync-token, header or `?t=`) or 404
 *  - DELETE  → admin bearer, or file-scoped contributor+ sync-token
 *
 * Returns null when the URL or method doesn't match, so the dispatcher falls
 * through to the next handler.
 */
export async function handleCellAttachmentRequest(
  request: Request,
  env: CellAttachmentsEnv,
): Promise<Response | null> {
  const url = new URL(request.url)
  const match = url.pathname.match(ATTACHMENT_PATH_RE)
  if (!match) return null

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  const projectId = decodeURIComponent(match[1])
  const fileId = decodeURIComponent(match[2])
  const objectName = decodeURIComponent(match[3])
  // Defense-in-depth, as audio.ts does it: R2 keys are opaque, and the caller
  // is already token-scoped to (projectId, fileId), but refuse anything
  // outside a plain filename charset so a decoded `../`, separator or control
  // character can never be embedded in a key at all.
  if (!/^[A-Za-z0-9._-]+$/.test(objectName)) {
    return withAttachmentCors(new Response("invalid attachment id", { status: 400 }))
  }
  const key = attachmentObjectKey(env, projectId, fileId, objectName)

  if (request.method === "DELETE") {
    const auth = request.headers.get("Authorization") ?? ""
    if (adminBearerMatches(auth, env)) {
      await env.SNAPSHOTS.delete(key)
      return withAttachmentCors(Response.json({ ok: true }))
    }
    const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null
    const verified = await verifyTokenForFile(token, fileId, env.SYNC_SECRET_KEY)
    if (!verified.ok) {
      return withAttachmentCors(new Response("unauthorized", { status: 401 }))
    }
    if (verified.claims.projectId !== projectId) {
      return withAttachmentCors(
        new Response("token scoped to different project", { status: 403 }),
      )
    }
    if (verified.claims.role < WRITE_ROLE_LEVEL) {
      return withAttachmentCors(new Response("insufficient role", { status: 403 }))
    }
    await env.SNAPSHOTS.delete(key)
    return withAttachmentCors(Response.json({ ok: true }))
  }

  if (request.method !== "PUT" && request.method !== "GET") {
    return withAttachmentCors(new Response("method not allowed", { status: 405 }))
  }

  const header = request.headers.get("Authorization") ?? ""
  let token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null
  // GET-only: accept the sync-token as `?t=` so `<img src>` can load the bytes.
  if (!token && request.method === "GET") {
    token = url.searchParams.get("t")
  }
  const verified = await verifyTokenForFile(token, fileId, env.SYNC_SECRET_KEY)
  if (!verified.ok) {
    return withAttachmentCors(new Response(verified.reason, { status: verified.status }))
  }
  if (verified.claims.projectId !== projectId) {
    return withAttachmentCors(
      new Response("token scoped to different project", { status: 403 }),
    )
  }

  if (request.method === "PUT") {
    // CONTRIBUTOR floor, matching the `cell.attachment.add` event this upload
    // precedes (sync-worker/src/events/role-policy.ts). GET stays
    // viewer-readable so every project member can see the reference images.
    if (verified.claims.role < WRITE_ROLE_LEVEL) {
      return withAttachmentCors(new Response("insufficient role", { status: 403 }))
    }
    const contentType = normalizeAttachmentContentType(request.headers.get("Content-Type"))
    if (!ALLOWED_ATTACHMENT_CONTENT_TYPES.has(contentType)) {
      return withAttachmentCors(
        Response.json(
          {
            error: "unsupported attachment type",
            allowed: [...ALLOWED_ATTACHMENT_CONTENT_TYPES],
          },
          { status: 415 },
        ),
      )
    }
    const tooLarge = () =>
      withAttachmentCors(
        Response.json(
          { error: "attachment too large", maxBytes: MAX_ATTACHMENT_BYTES },
          { status: 413 },
        ),
      )
    // Reject an oversize upload before buffering the whole body when the client
    // advertises the size; the post-buffer check is the backstop.
    const declaredLength = Number(request.headers.get("Content-Length"))
    if (Number.isFinite(declaredLength) && declaredLength > MAX_ATTACHMENT_BYTES) {
      return tooLarge()
    }
    const body = await request.arrayBuffer()
    if (body.byteLength === 0) {
      return withAttachmentCors(new Response("attachment upload is empty", { status: 400 }))
    }
    if (body.byteLength > MAX_ATTACHMENT_BYTES) {
      return tooLarge()
    }
    await env.SNAPSHOTS.put(key, body, { httpMetadata: { contentType } })
    return withAttachmentCors(
      Response.json({ ok: true, key, bytes: body.byteLength }),
    )
  }

  // GET — the objects are small and displayed whole, so no Range handling:
  // an `<img>` never asks for one, and a screenshot is not a 40-minute dub.
  const obj = await env.SNAPSHOTS.get(key)
  if (!obj) {
    return withAttachmentCors(new Response("not found", { status: 404 }))
  }
  // Re-check the allow-list on READ, not just on write, so an object stored
  // before this route existed (or written by another path into the same
  // prefix) can never be served as active content.
  const stored = normalizeAttachmentContentType(obj.httpMetadata?.contentType)
  const contentType = ALLOWED_ATTACHMENT_CONTENT_TYPES.has(stored)
    ? stored
    : "application/octet-stream"
  // Only an IMAGE is served inline. A PDF is on the allow-list because it is a
  // reasonable thing to attach, but it is a document format with a scripting
  // model, and serving it inline hands it to the browser's PDF viewer on a
  // first-party origin behind a URL that needs no session (`?t=`). The UI
  // never previews a PDF anyway — it renders an icon and a link — so forcing
  // the download costs nothing and removes the inline-renderer surface.
  const disposition = contentType.startsWith("image/") ? "inline" : "attachment"
  // Attachments are addressed by a uuidv7-derived objectName that is never
  // reused, so the bytes are immutable. `private` keeps authed responses out
  // of shared proxies (CACHE-5).
  return withAttachmentCors(
    new Response(obj.body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": disposition,
        "Cache-Control": "private, max-age=31536000, immutable",
        "Content-Length": String(obj.size),
      },
    }),
  )
}
