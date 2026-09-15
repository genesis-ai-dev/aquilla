// Cloudflare R2 bindings have no read-only mode at the binding level — a
// `[[r2_buckets]]` entry grants full get/put/delete/multipart authority
// regardless of what the code that holds it actually does. LFS_SRC
// (GitLab's LFS object bucket, see wrangler.toml) is documented as
// "read-only source" and today only ever reaches `.get()` (migrate-audio-copy
// and migrate-source-artifact-copy), but that was enforced by convention
// only — nothing stopped a future change from writing or deleting against
// someone else's bucket. This wraps the raw binding once, at the top of
// `fetch`, so the rest of the worker only ever sees get/head/list, and any
// write attempt (a bug, or a route added later without re-reading this file)
// fails loudly instead of silently succeeding.

export interface ReadonlyR2Bucket {
  get: R2Bucket["get"]
  head: R2Bucket["head"]
  list: R2Bucket["list"]
}

const WRITE_METHODS = new Set([
  "put",
  "delete",
  "createMultipartUpload",
  "resumeMultipartUpload",
])

export function asReadonlyR2(bucket: R2Bucket): ReadonlyR2Bucket {
  return new Proxy(bucket, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && WRITE_METHODS.has(prop)) {
        // R2Bucket's write methods are all async — reject rather than throw
        // synchronously, so a caller that (correctly) awaits this like the
        // real binding gets a normal rejected promise, not an uncaught throw.
        return () => Promise.reject(new Error(`readonly R2 binding: ${prop}() is not allowed`))
      }
      return Reflect.get(target, prop, receiver)
    },
  }) as unknown as ReadonlyR2Bucket
}
