/** Styles for the first-party default editor extension (see default-editor.ts). */
export const DEFAULT_EDITOR_STYLE = String.raw`
  html, body { height: 100%; }
  body { display: flex; flex-direction: column; overflow: hidden; }
  header { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 6px 14px; border-bottom: 1px solid var(--border, #ddd); font-size: 13px; }
  header .file { font-weight: 600; }
  header .progress, header .status { color: var(--muted-foreground, #666); }
  header .status.error { color: var(--destructive, #b91c1c); }
  header select { font: inherit; font-size: 12px; padding: 2px 4px; border-radius: 6px; border: 1px solid var(--border, #ddd); background: var(--background, #fff); color: var(--foreground, #111); }
  header .spacer { flex: 1; }
  .banner { padding: 6px 14px; font-size: 12px; border-bottom: 1px solid var(--border, #ddd); background: var(--muted, #f4f4f5); }
  .cols { display: grid; grid-template-columns: 92px 1fr 1fr 64px; gap: 0 12px; padding: 4px 14px; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted-foreground, #666); border-bottom: 1px solid var(--border, #ddd); }
  #list { flex: 1; overflow-y: auto; overscroll-behavior: contain; }
  .row { display: grid; grid-template-columns: 92px 1fr 1fr 64px; gap: 0 12px; padding: 8px 14px; border-bottom: 1px solid var(--border, #eee);
         content-visibility: auto; contain-intrinsic-size: auto 64px; }
  .row.heading { background: var(--muted, #f4f4f5); }
  .row.heading .src { font-weight: 700; }
  .row.active { box-shadow: inset 3px 0 0 var(--ring, #888); }
  .row.flash { animation: flash 1.2s ease-out; }
  @keyframes flash { from { background: var(--accent, #eef); } to { background: transparent; } }
  .gutter { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted-foreground, #666); min-width: 0; }
  .gutter .ref { font-weight: 600; color: var(--foreground, #111); overflow-wrap: anywhere; }
  .badges { display: flex; flex-wrap: wrap; gap: 4px; }
  .badge { font: inherit; font-size: 11px; line-height: 1; padding: 3px 6px; border-radius: 999px; border: 1px solid var(--border, #ddd); background: var(--card, #fff); color: var(--card-foreground, #111); cursor: pointer; }
  .badge.quiet { opacity: .35; }
  .row:hover .badge.quiet, .row.active .badge.quiet { opacity: .8; }
  .badge.lock { cursor: default; background: #f59e0b22; border-color: #f59e0b66; }
  .badge.ai { cursor: default; }
  .src, .tgt { font-size: 15px; line-height: 1.55; overflow-wrap: anywhere; min-width: 0; }
  .src p, .tgt p { margin: 0; }
  .tgt { min-height: 1.55em; padding: 2px 6px; border-radius: 6px; border: 1px solid transparent; outline: none; white-space: pre-wrap; }
  .tgt:hover { border-color: var(--border, #ddd); }
  .tgt:focus { border-color: var(--ring, #888); background: var(--card, #fff); }
  .tgt:empty::before { content: attr(data-placeholder); color: var(--muted-foreground, #999); }
  .tgt[contenteditable="false"] { opacity: .75; }
  .tgt.dirty { border-left: 3px solid #f59e0b; }
  .tgt.saving { border-left: 3px solid #94a3b8; }
  .remote { grid-column: 3; font-size: 12px; color: #b45309; display: flex; gap: 6px; align-items: center; margin-top: 4px; }
  .remote button { font: inherit; font-size: 12px; padding: 1px 6px; border-radius: 6px; border: 1px solid var(--border, #ddd); background: var(--card, #fff); color: var(--card-foreground, #111); cursor: pointer; }
  .actions { display: flex; align-items: flex-start; justify-content: flex-end; gap: 4px; }
  .val { font: inherit; font-size: 14px; width: 30px; height: 30px; border-radius: 999px; border: 1px solid var(--border, #ddd); background: var(--card, #fff); color: var(--muted-foreground, #666); cursor: pointer; }
  .val[aria-pressed="true"] { background: #16a34a; border-color: #16a34a; color: #fff; }
  .val:disabled { opacity: .4; cursor: default; }
  .empty { padding: 24px; color: var(--muted-foreground, #666); }
  .more { padding: 10px 14px; font-size: 12px; color: var(--muted-foreground, #666); }
  kbd { font-size: 10px; border: 1px solid var(--border, #ccc); border-radius: 4px; padding: 0 3px; }
`
