// LangQuest's mark — three rising bars with a check over the tallest — on its
// black tile. Traced from langquest-next apps/mobile/assets/logo.svg (same
// geometry); shown wherever Aquilla surfaces a LangQuest link, so a linked
// project is recognisable at a glance.

import { cn } from "@/lib/utils"

export function LangQuestLogo({ className, title }: { className?: string; title?: string }) {
  return (
    <svg
      viewBox="0 0 100 100"
      className={cn("size-4 shrink-0 rounded-[22%]", className)}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      <rect width="100" height="100" fill="#000" />
      <defs>
        <mask id="lq-gap" maskUnits="userSpaceOnUse" x="0" y="0" width="1536" height="1024">
          <rect width="1536" height="1024" fill="white" />
          <path d="M738 518 L878 652 L1124 415" fill="none" stroke="black" strokeWidth="150" strokeLinecap="round" strokeLinejoin="round" />
        </mask>
      </defs>
      <g transform="translate(50 50) scale(0.0809) translate(-780.5 -516.5)">
        <g fill="#fff" mask="url(#lq-gap)">
          <rect x="385" y="465" width="111" height="192" rx="55.5" />
          <rect x="531" y="374" width="111" height="342" rx="55.5" />
          <rect x="677" y="273" width="113" height="487" rx="56.5" />
        </g>
        <path d="M738 518 L878 652 L1124 415" fill="none" stroke="#fff" strokeWidth="106" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    </svg>
  )
}
