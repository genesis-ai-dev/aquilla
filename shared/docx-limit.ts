/**
 * The one size limit on a Word (.docx) file the server reads: the rule
 * import's parse-document route and the Knowledge Base's extractor both refuse
 * a DOCX over it, and the app checks it before uploading and states it in each
 * surface's text ("2 MB"). The Knowledge Base's used to be 2,000,000 bytes, so
 * the two lines read "2 MB" and "1.9 MB".
 *
 * Runtime-neutral, so the app and the auth worker share it.
 */
export const MAX_DOCX_BYTES = 2 * 1024 * 1024
