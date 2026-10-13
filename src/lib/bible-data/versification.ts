// ORG → project versification for Bible Knowledge Pack data (AQU-1686).
//
// The pack keys verses in ORG versification (the Macula/original-language
// scheme). A project may number some verses differently (ENG, LXX, VUL), so
// pack data must be moved onto the project's numbering when it loads. The
// pack client calls this hook on every layer it hands out.
//
// TODO(AQU-1685): map through the FRVT (Copenhagen Alliance) tables in
// ~/frontierrnd/versification-tool, using the project's versification code
// (today only recorded from Paratext imports). Re-key each layer's `verses`
// (text, structure, voices) through the mapping, and merge verses that map
// onto one project verse. Until then this is the identity, which is exact for
// every verse the schemes number alike.

/** A layer, from ORG into the project's versification. */
export function mapLayerToProject<T>(layer: T): T {
  return layer
}
