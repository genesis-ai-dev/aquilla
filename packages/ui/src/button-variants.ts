// Extracted from button.tsx so the component file only exports React
// components (keeps react-refresh happy and matches the convention in the
// workspace's src/components/ui/).

import { cva } from "class-variance-authority"

export const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center rounded-xl border border-transparent text-sm font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-ring active:translate-y-px disabled:pointer-events-none disabled:opacity-50 disabled:shadow-none",
  {
    variants: {
      // Neumorphic: solid + outline + secondary lift off the surface with a
      // soft dual-tone shadow and press inward (inset) on :active. ghost/link
      // stay flat.
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-neu-sm hover:bg-primary/95 hover:shadow-neu active:shadow-neu-pressed",
        outline:
          "bg-background text-foreground shadow-neu-sm hover:bg-muted/40 hover:shadow-neu active:shadow-neu-pressed",
        secondary:
          "bg-secondary text-secondary-foreground shadow-neu-sm hover:shadow-neu active:shadow-neu-pressed",
        ghost: "hover:bg-muted hover:text-foreground",
        destructive:
          "bg-destructive text-destructive-foreground shadow-neu-sm hover:bg-destructive/95 hover:shadow-neu active:shadow-neu-pressed",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-3",
        sm: "h-8 px-2.5 text-sm",
        lg: "h-10 px-4",
        icon: "size-9",
      },
      fullWidth: {
        true: "w-full",
        false: "",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
      fullWidth: false,
    },
  },
)
