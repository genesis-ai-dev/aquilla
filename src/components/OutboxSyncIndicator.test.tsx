import { afterEach, describe, expect, it } from "vitest"
import { act, render, screen } from "@testing-library/react"
import { OutboxSyncIndicator } from "./OutboxSyncIndicator"
import { __resetLeaderStalledForTests, setLeaderStalled } from "@/lib/offline/leader-watchdog"

afterEach(() => {
  __resetLeaderStalledForTests()
})

describe("OutboxSyncIndicator", () => {
  it("shows Synced when the queue is empty", () => {
    render(<OutboxSyncIndicator pendingCount={0} failureStreak={0} />)
    expect(screen.getByRole("button", { name: /all changes synced/i })).toHaveTextContent("Synced")
  })

  it("shows the queued count while writes are pending", () => {
    render(<OutboxSyncIndicator pendingCount={3} failureStreak={0} />)
    expect(screen.getByRole("button")).toHaveTextContent("Queued 3")
  })

  it("never claims Synced while the offline store has stopped saving", () => {
    setLeaderStalled(true)
    render(<OutboxSyncIndicator pendingCount={0} failureStreak={0} />)
    const chip = screen.getByRole("button", { name: /aren't being saved/i })
    expect(chip).toHaveTextContent("Not saving")
    expect(chip).not.toHaveTextContent("Synced")
  })

  it("ranks not-saving above permanently failed writes", () => {
    setLeaderStalled(true)
    render(<OutboxSyncIndicator pendingCount={2} failureStreak={5} failedCount={1} />)
    expect(screen.getByRole("button")).toHaveTextContent("Not saving")
  })

  it("updates live when the stall starts and clears", () => {
    render(<OutboxSyncIndicator pendingCount={0} failureStreak={0} />)
    expect(screen.getByRole("button")).toHaveTextContent("Synced")

    act(() => setLeaderStalled(true))
    expect(screen.getByRole("button")).toHaveTextContent("Not saving")

    act(() => setLeaderStalled(false))
    expect(screen.getByRole("button")).toHaveTextContent("Synced")
  })
})
