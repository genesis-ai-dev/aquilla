export function isTauri(): boolean {
  return typeof globalThis !== "undefined"
    && "__TAURI_INTERNALS__" in (globalThis as object);
}
