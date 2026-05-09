/**
 * Editor v2 — TipTap stays, but we stop binding it to a Y.XmlFragment as
 * the persistent CRDT. The persistence shape is plain text + placeholder
 * tokens (`{g1}…{/g1}`, `{f1}`); the editor's working shape is ProseMirror
 * JSON with the `phStyle` mark and `phRef` atomic node.
 *
 * See DATA_PERSISTENCE_PLAN.md §6 and EDITOR_REFACTOR_CHECKLIST.md Phase E.
 */

export {
  parseTranslationText,
  serializeProseMirrorDoc,
  type PMDoc,
  type PMParagraph,
  type PMInline,
  type PMTextNode,
  type PMPhRefNode,
  type PMMark,
  type TagDictionary,
  type TagDictionaryEntry,
  type TagKind,
} from "./placeholder-tokens"

export {
  PhStyleMark,
  PhRefNode,
  placeholderExtensions,
} from "./placeholder-extensions"
