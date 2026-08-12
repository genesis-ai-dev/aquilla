/**
 * AQU-254: Shell routing — all in-project views must render inside the editor
 * shell (fixed sidebar + top bar + bottom status bar).
 *
 * These tests cover:
 *  1. centerSurface derivation — the pure URL-path → surface mapping used by
 *     ProjectWorkspace to decide what to render in the main content area.
 *  2. Redirect-guard exclusions — the paths that must NOT trigger the
 *     "no file selected → bounce to last location" redirect effect.
 *
 * We test the logic as extracted pure functions rather than mounting the full
 * ProjectWorkspace (which pulls in every editor dependency). The intent is to
 * catch regressions where a new subroute accidentally falls through to the
 * editor or re-triggers the redirect loop.
 */
import { describe, it, expect } from "vitest"

// ── Replicate the pure derivation logic from ProjectWorkspace ──────────────
// Keep in sync with the `centerSurface` derivation in ProjectWorkspace.tsx.

type CenterSurface = "editor" | "rules" | "comments" | "memory" | "terminology" | "agent"

function deriveCenterSurface(pathname: string): CenterSurface {
  if (pathname.endsWith("/rules")) return "rules"
  if (pathname.endsWith("/comments")) return "comments"
  if (pathname.endsWith("/memory")) return "memory"
  if (pathname.endsWith("/terminology")) return "terminology"
  if (pathname.endsWith("/agent")) return "agent"
  return "editor"
}

// Keep in sync with the redirect-guard condition in ProjectWorkspace.tsx.
function isOverlaySurface(pathname: string): boolean {
  return (
    pathname.endsWith("/rules") ||
    pathname.endsWith("/comments") ||
    pathname.endsWith("/memory") ||
    pathname.endsWith("/terminology") ||
    pathname.endsWith("/agent")
  )
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("deriveCenterSurface", () => {
  it("returns 'rules' for /project/:id/rules", () => {
    expect(deriveCenterSurface("/project/proj1/rules")).toBe("rules")
  })

  it("returns 'comments' for /project/:id/comments", () => {
    expect(deriveCenterSurface("/project/proj1/comments")).toBe("comments")
  })

  it("returns 'memory' for /project/:id/memory", () => {
    expect(deriveCenterSurface("/project/proj1/memory")).toBe("memory")
  })

  it("returns 'terminology' for /project/:id/terminology", () => {
    expect(deriveCenterSurface("/project/proj1/terminology")).toBe("terminology")
  })

  it("returns 'agent' for /project/:id/agent", () => {
    expect(deriveCenterSurface("/project/proj1/agent")).toBe("agent")
  })

  it("returns 'editor' for the root project path", () => {
    expect(deriveCenterSurface("/project/proj1/editor")).toBe("editor")
  })

  it("returns 'editor' for a file path (shell stays mounted, editor renders)", () => {
    expect(deriveCenterSurface("/project/proj1/editor/file/GEN.sfm")).toBe("editor")
  })

  it("returns 'editor' for /voice (audio lens — still the editor surface)", () => {
    expect(deriveCenterSurface("/project/proj1/voice")).toBe("editor")
  })
})

describe("isOverlaySurface (redirect-guard exclusion)", () => {
  // Each overlay surface must be excluded from the "no file → bounce" redirect
  // so navigating to /comments etc. doesn't get clobbered by the restore effect.
  it("excludes /rules from the redirect", () => {
    expect(isOverlaySurface("/project/proj1/rules")).toBe(true)
  })

  it("excludes /comments from the redirect", () => {
    expect(isOverlaySurface("/project/proj1/comments")).toBe(true)
  })

  it("excludes /memory from the redirect", () => {
    expect(isOverlaySurface("/project/proj1/memory")).toBe(true)
  })

  it("excludes /terminology from the redirect", () => {
    expect(isOverlaySurface("/project/proj1/terminology")).toBe(true)
  })

  it("excludes /agent from the redirect", () => {
    expect(isOverlaySurface("/project/proj1/agent")).toBe(true)
  })

  it("does NOT exclude the root project path (redirect must fire here)", () => {
    expect(isOverlaySurface("/project/proj1/editor")).toBe(false)
  })

  it("does NOT exclude a file path (redirect must fire to validate the fileId)", () => {
    expect(isOverlaySurface("/project/proj1/editor/file/GEN.sfm")).toBe(false)
  })
})

describe("shell-routing: back-nav contract", () => {
  // Overlay surfaces (comments / memory / terminology / rules / agent) live
  // inside the workspace shell. Page-level back buttons were removed — the
  // breadcrumb, history arrows, and sidebar own navigation. Returning to the
  // editor still lands on `/project/:id/editor` (no fileId), where the
  // restore-location effect reads readLastLocation() and bounces to the last
  // open file + scroll position:
  //
  //   navigate("/project/:id/editor")
  //   → isOverlaySurface = false (redirect fires)
  //   → readLastLocation → fileId present → redirectTo /project/:id/editor/file/:fileId
  //
  // We test the guard side; the readLastLocation round-trip is integration-tested.

  it("navigating to /project/:id/editor is NOT guarded — restore-location fires", () => {
    expect(isOverlaySurface("/project/proj1/editor")).toBe(false)
  })

  it("overlay surface derivation covers all shell overlay subroutes", () => {
    const overlayRoutes = ["/comments", "/memory", "/terminology", "/rules", "/agent"]
    for (const suffix of overlayRoutes) {
      const path = `/project/proj1${suffix}`
      expect(deriveCenterSurface(path)).not.toBe("editor")
      expect(isOverlaySurface(path)).toBe(true)
    }
  })
})

// Keep in sync with `showAudioToolbar` in ProjectWorkspace statusBar.
function shouldShowAudioToolbar(lens: "text" | "audio", centerSurface: CenterSurface): boolean {
  return lens === "audio" && centerSurface === "editor"
}

describe("shouldShowAudioToolbar", () => {
  it("shows the playback bar only on the editor surface in audio lens", () => {
    expect(shouldShowAudioToolbar("audio", "editor")).toBe(true)
  })

  it("hides the playback bar on overlay surfaces even when audio lens is sticky", () => {
    for (const surface of ["rules", "comments", "memory", "terminology", "agent"] as const) {
      expect(shouldShowAudioToolbar("audio", surface)).toBe(false)
    }
  })

  it("hides the playback bar in text lens on the editor", () => {
    expect(shouldShowAudioToolbar("text", "editor")).toBe(false)
  })
})

// Keep in sync with `resolveSidebarAgentClick` in ProjectWorkspace.tsx.
function resolveSidebarAgentClick(
  agentTabOpen: boolean,
): "activate-editor-tab" | "open-dock" {
  return agentTabOpen ? "activate-editor-tab" : "open-dock"
}

describe("resolveSidebarAgentClick", () => {
  it("activates the editor Agent tab when that tab is already open", () => {
    expect(resolveSidebarAgentClick(true)).toBe("activate-editor-tab")
  })

  it("opens the agent panel inline in the dock when no editor Agent tab is open", () => {
    expect(resolveSidebarAgentClick(false)).toBe("open-dock")
  })
})
