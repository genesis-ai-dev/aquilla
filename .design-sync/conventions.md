# Aquilla Design System — how to build with it

These are the real, shipped UI primitives of Aquilla (a Bible-translation web app),
built on **Base UI** (`@base-ui/react`) + **Tailwind CSS v4** with CSS-variable design
tokens. Every component below is imported from `window.AquillaUI.<Name>` and styled by
the design tokens in `styles.css`. Build with these parts; style your own layout glue
with the Tailwind token utilities listed here.

## Styling idiom: Tailwind utilities bound to semantic tokens

This is a **utility-class** system. Do NOT hardcode colors — use the token-bound
utility classes so everything stays on-brand and dark-mode-correct. The tokens are
defined on `:root` (light) and `html.dark` (dark) in the bundled `styles.css`.

Color utilities (each has `bg-*`, `text-*`, and where sensible `border-*`):

| Token family | Utility examples | Use for |
|---|---|---|
| `primary` | `bg-primary` `text-primary-foreground` | the one primary action (muted blue) |
| `secondary` | `bg-secondary` `text-secondary-foreground` | secondary surfaces |
| `muted` | `bg-muted` `text-muted-foreground` | subtle fills, secondary text |
| `accent` | `bg-accent` `text-accent-foreground` | hover/selection overlays |
| `destructive` | `bg-destructive` `text-destructive` | errors, delete actions |
| `card` / `popover` | `bg-card` `bg-popover` | raised surfaces |
| `background` / `foreground` | `bg-background` `text-foreground` | base page + body text |
| `border` / `input` / `ring` | `border-border` `border-input` `ring-ring` | borders, inputs, focus rings |
| `sidebar` | `bg-sidebar` (+ token `--sidebar-foreground` via `text-[var(--sidebar-foreground)]`) | chrome/navigation |

Radius: `rounded-lg` = `--radius` (0.375rem base); the scale (`-xl`/`-2xl`/`-3xl`) derives
from it. Font: the brand sans is **Geist Variable** (`font-sans`), already loaded.
Standard Tailwind spacing/flex/grid utilities (`flex gap-2 p-4 …`) apply as normal.

## Wrapping & setup

- The tokens come from `styles.css` — make sure it's loaded; no React provider is needed
  for tokens. Dark mode = add `class="dark"` to `<html>`.
- **Tooltips need a provider.** `AppTooltip` is the easy hover wrapper
  (`<AppTooltip content="…"><Button/></AppTooltip>`). The lower-level `Tooltip`
  composition must be wrapped in `<TooltipProvider>`.
- **Overlays** (Dialog, Sheet, Popover, DropdownMenu) are Base UI: an open prop on the
  root + composed parts. Pass `modal` deliberately. They portal and self-position —
  don't override their `position`/`transform`.

## Controlled-component gotchas (these WILL bite)

- **`Tabs` and `Collapsible` are controlled-only.** `Tabs` requires `value` +
  `onValueChange`; `Collapsible` requires `open` + `onOpenChange`. There is no
  `defaultValue`/`defaultOpen` — wire state or they won't work. `TabsContent` renders
  only for the matching `value`.
- `DropdownMenuLabel` must be inside a `DropdownMenuGroup`.
- `Select`/`RadioGroup` use a `value` prop; give `Select` items human-readable values
  (the trigger echoes the raw value if it can't resolve a label).

## Where the truth lives

- **`styles.css`** (and its `@import` closure incl. `_ds_bundle.css`) — every token and
  component style. Read it before inventing a color.
- **`components/<group>/<Name>/<Name>.prompt.md`** — per-component usage + examples.
- **`components/<group>/<Name>/<Name>.d.ts`** — the prop contract. Groups: Actions,
  Forms, Overlays, Layout, Feedback, Chat.

## One idiomatic example

```tsx
const { Card, CardHeader, CardTitle, CardDescription, CardAction,
        CardContent, CardFooter, Button, Badge } = window.AquillaUI

function ProjectCard() {
  return (
    <Card className="w-90">
      <CardHeader>
        <CardTitle>Gospel of Mark</CardTitle>
        <CardDescription>Tok Pisin · drafting</CardDescription>
        <CardAction><Badge variant="secondary">68%</Badge></CardAction>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">421 of 678 verses reviewed.</p>
      </CardContent>
      <CardFooter className="gap-2">
        <Button>Open</Button>
        <Button variant="outline">Share</Button>
      </CardFooter>
    </Card>
  )
}
```
