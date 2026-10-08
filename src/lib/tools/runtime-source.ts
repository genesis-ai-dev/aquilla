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
  }
  if (boot.theme) applyTheme(boot.theme);

  var aquilla = {
    apiRev: 1,
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
      commit: function (edits) { return call("cells.commit", { edits: edits }); },
      validate: function (items) { return call("cells.validate", { items: items }); },
      // Removed-API marker (apiRev 1): the host answers with api_removed.
      save: function (edit) { return call("cells.save", edit === undefined ? null : edit); },
    },
    terms: {
      list: function () { return call("terms.list"); },
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
    },
    ai: {
      generate: function (prompt, opts) {
        return call("ai.generate", { prompt: String(prompt), system: opts && opts.system ? String(opts.system) : "", maxTokens: opts && opts.maxTokens ? Number(opts.maxTokens) : 0 });
      },
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
  Object.freeze(aquilla.storage); Object.freeze(aquilla.permissions); Object.freeze(aquilla.ui); Object.freeze(aquilla.ai);
  Object.defineProperty(window, "aquilla", { value: Object.freeze(aquilla), writable: false, configurable: false });

  window.addEventListener("load", function () { post({ type: "ready" }); });
})();`
