// Zero-dependency Tauri-runtime check. Deliberately kept dependency-free (no
// LiveStore imports) so modules used by every web build (cells-read.ts,
// outbox.ts) can check this without pulling LiveStore/OPFS/wa-sqlite into the
// plain browser SPA's bundle.
export const isTauriRuntime = (): boolean => typeof window !== "undefined" && "__TAURI__" in window
