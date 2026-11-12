// AQU-1937: the one helper every file-name surface (sidebar, tabs, pickers,
// search) reads. An extension's display label ("Titus · ULT") when it set one,
// else the stored file name — which, like every id, is never rewritten.
export { fileDisplayName } from "../../shared/tools/file-extension"
