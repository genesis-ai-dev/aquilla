# Showcase labels (`data-showcase`)

A small, app-wide standard that makes the UI **scriptable for video**: every
component a demo needs to point at, click, or zoom into carries a stable,
readable label in the DOM. With it, a documentation script reads like plain
stage directions —

```ts
await show.point("@sidebar.file")   // glide the cursor to a real file row
await show.click("@sidebar.file")   // …and open it (real DOM click)
await show.zoomTo("@editor.source") // magnify the source column
```

— instead of guessing pixel coordinates or hand-writing brittle CSS selectors
that drift with markup. (That guessing is what made an early take "click a
file" land in the sidebar gutter instead of on a populated list item.)

## The convention

Add a `data-showcase` attribute to the element a viewer would think of as
"the X":

```tsx
<div data-showcase="sidebar.file" data-showcase-name={file.name} … />
```

- **Value is a readable, dotted path:** `area.component` (kebab within a
  segment), e.g. `sidebar.file`, `editor.source`, `cell.health`. Read it aloud
  — it should sound like the direction you'd give a person.
- **Put it on the element you'd click/point at** — the whole row for "open the
  file", the button for "validate", the column for "the translation".
- **Optional `data-showcase-name`** carries an instance label (a file name, a
  cell id) for scripts that need to disambiguate *which* one.
- **Separate from `data-testid`.** Test ids target assertions and can be terse
  and plentiful; showcase labels are a curated, human-readable surface for
  driving the camera. A component may carry both.

## In a showcase spec

The `Showcase` helper (`e2e/recordings/helpers/showcase.ts`) resolves a target
string beginning with `@` to `[data-showcase="…"]`. So `point`, `click`,
`zoomTo` all accept `"@sidebar.file"` directly; a bare string is still treated
as a raw CSS selector, and `{ x, y }` as a literal point.

## Registry

The labels that exist today (extend this table as you label more — keep it the
single source of truth):

| Label             | Element                                  | Component        |
| ----------------- | ---------------------------------------- | ---------------- |
| `sidebar.file`    | A file row in the project sidebar (opens the file on click) | `FileRow.tsx` |
| `editor.source`   | The source-text column of a cell row     | `EditorTable.tsx` |
| `editor.target`   | The target/translation column of a cell row | `EditorTable.tsx` |
| `cell.health`     | The per-cell health/validate pill        | `EditorTable.tsx` |

## Adding a label

1. Pick a readable `area.component` name; reuse an existing area prefix if one
   fits (`sidebar`, `editor`, `cell`, …).
2. Add `data-showcase="…"` to the element a viewer would point at.
3. Add a row to the registry above.
4. Use it from a spec as `"@area.component"`.
