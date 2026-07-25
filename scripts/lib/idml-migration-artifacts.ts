import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import type { FilePairInput } from "../../src/lib/migrate/map"
import {
  sourceArtifactBindingIdFor,
  sourceArtifactIdFor,
} from "../../src/lib/migrate/ids"
import { discoverPointers, type DiscoveredPointer } from "../../src/lib/migrate/gitlab/lfs"

export interface LocalIdmlOriginal {
  kind: "local"
  absolutePath: string
  relativePath: string
  name: string
  size: number
  sha256: string
}

export interface GitlabIdmlOriginal {
  kind: "gitlab-lfs"
  relativePath: string
  name: string
  size: number
  oid: string
}

function walkFiles(root: string): string[] {
  if (!fs.existsSync(root)) return []
  const result: string[] = []
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()!
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(absolute)
      else if (entry.isFile()) result.push(absolute)
    }
  }
  return result.sort()
}

function expectedNames(pair: FilePairInput): Set<string> {
  return new Set([
    pair.source?.metadata.originalName,
    pair.target?.metadata.originalName,
    pair.name,
    pair.relPath,
    `${pair.name}.idml`,
    `${pair.relPath}.idml`,
  ].flatMap((value) => (
    typeof value === "string" && value.trim()
      ? [path.basename(value).toLowerCase()]
      : []
  )))
}

function chooseOne<T>(
  values: readonly T[],
  nameOf: (value: T) => string,
  expected: Set<string>,
): T | undefined {
  const exact = values.filter((value) => expected.has(nameOf(value).toLowerCase()))
  if (exact.length === 1) return exact[0]
  return values.length === 1 ? values[0] : undefined
}

/** Resolve only an unambiguous local `.project/attachments/files/originals` IDML. */
export function resolveLocalIdmlOriginal(
  projectDir: string,
  pair: FilePairInput,
): LocalIdmlOriginal | undefined {
  const root = path.join(projectDir, ".project", "attachments", "files", "originals")
  const candidates = walkFiles(root).filter((file) => /\.idml$/i.test(file))
  const chosen = chooseOne(candidates, (file) => path.basename(file), expectedNames(pair))
  if (!chosen) return undefined
  const bytes = fs.readFileSync(chosen)
  return {
    kind: "local",
    absolutePath: chosen,
    relativePath: path.relative(projectDir, chosen).replaceAll("\\", "/"),
    name: path.basename(chosen),
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }
}

/** Resolve only an unambiguous GitLab LFS pointer under pointers/originals. */
export function resolveGitlabIdmlOriginal(
  projectDir: string,
  pair: FilePairInput,
): GitlabIdmlOriginal | undefined {
  const candidates = discoverPointers(projectDir).pointers.filter((pointer) => {
    const normalized = pointer.relativePath.replaceAll("\\", "/")
    return normalized.includes("/attachments/pointers/originals/")
      && /\.idml$/i.test(normalized)
  })
  const chosen = chooseOne<DiscoveredPointer>(
    candidates,
    (pointer) => path.basename(pointer.relativePath),
    expectedNames(pair),
  )
  if (!chosen) return undefined
  return {
    kind: "gitlab-lfs",
    relativePath: chosen.relativePath,
    name: path.basename(chosen.relativePath),
    size: chosen.pointer.size,
    oid: chosen.pointer.oid,
  }
}

export async function uploadLocalIdmlOriginal(args: {
  syncBase: string
  projectId: string
  fileId: string
  token: string
  original: LocalIdmlOriginal
}): Promise<{ artifactId: string; sha256: string }> {
  const artifactId = sourceArtifactIdFor(args.projectId, args.fileId, args.original.sha256)
  const response = await fetch(
    `${args.syncBase}/api/v1/projects/${encodeURIComponent(args.projectId)}/files/${encodeURIComponent(args.fileId)}/source`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${args.token}`,
        "Content-Type": "application/vnd.adobe.indesign-idml-package",
        "X-Source-Format": "idml",
        "X-Source-Sha256": args.original.sha256,
        "X-Source-Size": String(args.original.size),
        "X-Artifact-Id": artifactId,
        "X-Artifact-Name": encodeURIComponent(args.original.name),
        "X-Artifact-Binding-Role": "source",
        "X-Artifact-Profile-Id": "builtin:idml-roundtrip",
        "X-Artifact-Profile-Version": "2",
        "X-Artifact-Fidelity": "content-only",
      },
      body: fs.readFileSync(args.original.absolutePath),
    },
  )
  if (!response.ok) {
    throw new Error(`source artifact upload HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`)
  }
  const body = await response.json() as { artifactId: string; sha256: string }
  if (body.artifactId !== artifactId || body.sha256 !== args.original.sha256) {
    throw new Error("source artifact upload returned a mismatched immutable identity")
  }
  return body
}

export async function copyGitlabIdmlOriginal(args: {
  syncBase: string
  secret: string
  projectId: string
  fileId: string
  original: GitlabIdmlOriginal
}): Promise<{ artifactId: string; sha256: string; copied: boolean }> {
  const artifactId = sourceArtifactIdFor(args.projectId, args.fileId, args.original.oid)
  const bindingId = sourceArtifactBindingIdFor(args.projectId, args.fileId, args.original.oid)
  const response = await fetch(`${args.syncBase}/migrate/source-artifact-copy`, {
    method: "POST",
    headers: { Authorization: `Bearer ${args.secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId: args.projectId,
      fileId: args.fileId,
      oid: args.original.oid,
      size: args.original.size,
      name: args.original.name,
      artifactId,
      bindingId,
    }),
  })
  if (!response.ok) {
    throw new Error(`source artifact copy HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`)
  }
  const body = await response.json() as { artifactId: string; sha256: string; copied: boolean }
  if (body.artifactId !== artifactId || body.sha256 !== args.original.oid) {
    throw new Error("source artifact copy returned a mismatched immutable identity")
  }
  return body
}
