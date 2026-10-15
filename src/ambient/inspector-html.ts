/** The inspector page: one file, no build step, no external requests. */
export const INSPECTOR_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ambient Inspector</title>
<style>
:root{--bg:#f7f6f2;--panel:#fff;--fg:#1c1b19;--muted:#6d6a63;--line:#e4e0d6;--accent:#2f6f5e;--accent-weak:#e3efe9;
--human:#7a4fb3;--human-weak:#efe7f8;--agent:#5f6b7a;--agent-weak:#eceff3;--warn:#a5531b;--warn-weak:#fbeadd;--ok:#2f6f5e}
@media (prefers-color-scheme:dark){:root{--bg:#131312;--panel:#1b1b19;--fg:#ecebe6;--muted:#a19e95;--line:#2c2b28;--accent:#7cc4ad;--accent-weak:#1d2f29;
--human:#c3a3f0;--human-weak:#2a2238;--agent:#a7b2c0;--agent-weak:#22262c;--warn:#f0a36e;--warn-weak:#33231a}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
header{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;padding:14px 20px;border-bottom:1px solid var(--line);background:var(--panel);position:sticky;top:0;z-index:2}
h1{font-size:16px;margin:0;letter-spacing:-.01em}h1 small{color:var(--muted);font-weight:400;margin-left:8px}
button,select,input{font:inherit;color:inherit}
button{border:1px solid var(--line);background:var(--panel);border-radius:8px;padding:6px 12px;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--bg)}
button:hover{filter:brightness(.97)}
input,select{border:1px solid var(--line);background:var(--bg);border-radius:8px;padding:6px 10px}
.layout{display:grid;grid-template-columns:260px 1fr;min-height:calc(100vh - 58px)}
aside{border-right:1px solid var(--line);padding:16px;display:flex;flex-direction:column;gap:18px}
aside h2{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:0 0 6px}
.doc{display:block;width:100%;text-align:left;border:0;background:none;padding:7px 10px;border-radius:8px;margin:1px 0}
.doc.active{background:var(--accent-weak);color:var(--accent);font-weight:600}
.doc small{display:block;color:var(--muted);font-weight:400}
main{padding:18px 20px 60px;min-width:0}
.cards{display:flex;flex-direction:column;gap:8px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 12px;font-size:13px}
.card.warn{border-color:var(--warn);background:var(--warn-weak)}
table{width:100%;border-collapse:separate;border-spacing:0;background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden}
th,td{text-align:left;vertical-align:top;padding:10px 12px;border-bottom:1px solid var(--line)}
th{font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);background:var(--bg)}
tr:last-child td{border-bottom:0}
td.src{width:34%;color:var(--fg)}
.kind{display:inline-block;font-size:11px;color:var(--muted);margin-bottom:2px}
.t{outline:none;border-radius:6px;padding:2px 4px;margin:-2px -4px;white-space:pre-wrap}
.t:focus{background:var(--bg);box-shadow:0 0 0 2px var(--accent)}
.badge{display:inline-block;font-size:11px;border-radius:999px;padding:1px 8px;margin-top:4px}
.b-agent{background:var(--agent-weak);color:var(--agent)}.b-human{background:var(--human-weak);color:var(--human)}.b-approved{background:var(--accent-weak);color:var(--ok)}.b-stale{background:var(--warn-weak);color:var(--warn)}
.row-actions{display:flex;gap:6px;margin-top:6px}
.row-actions button{font-size:12px;padding:2px 8px}
.empty{color:var(--muted);padding:30px;text-align:center}
.toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:14px}
.toolbar .grow{flex:1}
.toast{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);background:var(--fg);color:var(--bg);padding:8px 14px;border-radius:10px;opacity:0;transition:opacity .2s}
.toast.show{opacity:1}
form.inline{display:flex;flex-direction:column;gap:6px}
@media (max-width:760px){.layout{grid-template-columns:1fr}aside{border-right:0;border-bottom:1px solid var(--line)}td.src{width:auto}table,tbody,tr,td,th{display:block}thead{display:none}td{border-bottom:0}tr{border-bottom:1px solid var(--line)}}
</style>
</head>
<body>
<header>
  <h1>Ambient <small id="meta">loading…</small></h1>
  <div style="display:flex;gap:8px;flex-wrap:wrap">
    <button onclick="window.open('/api/report')">Last report</button>
    <button class="primary" id="sync">Sync now</button>
  </div>
