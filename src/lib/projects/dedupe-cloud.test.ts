import { describe, it, expect } from "vitest"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { CloudProjectSummary } from "@/lib/sync/cloud-projects"
import { filterCloudOnly } from "./dedupe-cloud"

function localGitProject(overrides: Partial<ProjectRecord> & { id: string; gitlabProjectId: number }): ProjectRecord {
  const { gitlabProjectId, ...rest } = overrides
  return {
    id: rest.id,
    name: rest.name ?? "name",
    sourceLanguage: "en",
    targetLanguage: "en",
    createdAt: new Date().toISOString(),
    files: [],
    members: [],
    origin: {
      kind: "git",
      cloneUrl: "https://example",
      gitlabProjectId,
      branch: "main",
      headSha: "abc",
      importedAt: new Date().toISOString(),
    },
    ...rest,
  } as ProjectRecord
}

function cfNativeLocal(overrides: Partial<ProjectRecord> & { id: string }): ProjectRecord {
  return {
    id: overrides.id,
    name: overrides.name ?? "name",
    sourceLanguage: "",
    targetLanguage: "",
    createdAt: new Date().toISOString(),
    files: [],
    members: [],
    ...overrides,
  } as ProjectRecord
}

function cloud(overrides: Partial<CloudProjectSummary> & { id: string }): CloudProjectSummary {
  return {
    id: overrides.id,
    name: overrides.name ?? "cloud name",
    gitlabProjectId: overrides.gitlabProjectId ?? null,
    role: { level: 700, name: "owner", source: "creator" },
    ...overrides,
  }
}

describe("filterCloudOnly", () => {
  it("keeps cloud projects that have no local counterpart", () => {
    const result = filterCloudOnly(
      [cloud({ id: "p-cloud-only" })],
      [],
      []
    )
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe("p-cloud-only")
  })

  it("drops a cloud project when a local project shares the same id", () => {
    const result = filterCloudOnly(
      [cloud({ id: "p-shared" })],
      [cfNativeLocal({ id: "p-shared" })],
      []
    )
    expect(result).toEqual([])
  })

  it("drops a cloud project when a local git-imported project shares gitlabProjectId but has a different local id", () => {
    // Reproduces the user-visible bug: git-imported project has local IDB id
    // "local-42" but the cloud counterpart uses a different canonical id.
    // Both carry gitlabProjectId=42 — treat as one project, not two.
    const result = filterCloudOnly(
      [cloud({ id: "cloud-different-id", gitlabProjectId: 42 })],
      [localGitProject({ id: "local-42", gitlabProjectId: 42 })],
      []
    )
    expect(result).toEqual([])
  })

  it("also dedupes against trashed projects (local + git)", () => {
    const resultById = filterCloudOnly(
      [cloud({ id: "p-trashed" })],
      [],
      [cfNativeLocal({ id: "p-trashed", deletedAt: "2026-01-01T00:00:00Z" })]
    )
    expect(resultById).toEqual([])

    const resultByGitlab = filterCloudOnly(
      [cloud({ id: "cloud-id", gitlabProjectId: 99 })],
      [],
      [localGitProject({ id: "trash-id", gitlabProjectId: 99, deletedAt: "2026-01-01T00:00:00Z" })]
    )
    expect(resultByGitlab).toEqual([])
  })

  it("does not match on null/undefined gitlabProjectId (two CF-native projects are not the same just because neither has a GitLab link)", () => {
    const result = filterCloudOnly(
      [cloud({ id: "p-cloud", gitlabProjectId: null })],
      [cfNativeLocal({ id: "p-local" })], // no origin
      []
    )
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe("p-cloud")
  })

  it("preserves order of the input cloud list", () => {
    const result = filterCloudOnly(
      [
        cloud({ id: "a" }),
        cloud({ id: "b" }),
        cloud({ id: "c" }),
      ],
      [cfNativeLocal({ id: "b" })],
      []
    )
    expect(result.map((p) => p.id)).toEqual(["a", "c"])
  })
})
