import { ApiError } from "./errors"

/**
 * All container files live under /workspace. A caller-supplied path is
 * accepted as either workspace-relative (`data/foo.csv`) or already rooted at
 * `/workspace`. Anything that would escape the workspace — `..` segments,
 * absolute paths pointing elsewhere, or NUL bytes — is rejected.
 *
 * Returns the normalized absolute container path (always under /workspace).
 */
export const WORKSPACE_ROOT = "/workspace"

export function resolveWorkspacePath(input: string): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new ApiError("validation_failed", "path is required")
  }
  if (input.includes("\0")) {
    throw new ApiError("validation_failed", "path contains a NUL byte")
  }

  // Absolute paths are only allowed if they are already under /workspace.
  let rel: string
  if (input.startsWith("/")) {
    if (input !== WORKSPACE_ROOT && !input.startsWith(WORKSPACE_ROOT + "/")) {
      throw new ApiError(
        "validation_failed",
        `absolute path must be under ${WORKSPACE_ROOT}`,
      )
    }
    rel = input.slice(WORKSPACE_ROOT.length)
  } else {
    rel = "/" + input
  }

  // Normalize segments and reject any traversal.
  const out: string[] = []
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === ".") continue
    if (seg === "..") {
      throw new ApiError(
        "validation_failed",
        "path may not contain '..' segments",
      )
    }
    out.push(seg)
  }

  return out.length === 0 ? WORKSPACE_ROOT : `${WORKSPACE_ROOT}/${out.join("/")}`
}
