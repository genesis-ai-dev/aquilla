// src/lib/codex-editor/merge/resolvers.ts
// Top-level dispatcher: route a (path, ours, theirs) triple to the right resolver.

import { Strategy, determineStrategy } from "./strategies"
import { resolveCodexTwoWay } from "./resolveCodex"
import { resolveCommentsTwoWay } from "./resolveComments"
import { resolveMetadataTwoWay } from "./resolveMetadata"
import { resolveJsonMergeTwoWay } from "./resolveJsonMerge"

export async function resolveTwoWay(
  path: string,
  ourBytes: string,
  theirBytes: string,
): Promise<string> {
  const strategy = determineStrategy(path)
  switch (strategy) {
    case Strategy.CODEX: return resolveCodexTwoWay(ourBytes, theirBytes)
    case Strategy.COMMENTS: return resolveCommentsTwoWay(ourBytes, theirBytes)
    case Strategy.METADATA: return resolveMetadataTwoWay(ourBytes, theirBytes)
    case Strategy.JSON_MERGE: return resolveJsonMergeTwoWay(ourBytes, theirBytes)
    case Strategy.IGNORE: return ourBytes
    case Strategy.OVERRIDE:
      console.warn(`[merge] OVERRIDE fallback for "${path}" — taking theirs`)
      return theirBytes
  }
  return theirBytes
}
