/**
 * `Content-Disposition: attachment` for a user-influenced file name. Control
 * characters, quotes, backslashes and `;` are neutralised in the quoted
 * fallback, and the real (possibly non-Latin1) name rides in `filename*`.
 */
export function attachmentDisposition(fileName: string): string {
  // eslint-disable-next-line no-control-regex
  const safe = fileName.replace(/[\u0000-\u001f\u007f";]/g, "_").slice(0, 180) || "download"
  const ascii = safe.replace(/[^\x20-\x7e]/g, "_")
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`
}
