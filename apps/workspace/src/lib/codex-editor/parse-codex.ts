import type { CodexNotebookFile } from "./types";

export function parseCodexNotebook(raw: string): CodexNotebookFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid JSON: ${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Notebook must be an object");
  }
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.cells)) {
    throw new Error("Notebook missing 'cells' array");
  }
  if (!obj.metadata || typeof obj.metadata !== "object") {
    throw new Error("Notebook missing 'metadata' object");
  }
  return parsed as CodexNotebookFile;
}
