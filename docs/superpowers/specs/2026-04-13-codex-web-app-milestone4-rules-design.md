# Codex Web App — Milestone 4: Translation Standards & Rules

## Overview

Translation rules/standards that automatically check cell translations for pattern compliance. Rules produce infractions that degrade health and appear inline like Grammarly suggestions. Rules can be created manually (natural language → AI → regex), suggested by LLM analysis, or auto-detected algorithmically.

## Rule Data Model

```typescript
interface TranslationRule {
  id: string
  name: string
  description: string
  severity: "major" | "minor"
  source: "algorithmic" | "llm" | "user"
  scope: "project" | "org"
  check: RuleCheck
  enabled: boolean
  createdAt: string
}

type RuleCheck =
  | { type: "source-requires-target"; sourcePattern: string; targetPattern: string }
  | { type: "target-forbids"; targetPattern: string }
  | { type: "source-target-match"; pattern: string }

interface RuleInfraction {
  ruleId: string
  cellId: string
  fileId: string
  message: string
}
```

### RuleCheck Types

- **source-requires-target**: if source matches `sourcePattern` regex, target must match `targetPattern`. Example: if source has a number, target must have the same number.
- **target-forbids**: target must never match `targetPattern`. Example: target must not contain English articles "the/a/an" when translating to a language without articles.
- **source-target-match**: if `pattern` regex matches in source, the same match must appear in target. Example: proper nouns, numbers, URLs.

Patterns are JavaScript regex strings (without delimiters).

## Rule Storage

Rules stored in `ProjectRecord.rules: TranslationRule[]` and penalty config in `ProjectRecord.rulePenalties: { major: number; minor: number }` (defaults: major=15, minor=5).

Org-level rules: `ProjectRecord.orgRules?: TranslationRule[]` — stubbed, not editable in UI.

## Rule Engine

`checkRules(cells, rules)` → `Map<string, RuleInfraction[]>` (cellId → infractions)

Pure function. For each enabled rule, for each non-empty cell, test the check pattern. Produces a flat list of infractions grouped by cell.

## Health Integration

After `computeHealthMap` produces base health, apply rule penalties:

```
finalHealth[cell] = max(0, baseHealth[cell] - sum(penalty for each infraction on cell))
```

Where penalty = `rulePenalties.major` or `rulePenalties.minor` depending on rule severity.

## UI

### Rules Page (`/project/:id/rules`)

- Header with back button, "Translation Rules" title
- Penalty configuration: major penalty input, minor penalty input (auto-save)
- Rule list: name, severity badge (red for major, amber for minor), source badge, enabled toggle
- "Add Rule" button → dialog with:
  - Name, description, severity dropdown
  - Rule type dropdown (source-requires-target, target-forbids, source-target-match)
  - Pattern inputs (depends on type)
  - Test area: paste source/target to preview match
- Future: "Suggest from edits" and "Auto-detect" buttons (stubbed)

### Editor Inline Indicators

Cells with infractions show a small icon next to the health ring:
- Major: AlertTriangle icon (red)
- Minor: AlertCircle icon (amber)
- Count badge if multiple infractions

Click opens the rule drawer.

### Rule Drawer (slides from right)

- Rule name, severity, description
- The failing cell's source/target with infraction highlighted
- "Other cells breaking this rule" — list of other infractions
- "Cells following this rule" — cells that pass the same rule with similar content
- Close button

## File Structure

```
src/
├── lib/
│   ├── rules/
│   │   ├── rule-engine.ts           # checkRules pure function
│   │   └── rule-engine.test.ts      # TDD
│   └── health/
│       └── health-engine.ts         # MODIFY: accept infractions, apply penalties
├── components/
│   ├── RulesPage.tsx                # NEW: rules management page
│   ├── RuleCreateDialog.tsx         # NEW: add/edit rule dialog
│   ├── RuleDrawer.tsx               # NEW: slide-out infraction detail
│   ├── EditorTable.tsx              # MODIFY: infraction indicators
│   ├── ProjectWorkspace.tsx         # MODIFY: wire rules + drawer state
│   └── App.tsx                      # MODIFY: add /project/:id/rules route
├── hooks/
│   └── useRules.ts                  # NEW: load rules, run checks, expose infractions
└── ...
```
