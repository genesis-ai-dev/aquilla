/**
 * Minimal test-only custom editor extension written on the `window.aq` SDK.
 * Used by SDK unit tests (`sdk-editor-components.test.ts`, `rev4.test.ts`,
 * `rev5.test.ts`) to exercise the generic `editor` mount and `window.aq`
 * components without shipping a duplicate first-party default editor.
 */

import type { ToolManifest } from "../../../../shared/tools/manifest"

export const SDK_TEST_EDITOR_MANIFEST: ToolManifest = {
  name: "SDK Test Editor",
  description: "Minimal custom editor built on window.aq for SDK tests.",
  scopes: ["read:cells", "read:terms", "write:target", "write:validation", "read:comments", "ai:draft", "write:audio", "write:source"],
  mounts: ["page", "editor"],
  apiRev: 5,
  sdk: 1,
}

const SDK_TEST_EDITOR_APP = String.raw`
(function () {
  "use strict";
  var A = aq.actions;
  var list = aq.CellList({ row: function (id) { return aq.CellRow(id); } });
  aq.mount(aq.Layout([
    aq.Toolbar({ start: [aq.ChapterPicker()] }),
    aq.ReadOnlyBanner(),
    aq.ColumnHeader(),
    list,
  ]));
  window.__AQ_EDITOR__ = { S: aq.debug.state, scrollToCell: aq.cell.scrollTo, activate: A.edit };
})();
`

export const SDK_TEST_EDITOR_SOURCE = `<!doctype html>
<html>
<head></head>
<body>
<script>${SDK_TEST_EDITOR_APP}</script>
</body>
</html>`