</header>
<div class="layout">
<aside>
  <section><h2>Documents</h2><div id="docs"></div></section>
  <section><h2>Needs a decision</h2><div class="cards" id="attention"></div></section>
  <section><h2>Open in any language</h2>
    <form class="inline" id="openf"><select id="opendoc"></select><input id="openloc" placeholder="locale, e.g. sw or pt-BR" required><button>Download</button></form>
  </section>
  <section><h2>Add a term</h2>
    <form class="inline" id="termf"><input id="ts" placeholder="source term" required><input id="tt" placeholder="translation" required><input id="tl" placeholder="locale" required><button>Save term</button></form>
  </section>
</aside>
<main>
  <div class="toolbar"><strong id="doctitle" class="grow"></strong><input id="filter" placeholder="Filter…"><select id="show"><option value="all">All units</option><option value="human">Human / approved</option><option value="agent">Machine only</option><option value="stale">Needs review</option></select></div>
  <div id="units"><div class="empty">Choose a document.</div></div>
</main>
</div>
<div class="toast" id="toast"></div>
<script>
const $ = (s) => document.querySelector(s)
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])
let state = null, current = null, view = null
const toast = (m) => { const t = $("#toast"); t.textContent = m; t.classList.add("show"); setTimeout(() => t.classList.remove("show"), 2200) }
const api = async (path, body) => {
  const r = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {})
  const j = await r.json()
  if (!r.ok) throw new Error(j.error || r.statusText)
  return j
}
async function loadStatus() {
  state = await api("/api/status")
  $("#meta").textContent = state.sourceLocale + " → " + state.targets.join(", ") + " · " + state.translator + " · " + state.facts + " facts"
  $("#docs").innerHTML = state.docs.map((d) => '<button class="doc' + (d.docId === current ? " active" : "") + '" data-doc="' + esc(d.docId) + '">' + esc(d.docId) + "<small>" + (d.synced ? d.units + " units · " + d.revisions + " revision(s)" : "not synced yet") + "</small></button>").join("") || '<div class="empty">Drop files into the folder.</div>'
  $("#opendoc").innerHTML = state.docs.map((d) => "<option>" + esc(d.docId) + "</option>").join("")
  const items = []
  for (const c of state.conflicts) items.push('<div class="card warn"><strong>' + esc(c.kind) + "</strong><br>" + esc(c.detail) + "</div>")
  for (const c of state.concurrentEdits) items.push('<div class="card warn"><strong>Concurrent edits</strong> (' + esc(c.locale) + ")<br>" + c.versions.map((v) => esc(v.actor) + ": “" + esc(v.text) + "”").join("<br>") + "</div>")
  for (const s of state.suggestions) items.push('<div class="card"><strong>Correction</strong> [' + esc(s.locale) + "]<br>“" + esc(s.from) + "” → “" + esc(s.to) + '”<div class="row-actions"><button data-acc="' + s.id + '">Apply everywhere</button><button data-rej="' + s.id + '">Dismiss</button></div></div>')
  $("#attention").innerHTML = items.join("") || '<div class="card">Nothing waiting.</div>'
}
async function loadDoc(docId) {
  current = docId
  view = await api("/api/doc?doc=" + encodeURIComponent(docId))
  $("#doctitle").textContent = docId
  render()
  loadStatus()
}
function render() {
  if (!view) return
  const f = $("#filter").value.toLowerCase(), show = $("#show").value
  const rows = view.units.filter((u) => {
    if (f && !(u.source.toLowerCase().includes(f) || Object.values(u.targets).some((t) => t && t.text.toLowerCase().includes(f)))) return false
    const ts = Object.values(u.targets)
    if (show === "human") return ts.some((t) => t && t.authority !== "agent")
    if (show === "agent") return ts.every((t) => !t || t.authority === "agent")
    if (show === "stale") return ts.some((t) => !t || t.stale)
    return true
  })
  if (!rows.length) { $("#units").innerHTML = '<div class="empty">No units match.</div>'; return }
  $("#units").innerHTML = "<table><thead><tr><th>Source</th>" + view.targets.map((l) => "<th>" + esc(l) + "</th>").join("") + "</tr></thead><tbody>" + rows.map((u) =>
    '<tr><td class="src"><span class="kind">' + esc(u.kind) + (u.status !== "unchanged" ? " · " + esc(u.status) : "") + "</span><br>" + esc(u.source) + "</td>" +
    view.targets.map((l) => { const t = u.targets[l]; const badge = !t ? '<span class="badge b-stale">missing</span>' : t.stale ? '<span class="badge b-stale">source changed</span>' : '<span class="badge b-' + t.authority + '">' + t.authority + "</span>"
      return '<td><div class="t" contenteditable="true" data-unit="' + u.logicalId + '" data-loc="' + l + '">' + esc(t ? t.text : "") + "</div>" + badge + (t && t.authority === "agent" ? '<div class="row-actions"><button data-approve="' + u.logicalId + '" data-loc="' + l + '">Approve</button></div>' : "") + "</td>" }).join("") + "</tr>").join("") + "</tbody></table>"
}
document.addEventListener("click", async (e) => {
  const b = e.target.closest("button"); if (!b) return
  try {
    if (b.dataset.doc) loadDoc(b.dataset.doc)
    else if (b.dataset.approve) { await api("/api/approve", { doc: current, locale: b.dataset.loc, unit: b.dataset.approve }); toast("Approved"); loadDoc(current) }
    else if (b.dataset.acc || b.dataset.rej) { await api("/api/correction", { id: b.dataset.acc || b.dataset.rej, accept: !!b.dataset.acc }); toast(b.dataset.acc ? "Accepted — sync to propagate" : "Dismissed"); loadStatus() }
  } catch (err) { toast(err.message) }
})
document.addEventListener("focusout", async (e) => {
  const el = e.target; if (!el.classList || !el.classList.contains("t")) return
  const u = view.units.find((x) => x.logicalId === el.dataset.unit); const before = u.targets[el.dataset.loc]?.text ?? ""
  if (el.textContent === before) return
  try { await api("/api/edit", { doc: current, unit: el.dataset.unit, locale: el.dataset.loc, text: el.textContent }); toast("Saved as a human decision — sync to publish"); loadDoc(current) } catch (err) { toast(err.message) }
})
$("#sync").onclick = async () => { $("#sync").disabled = true; try { const s = await api("/api/sync", {}); toast(s.written.length ? "Wrote " + s.written.length + " file(s)" : "Everything is up to date"); if (current) loadDoc(current); else loadStatus() } catch (err) { toast(err.message) } finally { $("#sync").disabled = false } }
$("#filter").oninput = render; $("#show").onchange = render
$("#openf").onsubmit = (e) => { e.preventDefault(); location.href = "/files/" + encodeURIComponent($("#openloc").value.trim()) + "/" + $("#opendoc").value.split("/").map(encodeURIComponent).join("/") }
$("#termf").onsubmit = async (e) => { e.preventDefault(); try { await api("/api/term", { source: $("#ts").value, target: $("#tt").value, locale: $("#tl").value }); toast("Term saved — sync to apply"); e.target.reset() } catch (err) { toast(err.message) } }
loadStatus().then(() => { if (state.docs[0]) loadDoc(state.docs[0].docId) })
</script>
</body>
</html>`
