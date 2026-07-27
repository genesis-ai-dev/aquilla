# IDML Round-Trip v2 production trace

Updated: 2026-07-26

## Blocking external gates

- **Adobe validation:** native fidelity remains disabled until a licensed
  InDesign Server run passes the committed corpus plus rights-cleared files
  saved by supported older and current InDesign releases. The desktop checklist
  may support internal/beta evaluation, but cannot enable `native`.
- **Private package namespace:** GitHub Packages requires the npm scope to match
  a GitHub user or organization. The repositories are owned by
  `genesis-ai-dev`, while the requested package name is
  `@aquilla/idml-roundtrip`. Publishing needs confirmed control of the
  `aquilla` namespace or approval to publish
  `@genesis-ai-dev/idml-roundtrip` and consume it through an npm alias.
- **Biblica paired-file semantics:** the shared `biblica` profile currently
  preserves every literal IDML unit in a single file. Production Study Bible +
  translated Bible replacement still needs an authoritative, unique
  book/chapter/verse mapping contract and rights-cleared paired fixtures. The
  old heuristic largest-story/append-unmatched behavior must not be restored.

## Ready in the integration branches

- Shared schema/API v2 validates hostile UCF/ZIP inputs, parses nested literal
  locations structurally, protects slot/token anchors, exports surgically,
  returns exact original bytes for no-op exports, and fails closed on stale or
  incomplete mappings.
- Aquilla imports and exports IDML only through the transferable worker,
  persists the original source artifact and v2 locator metadata, protects
  TipTap edits and AI output, exposes recovery actions, and has a targeted
  import/edit/export smoke journey.
- Codex Editor imports both generic and single-file Biblica IDML through the
  shared v2 producer, protects Quill edits and AI output, preserves generic HTML
  repair behavior, and blocks partial export.
- Local and GitLab/LFS migrations prove legacy cells against the actual original
  artifact before emitting deterministic metadata-patch events.
- The committed CC0 corpus covers the supported literal scopes, Unicode and
  formatting cases, plus hostile packages. Adobe preparation and evidence
  finalization are implemented and fail closed.

## Shared package distribution

- Current package: `@aquilla/idml-roundtrip@2.0.1`.
- Aquilla pins `workspace:2.0.1`.
- Until registry publication is available, Codex Editor pins the immutable
  `aquilla-idml-roundtrip-2.0.1.tgz` artifact generated from Aquilla commit
  `4b52b44225a7ef3f875f187d1caa84734bc193d5`.
- Codex records the artifact SHA-256 in `vendor/README.md`; both Node and webview
  dependency locks point to the same exact artifact.

## Release sequence

1. Merge and publish the two integration branches after their repository gates.
2. Resolve the package namespace and replace the temporary Codex artifact with
   an exact registry dependency.
3. Add rights-cleared Adobe-exported fixtures and run browser, migration, and
   automated InDesign Server gates at the exact release commit.
4. Run migration readiness/backfill against canary projects and resolve every
   `needs-artifact`, `ambiguous-locator`, or `unsupported-legacy-html` result.
5. Enable internal and org beta stages before considering `native`.
