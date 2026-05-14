// Class-name merger — identical to src/lib/utils.ts so consumers can drop
// `cn()` into JSX without picking which lib to import from.

import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
