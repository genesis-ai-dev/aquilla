/**
 * Y.Doc → local-store bridge. See DATA_PERSISTENCE_PLAN.md §8.8 for the
 * design and EDITOR_REFACTOR_CHECKLIST.md Phase B.
 *
 *   const registry = new MirrorRegistry()
 *   registry.register(createTranslationTextMirror({ yDoc }))
 *   // future: threadsMirror, attachmentsMirror, validationsMirror, …
 *   const dispose = await registry.startAll(ctx)
 *   // later
 *   dispose()
 */

export {
  MirrorRegistry,
  type Mirror,
  type MirrorContext,
} from "./registry"

export {
  createTranslationTextMirror,
  type TranslationTextMirrorOptions,
} from "./translation-text-mirror"

export {
  createThreadsMirror,
  type ThreadsMirrorOptions,
} from "./threads-mirror"

export {
  useMirrorRegistry,
  type MirrorRegistryStatus,
} from "./use-mirror-registry"
