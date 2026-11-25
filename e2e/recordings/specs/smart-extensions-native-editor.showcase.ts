import { test, expect, type Page } from "@playwright/test"
import { mkdirSync, rmSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { ensureAuthState, injectSession } from "../../helpers/auth"
import { setProjectLanguagePair } from "../../helpers/frontier-api"
import { resetBackend } from "../../helpers/seed"
import {
  commitTargetServerSide,
  jwtFor,
  openSeededProject,
  readProjectedCells,
  seedProjectWithFile,
} from "../../helpers/seed-project"
import { NATIVE_EDITOR, ToolsPage } from "../../helpers/page-objects/ToolsPage"
import { Workspace } from "../../helpers/page-objects/Workspace"
import { Showcase } from "../helpers/showcase"

/**
 * AQU-2758 · Smart Extensions — Complete Tour of Extension Kinds & Native Editor Integration (apiRev 8)
 *
 * Captures both a live walkthrough video (1280×800, doc mode) AND 12 crisp screenshots
 * covering every available kind of Smart Extension and integration surface in Aquilla:
 *
 *   01-extensions-hub-and-builder.png  — /extensions hub: AI builder, starters, installed list & where:["settings"] action
 *   02-full-page-mount.png             — `page` mount: full-page Key-Term & Translation Audit dashboard
 *   03-side-panel-live-sync.png        — `panel` mount + `aq.useActiveCell()` tracking focused verse in native EditorTable
 *   04-native-column-badges-spans.png  — `manifest.columns` ("Study notes") + `aq.editor.annotate()` badges & wavy spans + where:["bar"]
 *   05-span-quick-fix-popover.png      — Declarative span popover with one-click target quick-fix ("Replace with Jesús")
 *   06-inline-cell-mount.png           — `inline` mount: per-cell expansion "Extensions" tab with `aquilla.context.cell`
 *   07-cell-menu-action.png            — `where: ["cell"]` action in native cell context menu + `aq.ui.openPanel()`
 *   08-extensions-palette.png          — Smart Extensions command palette (⌘⇧E) with `where: ["menu"]` actions & mounts
 *   09-edit-with-opt-in-menu.png       — "Edit with" switcher: native Aquilla editor always default, custom editors opt-in
 *   10-custom-editor-mount.png         — `editor` mount: opt-in Focus Editor custom editor active for the file
 *   11-importer-extension.png          — `manifest.importers`: Import dialog rendering schema-driven extension importer form
 *   12-exporter-extension.png          — `manifest.exports`: Export dialog offering custom extension export format (.tsv)
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(__dirname, "../../fixtures/tools/key-terms.usfm")
const SHOTS_DIR = path.resolve(__dirname, "../output/smart-extensions-native-editor-shots")
const AUTH_BASE = process.env.VITE_FRONTIER_BASE ?? "http://127.0.0.1:8787"

const TOOL_NAME = "Verse Companion & Checker"
const CUSTOM_EDITOR_NAME = "Focus Editor"
const IMPORTER_NAME = "Book Glossary Importer"

const CUSTOM_EDITOR_MANIFEST = {
  name: CUSTOM_EDITOR_NAME,
  description: "Distraction-free single-verse card view — opt-in custom editor via Edit with.",
  scopes: ["read:cells", "write:target"],
  mounts: ["page", "editor"],
  apiRev: 8,
  sdk: 1,
}

const CUSTOM_EDITOR_SOURCE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { margin: 0; padding: 28px 36px; font-family: var(--aq-font, system-ui, sans-serif); color: var(--aq-fg, #111); background: var(--aq-bg, #f8fafc); }
  .wrap { max-width: 720px; margin: 0 auto; }
  .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 18px; }
  .eyebrow { font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: #2563eb; }
  .title { font-size: 20px; font-weight: 700; margin-top: 2px; }
  .pill { font-size: 12px; font-weight: 600; padding: 4px 10px; border-radius: 999px; background: #e0e7ff; color: #1e40af; }
  .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 14px; padding: 22px 24px; box-shadow: 0 4px 20px rgba(15,23,42,.05); margin-bottom: 14px; }
  .ref { font-size: 13px; font-weight: 700; color: #475569; margin-bottom: 10px; }
  .src { font-size: 17px; line-height: 1.6; color: #0f172a; padding-bottom: 14px; border-bottom: 1px solid #f1f5f9; margin-bottom: 14px; }
  .lbl { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: #64748b; margin-bottom: 6px; }
  .tgt { font-size: 18px; line-height: 1.6; color: #0f172a; padding: 12px 14px; border-radius: 10px; border: 1px solid #cbd5e1; background: #f8fafc; }
  .nav { display: flex; gap: 10px; justify-content: space-between; align-items: center; margin-top: 14px; }
  button { font: inherit; font-size: 13px; font-weight: 600; padding: 7px 14px; border-radius: 8px; border: 1px solid #cbd5e1; background: #fff; cursor: pointer; }
  button.primary { background: #2563eb; color: #fff; border-color: transparent; }
</style>
</head>
<body>
<div class="wrap" id="app" data-testid="focus-editor-root">Loading Focus Editor…</div>
<script>
(function () {
  var root = document.getElementById("app");
  var idx = 1;
  var list = [];

  function render() {
    root.textContent = "";
    var header = document.createElement("div");
    header.className = "header";
    var left = document.createElement("div");
    var eye = document.createElement("div"); eye.className = "eyebrow"; eye.textContent = "Custom Editor Mount (opt-in via Edit with)";
    var title = document.createElement("div"); title.className = "title"; title.textContent = "Focus Editor";
    left.appendChild(eye); left.appendChild(title);
    var pill = document.createElement("span"); pill.className = "pill";
    pill.textContent = list.length ? ("Verse " + idx + " of " + (list.length - 1)) : "Loading";
    header.appendChild(left); header.appendChild(pill);
    root.appendChild(header);

    var c = list[idx] || list[0];
    if (!c) return;
    var card = document.createElement("div");
    card.className = "card";
    var ref = document.createElement("div"); ref.className = "ref"; ref.textContent = c.ref || "MAT";
    var sLbl = document.createElement("div"); sLbl.className = "lbl"; sLbl.textContent = "Source (English)";
    var src = document.createElement("div"); src.className = "src"; src.textContent = c.source || "";
    var tLbl = document.createElement("div"); tLbl.className = "lbl"; tLbl.textContent = "Target (Spanish)";
    var tgt = document.createElement("div"); tgt.className = "tgt"; tgt.textContent = c.target || "";
    card.appendChild(ref); card.appendChild(sLbl); card.appendChild(src); card.appendChild(tLbl); card.appendChild(tgt);
    root.appendChild(card);

    var nav = document.createElement("div");
    nav.className = "nav";
    var prev = document.createElement("button"); prev.textContent = "← Previous verse";
    prev.onclick = function () { idx = Math.max(1, idx - 1); render(); };
    var next = document.createElement("button"); next.className = "primary"; next.textContent = "Next verse →";
    next.onclick = function () { idx = Math.min(list.length - 1, idx + 1); render(); };
    nav.appendChild(prev); nav.appendChild(next);
    root.appendChild(nav);
  }

  aq.useCells().ready.then(function (cells) {
    list = cells || [];
    idx = list.length > 1 ? 1 : 0;
    render();
  });
})();
</script>
</body>
</html>`

const IMPORTER_MANIFEST = {
  name: IMPORTER_NAME,
  description: "Imports book-level key-term glossaries directly through Aquilla's Import dialog.",
  scopes: ["write:files"],
  mounts: ["page"],
  apiRev: 7,
  importers: [
    {
      id: "glossary",
      label: "Book glossary",
      description: "Create a structured glossary file per selected Scripture book.",
      options: [
        {
          key: "books",
          label: "Books to import",
          type: "multiselect",
          required: true,
          default: ["MAT"],
          choices: [
            { value: "MAT", label: "Matthew" },
            { value: "MRK", label: "Mark" },
            { value: "LUK", label: "Luke" },
          ],
        },
        {
          key: "includeNotes",
          label: "Include translator notes",
          type: "boolean",
          default: true,
        },
      ],
    },
  ],
}

const IMPORTER_SOURCE = `<!doctype html>
<html>
<head><meta charset="utf-8"><style>body{font-family:system-ui,sans-serif;padding:16px}</style></head>
<body>
<h3>Book Glossary Importer</h3>
<p>Open <strong>Import → Book glossary</strong> to run this importer with platform-rendered options.</p>
<script>
(function () {
  var ctx = aquilla.context || {};
  if (ctx.mount !== "import" || !ctx.import) return;
  (async function () {
    var books = (ctx.import.options && ctx.import.options.books) || ["MAT"];
    for (var i = 0; i < books.length; i++) {
      var b = books[i];
      await aquilla.import.progress("Importing " + b + " glossary", i / books.length);
      await aquilla.files.upsert({
        key: "showcase:glossary:" + b,
        name: b + " glossary",
        label: b + " · Key-Term Glossary",
        kind: "normal",
        tags: ["glossary", "book:" + b],
        cells: [
          { key: "g1", value: "Jesus — Greek Iēsous; Spanish: Jesús", ref: b + " 1:1" },
          { key: "g2", value: "Bethlehem — Judean town of David", ref: b + " 2:1" }
        ]
      });
    }
    await aquilla.import.done("Imported " + books.join(", "));
  })();
})();
</script>
</body>
</html>`

const TOOL_MANIFEST = {
  name: TOOL_NAME,
  description: "Full-page audit dashboard, live side panel, per-cell inline inspector, native Study notes column, span quick-fixes, contextual actions, and TSV export.",
  scopes: ["read:cells"],
  mounts: ["page", "panel", "inline"],
  apiRev: 8,
  sdk: 1,
  columns: [
    {
      id: "notes",
      label: "Study notes",
      description: "Translation & key-term notes per verse",
      placement: "after",
    },
  ],
  actions: [
    { id: "scan-file", label: "Run term check", where: ["bar", "menu", "settings"] },
    { id: "inspect-verse", label: "Inspect verse notes", where: ["cell"] },
    { id: "lookup-selection", label: "Look up term", where: ["selection"] },
  ],
  exports: [
    { id: "study-tsv", label: "Annotated Study TSV", extension: "tsv" },
  ],
}

const TOOL_SOURCE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { margin: 0; padding: 14px; font-family: var(--aq-font, system-ui, sans-serif); color: var(--aq-fg, #111); background: var(--aq-bg, #fff); font-size: 13px; line-height: 1.45; }
  .card { border: 1px solid var(--aq-border, #e2e8f0); border-radius: 10px; padding: 12px; margin-bottom: 10px; background: var(--aq-card, #fafafa); }
  .eyebrow { font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--aq-muted, #64748b); margin-bottom: 4px; }
  .ref { font-size: 16px; font-weight: 700; margin-bottom: 6px; }
  .label { font-size: 11px; font-weight: 600; color: var(--aq-muted, #64748b); margin-top: 6px; }
  .text { margin-top: 2px; color: var(--aq-fg, #111); }
  .row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
  button { font: inherit; font-size: 12px; font-weight: 600; padding: 6px 10px; border-radius: 7px; border: 1px solid var(--aq-border, #cbd5e1); background: var(--aq-bg, #fff); color: var(--aq-fg, #111); cursor: pointer; }
  button.primary { background: var(--aq-primary, #2563eb); color: #fff; border-color: transparent; }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; background: rgba(37,99,235,.1); color: #1d4ed8; }
  .pill.ok { background: #dcfce7; color: #166534; }
  .pill.warn { background: #fef3c7; color: #92400e; }
  .lookup { border-left: 3px solid #2563eb; padding-left: 10px; margin-top: 6px; }
  .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 14px; }
  .stat { border: 1px solid #e2e8f0; border-radius: 10px; padding: 12px 14px; background: #f8fafc; }
  .stat-n { font-size: 24px; font-weight: 700; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
  th { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: #64748b; background: #f8fafc; }
  .inline-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
</style>
</head>
<body>
<script>
(function () {
  var ctx = aquilla.context || {};
  var NOTES = {
    "MAT 1:1": { badge: "Genealogy", tone: "success", text: "Opening superscription tying Jesus to David and Abraham." },
    "MAT 1:2": { badge: "Names", tone: "neutral", text: "Keep patriarchal names consistent across chapters 1–2." },
    "MAT 1:3": { badge: "Key term", tone: "warn", text: "Verify Spanish diacritic on Jesús." },
    "MAT 2:1": { badge: "Geography", tone: "warn", text: "Bethlehem of Judea — check spelling of Jesús." },
    "MAT 2:2": { badge: "Key term", tone: "warn", text: "Eastern magi — verify accent on Jesús." },
    "MAT 2:3": { badge: "Context", tone: "info", text: "Herod the Great (king of Judea)." }
  };

  async function runTermCheck(fileId) {
    var files = fileId ? [{ fileId: fileId }] : await aquilla.files.list();
    var targetFileId = fileId || (files[0] && files[0].fileId);
    if (!targetFileId) return 0;
    var page = await aquilla.cells.page(targetFileId, { limit: 100 });
    var cells = page.cells || [];
    var byCell = {};
    var flagged = 0;

    for (var i = 0; i < cells.length; i++) {
      var c = cells[i];
      var ref = c.ref || "";
      var note = NOTES[ref];
      var entry = {};
      if (note) {
        entry.columns = { notes: { text: note.text, badge: note.badge, tone: note.tone } };
      }
      var target = c.target || "";
      var m = /\\b(Jesus|Jesu)\\b/.exec(target);
      if (m) {
        flagged++;
        entry.badges = [{
          id: "accent-" + c.cellId,
          label: "Accent check",
          tone: "warn",
          tooltip: "Spanish key term prefers 'Jesús' with an accent mark.",
          openPanel: true
        }];
        entry.spans = [{
          id: "span-" + c.cellId,
          side: "target",
          start: m.index,
          end: m.index + m[0].length,
          tone: "warn",
          label: "Key term spelling",
          message: "Use the team-approved Spanish spelling 'Jesús' instead of '" + m[0] + "'.",
          fix: { label: "Replace with Jesús", replacement: "Jesús" },
          openPanel: true
        }];
      } else if (ref === "MAT 1:1") {
        entry.badges = [{
          id: "ok-" + c.cellId,
          label: "Key terms OK",
          tone: "success",
          tooltip: "All tracked key terms match the project glossary."
        }];
      }
      if (entry.columns || entry.badges || entry.spans) {
        byCell[c.cellId] = entry;
      }
    }
    await aq.editor.annotate(targetFileId, { layer: "term-check", cells: byCell });
    return flagged;
  }

  // -- Headless export (manifest.exports) --
  if (ctx.mount === "export" && ctx.export) {
    (async function () {
      var fid = (ctx.export.fileIds && ctx.export.fileIds[0]) || null;
      if (!fid) {
        var files = await aquilla.files.list();
        fid = files[0] && files[0].fileId;
      }
      var page = fid ? await aquilla.cells.page(fid, { limit: 100 }) : { cells: [] };
      var lines = ["Ref\\tSource\\tTarget\\tStudy Note"];
      (page.cells || []).forEach(function (c) {
        var n = NOTES[c.ref || ""];
        lines.push([c.ref || "", c.source || "", c.target || "", n ? n.text : ""].join("\\t"));
      });
      await aquilla.export.deliver([{ name: "matthew-study-notes.tsv", text: lines.join("\\n"), mime: "text/tab-separated-values" }]);
    })();
    return;
  }

  // -- Headless action (manifest.actions) --
  if (ctx.mount === "action") {
    var act = ctx.action || {};
    (async function () {
      try {
        if (act.id === "scan-file") {
          var files = await aquilla.files.list();
          var fid = (act.cell && act.cell.fileId) || (files[0] && files[0].fileId);
          var flagged = await runTermCheck(fid);
          await aquilla.action.done("Annotated verses · " + flagged + " quick-fix suggestions ready");
          return;
        }
        if (act.id === "inspect-verse" && act.cell) {
          var r = act.cell.ref || act.cell.cellId;
          var info = NOTES[r];
          await aquilla.storage.set("lastLookup", {
            kind: "cell",
            term: r,
            ref: r,
            note: info ? info.text : "Inspecting verse " + r + " from cell context menu.",
            ts: Date.now()
          });
          await aq.ui.openPanel();
          await aquilla.action.done("Inspecting " + r);
          return;
        }
        await aquilla.action.done("Done");
      } catch (err) {
        await aquilla.action.done(String(err), false);
      }
    })();
    return;
  }

  // -- Inline cell mount (mounts: ["inline"]) --
  if (ctx.mount === "inline" && ctx.cell) {
    var inlineWrap = document.createElement("div");
    inlineWrap.setAttribute("data-testid", "inline-extension-root");
    document.body.appendChild(inlineWrap);
    (async function () {
      var list = await aquilla.cells.get(ctx.cell.fileId, [ctx.cell.cellId]);
      var c = list && list[0];
      var ref = (c && c.ref) || "Verse";
      var note = NOTES[ref];
      var srcWords = (c && c.source ? c.source.trim().split(/\\s+/).length : 0);
      var tgtWords = (c && c.target ? c.target.trim().split(/\\s+/).length : 0);

      var head = document.createElement("div");
      head.className = "card";
      var eye = document.createElement("div"); eye.className = "eyebrow"; eye.textContent = "Inline Cell Mount (aquilla.context.cell)";
      var title = document.createElement("div"); title.className = "ref"; title.textContent = ref + " — Per-Verse Key-Term Breakdown";
      head.appendChild(eye); head.appendChild(title);

      var grid = document.createElement("div");
      grid.className = "inline-grid";

      var left = document.createElement("div");
      var l1 = document.createElement("div"); l1.className = "label"; l1.textContent = "Exegesis & Glossary Note";
      var v1 = document.createElement("div"); v1.className = "text"; v1.textContent = note ? note.text : "No additional notes for this cell.";
      left.appendChild(l1); left.appendChild(v1);

      var right = document.createElement("div");
      var l2 = document.createElement("div"); l2.className = "label"; l2.textContent = "Verse Metrics";
      var v2 = document.createElement("div"); v2.className = "text"; v2.textContent = "Source: " + srcWords + " words · Target: " + tgtWords + " words";
      var badge = document.createElement("span");
      var hasIssue = c && /\\b(Jesus|Jesu)\\b/.test(c.target || "");
      badge.className = "pill " + (hasIssue ? "warn" : "ok");
      badge.style.marginTop = "6px";
      badge.textContent = hasIssue ? "Diacritic check: Jesús" : "All key terms verified";
      right.appendChild(l2); right.appendChild(v2); right.appendChild(badge);

      grid.appendChild(left); grid.appendChild(right);
      head.appendChild(grid);
      inlineWrap.appendChild(head);
    })();
    return;
  }

  // -- Full-page dashboard (mounts: ["page"]) --
  if (ctx.mount === "page") {
    var pageWrap = document.createElement("div");
    pageWrap.style.maxWidth = "980px";
    pageWrap.style.margin = "0 auto";
    pageWrap.setAttribute("data-testid", "page-dashboard-root");
    document.body.appendChild(pageWrap);

    aq.useCells().ready.then(function (cells) {
      var verses = (cells || []).filter(function (c) { return !!c.ref; });
      var flagged = verses.filter(function (c) { return /\\b(Jesus|Jesu)\\b/.test(c.target || ""); }).length;
      var okCount = verses.length - flagged;

      var eye = document.createElement("div"); eye.className = "eyebrow"; eye.textContent = "Full-Page Extension Mount (/extensions/:toolId)";
      var h = document.createElement("div"); h.className = "ref"; h.style.fontSize = "22px"; h.textContent = "Verse Companion & Key-Term Audit — Matthew (Spanish)";
      pageWrap.appendChild(eye); pageWrap.appendChild(h);

      var stats = document.createElement("div"); stats.className = "stats";
      [
        ["Verses scanned", String(verses.length)],
        ["Key terms verified", String(okCount)],
        ["Quick-fix suggestions", String(flagged)]
      ].forEach(function (pair) {
        var box = document.createElement("div"); box.className = "stat";
        var n = document.createElement("div"); n.className = "stat-n"; n.textContent = pair[1];
        var l = document.createElement("div"); l.className = "label"; l.textContent = pair[0];
        box.appendChild(n); box.appendChild(l); stats.appendChild(box);
      });
      pageWrap.appendChild(stats);

      var tbl = document.createElement("table");
      var thead = document.createElement("thead");
      var hr = document.createElement("tr");
      ["Ref", "Source", "Spanish Target", "Status", "Study Note"].forEach(function (col) {
        var th = document.createElement("th"); th.textContent = col; hr.appendChild(th);
      });
      thead.appendChild(hr); tbl.appendChild(thead);

      var tbody = document.createElement("tbody");
      verses.forEach(function (c) {
        var tr = document.createElement("tr");
        var issue = /\\b(Jesus|Jesu)\\b/.test(c.target || "");
        var note = NOTES[c.ref || ""];
        var tdRef = document.createElement("td"); tdRef.style.fontWeight = "600"; tdRef.style.whiteSpace = "nowrap"; tdRef.textContent = c.ref;
        var tdSrc = document.createElement("td"); tdSrc.textContent = c.source || "";
        var tdTgt = document.createElement("td"); tdTgt.textContent = c.target || "";
        var tdSt = document.createElement("td");
        var sp = document.createElement("span");
        sp.className = "pill " + (issue ? "warn" : "ok");
        sp.textContent = issue ? "Accent check" : "Verified";
        tdSt.appendChild(sp);
        var tdNote = document.createElement("td"); tdNote.textContent = note ? note.text : "";
        tr.appendChild(tdRef); tr.appendChild(tdSrc); tr.appendChild(tdTgt); tr.appendChild(tdSt); tr.appendChild(tdNote);
        tbody.appendChild(tr);
      });
      tbl.appendChild(tbody);
      pageWrap.appendChild(tbl);
    });
    return;
  }

  // -- Side panel (mounts: ["panel"]) --
  var root = document.createElement("div");
  document.body.appendChild(root);

  var activeCard = document.createElement("div");
  activeCard.className = "card";
  activeCard.setAttribute("data-testid", "panel-active-cell");
  root.appendChild(activeCard);

  var lookupCard = document.createElement("div");
  lookupCard.className = "card";
  lookupCard.setAttribute("data-testid", "panel-lookup-card");
  lookupCard.style.display = "none";
  root.appendChild(lookupCard);

  var actionsCard = document.createElement("div");
  actionsCard.className = "card";
  root.appendChild(actionsCard);

  var fileCells = [];
  var currentFileId = null;

  function renderActive(ac) {
    activeCard.textContent = "";
    var eye = document.createElement("div");
    eye.className = "eyebrow";
    eye.textContent = "Live Active Cell (aq.useActiveCell)";
    activeCard.appendChild(eye);

    var title = document.createElement("div");
    title.className = "ref";
    title.setAttribute("data-testid", "active-ref");
    title.textContent = ac && ac.ref ? ac.ref : "Click a verse in the editor";
    activeCard.appendChild(title);

    if (ac) {
      var sLab = document.createElement("div"); sLab.className = "label"; sLab.textContent = "Source";
      var sVal = document.createElement("div"); sVal.className = "text"; sVal.textContent = ac.source || "—";
      var tLab = document.createElement("div"); tLab.className = "label"; tLab.textContent = "Target";
      var tVal = document.createElement("div"); tVal.className = "text"; tVal.textContent = ac.target || "—";
      activeCard.appendChild(sLab); activeCard.appendChild(sVal);
      activeCard.appendChild(tLab); activeCard.appendChild(tVal);
      var note = NOTES[ac.ref || ""];
      if (note) {
        var nLab = document.createElement("div"); nLab.className = "label"; nLab.textContent = "Exegesis note";
        var nVal = document.createElement("div"); nVal.className = "text"; nVal.textContent = note.text;
        activeCard.appendChild(nLab); activeCard.appendChild(nVal);
      }
    }
  }

  function renderLookup(item) {
    if (!item) { lookupCard.style.display = "none"; return; }
    lookupCard.style.display = "block";
    lookupCard.textContent = "";
    var eye = document.createElement("div");
    eye.className = "eyebrow";
    eye.textContent = "Cell Menu Action";
    lookupCard.appendChild(eye);
    var pill = document.createElement("span");
    pill.className = "pill";
    pill.textContent = item.term;
    lookupCard.appendChild(pill);
    var body = document.createElement("div");
    body.className = "lookup";
    body.textContent = item.note;
    lookupCard.appendChild(body);
  }

  function renderControls() {
    actionsCard.textContent = "";
    var eye = document.createElement("div");
    eye.className = "eyebrow";
    eye.textContent = "Native Editor Controls (apiRev 8)";
    actionsCard.appendChild(eye);

    var row = document.createElement("div");
    row.className = "row";

    var jumpBtn = document.createElement("button");
    jumpBtn.className = "primary";
    jumpBtn.textContent = "Jump to MAT 2:1";
    jumpBtn.onclick = function () {
      var target = fileCells.find(function (c) { return c.ref === "MAT 2:1"; });
      if (target && currentFileId) aq.editor.reveal(currentFileId, target.cellId, { focus: true });
    };
    row.appendChild(jumpBtn);

    var checkBtn = document.createElement("button");
    checkBtn.textContent = "Refresh annotations";
    checkBtn.onclick = function () { if (currentFileId) runTermCheck(currentFileId); };
    row.appendChild(checkBtn);

    actionsCard.appendChild(row);
  }

  var activeHandle = aq.useActiveCell();
  renderActive(activeHandle.value);
  activeHandle.subscribe(function (ac) { renderActive(ac); });
  activeHandle.ready.then(function (ac) { if (ac) renderActive(ac); });

  var filesHandle = aq.useCells();
  filesHandle.ready.then(function (cells) {
    fileCells = cells || [];
    currentFileId = aq.useFile().value.fileId;
    renderControls();
  });
  renderControls();

  async function pollLookup() {
    try {
      var v = await aquilla.storage.get("lastLookup");
      if (v) renderLookup(v);
    } catch (_) {}
  }
  pollLookup();
  setInterval(pollLookup, 350);
})();
</script>
</body>
</html>`

async function installExtension(
  jwt: string,
  projectId: string,
  manifest: Record<string, unknown>,
  source: string,
  grant: string[],
): Promise<string> {
  const res = await fetch(`${AUTH_BASE}/api/v2/projects/${projectId}/tools`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ source, manifest, origin: "starter", grant }),
  })
  if (!res.ok) {
    throw new Error(`installExtension(${String(manifest.name)}) failed: HTTP ${res.status} — ${await res.text()}`)
  }
  const body = (await res.json()) as { tool: { id: string } }
  return body.tool.id
}

async function dismissChapterCard(page: Page): Promise<void> {
  await page.evaluate(() => document.getElementById("__showcase_chapter")?.classList.remove("on"))
  await page.waitForTimeout(550)
}

async function cleanScreenshot(page: Page, filename: string): Promise<void> {
  await dismissChapterCard(page)
  await page.evaluate(() => {
    const bug = document.getElementById("__showcase_bug")
    const cursor = document.getElementById("__showcase_cursor")
    if (bug) bug.style.opacity = "0"
    if (cursor) cursor.style.opacity = "0"
  })
  await page.screenshot({ path: path.join(SHOTS_DIR, filename) })
  await page.evaluate(() => {
    const bug = document.getElementById("__showcase_bug")
    const cursor = document.getElementById("__showcase_cursor")
    if (bug) bug.style.opacity = ""
    if (cursor) cursor.style.opacity = ""
  })
}

test("Smart Extensions — All Extension Kinds & Native Editor Integration (apiRev 8)", async ({ page }) => {
  test.setTimeout(240_000)
  rmSync(SHOTS_DIR, { recursive: true, force: true })
  mkdirSync(SHOTS_DIR, { recursive: true })

  await resetBackend()
  const session = await ensureAuthState("alice")
  await page.context().addCookies([{ name: "aq_hint", value: "1", url: process.env.E2E_BASE_URL ?? "http://127.0.0.1:6173" }])
  await page.goto("/")
  await injectSession(page, session)

  const jwt = await jwtFor("alice")
  const seeded = await seedProjectWithFile(jwt, {
    smartExtensions: true,
    steeringContext: false,
    name: "Matthew (Spanish)",
    fixturePath: FIXTURE,
  })
  await setProjectLanguagePair(jwt, seeded.projectId, {
    sourceLanguage: "English",
    sourceCode: "en",
    targetLanguage: "Spanish",
    targetCode: "es",
    translationBrief: { parameters: { purpose: "Spanish Gospel translation" } },
  })

  const sourceCells = await readProjectedCells(jwt, seeded, "source")
  const idByRef = new Map<string, string>()
  for (const row of sourceCells) {
    const refMatch = row.value.includes("genealogy") ? "MAT 1:1"
      : row.value.includes("Abraham") ? "MAT 1:2"
        : row.value.includes("Joseph named") ? "MAT 1:3"
          : row.value.includes("Bethlehem") ? "MAT 2:1"
            : row.value.includes("Wise men") ? "MAT 2:2"
              : row.value.includes("Herod") ? "MAT 2:3"
                : row.value.trim() === "Matthew" ? "HEADING" : null
    if (refMatch) idByRef.set(refMatch, row.cellId)
  }

  const targetsByRef: Record<string, string> = {
    HEADING: "Mateo",
    "MAT 1:1": "Libro de la genealogía de Jesús, hijo de David.",
    "MAT 1:2": "Abraham engendró a Isaac.",
    "MAT 1:3": "José llamó al niño Jesus.",
    "MAT 2:1": "Jesu nació en Belén de Judea.",
    "MAT 2:2": "Unos sabios vinieron a adorar a Jesus.",
    "MAT 2:3": "Herodes se turbó.",
  }
  for (const [ref, text] of Object.entries(targetsByRef)) {
    const cellId = idByRef.get(ref)
    if (cellId) await commitTargetServerSide(jwt, seeded, cellId, text, "alice")
  }

  const mat11 = idByRef.get("MAT 1:1")!
  const mat13 = idByRef.get("MAT 1:3")!

  const companionId = await installExtension(jwt, seeded.projectId, TOOL_MANIFEST, TOOL_SOURCE, ["read:cells"])
  await installExtension(jwt, seeded.projectId, CUSTOM_EDITOR_MANIFEST, CUSTOM_EDITOR_SOURCE, ["read:cells"])
  await installExtension(jwt, seeded.projectId, IMPORTER_MANIFEST, IMPORTER_SOURCE, ["write:files"])

  const tools = new ToolsPage(page)
  const ws = new Workspace(page)
  const show = new Showcase(page, {
    persona: "aqu-2758",
    feature: "native-editor-integration",
    title: "Smart Extensions — Every Extension Kind & Native Editor Integration (apiRev 8)",
    cta: "Extensions enhance Aquilla's real editor, importers, exporters, and workspaces.",
    mode: "doc",
  })

  let verified = false
  try {
    // ── Shot 01: Smart Extensions Hub & Builder (/extensions) ────────────────
    await tools.open(seeded.projectId)
    await expect(tools.installedTool(TOOL_NAME)).toBeVisible({ timeout: 15_000 })
    await expect(tools.installedTool(CUSTOM_EDITOR_NAME)).toBeVisible({ timeout: 10_000 })
    await expect(tools.installedTool(IMPORTER_NAME)).toBeVisible({ timeout: 10_000 })
    await tools.installedTool(TOOL_NAME).scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(SHOTS_DIR, "01-extensions-hub-and-builder.png") })

    // ── Shot 02: Full-page extension mount (`mounts: ["page"]`) ──────────────
    await page.goto(`/project/${seeded.projectId}/extensions/${companionId}`)
    const pageFrame = tools.toolFrame(TOOL_NAME)
    await expect(pageFrame.getByTestId("page-dashboard-root")).toBeVisible({ timeout: 20_000 })
    await expect(pageFrame.getByText("Verses scanned")).toBeVisible({ timeout: 10_000 })
    await page.screenshot({ path: path.join(SHOTS_DIR, "02-full-page-mount.png") })

    // ── Shot 03: Native EditorTable default + side panel (`mounts: ["panel"]`) ─
    await openSeededProject(page, seeded)
    await expect(tools.editWithTrigger()).toHaveAttribute("data-editor", "standard", { timeout: 10_000 })
    await expect(tools.editWithTrigger()).toContainText(NATIVE_EDITOR)

    await show.chapter("Native editor by default", "default-editor retired · Edit with stays for opt-in custom editors")
    await show.point('[data-testid="edit-with-trigger"]')
    await show.caption("Files always open in Aquilla's native editor — even with custom editors installed.")

    await show.chapter("Side panel & live active-cell sync", "mounts: ['panel'] + aq.useActiveCell()")
    await tools.openInSidePanelFromPalette(TOOL_NAME)
    const panelFrame = tools.toolFrame(TOOL_NAME)
    await expect(panelFrame.getByTestId("panel-active-cell")).toBeVisible({ timeout: 20_000 })

    const mat11Target = page.locator(`[data-cell-id="${mat11}"] [data-editor-cell-surface="target"]`).first()
    const mat13Target = page.locator(`[data-cell-id="${mat13}"] [data-editor-cell-surface="target"]`).first()
    await mat11Target.click()
    await expect(panelFrame.getByTestId("active-ref")).toHaveText("MAT 1:1", { timeout: 10_000 })
    await show.beat(400)
    await mat13Target.click()
    await expect(panelFrame.getByTestId("active-ref")).toHaveText("MAT 1:3", { timeout: 10_000 })
    await show.caption("Side panels track the active verse live via aq.useActiveCell().")
    await cleanScreenshot(page, "03-side-panel-live-sync.png")

    // ── Shot 04: Native columns, row badges, wavy spans & where:["bar"] ──────
    await show.chapter("Native columns, badges & spans", "manifest.columns + aq.editor.annotate() + where: ['bar']")
    await show.click('[data-testid="extension-action"]')
    await expect(page.getByTestId("extension-column-header-notes")).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId("extension-row-badge").first()).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId("extension-row-span").first()).toBeVisible({ timeout: 10_000 })
    await mat11Target.click()
    await expect(panelFrame.getByTestId("active-ref")).toHaveText("MAT 1:1", { timeout: 10_000 })
    await show.caption("Extensions contribute native grid columns, row badges, and wavy span highlights — zero per-row iframes.")
    await cleanScreenshot(page, "04-native-column-badges-spans.png")

    // ── Shot 05: Span popover + one-click target quick-fix ───────────────────
    await show.chapter("One-click quick-fix popovers", "Declarative span fixes apply directly in native EditorTable")
    await show.click(`[data-cell-id="${mat13}"] [data-testid="extension-row-span"]`)
    await expect(page.getByTestId("extension-span-apply-fix")).toBeVisible({ timeout: 10_000 })
    await show.caption("Clicking a wavy span explains the issue and offers a one-click target fix.")
    await cleanScreenshot(page, "05-span-quick-fix-popover.png")
    await show.click('[data-testid="extension-span-apply-fix"]')
    await expect(mat13Target).toContainText("Jesús", { timeout: 10_000 })
    await show.beat(400)

    // ── Shot 06: Inline cell mount (`mounts: ["inline"]`) ────────────────────
    await show.chapter("Inline per-cell mount", "mounts: ['inline'] renders under a verse with aquilla.context.cell")
    await mat11Target.click()
    const mat11Row = page.locator(`[data-cell-id="${mat11}"]`).first()
    await mat11Row.getByRole("button", { name: "Open cell details" }).click()
    await mat11Row.getByRole("tab", { name: "Extensions" }).click()
    await expect(mat11Row.getByTestId("tools-inline-tab")).toBeVisible({ timeout: 15_000 })
    const inlineFrame = mat11Row.frameLocator(`iframe[title="${TOOL_NAME} (sandboxed extension)"]`)
    await expect(inlineFrame.getByTestId("inline-extension-root")).toContainText("MAT 1:1", { timeout: 15_000 })
    await mat11Row.getByTestId("tools-inline-tab").scrollIntoViewIfNeeded()
    await show.caption("Inline mounts attach a per-cell extension tab directly inside a verse's expansion drawer.")
    await cleanScreenshot(page, "06-inline-cell-mount.png")
    await mat11Row.getByRole("button", { name: "Close cell details" }).first().click()

    // ── Shot 07: Cell context menu action (`where: ["cell"]`) + ui.openPanel() ─
    await show.chapter("Cell menu actions & panel hand-off", "where: ['cell'] runs headless and opens/updates the side panel")
    const mat11Source = mat11Row.locator('[data-editor-cell-surface="source"]').first()
    await mat11Source.click({ button: "right" })
    const cellAction = page.getByTestId("cell-menu-extension-inspect-verse")
    await expect(cellAction).toBeVisible({ timeout: 10_000 })
    await show.caption('Right-clicking a row exposes cell-level extension actions ("Inspect verse notes").')
    await cleanScreenshot(page, "07-cell-menu-action.png")
    await cellAction.click()
    await expect(panelFrame.getByTestId("panel-lookup-card")).toContainText("Opening superscription", { timeout: 15_000 })

    // ── Panel reveal (`aq.editor.reveal()`) ──────────────────────────────────
    await show.chapter("Jump to verse from extension", "aq.editor.reveal() focuses any verse in EditorTable")
    await panelFrame.getByRole("button", { name: "Jump to MAT 2:1" }).click()
    await expect(panelFrame.getByTestId("active-ref")).toHaveText("MAT 2:1", { timeout: 10_000 })
    await show.beat(400)

    // ── Shot 08: Smart Extensions Command Palette (`⌘⇧E`, where: ["menu"]) ───
    await show.chapter("Extensions command palette", "⌘⇧E lists panels, custom editors, full pages & menu actions")
    await page.getByRole("button", { name: "Smart Extensions (⌘⇧E)", exact: true }).click()
    await expect(page.getByRole("option", { name: `${TOOL_NAME}: Run term check` })).toBeVisible({ timeout: 10_000 })
    await show.caption("The command palette surfaces every installed extension's panels, editors, pages, and actions.")
    await cleanScreenshot(page, "08-extensions-palette.png")
    await page.keyboard.press("Escape")

    // ── Shot 09 & 10: Edit with opt-in menu + active custom `editor` mount ───
    await show.chapter("Opt-in custom editors", "Aquilla editor is default · specialized editors live under Edit with")
    await show.click('[data-testid="edit-with-trigger"]')
    await expect(tools.editWithItem(CUSTOM_EDITOR_NAME)).toBeVisible({ timeout: 10_000 })
    await show.caption("Native Aquilla editor stays default; users can still opt into specialized custom editors.")
    await cleanScreenshot(page, "09-edit-with-opt-in-menu.png")

    await tools.editWithItem(CUSTOM_EDITOR_NAME).click()
    const focusFrame = tools.toolFrame(CUSTOM_EDITOR_NAME)
    await expect(focusFrame.getByTestId("focus-editor-root")).toContainText("MAT 1:1", { timeout: 20_000 })
    await show.caption("Custom editor extensions (mounts: ['editor']) render full alternative views and switch right back to native.")
    await cleanScreenshot(page, "10-custom-editor-mount.png")

    // Switch back to native Aquilla editor before Import/Export dialogs.
    await tools.switchEditor(NATIVE_EDITOR)
    await expect(tools.editWithTrigger()).toHaveAttribute("data-editor", "standard", { timeout: 10_000 })

    // ── Shot 11: Importer extension (`manifest.importers`) in Import dialog ──
    await show.chapter("Importer extensions", "manifest.importers renders schema-driven forms inside Import")
    await ws.openImportDialog()
    const glossaryImporter = page.getByTestId("extension-importer").filter({ hasText: "Book glossary" })
    await expect(glossaryImporter).toBeVisible({ timeout: 15_000 })
    await glossaryImporter.click()
    await expect(page.getByTestId("extension-import-panel")).toBeVisible({ timeout: 10_000 })
    await show.caption("Importer extensions contribute directly to Aquilla's Import dialog with platform-rendered options.")
    await cleanScreenshot(page, "11-importer-extension.png")
    await page.keyboard.press("Escape")

    // ── Shot 12: Exporter extension (`manifest.exports`) in Export dialog ────
    await show.chapter("Exporter extensions", "manifest.exports adds custom formats inside Aquilla's Export dialog")
    await ws.openExportDialog()
    const studyExport = page.getByTestId("extension-export").filter({ hasText: "Annotated Study TSV" })
    await expect(studyExport).toBeVisible({ timeout: 15_000 })
    await studyExport.scrollIntoViewIfNeeded()
    await show.caption("Exporter extensions add custom download formats directly inside the Export dialog.")
    await cleanScreenshot(page, "12-exporter-extension.png")
    await page.keyboard.press("Escape")

    verified = true
    await dismissChapterCard(page)
    await show.beat(700)
  } finally {
    await show.save(verified)
  }
})
