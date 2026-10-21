// AQU-1642 follow-up (Sam, 2026-10-17): the Audio view's one place to play from.
import { describe, expect, it } from "vitest"
import {
  placeOnCardPress,
  placeOnMenuPress,
  placeOnSelect,
  placeOnWaveformPick,
  type RunOn,
} from "./audio-view-place"

const playing = (cellId: string): RunOn => ({ cellId, kind: "playing" })
const loading = (cellId: string): RunOn => ({ cellId, kind: "loading" })
const paused = (cellId: string): RunOn => ({ cellId, kind: "paused" })

describe("selecting a verse", () => {
  it("lets a paused place go, in that verse or another, so Play starts the verse from the top", () => {
    expect(placeOnSelect(paused("v1"))).toEqual({ kind: "stop" })
    expect(placeOnSelect(paused("v3"))).toEqual({ kind: "stop" })
  })

  it("leaves a playing run alone, and does nothing when idle", () => {
    expect(placeOnSelect(playing("v1"))).toEqual({ kind: "none" })
    expect(placeOnSelect(loading("v1"))).toEqual({ kind: "none" })
    expect(placeOnSelect(null)).toEqual({ kind: "none" })
  })
})

describe("the card's corner button", () => {
  it("is Stop while the run is on its verse, opening included", () => {
    expect(placeOnCardPress(playing("v2"), "v2")).toEqual({ kind: "stop" })
    expect(placeOnCardPress(loading("v2"), "v2")).toEqual({ kind: "stop" })
  })

  it("carries on from a place paused in its verse", () => {
    expect(placeOnCardPress(paused("v2"), "v2")).toEqual({ kind: "resume" })
  })

  it("otherwise starts its verse from the top, and the run plays on", () => {
    expect(placeOnCardPress(null, "v2")).toEqual({ kind: "start", play: true })
    expect(placeOnCardPress(paused("v1"), "v2")).toEqual({ kind: "start", play: true })
    expect(placeOnCardPress(playing("v1"), "v2")).toEqual({ kind: "start", play: true })
  })
})

describe("⋯ Play audio", () => {
  it("is Pause while the run is on its verse, and keeps the place", () => {
    expect(placeOnMenuPress(playing("v2"), "v2")).toEqual({ kind: "pause" })
    expect(placeOnMenuPress(loading("v2"), "v2")).toEqual({ kind: "pause" })
  })

  it("carries on from a place paused in its verse, else starts it from the top", () => {
    expect(placeOnMenuPress(paused("v2"), "v2")).toEqual({ kind: "resume" })
    expect(placeOnMenuPress(paused("v1"), "v2")).toEqual({ kind: "start", play: true })
    expect(placeOnMenuPress(null, "v2")).toEqual({ kind: "start", play: true })
  })
})

describe("a click inside a card's waveform", () => {
  it("moves the place within the verse the run is on, playing or not", () => {
    expect(placeOnWaveformPick(playing("v2"), "v2", 1.5)).toEqual({ kind: "seek", atSeconds: 1.5 })
    expect(placeOnWaveformPick(paused("v2"), "v2", 1.5)).toEqual({ kind: "seek", atSeconds: 1.5 })
  })

  it("puts the place in another verse: playing on if the run was, else waiting there", () => {
    expect(placeOnWaveformPick(playing("v1"), "v2", 1.5)).toEqual({ kind: "start", atSeconds: 1.5, play: true })
    expect(placeOnWaveformPick(paused("v1"), "v2", 1.5)).toEqual({ kind: "start", atSeconds: 1.5, play: false })
    expect(placeOnWaveformPick(null, "v2", 1.5)).toEqual({ kind: "start", atSeconds: 1.5, play: false })
  })
})
