import { test, expect, type Page } from "@playwright/test"
import { mkdirSync } from "node:fs"
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
import { Showcase } from "../helpers/showcase"

/**
 * AQU-2758 · Smart Extensions — Native Editor Integration (`apiRev 8` / `SDK 1.2`)
 *
 * Shot list (1280×800, clarity-first doc profile):
 *   1. Native EditorTable opens by default ("Edit with: Aquilla editor" even with an opt-in
 *      "Focus Editor" custom editor extension installed — default-editor takeover is gone).
 *   2. Open "Verse Companion & Checker" in the side panel → live active-cell sync via `aq.useActiveCell()`.
 *   3. Click "Run term check" (headless `where: ["bar"]` action) → populates native "Study notes" column
 *      (`manifest.columns`), row badges, and wavy span highlights via `aq.editor.annotate()`.
 *   4. Click a wavy span highlight → open native popover → apply one-click target quick-fix ("Replace with Jesús").
 *   5. Click "Jump to MAT 2:1" in the panel → `aq.editor.reveal()` focuses the target row in native EditorTable.
 *   6. Select source text ("Bethlehem") → `SourceSelectionToolbar` shows `where: ["selection"]` action →
 *      click "Look up term" → headless action opens/updates the panel via `aq.ui.openPanel()`.
 *   7. Right-click a cell → native context menu shows `where: ["cell"]` action ("Inspect verse notes").
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(__dirname, "../../fixtures/tools/key-terms.usfm")
const SHOTS_DIR = path.resolve(__dirname, "../output/smart-extensions-native-editor-shots")
const AUTH_BASE = process.env.VITE_FRONTIER_BASE ?? "http://127.0.0.1:8787"

const TOOL_NAME = "Verse Companion & Checker"
const CUSTOM_EDITOR_NAME = "Focus Editor"

const CUSTOM_EDITOR_MANIFEST = {
  name: CUSTOM_EDITOR_NAME,
  description: "Minimal opt-in custom editor extension for distraction-free drafting.",
  scopes: ["read:cells", "write:target"],
  mounts: ["editor"],
  apiRev: 8,
  sdk: 1,
}

const CUSTOM_EDITOR_SOURCE = `<!doctype html>
<html>
<head><meta charset="utf-8"><style>body{margin:0;padding:24px;font-family:var(--aq-font,system-ui,sans-serif)}</style></head>
<body>
<div id="app">Focus Editor</div>
<script>
(function(){
  var app = document.getElementById("app");
  if (window.aq && aq.useCells) {
    aq.useCells().ready.then(function(cells){
      app.textContent = "Focus Editor · " + (cells ? cells.length : 0) + " verses";
    });
  }
})();
</script>
</body>
</html>`

const TOOL_MANIFEST = {
  name: TOOL_NAME,
  description: "Tracks the active verse, renders a native Study notes column, flags key-term accents with one-click fixes, and adds cell & selection actions.",
  scopes: ["read:cells"],
  mounts: ["page", "panel"],
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
    { id: "scan-file", label: "Run term check", where: ["bar", "menu"] },
    { id: "inspect-verse", label: "Inspect verse notes", where: ["cell"] },
    { id: "lookup-selection", label: "Look up term", where: ["selection"] },
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
  .pill { display: inline-block; padding: 2px 7px; border-radius: 999px; font-size: 11px; font-weight: 600; background: rgba(37,99,235,.1); color: #1d4ed8; }
  .lookup { border-left: 3px solid #2563eb; padding-left: 10px; margin-top: 6px; }
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
  var GLOSS = {
    "Bethlehem": "Bethlehem of Judea (~8 km south of Jerusalem), ancestral town of David (Mic 5:2).",
    "Jesus": "Greek Iēsous (Hebrew Yeshua, 'the LORD saves'). Preferred Spanish: Jesús.",
    "David": "Israel's second king; Messiah's royal lineage."
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
        if (act.id === "lookup-selection" && act.selection) {
          var term = String(act.selection.text || "").trim();
          await aquilla.storage.set("lastLookup", {
            kind: "selection",
            term: term,
            ref: (act.cell && act.cell.ref) || "",
            note: GLOSS[term] || ("Glossary lookup for '" + term + "' in " + ((act.cell && act.cell.ref) || "active file") + "."),
            ts: Date.now()
          });
          await aq.ui.openPanel();
          await aquilla.action.done('Looked up "' + term + '"');
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

  // Panel / Page UI
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
    eye.textContent = item.kind === "selection" ? "Source Selection Action" : "Cell Menu Action";
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

test("Smart Extensions — Native Editor Integration (apiRev 8)", async ({ page }) => {
  test.setTimeout(180_000)
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

  // Map Spanish translations by actual canonicalRef / source text so heading + verses align accurately.
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

  await installExtension(jwt, seeded.projectId, TOOL_MANIFEST, TOOL_SOURCE, ["read:cells"])
  await installExtension(jwt, seeded.projectId, CUSTOM_EDITOR_MANIFEST, CUSTOM_EDITOR_SOURCE, ["read:cells"])

  const tools = new ToolsPage(page)
  const show = new Showcase(page, {
    persona: "aqu-2758",
    feature: "native-editor-integration",
    title: "Smart Extensions — Native Editor Integration (apiRev 8)",
    cta: "Extensions enhance Aquilla's real editor instead of replacing it.",
    mode: "doc",
  })

  let verified = false
  try {
    // 1. Open the file directly into Aquilla's native EditorTable (default-editor extension is retired).
    await openSeededProject(page, seeded)

    await expect(tools.editWithTrigger()).toHaveAttribute("data-editor", "standard", { timeout: 10_000 })
    await expect(tools.editWithTrigger()).toContainText(NATIVE_EDITOR)

    await show.chapter("Native editor by default", "default-editor retired · Edit with stays for opt-in custom editors")
    await show.point('[data-testid="edit-with-trigger"]')
    await show.caption("Files open directly in Aquilla's native editor — even with custom editors installed under Edit with.")

    // 2. Open the extension side panel and demonstrate live aq.useActiveCell() sync.
    await show.chapter("Live active-cell sync", "aq.useActiveCell() tracks the focused verse in real time")
    await tools.openInSidePanelFromPalette(TOOL_NAME)
    const panelFrame = tools.toolFrame(TOOL_NAME)
    await expect(panelFrame.getByTestId("panel-active-cell")).toBeVisible({ timeout: 20_000 })

    const mat11Target = page.locator(`[data-cell-id="${mat11}"] [data-editor-cell-surface="target"]`).first()
    const mat13Target = page.locator(`[data-cell-id="${mat13}"] [data-editor-cell-surface="target"]`).first()
    await mat11Target.click()
    await expect(panelFrame.getByTestId("active-ref")).toHaveText("MAT 1:1", { timeout: 10_000 })
    await show.beat(500)
    await mat13Target.click()
    await expect(panelFrame.getByTestId("active-ref")).toHaveText("MAT 1:3", { timeout: 10_000 })
    await show.caption("Clicking verses in the native editor updates side panels immediately via aq.useActiveCell().")
    await cleanScreenshot(page, "01-native-default-and-panel-sync.png")

    // 3. Run the headless bar action → populates native "Study notes" column, row badges & wavy span highlights.
    await show.chapter("Native columns, badges & span highlights", "manifest.columns + aq.editor.annotate() render natively in the grid")
    await show.click('[data-testid="extension-action"]')
    await expect(page.getByTestId("extension-column-header-notes")).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId("extension-row-badge").first()).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId("extension-row-span").first()).toBeVisible({ timeout: 10_000 })
    await mat11Target.click()
    await expect(panelFrame.getByTestId("active-ref")).toHaveText("MAT 1:1", { timeout: 10_000 })
    await show.caption("Extensions contribute read-only grid columns, row badges, and wavy span highlights — zero per-row iframes.")
    await show.beat(400)
    await cleanScreenshot(page, "02-native-column-badges-and-spans.png")

    // 4. Open a span popover and apply a one-click target quick-fix.
    await show.chapter("One-click quick-fix popovers", "Declarative span fixes apply directly in native EditorTable")
    await show.click(`[data-cell-id="${mat13}"] [data-testid="extension-row-span"]`)
    const fixButton = page.getByTestId("extension-span-apply-fix")
    await expect(fixButton).toBeVisible({ timeout: 10_000 })
    await show.caption("Clicking a span highlight explains the issue and offers a one-click target fix.")
    await cleanScreenshot(page, "03-span-quick-fix-popover.png")

    await show.click('[data-testid="extension-span-apply-fix"]')
    await expect(mat13Target).toContainText("Jesús", { timeout: 10_000 })
    await show.beat(600)

    // 5. Panel calls aq.editor.reveal() to jump to MAT 2:1 in the native editor.
    await show.chapter("Reveal from extension", "aq.editor.reveal() scrolls and focuses any verse in the real editor")
    await panelFrame.getByRole("button", { name: "Jump to MAT 2:1" }).click()
    await expect(panelFrame.getByTestId("active-ref")).toHaveText("MAT 2:1", { timeout: 10_000 })
    await show.caption("Extensions can jump straight to any verse in EditorTable with aq.editor.reveal().")
    await show.beat(400)

    // 6. Right-click MAT 1:1 to show the cell context menu extension item (`where: ["cell"]`).
    await show.chapter("Cell menu actions & panel hand-off", 'where: ["cell"] runs headless and updates the panel via aq.ui.openPanel()')
    const mat11Source = page.locator(`[data-cell-id="${mat11}"] [data-editor-cell-surface="source"]`).first()
    await mat11Source.scrollIntoViewIfNeeded()
    await mat11Source.click({ button: "right" })
    const cellAction = page.getByTestId("cell-menu-extension-inspect-verse")
    await expect(cellAction).toBeVisible({ timeout: 10_000 })
    await show.caption('Right-clicking a row surfaces cell-level extension actions ("Inspect verse notes") inside the native menu.')
    await cleanScreenshot(page, "04-cell-menu-extension-action.png")
    await cellAction.click()
    await expect(panelFrame.getByTestId("panel-lookup-card")).toContainText("Opening superscription", { timeout: 15_000 })
    await show.beat(700)

    // 7. Open "Edit with" to show native Aquilla editor is the default while custom editor extensions stay opt-in.
    await show.chapter("Custom editors remain opt-in", "Aquilla editor is always default · specialized editors live under Edit with")
    await show.click('[data-testid="edit-with-trigger"]')
    await expect(tools.editWithItem(CUSTOM_EDITOR_NAME)).toBeVisible({ timeout: 10_000 })
    await show.caption("The native editor is always the default; users can still opt into custom editors via Edit with.")
    await cleanScreenshot(page, "05-edit-with-opt-in-custom-editor.png")
    await page.keyboard.press("Escape")

    verified = true
    await dismissChapterCard(page)
    await show.beat(900)
  } finally {
    await show.save(verified)
  }
})
