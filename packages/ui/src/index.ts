// Aggregate export for `@aquilla/ui`. Per-component sub-paths are also
// exported in package.json so consumers can tree-shake or pin imports as
// they prefer.

export { Button } from "./button"
export type { ButtonProps } from "./button"
export { buttonVariants } from "./button-variants"

export { Input } from "./input"
export type { InputProps } from "./input"

export { Label } from "./label"
export type { LabelProps } from "./label"

export {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "./card"

export { Alert } from "./alert"
export type { AlertProps } from "./alert"

export { FormRow } from "./form-row"
export type { FormRowProps } from "./form-row"

export { Skeleton } from "./skeleton"

export { cn } from "./cn"

export {
  ThemeProvider,
  ThemeToggle,
  useTheme,
  applyStoredTheme,
  THEME_STORAGE_KEY,
} from "./theme-mode"
export type { ThemeMode, ResolvedTheme } from "./theme-mode"

export { AppHeader } from "./app-header"

export { FloatingThemeToggle } from "./floating-theme-toggle"
