# `@aquilla/idml-roundtrip`

Runtime-neutral IDML package inspection, protected-slot parsing, validation, and surgical export for Aquilla and Codex Editor.

## Status

Schema/API version: **2**

The v2 engine is intentionally strict:

- it treats every IDML `<Content>` node as a distinct text slot;
- it preserves the original paragraph, character-style, object, resource, and package structures around translated text;
- it rejects stale locators or missing, duplicated, reordered, or modified anchors;
- it returns the original bytes exactly when no content changes;
- it never emits a partially mapped translation as a successful export.

Until the automated Adobe open/preflight/save/reopen/PDF corpus gate passes, consumers must describe IDML as **experimental/content-only**, not native or lossless.

## Public API

```ts
import {
  inspectIdml,
  parseIdml,
  renderIdmlUnitHtml,
  validateIdmlTranslation,
  exportIdml,
  upgradeLegacyIdmlMetadata,
  validateExport,
} from "@aquilla/idml-roundtrip"
```

All binary inputs accept `Uint8Array` or `ArrayBuffer`. Parsing and export support `AbortSignal` cancellation and phase progress callbacks.

## Consumer contract

Persist these fields together for every IDML cell:

- the exact v2 locator returned by `parseIdml`;
- `metadata.idml` returned by `parseIdml`;
- canonical protected source and target HTML;
- the untouched original IDML as the file's source artifact.

Editors may change literal slot text and add bare line breaks inside a slot. They must not remove, duplicate, renumber, reorder, or alter `data-idml-*` anchors. Always call `validateIdmlTranslation` before committing model, translation-memory, paste, or manual editor output, and call strict `exportIdml` before offering a translated download.

Unsupported future major versions must be rejected. Do not infer or redistribute text when a locator or legacy upgrade is ambiguous.

## Packaging

The package is prepared for restricted GitHub Packages publication. Both consumers must pin the exact released version; publishing is gated on shared browser/Node conformance, both consumer builds, migration parity, and the Adobe release gate.
