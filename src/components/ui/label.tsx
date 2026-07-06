"use client"

import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const labelVariants = cva(
  "flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
  {
    variants: {
      layout: {
        /** Stacked above a control when not wrapped in Field (Field supplies gap). */
        stacked: "mb-1.5",
        /** Beside a control (checkbox row, Field + FieldLabel, horizontal flex). */
        inline: "",
      },
    },
    defaultVariants: {
      layout: "stacked",
    },
  }
)

function Label({
  className,
  layout,
  ...props
}: React.ComponentProps<"label"> & VariantProps<typeof labelVariants>) {
  return (
    <label
      data-slot="label"
      className={cn(labelVariants({ layout }), className)}
      {...props}
    />
  )
}

export { Label, labelVariants }
