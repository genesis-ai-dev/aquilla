# Codex Web App — Milestone 3: Health System & Progress Visualization

## Health Model

A cell's health score (0-100) represents confidence in translation quality, derived from human expertise:

- **Human-edited/validated cell** → 100%
- **LLM-generated, no examples** → 0%
- **LLM-generated, with examples** → average health of example cells
  - Validated example → 100%
  - LLM example → its own recursive health
- **Empty cell** → null (not applicable)

When a cell is validated, it becomes 100% and that change cascades through all cells that used it as an example.

## Computation

`computeHealthMap(cells, allCells)` → `Map<string, number>`

Full traversal in topological order (creation time). Cells can only reference previously-existing cells as examples, so iteration order = topological order. ~25,000 lookups for a 5,000-cell project — microseconds.

Recomputed on every cell change. No caching, no invalidation logic. Always correct.

## Visualization

### Cell Health Indicator (EditorTable)

SVG radial progress ring around the validation checkmark icon. Fills clockwise from 0% (empty ring) to 100% (full ring). Color transitions: red (0-33%) → amber (34-66%) → green (67-100%).

### Sidebar File Progress

Each file in the sidebar shows two overlapping horizontal bars:
- **Bottom bar (muted):** % translated (cells with any content / total cells)
- **Top bar (primary):** % validated (validated cells / total cells)

Plus a small circular health indicator showing the file's average health.

### Project Health

Sidebar header shows overall project health as a radial indicator + percentage.

### StatusBar

Existing status bar updated to include health percentage.
