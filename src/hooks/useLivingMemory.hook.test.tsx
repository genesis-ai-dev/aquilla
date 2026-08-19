import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import type { ProjectRecord } from "@/lib/parsers/types"

const useProjectCellsMock = vi.hoisted(() => vi.fn(() => ({
  files: [],
  isLoading: false,
  isTruncated: false,
  error: undefined,
})))

vi.mock("@/hooks/useProjectCells", () => ({
  useProjectCells: useProjectCellsMock,
}))

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "jwt" }, loading: false }),
}))

vi.mock("@/lib/sync/cqrs-bridge", () => ({
  buildFileScopedTokenFetcher: () => async () => "file-token",
}))

import { useLivingMemory } from "./useLivingMemory"

const project = {
  id: "p1",
  name: "Project",
  files: [{ id: "f1", name: "Genesis", type: "usfm" }],
} as ProjectRecord

describe("useLivingMemory — query ownership", () => {
  beforeEach(() => {
    useProjectCellsMock.mockClear()
  })

  it("keeps the complete corpus query idle when the consumer does not need examples", () => {
    const { result } = renderHook(() => useLivingMemory({
      projectId: "p1",
      project,
      enabled: false,
    }))

    expect(useProjectCellsMock).toHaveBeenLastCalledWith(expect.objectContaining({
      enabled: false,
      projectFiles: [{ id: "f1", name: "Genesis", type: "usfm" }],
    }))
    expect(result.current.isLoading).toBe(false)
    expect(result.current.isEmpty).toBe(false)
  })

  it("starts the corpus query from the caller-owned project when enabled", () => {
    renderHook(() => useLivingMemory({
      projectId: "p1",
      project,
      enabled: true,
    }))

    expect(useProjectCellsMock).toHaveBeenLastCalledWith(expect.objectContaining({
      enabled: true,
      projectFiles: [{ id: "f1", name: "Genesis", type: "usfm" }],
    }))
  })
})
