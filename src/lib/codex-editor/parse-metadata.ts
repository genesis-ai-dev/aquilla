import type { CodexLanguageEntry, CodexProjectMetadata } from "./types";

export function parseCodexProjectMetadata(raw: string): CodexProjectMetadata {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("metadata.json must be a JSON object");
  }
  return parsed as CodexProjectMetadata;
}

/**
 * Resolve the source/target language tags from a parsed metadata record,
 * tolerating both the modern flat shape and the legacy `languages` array.
 *
 * Returns `undefined` for either side when neither shape carries a usable
 * tag — callers decide whether to fall back to a default ("en") or surface
 * an "unknown languages" warning.
 */
export function extractProjectLanguages(
  meta: CodexProjectMetadata,
): { sourceTag?: string; targetTag?: string } {
  const flatSource = meta.sourceLanguage?.tag?.trim();
  const flatTarget = meta.targetLanguage?.tag?.trim();

  let arraySource: string | undefined;
  let arrayTarget: string | undefined;
  if (Array.isArray(meta.languages)) {
    const findEntry = (status: string): CodexLanguageEntry | undefined =>
      meta.languages?.find((l) => l && typeof l === "object" && l.projectStatus === status);
    arraySource = findEntry("source")?.tag?.trim() || undefined;
    arrayTarget = findEntry("target")?.tag?.trim() || undefined;
  }

  return {
    sourceTag: flatSource || arraySource,
    targetTag: flatTarget || arrayTarget,
  };
}
