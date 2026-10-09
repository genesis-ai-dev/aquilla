/**
 * Styles for the first-party default editor extension (see default-editor.ts).
 *
 * A hand-written replica of the built-in editor's Tailwind classes
 * (EditorTable, EditorCellSurface, TargetValidationControl, CellActionRail,
 * ChapterNavigator, CellExpansion …) over the app's own design tokens, which
 * the host forwards as CSS variables (light/dark tracked live). Breakpoint
 * classes on <html> (vp-md, vp-lg, vp-xl) come from the APP's viewport, so the
 * responsive layout switches exactly where the built-in's does.
 */
export const DEFAULT_EDITOR_STYLE = String.raw`
  :root {
    --aq-green-500: oklch(72.3% 0.219 149.579);
    --aq-blue-400: oklch(70.7% 0.165 254.624);
    --aq-blue-500: oklch(62.3% 0.214 259.815);
    --aq-blue-600: oklch(54.6% 0.245 262.881);
    --aq-amber-400: oklch(82.8% 0.189 84.429);
    --aq-amber-500: oklch(76.9% 0.188 70.08);
    --aq-amber-600: oklch(66.6% 0.179 58.318);
    --aq-red-500: oklch(63.7% 0.237 25.331);
    --aq-red-600: oklch(57.7% 0.245 27.325);
    --aq-emerald-500: oklch(69.6% 0.17 162.48);
    --aq-emerald-600: oklch(59.6% 0.145 163.225);
    --aq-sky-400: oklch(74.6% 0.16 232.661);
    --aq-sky-500: oklch(68.5% 0.169 237.323);
    --aq-sky-600: oklch(58.8% 0.158 241.966);
    --aq-violet-500: oklch(60.6% 0.25 292.717);
    --aq-violet-600: oklch(54.1% 0.281 293.009);
    --r-sm: calc(var(--radius, .375rem) * .6);
    --r-md: calc(var(--radius, .375rem) * .8);
    --r-lg: var(--radius, .375rem);
    --r-xl: calc(var(--radius, .375rem) * 1.4);
    --aq-issue: var(--aq-amber-600);
    --aq-major: var(--aq-red-600);
  }
  html.dark { --aq-issue: var(--aq-amber-400); --aq-major: oklch(70.4% 0.191 22.216); }
  html { font-size: 16px; }
  html, body { height: 100%; }
  body { margin: 0; display: flex; flex-direction: column; overflow: hidden; font-family: var(--font-sans, 'Geist Variable', system-ui, sans-serif);
         font-size: 16px; line-height: 1.5; user-select: none; }
  button { font: inherit; color: inherit; background: none; border: 0; padding: 0; margin: 0; cursor: pointer; }
  button:disabled { cursor: default; }
  svg.i { width: 16px; height: 16px; flex-shrink: 0; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; display: block; }
  svg.i.s3 { width: 12px; height: 12px; } svg.i.s35 { width: 14px; height: 14px; } svg.i.s4 { width: 16px; height: 16px; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .muted { color: var(--muted-foreground); }

  /* ── Chapter row (EDITOR_SURFACE_TOOLBAR_CLASS) ───────────────────────── */
  .chapter-row { position: relative; display: flex; min-width: 0; flex-shrink: 0; align-items: center; gap: 8px; height: 49px; box-sizing: border-box;
                 border-bottom: 1px solid var(--border); background: color-mix(in oklab, var(--background) 90%, transparent);
                 padding: 8px 8px 8px 16px; backdrop-filter: blur(24px); }
  .chapter-row .fill { display: none; min-width: 0; flex: 1 1 0%; }
  .vp-lg .chapter-row .fill { display: block; }
  .chapter-row .slot { margin-inline-end: auto; display: flex; min-width: 96px; max-width: 100%; flex: 1 1 0%; align-items: center; }
  .vp-lg .chapter-row .slot { margin-inline-end: 0; flex: none; flex-shrink: 1; }
  .chapter-row .chrome-pad { flex-shrink: 0; }
  .vp-lg .chapter-row .chrome-pad { flex: 1 1 0%; }
  .navw { min-width: 0; max-width: 100%; width: 100%; } .vp-lg .navw { width: auto; }
  .bgroup { display: flex; align-items: stretch; }
  .btn-o { display: inline-flex; align-items: center; justify-content: center; height: 32px; box-sizing: border-box; border: 1px solid var(--border);
           background: var(--background); box-shadow: var(--shadow-soft-xs, 0 1px 2px -1px rgb(0 0 0 / .08)); font-size: 14px; font-weight: 500;
           color: var(--foreground); border-radius: var(--r-lg); transition: background-color .15s, color .15s; }
  html.dark .btn-o { background: color-mix(in oklab, var(--input) 30%, transparent); border-color: var(--input); }
  .btn-o:hover:not(:disabled) { background: var(--muted); }
  .bgroup .btn-o { border-radius: 0; } .bgroup .btn-o:first-child { border-radius: var(--r-lg) 0 0 var(--r-lg); }
  .bgroup .btn-o:last-child { border-radius: 0 var(--r-lg) var(--r-lg) 0; } .bgroup .btn-o + .btn-o { border-inline-start-width: 0; }
  .btn-o.sq { width: 32px; padding: 0; } .btn-o:disabled svg { opacity: .3; }
  .ms-trigger { gap: 4px; padding: 0 8px; min-width: 32px; max-width: 100%; overflow: hidden; justify-content: center; }
  .vp-xl .ms-trigger { width: 224px; min-width: 224px; justify-content: flex-start; gap: 6px; padding: 0 8px 0 10px; }
  .vp-xl .ms-trigger > svg:last-child { margin-inline-start: auto; }
  .ms-trigger .lbl { display: flex; min-width: 0; align-items: center; gap: 8px; text-align: start; }
  .ms-trigger .lbl b { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; line-height: 1; }
  .ms-trigger .lbl span { display: none; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 400; line-height: 1; color: var(--muted-foreground); }
  .vp-xl .ms-trigger .lbl span { display: inline; }
  .ms-trigger svg { opacity: .5; }
  .btn-g { display: inline-flex; align-items: center; gap: 6px; height: 28px; border: 1px solid transparent; box-sizing: border-box; border-radius: var(--r-md); padding: 0 10px; font-size: 12px; font-weight: 500; white-space: nowrap; color: var(--foreground); }
  .btn-g:hover { background: var(--muted); }

  /* Popovers (picker, menus, validators, footnote, dialogs) */
  .pop { position: fixed; z-index: 50; background: var(--popover, var(--card)); color: var(--popover-foreground, var(--card-foreground)); border-radius: var(--r-lg);
         box-shadow: var(--shadow-soft, 0 6px 18px -4px rgb(0 0 0 / .1)); outline: 1px solid color-mix(in oklab, var(--foreground) 10%, transparent); font-size: 14px;
         animation: pop-in .12s ease-out; }
  @keyframes pop-in { from { opacity: 0; transform: scale(.96); } to { opacity: 1; transform: none; } }
  .picker { width: 288px; display: flex; flex-direction: column; overflow: hidden; }
  .picker .search { display: flex; align-items: center; gap: 8px; padding: 0 12px; height: 36px; border-bottom: 1px solid var(--border); }
  .picker .search input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: inherit; font: inherit; font-size: 14px; }
  .picker .list { height: 288px; overflow: auto; overscroll-behavior: contain; padding: 4px; }
  .picker .bookh { padding: 6px 8px 2px; font-size: 12px; font-weight: 600; color: var(--muted-foreground); }
  .picker .item { display: flex; width: 100%; align-items: center; gap: 8px; border-radius: var(--r-md); padding: 4px 8px; font-size: 14px; text-align: start; }
  .picker .item:hover, .picker .item[data-hl] { background: var(--accent); color: var(--accent-foreground); }
  .picker .item .t { min-width: 0; flex: 1; } .picker .item .t b { display: block; font-weight: 500; font-variant-numeric: tabular-nums; }
  .picker .item .t span { display: block; font-size: 12px; color: var(--muted-foreground); }
  .picker .prog { width: 56px; flex-shrink: 0; font-size: 12px; font-variant-numeric: tabular-nums; color: var(--muted-foreground); }
  .picker .prog div { display: flex; align-items: center; gap: 4px; } .picker .prog .tr svg { color: var(--aq-amber-500); } .picker .prog .va svg { color: var(--aq-emerald-500); }
  .picker .empty { padding: 24px 8px; text-align: center; font-size: 14px; color: var(--muted-foreground); }
  .menu { min-width: 176px; padding: 4px; }
  .menu .mi { display: flex; width: 100%; align-items: center; gap: 8px; border-radius: var(--r-md); padding: 6px 8px; font-size: 14px; text-align: start; }
  .menu .mi:hover { background: var(--accent); } .menu .mi:disabled { opacity: .5; } .menu .mi svg { color: var(--muted-foreground); }
  .menu .mi.chk::after { content: ""; margin-inline-start: auto; }
  .menu .mi.sm { font-size: 12px; }
  .menu .sep { height: 1px; margin: 4px -4px; background: var(--border); }

  /* ── Column header ───────────────────────────────────────────────────── */
  .col-head { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; border-bottom: 1px solid var(--border); padding: 8px 16px 8px 10px;
              font-size: 12px; line-height: 16px; font-weight: 500; color: var(--muted-foreground); flex-shrink: 0; }
  .vp-md .col-head { grid-template-columns: 84px minmax(0, 1fr) minmax(0, 1fr); }
  .col-head .marks { display: none; height: 20px; align-items: center; }
  .vp-md .col-head .marks { display: flex; }
  .col-head .marks .m5 { display: flex; width: 20px; flex-shrink: 0; justify-content: center; }
  .col-head .marks .mrest { margin-inline-start: 8px; display: flex; min-width: 0; flex: 1; align-items: center; gap: 2px; }
  .col-head .marks .m1 { display: flex; min-width: 0; flex: 1; justify-content: center; }
  .col-head .ch-src { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .vp-md .col-head .ch-src { padding-inline-start: 8px; }
  .chip { display: inline-flex; align-items: center; gap: 4px; height: 20px; box-sizing: border-box; border-radius: var(--r-md); border: 1px solid transparent;
          background: var(--card); padding: 2px 6px; font-size: 10px; line-height: 1.3333; font-weight: 400; text-transform: none; color: color-mix(in oklab, var(--foreground) 90%, var(--muted-foreground)); white-space: nowrap; }
  button.chip:hover { background: var(--muted); }
  .col-head .ch-tgt { display: flex; align-items: center; gap: 8px; padding: 0 0 0 4px; min-width: 0; }
  html:not(.vp-md) .col-head .ch-tgt .checks { display: none; }
  .vp-md .col-head .ch-tgt { display: flex; padding: 0 8px 0 24px; }
  .col-head .ch-tgt .checks { display: flex; align-items: center; margin-inline-start: -12px; }
  .col-head .ch-tgt .checks span { display: inline-flex; width: 24px; justify-content: center; }

  /* ── List ───────────────────────────────────────────────────────────── */
  .readonly-banner { display: flex; align-items: center; gap: 8px; border-bottom: 1px solid var(--border); background: oklch(98.7% 0.022 95.277); color: oklch(41.4% 0.112 45.904);
                     padding: 8px 16px; font-size: 12px; flex-shrink: 0; }
  html.dark .readonly-banner { background: color-mix(in oklab, oklch(27.9% 0.077 45.635) 40%, transparent); color: oklch(87.9% 0.169 91.605); }
  #scroller { flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain; position: relative; overflow-anchor: none; }
  #rows { position: relative; }
  .empty-state { display: flex; height: 100%; align-items: center; justify-content: center; padding: 24px; font-size: 14px; color: var(--muted-foreground); gap: 8px; }
  .spin { animation: spin 1s linear infinite; } @keyframes spin { to { transform: rotate(360deg); } }

  .cell { position: relative; }
  .cell[data-paragraph-start] { margin-top: 12px; }
  .pbar { display: grid; grid-template-columns: 48px minmax(0, 1fr); gap: 8px; border-top: 1px solid color-mix(in oklab, var(--border) 60%, transparent); padding: 0 16px 0 10px; }
  .vp-md .pbar { grid-template-columns: 84px minmax(0, 1fr) minmax(0, 1fr); }
  .pbar div { grid-column: 1 / -1; display: flex; align-items: center; justify-content: center; padding: 4px 0; color: var(--muted-foreground); }
  .vp-md .pbar div { grid-column: 1 / 2; padding-inline-start: 28px; }

  /* Row (EditorRow) */
  .row { position: relative; display: grid; grid-template-columns: 48px minmax(0, 1fr); column-gap: 8px; row-gap: 6px; padding: 8px 8px 8px 10px; overflow: hidden;
         transition: background-color .15s ease-out; outline: none; }
  .vp-md .row { grid-template-columns: 84px minmax(0, 1fr) minmax(0, 1fr); row-gap: 8px; padding-inline-end: 16px; }
  .row:hover, .row.expanded { background: color-mix(in oklab, var(--muted) 50%, transparent); }
  .row:focus-visible { box-shadow: inset 0 0 0 2px color-mix(in oklab, var(--primary) 40%, transparent); }
  .row.has-comments { box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--aq-blue-400) 50%, transparent); }
  .row.selected { background: color-mix(in oklab, var(--primary) 5%, transparent); box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--primary) 40%, transparent); }
  .row.drafting { background: color-mix(in oklab, var(--primary) 5%, transparent); box-shadow: inset 0 0 0 2px color-mix(in oklab, var(--primary) 50%, transparent); animation: pulse 2s cubic-bezier(.4,0,.6,1) infinite; }
  @keyframes pulse { 50% { opacity: .5; } }
  .row.hidden-cell { opacity: .6; }
  .row.flash { animation: flash 1.8s ease-out; }
  @keyframes flash { 0%, 30% { background: color-mix(in oklab, var(--primary) 18%, transparent); } 100% { background: transparent; } }

  /* Gutter */
  .gutter { grid-row: span 2; display: flex; height: 100%; flex-direction: column; align-items: center; align-self: stretch; padding: 6px 0; box-sizing: border-box; }
  .vp-md .gutter { grid-row: span 1; flex-direction: row; align-items: flex-start; }
  .g-sel { display: flex; width: 20px; flex-shrink: 0; flex-direction: column; align-items: center; }
  .g-sp { display: none; height: 16px; margin-bottom: 4px; flex-shrink: 0; } .vp-md .g-sp { display: block; }
  .sel { display: grid; width: 20px; height: 20px; place-items: center; border-radius: var(--r-md); border: 1px solid var(--border); background: var(--card);
         color: color-mix(in oklab, var(--muted-foreground) 70%, transparent); opacity: .6; cursor: ns-resize; touch-action: none; box-sizing: border-box;
         transition: opacity .15s ease-out, color .15s, background-color .15s; }
  .sel .dot { width: 6px; height: 6px; border-radius: 999px; background: currentColor; opacity: .7; }
  .row:hover .sel, .sel:focus-visible { opacity: 1; } .sel:hover { color: var(--primary); }
  .sel[aria-checked="true"] { border-color: transparent; background: var(--primary); color: var(--primary-foreground); opacity: 1; }
  .g-bn { display: flex; min-width: 0; flex-direction: column; align-items: center; gap: 2px; }
  .vp-md .g-bn { margin-inline-start: 8px; flex: 1; flex-direction: row; align-items: flex-start; }
  .g-badges { display: flex; width: 20px; flex-shrink: 0; flex-direction: column; align-items: center; }
  .g-badges .stack { display: flex; flex-direction: column; align-items: center; gap: 2px; }
  .gicon { display: inline-flex; width: 20px; height: 20px; flex-shrink: 0; align-items: center; justify-content: center; border-radius: var(--r-md); }
  .gicon.stale { color: var(--aq-amber-600); } .gicon.upstream { color: var(--aq-violet-500); } .gicon.fmt { color: var(--aq-amber-600); }
  .gicon.comments { color: var(--aq-blue-500); transition: background-color .15s, color .15s; }
  .gicon.comments:hover { background: color-mix(in oklab, var(--aq-blue-500) 10%, transparent); color: var(--aq-blue-600); }
  .gicon.comments svg { fill: color-mix(in oklab, currentColor 15%, transparent); }
  .g-num { order: -1; display: flex; min-width: 0; flex-direction: column; align-items: center; }
  .vp-md .g-num { order: 99; flex: 1; }
  .g-num .line { display: flex; width: 100%; align-items: center; justify-content: center; }
  .num { display: inline-flex; align-items: center; gap: 4px; font-size: 10px; font-weight: 500; line-height: 1; font-variant-numeric: tabular-nums;
         color: color-mix(in oklab, var(--muted-foreground) 50%, transparent); }
  .num.issue { color: var(--aq-issue); } .num.major { color: var(--aq-major); }

  /* Source cell */
  .src { position: relative; grid-column-start: 2; display: flex; height: 100%; min-height: 40px; min-width: 0; flex-direction: column; overflow-wrap: break-word;
         border-radius: var(--r-lg); padding: 6px 28px 6px 8px; box-sizing: border-box; user-select: text; transition: background-color .15s, opacity .15s; }
  .vp-md .src { grid-column-start: auto; }
  .lane { margin-bottom: 4px; display: flex; height: 16px; align-items: center; gap: 8px; font-size: 12px; line-height: 16px; color: var(--muted-foreground); user-select: none; }
  .src .lane { justify-content: center; text-align: center; }
  .src .lane.start { justify-content: flex-start; text-align: start; }
  .lane .lbl { max-width: 45%; flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .lane .ctx { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rep { flex-shrink: 0; border-radius: var(--r-sm); background: var(--muted); padding: 0 4px; font-weight: 500; font-variant-numeric: tabular-nums; }
  .txt p { margin: 0; } .txt { white-space: pre-line; }
  .term { background-image: linear-gradient(100deg, color-mix(in oklab, var(--primary) 12%, transparent), color-mix(in oklab, var(--primary) 12%, transparent));
          border-radius: 2px; cursor: pointer; }
  .term:hover { background-image: linear-gradient(100deg, color-mix(in oklab, var(--primary) 24%, transparent), color-mix(in oklab, var(--primary) 24%, transparent)); }
  .blot { text-decoration: underline wavy; text-decoration-thickness: 1px; text-underline-offset: 3px; cursor: pointer; }
  .blot.major { text-decoration-color: var(--aq-red-500); } .blot.minor { text-decoration-color: var(--aq-amber-500); }
  .blot.waived { text-decoration-color: color-mix(in oklab, var(--muted-foreground) 60%, transparent); }
  .blot.term-forbidden { text-decoration-color: var(--aq-red-500); }
  .fn { display: inline-flex; align-items: center; justify-content: center; min-width: 14px; height: 14px; margin: 0 1px; padding: 0 3px; border-radius: 999px;
        vertical-align: super; font-size: 9px; font-weight: 600; line-height: 1; background: color-mix(in oklab, var(--primary) 20%, transparent);
        color: var(--primary-foreground); cursor: pointer; user-select: all; }

  /* Target column */
  .tcol { position: relative; grid-column-start: 2; display: flex; min-width: 0; flex-direction: column; overflow-wrap: break-word; padding: 4px 8px 0;
          border-top: 1px solid color-mix(in oklab, var(--border) 60%, transparent); background: color-mix(in oklab, var(--muted) 25%, transparent); transition: opacity .15s; }
  .vp-md .tcol { grid-column-start: auto; border-top: 0; background: transparent; padding: 0 36px 0 12px; }
  .ribbon { display: none; position: absolute; top: -8px; bottom: -8px; left: 0; z-index: 10; width: 12px; cursor: help; }
  .vp-md .ribbon { display: block; } .ribbon i { position: absolute; top: 0; bottom: 0; left: 0; width: 2px; transition: opacity .5s; }
  .ribbon-m { position: absolute; top: 0; bottom: 0; left: 0; z-index: 10; width: 12px; } .vp-md .ribbon-m { display: none; } .ribbon-m i { position: absolute; inset: 0 auto 0 0; width: 2px; }
  .tcol .lane { justify-content: flex-start; text-align: start; }
  .tbody { display: flex; flex: 1; gap: 6px; }
  .valg { display: flex; width: 24px; flex-shrink: 0; align-items: flex-start; padding-top: 4px; }
  .val { position: relative; display: flex; width: 24px; height: 24px; align-items: center; justify-content: center; border-radius: var(--r-lg);
         transition: transform .15s ease-out, color .15s, background-color .15s; color: color-mix(in oklab, var(--muted-foreground) 30%, transparent); }
  .val:hover { background: color-mix(in oklab, var(--muted) 80%, transparent); } .val:active { transform: scale(.88); }
  .val[data-state="others"] { color: color-mix(in oklab, var(--muted-foreground) 60%, transparent); }
  .val[data-state="others"] svg { fill: currentColor; }
  .val[data-state="self"], .val[data-state="full-self"], .val[data-state="full-others"] { color: var(--aq-green-500); }
  .val.can:not([aria-pressed="true"]):hover { color: var(--aq-green-500); }
  .val[aria-disabled="true"] { cursor: not-allowed; opacity: .3; }
  .val-na { display: flex; width: 24px; height: 24px; cursor: default; align-items: center; justify-content: center; color: color-mix(in oklab, var(--muted-foreground) 30%, transparent); opacity: .4; }
  .val-na svg { stroke-width: 2.5; width: 14px; height: 14px; }
  .val svg { stroke-width: 2.5; width: 14px; height: 14px; }
  .well { position: relative; display: flex; min-height: 40px; min-width: 0; flex: 1; flex-direction: column; border-radius: var(--r-lg); padding: 6px 8px; box-sizing: border-box;
          transition: background-color .15s; }
  .well:hover { background: color-mix(in oklab, var(--muted) 60%, transparent); }
  .well:focus-within { background: var(--muted); box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--ring) 40%, transparent); }
  .well.empty { background: color-mix(in oklab, var(--muted) 40%, transparent); }
  .read { position: relative; min-height: 40px; width: 100%; min-width: 0; flex: 1; overflow-wrap: break-word; border-radius: var(--r-lg); padding: 2px 4px; box-sizing: border-box;
          line-height: 1.625; color: color-mix(in oklab, var(--foreground) 90%, transparent); outline: none; white-space: pre-line; }
  .read.editable { cursor: text; } .read.editable:focus-visible { box-shadow: 0 0 0 2px var(--background), 0 0 0 3px color-mix(in oklab, var(--primary) 30%, transparent); }
  .read.empty { color: color-mix(in oklab, var(--muted-foreground) 60%, transparent); } .read.subdued { opacity: .3; }
  .read[contenteditable="true"] { user-select: text; white-space: pre-wrap; cursor: text; box-shadow: none; }
  .read p { margin: 0; }
  .read .ghost { color: color-mix(in oklab, var(--muted-foreground) 70%, transparent); pointer-events: none; user-select: none; }
  .read .ghost-hint { margin-inline-start: 6px; font-size: 10px; border: 1px solid var(--border); border-radius: 4px; padding: 0 3px; vertical-align: 1px; }
  .remote-draft { color: color-mix(in oklab, var(--foreground) 90%, transparent); }
  .rcaret { position: relative; display: inline-block; width: 0; }
  .rcaret i { position: absolute; top: -2px; bottom: -2px; width: 2px; border-radius: 1px; }
  .rcaret b { position: absolute; bottom: 100%; left: 0; white-space: nowrap; border-radius: 3px; padding: 0 4px; font-size: 10px; font-weight: 500; line-height: 14px; color: #fff; }
  .ai-overlay { pointer-events: none; position: absolute; inset: 0; display: flex; }
  .ai-overlay p { margin: 0; white-space: pre-wrap; padding: 4px 8px; line-height: 1.625; color: color-mix(in oklab, var(--foreground) 90%, transparent); }
  .ai-caret { display: inline-block; width: 2px; height: 14px; margin: 0 0 -2px 2px; background: color-mix(in oklab, var(--primary) 70%, transparent); vertical-align: middle; animation: pulse 1s infinite; }
  .ai-pill { margin: auto; display: flex; align-items: center; gap: 6px; border-radius: var(--r-md); background: var(--card); padding: 4px 10px; font-size: 14px; color: var(--muted-foreground); }
  .fills { position: absolute; left: 8px; right: 8px; bottom: 4px; z-index: 10; height: 2px; border-radius: 2px; overflow: hidden; background: color-mix(in oklab, var(--primary) 15%, transparent); }
  .fills i { position: absolute; inset: 0; width: 40%; background: var(--primary); animation: fills 1.4s ease-in-out infinite; }
  @keyframes fills { from { transform: translateX(-100%); } to { transform: translateX(250%); } }
  .presence { display: inline-flex; align-items: center; gap: 4px; direction: ltr; }
  .avatar { display: inline-flex; width: 16px; height: 16px; align-items: center; justify-content: center; border-radius: 999px; font-size: 8px; font-weight: 600; color: #fff; }
  .presence .state { font-size: 10px; color: var(--muted-foreground); }
  .tline { margin-top: 4px; display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; border-radius: var(--r-xl); padding: 6px 10px; font-size: 11px; }
  .tline.err { background: color-mix(in oklab, var(--destructive) 10%, transparent); color: var(--destructive); }
  .tline.err button { flex-shrink: 0; border-radius: var(--r-md); padding: 0 4px; } .tline.err button:hover { background: color-mix(in oklab, var(--destructive) 20%, transparent); }
  .saved { margin-top: 4px; display: flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 500; color: var(--aq-emerald-600); }
  .saved svg { stroke-width: 3; }
  .remote-bar { margin-top: 4px; display: flex; align-items: center; gap: 8px; border-radius: var(--r-lg); background: color-mix(in oklab, var(--aq-amber-500) 12%, transparent);
                padding: 4px 8px; font-size: 12px; color: var(--aq-amber-600); }
  .remote-bar button { margin-inline-start: auto; border-radius: var(--r-md); border: 1px solid var(--border); background: var(--card); padding: 1px 8px; color: var(--foreground); }
  .links { margin-top: 4px; display: flex; flex-wrap: wrap; gap: 4px; }
  .links button { display: inline-flex; align-items: center; gap: 4px; border-radius: var(--r-md); background: var(--muted); padding: 1px 6px; font-size: 11px; color: var(--muted-foreground); }
  .fnline { margin-top: 4px; display: flex; flex-direction: column; gap: 2px; font-size: 12px; line-height: 1.4; }
  .fnline .fni { display: flex; gap: 6px; align-items: baseline; }
  .fnline .fni .k { flex-shrink: 0; font-weight: 600; color: var(--muted-foreground); } .fnline .fni .v { flex: 1; min-width: 0; border-radius: 4px; padding: 0 4px; cursor: text; }
  .fnline .fni .v:hover { background: var(--muted); } .fnline .fni .v.empty { color: var(--muted-foreground); font-style: italic; }

  /* Action rail */
  .railw { pointer-events: none; position: relative; grid-column-start: 2; z-index: 20; display: flex; justify-content: flex-end; }
  .vp-md .railw { position: absolute; inset-inline-end: 8px; top: 2px; }
  .rail { pointer-events: auto; display: flex; align-items: center; justify-content: flex-end; border-radius: min(var(--r-md), 10px); padding: 2px;
          transition: background-color .2s ease-out; }
  .rail.on { background: var(--card); }
  .rail .prim { display: flex; align-items: center; opacity: 0; transform: scale(.85); transform-origin: right center; pointer-events: none;
                transition: opacity .18s ease-out, transform .22s cubic-bezier(.68,-0.55,.32,1.45); }
  .rail.on .prim { opacity: 1; transform: none; pointer-events: auto; }
  .rbtn { position: relative; display: inline-flex; width: 24px; height: 24px; align-items: center; justify-content: center; border-radius: var(--r-md);
          color: color-mix(in oklab, var(--muted-foreground) 70%, transparent); transition: color .15s, background-color .15s; }
  .rbtn:hover:not(:disabled) { color: var(--foreground); background: var(--muted); }
  .rbtn:disabled { color: color-mix(in oklab, var(--muted-foreground) 30%, transparent); }
  .rbtn.pulsing { animation: pulse 2s cubic-bezier(.4,0,.6,1) infinite; }
  .rbtn .dot { pointer-events: none; position: absolute; inset-inline-end: 2px; top: 2px; width: 6px; height: 6px; border-radius: 999px; box-shadow: 0 0 0 2px var(--background); }
  .dot.amber { background: var(--aq-amber-500); } .dot.red { background: var(--aq-red-500); } .dot.primary { background: var(--primary); } .dot.emerald { background: var(--aq-emerald-500); }
  .chev { display: flex; transition: opacity .15s; opacity: .3; } .chev:hover, .rail.on .chev { opacity: 1; }
  .chev svg { transition: transform .2s; } .chev.open svg { transform: rotate(180deg); } .chev.open .rbtn { background: var(--card); color: var(--foreground); }
  .overflow { display: flex; flex-direction: row; align-items: center; padding: 4px; }

  /* Expansion (CellExpansion) */
  .exp { padding: 0 16px 8px 60px; }
  .exp-in { margin-top: 6px; overflow: hidden; border-radius: var(--r-lg); border: 1px solid var(--border); background: color-mix(in oklab, var(--muted) 40%, transparent); }
  .tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--border); padding: 4px; }
  .tab { display: inline-flex; align-items: center; gap: 6px; border-radius: var(--r-md); padding: 4px 8px; font-size: 12px; font-weight: 500; color: var(--muted-foreground); position: relative; }
  .tab:hover { color: var(--foreground); } .tab[aria-selected="true"] { background: var(--card); color: var(--foreground); box-shadow: var(--shadow-soft-xs); }
  .tab:disabled { opacity: .4; } .tab .dot { position: static; width: 6px; height: 6px; border-radius: 999px; box-shadow: none; }
  .panel { padding: 10px 12px; font-size: 13px; line-height: 1.5; }
  .panel p { margin: 0 0 6px; } .panel .k { color: var(--muted-foreground); font-size: 12px; }
  .panel textarea { width: 100%; box-sizing: border-box; min-height: 60px; border: 1px solid var(--input, var(--border)); border-radius: var(--r-lg); background: var(--background);
                    color: inherit; font: inherit; font-size: 13px; padding: 6px 8px; resize: vertical; user-select: text; }
  .panel .actions { display: flex; gap: 6px; margin-top: 8px; }
  .btn-s { display: inline-flex; align-items: center; gap: 6px; height: 28px; border-radius: var(--r-md); border: 1px solid var(--border); background: var(--background); padding: 0 10px; font-size: 12px; font-weight: 500; }
  .btn-s:hover:not(:disabled) { background: var(--muted); } .btn-s:disabled { opacity: .5; }
  .btn-s.primary { background: var(--primary); color: var(--primary-foreground); border-color: transparent; }
  .btn-s.danger { color: var(--destructive); }
  .issue { display: flex; gap: 8px; align-items: flex-start; padding: 6px 0; border-top: 1px solid color-mix(in oklab, var(--border) 60%, transparent); }
  .issue:first-child { border-top: 0; } .issue svg { margin-top: 2px; } .issue.major svg { color: var(--aq-red-500); } .issue.minor svg { color: var(--aq-amber-500); }
  .issue.waived { opacity: .6; } .issue .b { flex: 1; min-width: 0; } .issue .b b { display: block; font-weight: 500; }

  .vcard { display: flex; flex-direction: column; gap: 6px; padding-top: 2px; } .vcard .k { font-size: 12px; color: var(--muted-foreground); }
  .vcard .vrow { display: flex; align-items: center; gap: 6px; } .vstatus { display: inline-flex; align-items: center; gap: 6px; }

  /* Validators popover */
  .vpop { width: 288px; border-radius: var(--r-xl); padding: 8px; font-size: 12px; }
  .vpop ul { list-style: none; margin: 0; padding: 0; } .vpop li { display: flex; align-items: center; justify-content: space-between; gap: 8px; border-radius: 4px; padding: 4px; }
  .vpop li.h { color: var(--muted-foreground); margin-bottom: 4px; } .vpop li:not(.h):hover { background: color-mix(in oklab, var(--muted) 50%, transparent); }
  .vpop .rm { flex-shrink: 0; border-radius: 4px; padding: 2px; color: color-mix(in oklab, var(--muted-foreground) 70%, transparent); }
  .vpop .rm:hover { background: color-mix(in oklab, var(--destructive) 10%, transparent); color: var(--destructive); }
  .vpop .note { margin-top: 4px; border-top: 1px solid var(--border); padding: 6px 4px 0; font-size: 11px; color: var(--muted-foreground); }

  /* Tooltip */
  .tip { position: fixed; z-index: 60; max-width: 280px; pointer-events: none; border-radius: var(--r-md); background: var(--foreground); color: var(--background);
         padding: 4px 8px; font-size: 12px; line-height: 1.35; animation: pop-in .1s ease-out; }

  /* Formatting bubble (TranslatedEditor) */
  .bubble { position: fixed; z-index: 30; display: flex; gap: 2px; border-radius: var(--r-lg); background: var(--card); padding: 2px;
            box-shadow: var(--shadow-soft-sm), 0 0 0 1px color-mix(in oklab, var(--foreground) 10%, transparent); }
  .bubble button { display: inline-flex; width: 24px; height: 24px; align-items: center; justify-content: center; border-radius: var(--r-md); color: var(--muted-foreground); }
  .bubble button:hover { background: var(--muted); color: var(--foreground); } .bubble button[aria-pressed="true"] { background: var(--accent); color: var(--foreground); }

  /* Dialogs */
  .scrim { position: fixed; inset: 0; z-index: 70; background: rgb(0 0 0 / .32); display: flex; align-items: center; justify-content: center; animation: pop-in .12s; }
  .dialog { width: min(420px, calc(100vw - 32px)); border-radius: var(--r-xl); background: var(--popover, var(--card)); color: var(--popover-foreground, var(--foreground));
            box-shadow: var(--shadow-soft); padding: 20px; font-size: 14px; }
  .dialog h2 { margin: 0 0 6px; font-size: 16px; font-weight: 600; } .dialog p { margin: 0 0 12px; color: var(--muted-foreground); }
  .dialog label { display: block; margin: 8px 0 4px; font-size: 12px; font-weight: 500; }
  .dialog textarea, .dialog input[type=text] { width: 100%; box-sizing: border-box; border: 1px solid var(--input, var(--border)); border-radius: var(--r-lg); background: var(--background);
            color: inherit; font: inherit; padding: 6px 8px; user-select: text; }
  .dialog .row-b { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
  .dialog .chk { display: flex; align-items: center; gap: 6px; margin-top: 10px; font-size: 13px; color: var(--muted-foreground); }

  /* Narrow (below md): the built-in's two-column stacked layout */
  html:not(.vp-md) .row { padding-inline-end: 8px; }
`
