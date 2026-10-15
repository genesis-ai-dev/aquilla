/**
 * OPS-44: after a platform admin verifies the emailed code, the project page
 * whose sync-token mint was refused reloads its reads without a browser reload.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen } from "@testing-library/react"
import { useEffect, useMemo, useState } from "react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { ProjectElevationBoundary } from "./ProjectElevationBoundary"
import { makeSyncTokenFetcher } from "@/lib/sync/sync-token"
import {
  clearElevationRequired,
  isElevationRequired,
  notifyElevationGranted,
  notifyElevationRequired,
} from "@/lib/errors/elevation-required-signal"
import type { FrontierSession } from "@/lib/frontier/types"

// The step-up prompt only opens for the ACTIVE session's JWT.
vi.mock("@/lib/frontier/session-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/frontier/session-store")>()),
  loadActiveSession: async () => ({ jwt: "jwt-admin" }) as FrontierSession,
}))

/** auth-worker/src/routes/sync-token.ts, case "elevation_required". */
const ELEVATION_BODY = JSON.stringify({
  error: "elevation required to mint a project sync token with platform-admin access",
})

function resetSignal() {
  clearElevationRequired()
  notifyElevationGranted() // consume any refused projects left by a prior test
}

beforeEach(resetSignal)
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  resetSignal()
})

let mounts = 0
function MountCounter() {
  const [mountId] = useState(() => ++mounts)
  return <span data-testid="mount-id">{mountId}</span>
}

function renderAt(path: string, child: React.ReactNode) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/project/:id/editor" element={<ProjectElevationBoundary>{child}</ProjectElevationBoundary>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe("ProjectElevationBoundary", () => {
  beforeEach(() => { mounts = 0 })

  it("remounts its page when a grant follows a refused sync-token mint for this project", () => {
    renderAt("/project/p1/editor", <MountCounter />)
    expect(screen.getByTestId("mount-id").textContent).toBe("1")
    notifyElevationRequired({ kind: "sync-token", projectId: "p1" })
    act(() => notifyElevationGranted())
    expect(screen.getByTestId("mount-id").textContent).toBe("2")
  })

  it("leaves the page alone for a grant that only unblocks another project", () => {
    renderAt("/project/p1/editor", <MountCounter />)
    notifyElevationRequired({ kind: "sync-token", projectId: "p2" })
    act(() => notifyElevationGranted())
    expect(screen.getByTestId("mount-id").textContent).toBe("1")
  })

  it("leaves the page alone for a grant after a membership refusal, so a half-filled form survives", () => {
    renderAt("/project/p1/editor", <MountCounter />)
    notifyElevationRequired({ kind: "action" })
    act(() => notifyElevationGranted())
    expect(screen.getByTestId("mount-id").textContent).toBe("1")
  })

  it("reloads a read whose sync-token mint was refused, once the admin steps up", async () => {
    let elevated = false
    vi.stubGlobal("fetch", vi.fn(async () =>
      elevated
        ? new Response(
            JSON.stringify({
              token: "sync-jwt-p1",
              expiresIn: 900,
              role: { level: 1000, name: "owner", source: "platform_admin" },
            }),
            { status: 200 },
          )
        : new Response(ELEVATION_BODY, { status: 403 }),
    ))

    // Shaped like the workspace's reads: the token fetcher is built per mount
    // (ProjectWorkspace's getTokenForFile), and a null token is a failed read.
    function CellsReader() {
      const getToken = useMemo(() => makeSyncTokenFetcher(() => "jwt-admin", "p1", "f1"), [])
      const [state, setState] = useState("loading")
      useEffect(() => {
        let cancelled = false
        void getToken().then((token) => {
          if (!cancelled) setState(token ? `cells read with ${token}` : "cells unavailable")
        })
        return () => { cancelled = true }
      }, [getToken])
      return <p>{state}</p>
    }

    renderAt("/project/p1/editor", <CellsReader />)
    expect(await screen.findByText("cells unavailable")).toBeInTheDocument()
    expect(isElevationRequired()).toBe(true)

    elevated = true
    act(() => notifyElevationGranted())
    expect(await screen.findByText("cells read with sync-jwt-p1")).toBeInTheDocument()
  })
})

describe("App route table", () => {
  it("puts every project read surface inside the boundary", () => {
    const app = readFileSync(join(__dirname, "..", "App.tsx"), "utf8")
    expect(app).toContain(
      '<Route path="/projects/:id" element={<ProjectElevationBoundary><ProjectOverview /></ProjectElevationBoundary>} />',
    )
    for (const page of ["ProjectSettings", "ProjectSettingsDialog", "ProjectApprovals"]) {
      const routes = app.match(new RegExp(`element=\\{.*<${page} />.*\\}`, "g")) ?? []
      expect(routes.length, page).toBeGreaterThan(0)
      for (const route of routes) {
        expect(route, page).toContain(`<ProjectElevationBoundary><LazyRoute><${page} /></LazyRoute></ProjectElevationBoundary>`)
      }
    }
  })
})
