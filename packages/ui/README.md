# @aquilla/ui

Shared theme and shadcn-style design primitives used by Aquilla's
standalone apps. Tailwind v4.

## What's in it

```ts
import {
  Button,
  Input,
  Label,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  Alert,
  FormRow,
  cn,
} from "@aquilla/ui"
```

Components are plain HTML — no `@base-ui/react` dependency — so the small
auth apps don't have to pull it in. The full workspace SPA still uses
`src/components/ui/`; Phase 3a is responsible for deduping when the
workspace moves into `apps/workspace/`.

Every browser UI worker should import the shared theme once from its
`src/index.css`:

```css
@import "@aquilla/ui/theme.css";
```

## Tests

```bash
pnpm --filter @aquilla/ui test
```
