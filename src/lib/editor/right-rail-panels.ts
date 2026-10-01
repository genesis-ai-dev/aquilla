// AQU-1316: decide, for the editor's right rail, which of the two scripture
// side surfaces render — the full panel or its collapsed edge tab — for
// Parallel Bibles (helloao) and Verse Resources (Aquifer).
//
// This lived as two inline IIFEs in ProjectWorkspace's `aside` and `asideEdge`
// props, ~180 lines apart in a 13,000-line component. Both re-derived the same
// three predicates (in a scripture editor, verse resources gated on, each
// panel's persisted open flag) and each decided half of the answer, so the one
// rule that actually matters — a surface is EITHER the panel OR the edge tab,
// never both, never neither — was written nowhere and pinned by no test. That
// is the shape AQU-1316 was reported against: duplicate Parallel Bibles panels
// side by side, and an edge tab that reopened what the panel's X had closed.
//
// Keeping the decision here makes the invariant checkable: `aside` renders the
// `*Panel` flags, `asideEdge` renders the `*Edge` flags, and the exclusivity is
// a property of one pure function rather than an agreement between two call
// sites that nothing enforces.

export interface RightRailInputs {
  /**
   * The center surface is the editor, on a file with sections (the gate both
   * surfaces already shared). False on overlay surfaces (Terminology, Agent, …)
   * and on files with no scripture structure — neither surface exists there.
   */
  inScriptureEditor: boolean
  /**
   * AQU-461: the project's Bible-resources gate. The aquifer routes 404 when it
   * is off, so an ungated Verse Resources surface would only ever show an error.
   */
  verseResourcesAvailable: boolean
  /** Persisted per-project open flag for Parallel Bibles. */
  parallelBiblesOpen: boolean
  /** Persisted per-project open flag for Verse Resources. */
  verseResourcesOpen: boolean
}

export interface RightRailSurfaces {
  /** Render the full Parallel Bibles panel in `aside`. */
  biblesPanel: boolean
  /** Render the collapsed Parallel Bibles edge tab in `asideEdge`. */
  biblesEdge: boolean
  /** Render the full Verse Resources panel in `aside`. */
  resourcesPanel: boolean
  /** Render the collapsed Verse Resources edge tab in `asideEdge`. */
  resourcesEdge: boolean
}

/**
 * Exactly one surface per feature, and only inside the scripture editor.
 *
 * Each feature is a two-state toggle: open → panel, closed → edge tab. Writing
 * both flags from the same `open` boolean is what makes "panel and edge tab at
 * once" (the duplicate-panel report) unrepresentable rather than merely
 * unintended, and it keeps the X in the panel header and the edge tab as two
 * views of one piece of state — closing one cannot leave the other behind.
 */
export function computeRightRailSurfaces({
  inScriptureEditor,
  verseResourcesAvailable,
  parallelBiblesOpen,
  verseResourcesOpen,
}: RightRailInputs): RightRailSurfaces {
  if (!inScriptureEditor) {
    return { biblesPanel: false, biblesEdge: false, resourcesPanel: false, resourcesEdge: false }
  }
  // Verse Resources rides the scripture-editor gate PLUS the project's
  // Bible-resources setting; with the setting off it has neither surface.
  const resourcesUsable = verseResourcesAvailable
  return {
    biblesPanel: parallelBiblesOpen,
    biblesEdge: !parallelBiblesOpen,
    resourcesPanel: resourcesUsable && verseResourcesOpen,
    resourcesEdge: resourcesUsable && !verseResourcesOpen,
  }
}

/** True when `aside` has at least one of these two surfaces to render. */
export function hasRightRailPanel(s: RightRailSurfaces): boolean {
  return s.biblesPanel || s.resourcesPanel
}

/** True when `asideEdge` has at least one collapsed tab to render. */
export function hasRightRailEdge(s: RightRailSurfaces): boolean {
  return s.biblesEdge || s.resourcesEdge
}
