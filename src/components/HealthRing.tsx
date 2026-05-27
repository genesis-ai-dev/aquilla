interface HealthRingProps {
  health: number           // 0-100
  size?: number            // px, default 20
  strokeWidth?: number     // px, default 2.5
  className?: string
  style?: React.CSSProperties
  children?: React.ReactNode  // icon rendered inside the ring
}

export function HealthRing({ health, size = 20, strokeWidth = 2.5, className, style, children }: HealthRingProps) {
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const offset = circumference - (health / 100) * circumference

  // Color: red (0-33) → amber (34-66) → green (67-100)
  const color = health <= 33 ? "#ef4444" : health <= 66 ? "#f59e0b" : "#22c55e"

  return (
    <div className={className} style={{ position: "relative", width: size, height: size, ...style }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        {/* Background track */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          className="text-muted-foreground/20"
        />
        {/* Health arc */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          style={{ transition: "stroke-dashoffset 0.5s ease, stroke 0.5s ease" }}
        />
      </svg>
      {/* Center content (icon) */}
      {children && (
        <div style={{
          position: "absolute", inset: 0,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          {children}
        </div>
      )}
    </div>
  )
}
