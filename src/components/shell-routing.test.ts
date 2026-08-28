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
 *
 * Living Memory is a workspace overlay at /project/:id/memory[/:section];
 * Rules pane URLs under /project/:id/settings/{rules,memory} now redirect
 * there before reaching the shell, so the derivation stays conservative and
 * still maps them to "editor".
 */
import { describe, it, expect } from "vitest"
import { resolveSidebarAgentClick } from "./project-workspace-helpers"

// ── Replicate the pure derivation logic from ProjectWorkspace ──────────────
// Keep in sync with the `centerSurface` derivation in ProjectWorkspace.tsx.

type CenterSurface = "editor" | "comments" | "terminology" | "agent" | "memory"

// Anchored on the /project/:id prefix so /project/:id/settings/memory never matches.
const PROJECT_MEMORY_PATH_RE = /^\/project\/[^/]+\/memory(\/[^/]+)?$/

function deriveCenterSurface(pathname: string): CenterSurface {
  if (pathname.endsWith("/comments")) return "comments"
  if (pathname.endsWith("/terminology")) return "terminology"
  if (pathname.endsWith("/agent")) return "agent"
  if (PROJECT_MEMORY_PATH_RE.test(pathname)) return "memory"
  return "editor"
}

// Keep in sync with the redirect-guard condition in ProjectWorkspace.tsx.
function isOverlaySurface(pathname: string): boolean {
  return (
    pathname.endsWith("/comments") ||
    pathname.endsWith("/terminology") ||
    pathname.endsWith("/agent") ||
    PROJECT_MEMORY_PATH_RE.test(pathname)
  )
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("deriveCenterSurface", () => {
  it("returns 'comments' for /project/:id/comments", () => {
    expect(deriveCenterSurface("/project/proj1/comments")).toBe("comments")
  })

  it("returns 'terminology' for /project/:id/terminology", () => {
    expect(deriveCenterSurface("/project/proj1/terminology")).toBe("terminology")
  })

  it("returns 'agent' for /project/:id/agent", () => {
    expect(deriveCenterSurface("/project/proj1/agent")).toBe("agent")
  })

  it("returns 'memory' for the Living Memory index and its section panes", () => {
    expect(deriveCenterSurface("/project/proj1/memory")).toBe("memory")
    expect(deriveCenterSurface("/project/proj1/memory/instructions")).toBe("memory")
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

  it("does not treat settings panes as workspace overlays", () => {
    // These URLs redirect into /project/:id/memory[/…] before reaching the
    // shell, but the derivation stays conservative: a settings path must
    // never read as an overlay surface.
    expect(deriveCenterSurface("/project/proj1/settings/rules")).toBe("editor")
    expect(deriveCenterSurface("/project/proj1/settings/memory")).toBe("editor")
  })
})

describe("isOverlaySurface (redirect-guard exclusion)", () => {
  // Each overlay surface must be excluded from the "no file → bounce" redirect
  // so navigating to /comments etc. doesn't get clobbered by the restore effect.
  it("excludes /comments from the redirect", () => {
    expect(isOverlaySurface("/project/proj1/comments")).toBe(true)
  })

  it("excludes /terminology from the redirect", () => {
    expect(isOverlaySurface("/project/proj1/terminology")).toBe(true)
  })

  it("excludes /agent from the redirect", () => {
    expect(isOverlaySurface("/project/proj1/agent")).toBe(true)
  })

  it("excludes /memory and /memory/:section from the redirect", () => {
    expect(isOverlaySurface("/project/proj1/memory")).toBe(true)
    expect(isOverlaySurface("/project/proj1/memory/instructions")).toBe(true)
  })

  it("does NOT exclude the root project path (redirect must fire here)", () => {
    expect(isOverlaySurface("/project/proj1/editor")).toBe(false)
  })

  it("does NOT exclude a file path (redirect must fire to validate the fileId)", () => {
    expect(isOverlaySurface("/project/proj1/editor/file/GEN.sfm")).toBe(false)
  })

  it("does NOT exclude settings panes (they are not workspace overlays)", () => {
    expect(isOverlaySurface("/project/proj1/settings/rules")).toBe(false)
    expect(isOverlaySurface("/project/proj1/settings/memory")).toBe(false)
  })
})

describe("shell-routing: back-nav contract", () => {
  // Overlay surfaces (comments / terminology / agent) live inside the
  // workspace shell. Page-level back buttons were removed — the breadcrumb,
  // history arrows, and sidebar own navigation. Returning to the editor still
  // lands on `/project/:id/editor` (no fileId), where the restore-location
  // effect reads readLastLocation() and bounces to the last open file +
  // scroll position:
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
    const overlayRoutes = ["/comments", "/terminology", "/agent", "/memory", "/memory/quality"]
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
    for (const surface of ["comments", "terminology", "agent", "memory"] as const) {
      expect(shouldShowAudioToolbar("audio", surface)).toBe(false)
    }
  })

  it("hides the playback bar in text lens on the editor", () => {
    expect(shouldShowAudioToolbar("text", "editor")).toBe(false)
  })
})

describe("resolveSidebarAgentClick", () => {
  it("toggles back to the editor while the workbench is the active surface", () => {
    // Re-navigating to the URL you are already on reads as a dead control
    // (2026-08-28 transcript) — the rail click must visibly do something.
    expect(resolveSidebarAgentClick(true)).toBe("close-workbench")
  })

  it("opens the agent panel inline in the dock when the workbench is minimized", () => {
    expect(resolveSidebarAgentClick(false)).toBe("open-dock")
  })
})
