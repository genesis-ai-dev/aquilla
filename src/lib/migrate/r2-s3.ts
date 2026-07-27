// Minimal S3-compatible client for Cloudflare R2, used by the fast asset
// migrator to copy LFS blobs bucket→bucket with server-side CopyObject (a
// metadata op — no bytes move). Hand-rolled SigV4 so we don't pull the heavy
// @aws-sdk into the build; the signer is locked to AWS's official test vector.
//
// Everything that touches the network lives in R2Client; the pure signing +
// key-derivation helpers are exported for unit testing.

import crypto from "node:crypto"

// This helper only hashes the canonical request string. Keeping the input
// precise avoids Node 26's broader BinaryLike (which includes ArrayBuffer)
// leaking into Hash.update's narrower overload under TypeScript 7.
const sha256hex = (data: string): string => crypto.createHash("sha256").update(data).digest("hex")
const hmac = (key: crypto.BinaryLike, data: string): Buffer => crypto.createHmac("sha256", key).update(data).digest()

/** sha256 of an empty body — used when there is no payload (GET/DELETE/CopyObject). */
export const EMPTY_PAYLOAD_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

export interface SigV4Input {
  method: string
  /** Percent-encoded path, e.g. "/bucket/key". */
  canonicalUri: string
  /** Sorted, percent-encoded query string (may be ""). */
  canonicalQuery: string
  /** Header name→value; must include Host. Case is normalized by the signer. */
  headers: Record<string, string>
  payloadHash: string
  accessKeyId: string
  secretAccessKey: string
  region: string
  service: string
  /** Timestamp as YYYYMMDDTHHMMSSZ. Passed in (never Date.now) so it's testable. */
  amzDate: string
}

/** Build an AWS SigV4 Authorization header. Pure + locked to AWS's get-vanilla
 *  test vector. */
export function sigv4AuthHeader(i: SigV4Input): string {
  const dateStamp = i.amzDate.slice(0, 8)
  const norm = Object.entries(i.headers)
    .map(([k, v]) => [k.toLowerCase(), String(v).trim()] as [string, string])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const canonicalHeaders = norm.map(([k, v]) => `${k}:${v}\n`).join("")
  const signedHeaders = norm.map(([k]) => k).join(";")
  const canonicalRequest = `${i.method}\n${i.canonicalUri}\n${i.canonicalQuery}\n${canonicalHeaders}\n${signedHeaders}\n${i.payloadHash}`
  const scope = `${dateStamp}/${i.region}/${i.service}/aws4_request`
  const stringToSign = `AWS4-HMAC-SHA256\n${i.amzDate}\n${scope}\n${sha256hex(canonicalRequest)}`
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${i.secretAccessKey}`, dateStamp), i.region), i.service), "aws4_request")
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign).digest("hex")
  return `AWS4-HMAC-SHA256 Credential=${i.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
}

/** GitLab LFS object-storage key: oid[0:2]/oid[2:4]/oid[4:] (object name is the
 *  oid with the first 4 hex stripped — verified against the live bucket). */
export function gitlabLfsKey(oid: string): string {
  return `${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid.slice(4)}`
}

/** Canonical R2 key the app reads audio from (mirrors sync-worker audioObjectKey,
 *  no R2_KEY_PREFIX in prod). */
export function audioDestKey(projectId: string, fileId: string, audioId: string): string {
  return `projects/${projectId}/files/${fileId}/audio/${audioId}`
}

/** Percent-encode each path segment but keep the "/" separators. */
function encodePath(key: string): string {
  return key
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/")
}

export interface R2ClientOptions {
  accountId: string
  accessKeyId: string
  secretAccessKey: string
  region?: string
}

export interface ListedObject {
  key: string
  size: number
}

/** Thin S3 client over R2. One per migration run. */
export class R2Client {
  private host: string
  private region: string
  private opts: R2ClientOptions
  constructor(opts: R2ClientOptions) {
    this.opts = opts
    this.host = `${opts.accountId}.r2.cloudflarestorage.com`
    this.region = opts.region ?? "auto"
  }

  private amzDate(): string {
    // YYYYMMDDTHHMMSSZ
    return new Date().toISOString().replace(/[:-]|\.\d{3}/g, "")
  }

  private sign(method: string, bucketKey: string, extraHeaders: Record<string, string>, query = ""): {
    url: string
    headers: Record<string, string>
  } {
    const amzDate = this.amzDate()
    const canonicalUri = "/" + encodePath(bucketKey)
    const payloadHash = "UNSIGNED-PAYLOAD"
    const headers: Record<string, string> = {
      host: this.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      ...extraHeaders,
    }
    const authorization = sigv4AuthHeader({
      method,
      canonicalUri,
      canonicalQuery: query,
      headers,
      payloadHash,
      accessKeyId: this.opts.accessKeyId,
      secretAccessKey: this.opts.secretAccessKey,
      region: this.region,
      service: "s3",
      amzDate,
    })
    return {
      url: `https://${this.host}${canonicalUri}${query ? `?${query}` : ""}`,
      headers: { ...headers, Authorization: authorization },
    }
  }

  /** Server-side copy within the same account: NO bytes traverse the wire. */
  async copyObject(srcBucket: string, srcKey: string, destBucket: string, destKey: string): Promise<void> {
    const copySource = `/${srcBucket}/${encodePath(srcKey)}`
    const { url, headers } = this.sign("PUT", `${destBucket}/${destKey}`, { "x-amz-copy-source": copySource })
    const res = await fetch(url, { method: "PUT", headers })
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200)
      const err = new Error(`CopyObject ${res.status}: ${detail}`) as Error & { status?: number }
      err.status = res.status
      throw err
    }
  }

  /** Page through a bucket prefix. Returns one page + the continuation token. */
  async listObjects(
    bucket: string,
    opts: { prefix?: string; continuationToken?: string; maxKeys?: number } = {},
  ): Promise<{ objects: ListedObject[]; nextToken?: string }> {
    const q = new URLSearchParams()
    q.set("list-type", "2")
    q.set("max-keys", String(opts.maxKeys ?? 1000))
    if (opts.prefix) q.set("prefix", opts.prefix)
    if (opts.continuationToken) q.set("continuation-token", opts.continuationToken)
    q.sort()
    const { url, headers } = this.sign("GET", bucket, {}, q.toString())
    const res = await fetch(url, { method: "GET", headers })
    if (!res.ok) throw new Error(`ListObjects ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`)
    const body = await res.text()
    const keys = [...body.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1])
    const sizes = [...body.matchAll(/<Size>([^<]+)<\/Size>/g)].map((m) => Number(m[1]))
    const nextToken = /<IsTruncated>true<\/IsTruncated>/.test(body)
      ? body.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1]
      : undefined
    return { objects: keys.map((key, i) => ({ key, size: sizes[i] ?? 0 })), nextToken }
  }
}
