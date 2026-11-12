/**
 * Aquilla extension SDK — part 8: the UI kit (aq.ui). Small, Aquilla-styled
 * building blocks over the app's own design tokens (forwarded live, light
 * and dark): Page, Panel, Card, Stack, Heading, Button, IconButton, Badge,
 * Stat, Progress, Tabs, Input, Textarea, Checkbox, Select, Spinner, Empty,
 * Avatar, Kbd, Divider, plus menu / popover / tooltip / dialog / toast.
 */
export const SDK_KIT = String.raw`
  function kids(o) { return o && (o.children !== undefined ? o.children : o.content); }
  var ui = {
    /** A full page: header (title, subtitle, actions) over a scrolling body. */
    Page: function (o) {
      o = o || {};
      return el("div", { class: "k-page" }, [
        o.title || o.actions ? el("header", { class: "k-page-h" }, [
          el("div", { class: "k-page-t" }, [o.title ? el("h1", { text: o.title }) : null, o.subtitle ? el("p", { text: o.subtitle }) : null]),
          o.actions ? el("div", { class: "k-row" }, o.actions) : null,
        ]) : null,
        el("div", { class: "k-page-b" }, kids(o)),
      ]);
    },
    /** A side-panel layout: compact header, scrolling body. */
    Panel: function (o) {
      o = o || {};
      return el("div", { class: "k-panel" }, [
        o.title ? el("header", { class: "k-panel-h" }, [el("h2", { text: o.title }), o.actions ? el("div", { class: "k-row" }, o.actions) : null]) : null,
        el("div", { class: "k-panel-b" }, kids(o)),
      ]);
    },
    Card: function (o) {
      o = o || {};
      var card = el(o.onClick ? "button" : "div", { class: "k-card" + (o.onClick ? " k-click" : "") + (o.tone ? " k-" + o.tone : ""), type: o.onClick ? "button" : null, onclick: o.onClick || null,
        "data-cell-id": o.cellId || null }, [
        o.title || o.subtitle || o.actions ? el("div", { class: "k-card-h" }, [
          el("div", { class: "k-card-t" }, [o.title ? el("div", { class: "k-title" }, o.title) : null, o.subtitle ? el("div", { class: "k-sub" }, o.subtitle) : null]),
          o.actions ? el("div", { class: "k-row" }, o.actions) : null,
        ]) : null,
        kids(o) !== undefined ? el("div", { class: "k-card-b" }, kids(o)) : null,
      ]);
      return card;
    },
    /** Flex layout: Stack({ row, gap: 8, align, justify, wrap, children }). */
    Stack: function (o) {
      o = o || {};
      return el("div", { class: "k-stack", style: { "flex-direction": o.row ? "row" : "column", gap: (o.gap === undefined ? 8 : o.gap) + "px",
        "align-items": o.align || (o.row ? "center" : "stretch"), "justify-content": o.justify || "flex-start", "flex-wrap": o.wrap ? "wrap" : "nowrap" } }, kids(o));
    },
    Heading: function (o) {
      o = typeof o === "string" ? { text: o } : o || {};
      return el("div", { class: "k-heading" }, [el(o.level === 1 ? "h1" : o.level === 3 ? "h3" : "h2", { text: o.text }), o.subtitle ? el("p", { text: o.subtitle }) : null]);
    },
    Text: function (o) {
      o = typeof o === "string" ? { text: o } : o || {};
      return el("p", { class: "k-text" + (o.muted ? " k-muted" : "") + (o.small ? " k-small" : ""), text: o.text });
    },
    /** variant: "primary" | "outline" (default) | "ghost" | "danger"; size: "sm" | "md". */
    Button: function (o) {
      o = o || {};
      var b = el("button", { class: "k-btn k-" + (o.variant || "outline") + (o.size === "sm" ? " k-sm" : ""), type: "button", title: o.title || null, "data-testid": o.testId || null,
        "aria-label": o.ariaLabel || null, onclick: o.onClick ? function (e) { e.stopPropagation(); o.onClick(e); } : null }, [o.icon ? icon(o.icon, o.size === "sm" ? "s3" : "s35") : null, o.label]);
      if (o.disabled) b.disabled = true;
      return b;
    },
    IconButton: function (o) {
      o = o || {};
      var b = el("button", { class: "rbtn k-ibtn", type: "button", "aria-label": o.label, onclick: o.onClick ? function (e) { e.stopPropagation(); o.onClick(e); } : null }, [icon(o.icon, "s35"),
        o.dot ? el("span", { class: "dot " + o.dot, "aria-hidden": "true" }) : null]);
      if (o.disabled) b.disabled = true;
      return o.label ? tip(b, o.label) : b;
    },
    /** tone: "neutral" | "primary" | "success" | "warning" | "danger". */
    Badge: function (o) {
      o = typeof o === "string" ? { text: o } : o || {};
      return el("span", { class: "k-badge k-" + (o.tone || "neutral") }, [o.icon ? icon(o.icon, "s3") : null, o.text]);
    },
    /** Stat({ label, value, hint }); stat.set(value) updates it. */
    Stat: function (o) {
      o = o || {};
      var v = el("div", { class: "k-stat-v", text: String(o.value === undefined ? "" : o.value) });
      var n = el("div", { class: "k-stat" }, [v, el("div", { class: "k-stat-l", text: o.label }), o.hint ? el("div", { class: "k-sub", text: o.hint }) : null]);
      n.set = function (x) { v.textContent = String(x); };
      return n;
    },
    Progress: function (o) {
      o = o || {};
      var pctV = Math.max(0, Math.min(100, o.max ? (o.value / o.max) * 100 : o.value || 0));
      return el("div", { class: "k-progress", role: "progressbar", "aria-valuenow": String(Math.round(pctV)), "aria-valuemin": "0", "aria-valuemax": "100", "aria-label": o.label || null },
        [el("i", { class: o.tone ? "k-" + o.tone : null, style: { width: pctV + "%" } })]);
    },
    /** Tabs({ tabs: [{ key, label, icon }], value, onChange }). */
    Tabs: function (o) {
      o = o || {};
      var bar = el("div", { class: "tabs k-tabs", role: "tablist" });
      (o.tabs || []).forEach(function (tb) {
        var b = el("button", { class: "tab", type: "button", role: "tab", "aria-selected": tb.key === o.value ? "true" : "false", tabindex: tb.key === o.value ? "0" : "-1",
          onclick: function () { if (o.onChange) o.onChange(tb.key); } }, [tb.icon ? icon(tb.icon, "s3") : null, tb.label, tb.dot ? el("span", { class: "dot " + tb.dot }) : null]);
        if (tb.disabled) b.disabled = true;
        bar.appendChild(b);
      });
      bar.addEventListener("keydown", function (e) {
        var en = (o.tabs || []).filter(function (x) { return !x.disabled; });
        var at = en.map(function (x) { return x.key; }).indexOf(o.value);
        var to = e.key === "ArrowRight" ? en[(at + 1) % en.length] : e.key === "ArrowLeft" ? en[(at - 1 + en.length) % en.length] : e.key === "Home" ? en[0] : e.key === "End" ? en[en.length - 1] : null;
        if (to && o.onChange) { e.preventDefault(); o.onChange(to.key, true); }
      });
      return bar;
    },
    Input: function (o) {
      o = o || {};
      var i = el("input", { class: "k-input", type: o.type || "text", placeholder: o.placeholder || null, "aria-label": o.label || o.placeholder || null });
      i.value = o.value || "";
      if (o.onInput) i.addEventListener("input", function () { o.onInput(i.value); });
      if (o.onEnter) i.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); o.onEnter(i.value); } });
      return o.label && o.showLabel ? el("label", { class: "k-field" }, [el("span", { text: o.label }), i]) : i;
    },
    Textarea: function (o) {
      o = o || {};
      var ta = el("textarea", { class: "k-input", rows: String(o.rows || 3), placeholder: o.placeholder || null, "aria-label": o.label || null });
      ta.value = o.value || "";
      if (o.onInput) ta.addEventListener("input", function () { o.onInput(ta.value); });
      return ta;
    },
    Checkbox: function (o) {
      o = o || {};
      var c = el("input", { type: "checkbox" });
      c.checked = !!o.checked;
      if (o.onChange) c.addEventListener("change", function () { o.onChange(c.checked); });
      return el("label", { class: "chk k-check" }, [c, o.label]);
    },
    Select: function (o) {
      o = o || {};
      var s = el("select", { class: "k-input k-select", "aria-label": o.label || null }, (o.options || []).map(function (op) {
        var v = typeof op === "object" ? op : { value: op, label: op };
        return el("option", { value: v.value, selected: v.value === o.value ? true : null, text: v.label });
      }));
      if (o.onChange) s.addEventListener("change", function () { o.onChange(s.value); });
      return s;
    },
    Spinner: function (o) { return el("span", { class: "k-spinner", role: "status" }, [icon("loader-circle", "spin"), o && o.label ? o.label : null]); },
    Empty: function (o) {
      o = typeof o === "string" ? { text: o } : o || {};
      return el("div", { class: "k-empty" }, [o.icon ? icon(o.icon, "k-empty-i") : null, o.title ? el("b", { text: o.title }) : null, o.text ? el("span", { text: o.text }) : null, o.action || null]);
    },
    Avatar: function (o) { o = typeof o === "string" ? { name: o } : o || {}; return el("span", { class: "avatar k-avatar", style: { background: o.color || "#64748b" }, title: o.name, text: initials(o.name) }); },
    Kbd: function (text) { return el("kbd", { class: "k-kbd", text: text }); },
    Divider: function () { return el("hr", { class: "k-hr" }); },
    /** Menu(anchor, [{ label, icon, run, disabled, checked }]). */
    Menu: function (anchor, items, opts) {
      var box = el("div", { class: "menu", role: "menu" });
      items.forEach(function (it) {
        if (it === "-") { box.appendChild(el("div", { class: "sep" })); return; }
        var b = el("button", { class: "mi", type: "button", role: "menuitem", onclick: function () { closePop(); if (it.run) it.run(); } },
          [it.icon ? icon(it.checked ? "check" : it.icon, "s35") : it.checked ? icon("check", "s35") : null, it.label]);
        if (it.disabled) b.disabled = true;
        box.appendChild(b);
      });
      return popover(anchor, box, Object.assign({ role: "menu", align: "start" }, opts || {}));
    },
    popover: popover,
    closePopover: closePop,
    tooltip: tip,
    /** dialog({ title, body: [nodes], actions: [{ label, primary, danger, run }] }). */
    dialog: function (o) { return dialog(o.title, o.body || [], o.actions); },
    /** confirm({ title, text, action }) → Promise<boolean>. */
    confirm: function (o) {
      return new Promise(function (resolve) {
        dialog(o.title, o.text ? [el("p", { text: o.text })] : [], [{ label: t("common.cancel"), run: function () { resolve(false); } }, { label: o.action || "OK", primary: !o.danger, danger: !!o.danger, run: function () { resolve(true); } }]);
      });
    },
    toast: toast,
  };
`

