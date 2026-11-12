const utf8 = (text: string) => new TextEncoder().encode(text)

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

function u32(...values: number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4)
  values.forEach((value, i) => new DataView(bytes.buffer).setUint32(i * 4, value))
  return bytes
}

function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const payload = concat(...parts)
  return concat(u32(payload.length + 8), utf8(type), payload)
}

function sample(text: string | Uint8Array): Uint8Array {
  const bytes = typeof text === "string" ? utf8(text) : text
  const size = new Uint8Array(2)
  new DataView(size.buffer).setUint16(0, bytes.length)
  return concat(size, bytes)
}

export function embeddedSubtitleFixture(
  texts: Array<string | Uint8Array> = ["First phrase", "Second phrase"],
  options: {
    edit?: boolean
    offsets64?: boolean
    splitChunks?: boolean
    timescale?: number
    durations?: readonly [number, number]
    leadingEmptyMediaBoxes?: number
  } = {},
): ArrayBuffer {
  const timescale = options.timescale ?? 1000
  const durations = options.durations ?? [1000, 2000]
  const samples = texts.map(sample)
  const prefix = concat(...Array.from(
    { length: options.leadingEmptyMediaBoxes ?? 0 }, () => box("mdat"),
  ))
  const firstOffset = prefix.length + 8
  const mdat = box("mdat", ...samples)
  const stbl = box("stbl",
    box("stsd", u32(0, 1), box("tx3g")),
    box("stts", u32(0, 2, 1, durations[0], 1, durations[1])),
    box("stsc", u32(0, 1, 1, options.splitChunks ? 1 : 2, 1)),
    box("stsz", u32(0, 0, 2, ...samples.map(part => part.length))),
    options.offsets64
      ? box("co64", u32(0, 1, 0, firstOffset))
      : box("stco", options.splitChunks
        ? u32(0, 2, firstOffset, firstOffset + samples[0].length)
        : u32(0, 1, firstOffset)),
  )
  const mdhd = box("mdhd", u32(0, 0, 0, timescale, durations[0] + durations[1], 0))
  const hdlr = box("hdlr", u32(0, 0), utf8("sbtl"))
  const edit = options.edit ? box("edts",
    box("elst", u32(0, 2, 500, 0xffffffff, 0x10000, 3000, 0, 0x10000)),
  ) : new Uint8Array()
  const moov = box("moov",
    box("mvhd", u32(0, 0, 0, 1000, 3500)),
    box("trak", edit, box("mdia", mdhd, hdlr, box("minf", stbl))),
  )
  return concat(prefix, mdat, moov).buffer as ArrayBuffer
}
