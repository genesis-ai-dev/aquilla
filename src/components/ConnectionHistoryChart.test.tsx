import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import { ConnectionHistoryChart } from "./ConnectionHistoryChart"
import type { ConnectionHistoryPoint } from "@/lib/sync/connection-activity"

describe("ConnectionHistoryChart", () => {
  it("shows no invented reply points when there have been no observations", () => {
    const history = Array.from({ length: 60 }, () => ({ upload: null, download: null, latency: null }))
    render(<ConnectionHistoryChart history={history} />)
    const replies = screen.getByRole("img", { name: "Observed server replies over the past five minutes" })
    expect(replies.querySelectorAll("circle")).toHaveLength(0)
    expect(screen.getAllByText("Waiting for activity")).toHaveLength(2)
  })

  it("uses separate labelled scales and leaves missing reply samples as gaps", () => {
    const history: ConnectionHistoryPoint[] = Array.from({ length: 60 }, () => ({ upload: 0, download: 0, latency: null }))
    history[10] = { upload: 1000, download: 2000, latency: 100 }
    history[30] = { upload: 500, download: 0, latency: 200 }
    render(<ConnectionHistoryChart history={history} />)
    expect(screen.getByText("2 kB/s")).toBeTruthy()
    expect(screen.getByText("200 ms")).toBeTruthy()
    const replies = screen.getByRole("img", { name: "Observed server replies over the past five minutes" })
    expect(replies.querySelectorAll("circle")).toHaveLength(2)
    const dots = replies.querySelectorAll("circle")
    expect(Number(dots[0].getAttribute("cx"))).toBeLessThan(Number(dots[1].getAttribute("cx")))
    expect(Number(dots[0].getAttribute("cy"))).toBeGreaterThan(Number(dots[1].getAttribute("cy")))
  })
})
