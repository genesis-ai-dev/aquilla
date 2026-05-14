// @aquilla/ui — minimal shared primitives. Phase 3c subset; 3b's UI PR
// expands to the full shadcn surface (Dialog, Popover, ScrollArea, Tooltip…).
// Consumers should prefer this package over deep imports into src/components/ui/
// in the workspace SPA — sharing through packages is the AD-11 contract.

export { cn } from "./utils"
export {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "./card"
export { Skeleton } from "./skeleton"
export { Button } from "./button"