export const SDK_KIT_STYLE = String.raw`
  .k-page { display: flex; flex-direction: column; min-height: 100%; }
  .k-page-h, .k-page-b { width: 100%; max-width: 960px; margin: 0 auto; box-sizing: border-box; }
  .k-page-h { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 20px 24px 12px; }
  .k-page-t h1 { margin: 0; font-size: 20px; line-height: 28px; font-weight: 600; letter-spacing: -.01em; }
  .k-page-t p { margin: 2px 0 0; font-size: 14px; color: var(--muted-foreground); }
  .k-page-b { flex: 1; padding: 4px 24px 24px; display: flex; flex-direction: column; gap: 12px; font-size: 14px; }
  body.aq-fill .k-page { height: 100%; min-height: 0; } body.aq-fill .k-page-b { min-height: 0; }
  .k-page-b > .aq-list { margin: 0 -24px -24px; padding: 0 24px; }
  .k-panel { display: flex; flex-direction: column; height: 100%; font-size: 14px; }
  .k-panel-h { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--border); }
  .k-panel-h h2 { margin: 0; font-size: 14px; font-weight: 600; }
  .k-panel-b { flex: 1; overflow: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
  .k-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .k-stack { display: flex; min-width: 0; }
  .k-card { display: flex; flex-direction: column; gap: 8px; width: 100%; box-sizing: border-box; text-align: start; border: 1px solid var(--border); background: var(--card);
            color: var(--card-foreground); border-radius: var(--r-xl); padding: 12px 14px; box-shadow: var(--shadow-soft-xs, 0 1px 2px -1px rgb(0 0 0 / .08)); font-size: 14px; }
  .k-card.k-click { cursor: pointer; transition: background-color .15s, border-color .15s; } .k-card.k-click:hover { background: var(--muted); }
  .k-card.k-primary { border-color: color-mix(in oklab, var(--primary) 40%, var(--border)); }
  .k-card.k-success { border-color: color-mix(in oklab, var(--aq-emerald-500) 45%, var(--border)); }
  .k-card.k-warning { border-color: color-mix(in oklab, var(--aq-amber-500) 45%, var(--border)); }
  .k-card.k-danger { border-color: color-mix(in oklab, var(--destructive) 45%, var(--border)); }
  .k-card-h { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
  .k-card-t { min-width: 0; } .k-title { font-weight: 600; font-size: 14px; } .k-sub { font-size: 12px; color: var(--muted-foreground); }
  .k-card-b { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  /* Editor parts inside a card: no empty lanes, the source flush with the
     title, the translation well visible as a field (text aligned with the source). */
  .k-card .lane:empty { display: none; }
  .k-card .src, .k-card .tcol { padding: 0; min-height: 0; height: auto; }
  .k-card .src .txt { line-height: 1.6; }
  .k-card .read { min-height: 24px; }
  .k-card .well { min-height: 36px; margin: 0 -12px; background: color-mix(in oklab, var(--muted) 45%, transparent); }
  .k-card .well:hover { background: color-mix(in oklab, var(--muted) 75%, transparent); }
  .k-card .well:focus-within { background: var(--muted); }
  .k-card .after:empty { display: none; }
  .k-heading h1, .k-heading h2, .k-heading h3 { margin: 0; font-weight: 600; letter-spacing: -.01em; }
  .k-heading h1 { font-size: 20px; } .k-heading h2 { font-size: 16px; } .k-heading h3 { font-size: 14px; }
  .k-heading p { margin: 2px 0 0; font-size: 13px; color: var(--muted-foreground); }
  .k-text { margin: 0; font-size: 14px; } .k-muted { color: var(--muted-foreground); } .k-small { font-size: 12px; }
  .k-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 32px; padding: 0 12px; border-radius: var(--r-lg); font-size: 14px; font-weight: 500;
           white-space: nowrap; border: 1px solid transparent; transition: background-color .15s, color .15s, opacity .15s; box-sizing: border-box; }
  .k-btn.k-sm { height: 28px; padding: 0 10px; font-size: 12px; border-radius: var(--r-md); }
  .k-btn.k-primary { background: var(--primary); color: var(--primary-foreground); } .k-btn.k-primary:hover:not(:disabled) { background: color-mix(in oklab, var(--primary) 90%, transparent); }
  .k-btn.k-outline { border-color: var(--border); background: var(--background); box-shadow: var(--shadow-soft-xs, 0 1px 2px -1px rgb(0 0 0 / .08)); }
  html.dark .k-btn.k-outline { background: color-mix(in oklab, var(--input) 30%, transparent); border-color: var(--input); }
  .k-btn.k-outline:hover:not(:disabled), .k-btn.k-ghost:hover:not(:disabled) { background: var(--muted); }
  .k-btn.k-danger { background: var(--destructive); color: #fff; }
  .k-btn:disabled { opacity: .5; }
  .k-btn:focus-visible, .k-input:focus-visible, .k-card.k-click:focus-visible { outline: 2px solid color-mix(in oklab, var(--ring) 60%, transparent); outline-offset: 1px; }
  .k-badge { display: inline-flex; align-items: center; gap: 4px; height: 20px; padding: 0 8px; border-radius: 999px; font-size: 12px; font-weight: 500; white-space: nowrap;
             background: var(--muted); color: var(--muted-foreground); }
  .k-badge.k-primary { background: color-mix(in oklab, var(--primary) 12%, transparent); color: var(--primary); }
  .k-badge.k-success { background: color-mix(in oklab, var(--aq-emerald-500) 14%, transparent); color: var(--aq-emerald-600); }
  .k-badge.k-warning { background: color-mix(in oklab, var(--aq-amber-500) 16%, transparent); color: var(--aq-amber-600); }
  .k-badge.k-danger { background: color-mix(in oklab, var(--destructive) 12%, transparent); color: var(--destructive); }
  html.dark .k-badge.k-success { color: var(--aq-emerald-500); } html.dark .k-badge.k-warning { color: var(--aq-amber-400); }
  .k-stat { display: flex; flex-direction: column; gap: 2px; } .k-stat-v { font-size: 24px; line-height: 1.2; font-weight: 600; font-variant-numeric: tabular-nums; }
  .k-stat-l { font-size: 12px; color: var(--muted-foreground); }
  .k-progress { height: 6px; border-radius: 999px; background: var(--muted); overflow: hidden; }
  .k-progress i { display: block; height: 100%; border-radius: inherit; background: var(--primary); transition: width .3s; }
  .k-progress i.k-success { background: var(--aq-emerald-500); } .k-progress i.k-warning { background: var(--aq-amber-500); }
  .k-input { width: 100%; box-sizing: border-box; height: 32px; border: 1px solid var(--input, var(--border)); border-radius: var(--r-lg); background: transparent; color: inherit;
             padding: 0 10px; font: inherit; font-size: 14px; outline: 0; }
  textarea.k-input { height: auto; padding: 6px 10px; resize: vertical; line-height: 1.5; }
  .k-select { appearance: auto; }
  .k-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; font-weight: 500; color: var(--muted-foreground); }
  .k-check { font-size: 14px; }
  .k-spinner { display: inline-flex; align-items: center; gap: 8px; font-size: 14px; color: var(--muted-foreground); }
  .k-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; padding: 32px 16px; text-align: center; font-size: 14px; color: var(--muted-foreground); }
  .k-empty b { color: var(--foreground); font-weight: 600; } .k-empty .k-empty-i { width: 28px; height: 28px; opacity: .6; }
  .k-avatar { display: inline-flex; width: 22px; height: 22px; border-radius: 999px; align-items: center; justify-content: center; font-size: 10px; font-weight: 600; color: #fff; }
  .k-kbd { font: 500 11px/1 ui-monospace, monospace; padding: 2px 5px; border-radius: 4px; border: 1px solid var(--border); background: var(--muted); }
  .k-hr { border: 0; border-top: 1px solid var(--border); margin: 4px 0; width: 100%; }
  .k-ibtn { position: relative; }
  .vp-sm .k-page-h, html:not(.vp-md) .k-page-h { padding: 16px 16px 8px; } html:not(.vp-md) .k-page-b { padding: 4px 16px 16px; }
`
