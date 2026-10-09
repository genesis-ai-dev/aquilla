/**
 * The in-frame half of the Aquilla Tools bridge.
 *
 * This is a SOURCE STRING, injected verbatim into every tool's srcdoc ahead of
 * the tool's own code (see srcdoc.ts). Keeping it a string — rather than a
 * function we `.toString()` — means what tests evaluate is byte-for-byte what
 * ships, and nothing the bundler does can change it.
 *
 * Protocol (both directions are plain postMessage objects):
 *   tool → host  { channel: "aquilla-tool", type: "call", requestId, method, params }
 *                { channel: "aquilla-tool", type: "ready" }
 *                { channel: "aquilla-tool", type: "error", message, stack }
 *   host → tool  { channel: "aquilla-host", type: "result", requestId, ok, value | error }
 *                { channel: "aquilla-host", type: "event", event: { type, ... } }
 *
 * The runtime only accepts messages whose `source` is its parent window; the
 * host only accepts messages whose `source` is this frame's contentWindow (and
 * origin "null", since the frame has an opaque origin).
 *
 * Expects `window.__AQUILLA_BOOT__` to be set by the host before this runs.
 */
export const TOOL_RUNTIME_SOURCE = String.raw`(function () {
  "use strict";
  var host = window.parent;
  var boot = window.__AQUILLA_BOOT__ || {};
  var pending = Object.create(null);
  var listeners = Object.create(null);
  var seq = 0;
  var CALL_TIMEOUT_MS = 30000;

  function post(msg) {
    msg.channel = "aquilla-tool";
    host.postMessage(msg, "*");
  }

  function call(method, params) {
    return new Promise(function (resolve, reject) {
      var requestId = "r" + (++seq) + "-" + Date.now().toString(36);
      var timer = setTimeout(function () {
        delete pending[requestId];
        reject(new Error("aquilla." + method + " timed out"));
      }, CALL_TIMEOUT_MS);
      pending[requestId] = { resolve: resolve, reject: reject, timer: timer };
      post({ type: "call", requestId: requestId, method: method, params: params === undefined ? null : params });
    });
  }

  function emit(event) {
    var list = listeners[event.type] || [];
    var all = listeners["*"] || [];
    list.concat(all).forEach(function (cb) {
      try { cb(event); } catch (err) { reportError(err); }
    });
  }

  function reportError(err) {
    var message = err && err.message ? String(err.message) : String(err);
    var stack = err && err.stack ? String(err.stack).slice(0, 4000) : "";
    post({ type: "error", message: message.slice(0, 1000), stack: stack });
  }

  window.addEventListener("message", function (e) {
    if (e.source !== host) return;
    var msg = e.data;
    if (!msg || typeof msg !== "object" || msg.channel !== "aquilla-host") return;
    if (msg.type === "result") {
      var p = pending[msg.requestId];
      if (!p) return;
      delete pending[msg.requestId];
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.value);
      else {
        var error = new Error(msg.error && msg.error.message ? msg.error.message : "bridge call failed");
        error.code = msg.error && msg.error.code ? msg.error.code : "error";
        p.reject(error);
      }
    } else if (msg.type === "event" && msg.event && typeof msg.event.type === "string") {
      if (msg.event.type === "theme" && msg.event.vars) applyTheme(msg.event.vars);
      if (msg.event.type === "fonts") applyFonts(msg.event.fonts);
      emit(msg.event);
    }
  });

  window.addEventListener("error", function (e) {
    reportError(e.error || { message: e.message || "script error" });
  });
  window.addEventListener("unhandledrejection", function (e) {
    reportError(e.reason || { message: "unhandled rejection" });
  });

  function applyTheme(vars) {
    var root = document.documentElement;
    Object.keys(vars).forEach(function (k) {
      if (/^--[a-z0-9-]+$/i.test(k)) root.style.setProperty(k, String(vars[k]));
    });
    // apiRev 3: the app's light/dark scheme as a class, like the app's own.
    if (vars["--aq-color-scheme"]) {
      var dark = vars["--aq-color-scheme"] === "dark";
      root.classList.toggle("dark", dark);
      root.style.colorScheme = dark ? "dark" : "light";
    }
    // apiRev 3: the app's breakpoints, from the APP's viewport width.
    var vw = parseFloat(vars["--aq-viewport-width"]);
    if (vw > 0) {
      root.classList.toggle("vp-sm", vw >= 640);
      root.classList.toggle("vp-md", vw >= 768);
      root.classList.toggle("vp-lg", vw >= 1024);
      root.classList.toggle("vp-xl", vw >= 1280);
    }
  }
  // apiRev 3: the app font arrives as bytes (no URL can load under the CSP).
  function applyFonts(fonts) {
    if (!Array.isArray(fonts) || typeof FontFace === "undefined" || !document.fonts) return;
    fonts.forEach(function (f) {
      try {
        if (!f || typeof f.family !== "string" || !(f.data instanceof ArrayBuffer)) return;
        var face = new FontFace(f.family, f.data, f.descriptors || {});
        document.fonts.add(face);
        face.load().catch(function () {});
      } catch (err) { /* a font is a nicety, never an error */ }
    });
  }
  if (boot.theme) applyTheme(boot.theme);

  var aquilla = {
    apiRev: 3,
    context: Object.freeze({
      tool: boot.tool || null,
      project: boot.project || null,
      user: boot.user || null,
      mount: boot.mount || "page",
      cell: boot.cell || null,
      file: boot.file || null,
    }),
    files: {
      list: function () { return call("files.list"); },
    },
    cells: {
      list: function (fileId, opts) { return call("cells.list", { fileId: fileId, lane: opts && opts.lane ? opts.lane : "" }); },
      // apiRev 2: one server page at a time (long books), and a targeted re-read.
      page: function (fileId, opts) {
        return call("cells.page", { fileId: fileId, lane: opts && opts.lane ? opts.lane : "", cursor: opts && opts.cursor ? opts.cursor : null, limit: opts && opts.limit ? Number(opts.limit) : 500 });
      },
      get: function (fileId, cellIds, opts) { return call("cells.get", { fileId: fileId, cellIds: cellIds, lane: opts && opts.lane ? opts.lane : "" }); },
      commit: function (edits) { return call("cells.commit", { edits: edits }); },
      validate: function (items) { return call("cells.validate", { items: items }); },
      unvalidate: function (items) { return call("cells.unvalidate", { items: items }); },
      // apiRev 3: chapter/section paging, host-computed per-cell signals, and
      // "the user left this cell" (pays owed repetition propagation).
      sections: function (fileId) { return call("cells.sections", { fileId: fileId }); },
      signals: function (fileId) { return call("cells.signals", { fileId: fileId }); },
      pericopes: function (fileId) { return call("cells.pericopes", { fileId: fileId }); },
      settle: function (fileId, cellId) { return call("cells.settle", { fileId: fileId, cellId: cellId }); },
      // Removed-API marker (apiRev 1): the host answers with api_removed.
      save: function (edit) { return call("cells.save", edit === undefined ? null : edit); },
    },
    terms: {
      list: function () { return call("terms.list"); },
      matches: function (fileId, cellIds) { return call("terms.matches", { fileId: fileId, cellIds: cellIds }); },
      open: function (conceptId) { return call("terms.open", { conceptId: conceptId }); },
    },
    // apiRev 3: the host editor's configuration and workspace controls.
    editor: {
      config: function (fileId) { return call("editor.config", { fileId: fileId }); },
      setLane: function (fileId, lane) { return call("editor.setLane", { fileId: fileId, lane: String(lane || "") }); },
      setLens: function (lens) { return call("editor.setLens", { lens: lens }); },
      openSettings: function (section) { return call("editor.openSettings", { section: section }); },
    },
    backtranslation: {
      list: function (fileId) { return call("backtranslation.list", { fileId: fileId }); },
      run: function (fileId, cellId) { return call("backtranslation.run", { fileId: fileId, cellId: cellId }); },
      save: function (fileId, cellId, text) { return call("backtranslation.save", { fileId: fileId, cellId: cellId, text: String(text) }); },
    },
    history: {
      open: function (fileId, cellId) { return call("history.open", { fileId: fileId, cellId: cellId }); },
    },
    attachments: {
      open: function (fileId, cellId) { return call("attachments.open", { fileId: fileId, cellId: cellId }); },
    },
    rules: {
      open: function (fileId, cellId, ruleId) { return call("rules.open", { fileId: fileId, cellId: cellId, ruleId: ruleId }); },
    },
    selection: {
      set: function (fileId, cellIds) { return call("selection.set", { fileId: fileId, cellIds: cellIds }); },
    },
    suggestions: {
      get: function (fileId, cellId, prefix) { return call("suggestions.get", { fileId: fileId, cellId: cellId, prefix: String(prefix || "") }); },
      feedback: function (fileId, cellId, suggestionId, accepted) { return call("suggestions.feedback", { fileId: fileId, cellId: cellId, suggestionId: suggestionId, accepted: !!accepted }); },
    },
    presence: {
      list: function (fileId) { return call("presence.list", { fileId: fileId }); },
      claim: function (fileId, cellId) { return call("presence.claim", { fileId: fileId, cellId: cellId }); },
      release: function (fileId, cellId) { return call("presence.release", { fileId: fileId, cellId: cellId }); },
      // apiRev 3: collaborators (colour, live draft), your own live draft, where you are.
      peers: function (fileId) { return call("presence.peers", { fileId: fileId }); },
      typing: function (fileId, cellId, selection) { return call("presence.typing", { fileId: fileId, cellId: cellId, selection: selection || null }); },
      view: function (fileId, cellId) { return call("presence.view", { fileId: fileId, cellId: cellId || null }); },
    },
    comments: {
      counts: function (fileId) { return call("comments.counts", { fileId: fileId }); },
      open: function (fileId, cellId) { return call("comments.open", { fileId: fileId, cellId: cellId }); },
    },
    audio: {
      list: function (fileId) { return call("audio.list", { fileId: fileId }); },
      play: function (fileId, cellId) { return call("audio.play", { fileId: fileId, cellId: cellId }); },
      stop: function () { return call("audio.stop"); },
      // apiRev 3: the HOST records (it owns the microphone) and synthesizes.
      record: function (fileId, cellId) { return call("audio.record", { fileId: fileId, cellId: cellId }); },
      generate: function (fileId, cellId) { return call("audio.generate", { fileId: fileId, cellId: cellId }); },
    },
    storage: {
      get: function (key) { return call("storage.get", { key: key }); },
      set: function (key, value) { return call("storage.set", { key: key, value: value }); },
      remove: function (key) { return call("storage.remove", { key: key }); },
    },
    permissions: {
      request: function (scope) { return call("permissions.request", { scope: scope }); },
      list: function () { return call("permissions.list"); },
    },
    ui: {
      notify: function (message) { return call("ui.notify", { message: String(message) }); },
      // apiRev 3: the app's UI strings in the user's language.
      strings: function (keys) { return call("ui.strings", { keys: keys }); },
      hostKey: function (k) {
        return call("ui.hostKey", { key: String(k && k.key || ""), mod: !!(k && k.mod), shift: !!(k && k.shift), alt: !!(k && k.alt) });
      },
    },
    ai: {
      generate: function (prompt, opts) {
        return call("ai.generate", { prompt: String(prompt), system: opts && opts.system ? String(opts.system) : "", maxTokens: opts && opts.maxTokens ? Number(opts.maxTokens) : 0 });
      },
      // apiRev 3: the app's own drafting pipeline (examples, brief, credits).
      draft: function (fileId, cellIds, opts) { return call("ai.draft", { fileId: fileId, cellIds: cellIds, regenerate: !!(opts && opts.regenerate) }); },
      draftParagraph: function (fileId, cellId) { return call("ai.draftParagraph", { fileId: fileId, cellId: cellId }); },
    },
    tell: function (message) { return call("tell", { message: String(message) }); },
    on: function (type, cb) {
      (listeners[type] = listeners[type] || []).push(cb);
      return function () { aquilla.off(type, cb); };
    },
    off: function (type, cb) {
      listeners[type] = (listeners[type] || []).filter(function (x) { return x !== cb; });
    },
  };
  Object.freeze(aquilla.files); Object.freeze(aquilla.cells); Object.freeze(aquilla.terms);
  Object.freeze(aquilla.presence); Object.freeze(aquilla.comments); Object.freeze(aquilla.audio);
  Object.freeze(aquilla.storage); Object.freeze(aquilla.permissions); Object.freeze(aquilla.ui); Object.freeze(aquilla.ai);
  Object.freeze(aquilla.editor); Object.freeze(aquilla.backtranslation); Object.freeze(aquilla.history); Object.freeze(aquilla.attachments);
  Object.freeze(aquilla.rules); Object.freeze(aquilla.selection); Object.freeze(aquilla.suggestions);
  Object.defineProperty(window, "aquilla", { value: Object.freeze(aquilla), writable: false, configurable: false });

  // apiRev 2: focus handoff. App-wide shortcuts (Ctrl/Cmd+K search, the
  // extensions palette, …) would die inside the frame. The host lists them in
  // boot.hostShortcuts ("mod+shift+e" form); those chords are forwarded to the
  // host (and kept from the frame's browser defaults). Only the key identity
  // crosses, and the host re-checks its own allowlist.
  var hostShortcuts = Array.isArray(boot.hostShortcuts) ? boot.hostShortcuts : [];
  function chordOf(e) {
    var k = String(e.key || "").toLowerCase();
    return ((e.ctrlKey || e.metaKey) ? "mod+" : "") + (e.shiftKey ? "shift+" : "") + (e.altKey ? "alt+" : "") + k;
  }
  window.addEventListener("keydown", function (e) {
    if (!e.key || e.key.length > 20 || hostShortcuts.indexOf(chordOf(e)) < 0) return;
    e.preventDefault();
    aquilla.ui.hostKey({ key: e.key, mod: !!(e.ctrlKey || e.metaKey), shift: e.shiftKey, alt: e.altKey }).catch(function () {});
  }, true);

  window.addEventListener("load", function () { post({ type: "ready" }); });
})();`
