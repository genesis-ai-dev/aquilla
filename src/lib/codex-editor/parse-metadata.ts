import type { CodexProjectMetadata } from "./types";

export function parseCodexProjectMetadata(raw: string): CodexProjectMetadata {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("metadata.json must be a JSON object");
  }
  return parsed as CodexProjectMetadata;
}
