import { describe, expect, it } from "vitest"
import { pidsFromNetstat } from "./listening-pids"

const NETSTAT = `
  Proto  Local Address          Foreign Address        State           PID
  TCP    127.0.0.1:10460        0.0.0.0:0              LISTENING       9132
  TCP    127.0.0.1:1046         0.0.0.0:0              LISTENING       1111
  TCP    [::1]:10460            [::]:0                 LISTENING       9132
  TCP    127.0.0.1:10560        0.0.0.0:0              LISTENING       39524
  TCP    127.0.0.1:9787         127.0.0.1:54000        ESTABLISHED     4242
`

describe("pidsFromNetstat", () => {
  it("returns the listener for an exact port, including IPv6", () => {
    expect(pidsFromNetstat(NETSTAT, 10460)).toEqual(["9132"])
  })

  it("does not treat a shorter port as a match", () => {
    expect(pidsFromNetstat(NETSTAT, 1046)).toEqual(["1111"])
  })

  it("ignores connections that are not listening", () => {
    expect(pidsFromNetstat(NETSTAT, 9787)).toEqual([])
  })
})
