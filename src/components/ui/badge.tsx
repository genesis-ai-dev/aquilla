import { cva, type VariantProps } from "class-variance-authority"

import { AppTooltip } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-muted text-muted-foreground",
        destructive: "border-transparent bg-destructive/10 text-destructive",
        outline: "border-input text-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  title,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  const badge = (
    <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
  )

  if (!title) return badge

  return <AppTooltip content={title}>{badge}</AppTooltip>
}

export { Badge, badgeVariants }
