export interface EmbeddedSubtitleCue {
  text: string
  start: number
  end: number
}

export interface EmbeddedSubtitleTrack {
  codec: "tx3g"
  language: string | null
  cues: EmbeddedSubtitleCue[]
}

interface Box {
  type: string
  data: number
  end: number
}

// Bound untrusted sample tables before allocating or iterating over them.
const MAX_SAMPLES = 100_000
const MAX_BOX_READS = 100_000
const utf8 = new TextDecoder("utf-8", { fatal: true })
const utf16be = new TextDecoder("utf-16be", { fatal: true })
const utf16le = new TextDecoder("utf-16le", { fatal: true })

function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return utf16be.decode(bytes)
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return utf16le.decode(bytes)
  return utf8.decode(bytes)
}

/** Read non-fragmented ISO BMFF timed text. mov_text's sample entry is tx3g.
 * Malformed containers/tracks return no subtitles; audio import remains usable.
 */
export function extractEmbeddedSubtitles(
  buffer: ArrayBuffer,
): EmbeddedSubtitleTrack[] {
  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)
  const u32 = (offset: number) => view.getUint32(offset)
  const type = (offset: number) => String.fromCharCode(
    ...bytes.subarray(offset, offset + 4),
  )
  let mediaData: Box[] = []
  let boxReads = 0
  function boxes(start: number, end: number): Box[] {
    const result: Box[] = []
    while (start < end) {
      if (++boxReads > MAX_BOX_READS) throw new Error("Too many container boxes")
      if (end - start < 8) throw new Error("Truncated box")
      let size = u32(start)
      let header = 8
      if (size === 1) {
        if (end - start < 16) throw new Error("Truncated large box")
        size = Number(view.getBigUint64(start + 8))
        header = 16
      } else if (size === 0) size = end - start
      if (!Number.isSafeInteger(size) || size < header || size > end - start) {
        throw new Error("Invalid box size")
      }
      result.push({ type: type(start + 4), data: start + header, end: start + size })
      start += size
    }
    return result
  }
  const children = (parent: Box) => boxes(parent.data, parent.end)
  // Top-level boxes stay ordered and cannot overlap. Avoid scanning every
  // media-data box for every sample in a file with many separate chunks.
  function containsSample(offset: number, size: number): boolean {
    let low = 0
    let high = mediaData.length - 1
    let candidate: Box | undefined
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      const box = mediaData[middle]
      if (box.data <= offset) {
        candidate = box
        low = middle + 1
      } else high = middle - 1
    }
    return candidate !== undefined && offset <= candidate.end &&
      size <= candidate.end - offset
  }
  function required(parent: Box, name: string): Box {
    const result = children(parent).find(box => box.type === name)
    if (!result) throw new Error(`Missing ${name}`)
    return result
  }
  function table(box: Box, width: number, header = 8): number {
    if (box.end - box.data < header) throw new Error("Truncated table")
    const count = u32(box.data + header - 4)
    if (count > MAX_SAMPLES || count * width > box.end - box.data - header) {
      throw new Error("Invalid table length")
    }
    return count
  }
  function applyEdits(
    track: Box, movie: Box, scale: number, cues: EmbeddedSubtitleCue[],
  ): EmbeddedSubtitleCue[] {
    const edts = children(track).find(box => box.type === "edts")
    if (!edts) return cues
    const elst = required(edts, "elst")
    const version = view.getUint8(elst.data)
    if (version !== 0 && version !== 1) throw new Error("Unknown edit version")
    const width = version === 1 ? 20 : 12
    const count = table(elst, width)
    if (count * cues.length > 1_000_000) throw new Error("Too many edits")
    const mvhd = required(movie, "mvhd")
    const movieVersion = view.getUint8(mvhd.data)
    if (movieVersion !== 0 && movieVersion !== 1) throw new Error("Unknown movie version")
    const scaleOffset = mvhd.data + (movieVersion === 1 ? 20 : 12)
    if (scaleOffset + 4 > mvhd.end) throw new Error("Truncated movie header")
    const movieScale = u32(scaleOffset)
    if (!movieScale) throw new Error("Invalid movie scale")
    const result: EmbeddedSubtitleCue[] = []
    let movieTime = 0
    for (let i = 0; i < count; i++) {
      const offset = elst.data + 8 + i * width
      const duration = version === 1 ? Number(view.getBigUint64(offset)) : u32(offset)
      const mediaTime = version === 1
        ? Number(view.getBigInt64(offset + 8)) : view.getInt32(offset + 4)
      const rateOffset = offset + (version === 1 ? 16 : 8)
      if (!Number.isSafeInteger(duration) || !Number.isSafeInteger(mediaTime) ||
          mediaTime < -1 || view.getInt16(rateOffset) !== 1 || view.getInt16(rateOffset + 2) !== 0) {
        throw new Error("Unsupported edit")
      }
      const movieDuration = duration / movieScale
      if (mediaTime !== -1) {
        const mediaStart = mediaTime / scale
        const mediaEnd = mediaStart + movieDuration
        for (const cue of cues) {
          const start = Math.max(cue.start, mediaStart)
          const end = Math.min(cue.end, mediaEnd)
          const zeroDuration = cue.start === cue.end && cue.start >= mediaStart && cue.start < mediaEnd
          if (end > start || zeroDuration) {
            result.push({
              text: cue.text,
              start: movieTime + start - mediaStart,
              end: movieTime + end - mediaStart,
            })
          }
        }
      }
      movieTime += movieDuration
    }
    return result
  }
  function readTrack(track: Box, movie: Box): EmbeddedSubtitleTrack | null {
    const mdia = required(track, "mdia")
    const hdlr = required(mdia, "hdlr")
    if (hdlr.end - hdlr.data < 12) throw new Error("Truncated handler")
    if (!["sbtl", "subt", "text"].includes(type(hdlr.data + 8))) return null
    const mdhd = required(mdia, "mdhd")
    const version = view.getUint8(mdhd.data)
    if (version !== 0 && version !== 1) throw new Error("Unknown header version")
    const scaleOffset = mdhd.data + (version === 1 ? 20 : 12)
    const languageOffset = mdhd.data + (version === 1 ? 32 : 20)
    if (languageOffset + 2 > mdhd.end) throw new Error("Truncated media header")
    const scale = u32(scaleOffset)
    if (scale === 0) throw new Error("Invalid timescale")
    const packedLanguage = view.getUint16(languageOffset)
    const language = packedLanguage === 0 ? null : String.fromCharCode(
      ((packedLanguage >> 10) & 31) + 96,
      ((packedLanguage >> 5) & 31) + 96,
      (packedLanguage & 31) + 96,
    )
    const stbl = required(required(mdia, "minf"), "stbl")
    const stsd = required(stbl, "stsd")
    table(stsd, 0)
    const descriptions = boxes(stsd.data + 8, stsd.end)
    if (descriptions.length !== u32(stsd.data + 4)) throw new Error("Invalid descriptions")
    const stsz = required(stbl, "stsz")
    if (stsz.end - stsz.data < 12) throw new Error("Truncated sample sizes")
    const fixedSize = u32(stsz.data + 4)
    const sampleCount = table(stsz, fixedSize === 0 ? 4 : 0, 12)
    const sizes = Array.from({ length: sampleCount }, (_, i) =>
      fixedSize || u32(stsz.data + 12 + i * 4),
    )
    const stts = required(stbl, "stts")
    const timingCount = table(stts, 8)
    const durations: number[] = []
    for (let i = 0; i < timingCount; i++) {
      const count = u32(stts.data + 8 + i * 8)
      const delta = u32(stts.data + 12 + i * 8)
      if (count > sampleCount - durations.length) throw new Error("Invalid timing count")
      for (let j = 0; j < count; j++) durations.push(delta)
    }
    if (durations.length !== sampleCount) throw new Error("Missing timings")
    const stsc = required(stbl, "stsc")
    const mappingCount = table(stsc, 12)
    const mappings = Array.from({ length: mappingCount }, (_, i) => ({
      first: u32(stsc.data + 8 + i * 12),
      count: u32(stsc.data + 12 + i * 12),
      description: u32(stsc.data + 16 + i * 12),
    }))
    if (mappings.length === 0 || mappings[0].first !== 1 || mappings.some(
      (mapping, i) => mapping.count === 0 || mapping.description === 0 ||
        mapping.description > descriptions.length ||
        (i > 0 && mapping.first <= mappings[i - 1].first),
    )) throw new Error("Invalid chunk mapping")
    const stco = children(stbl).find(box => box.type === "stco" || box.type === "co64")
    if (!stco) throw new Error("Missing offsets")
    const width = stco.type === "co64" ? 8 : 4
    const chunkCount = table(stco, width)
    const cues: EmbeddedSubtitleCue[] = []
    let sampleIndex = 0
    let mappingIndex = 0
    let time = 0
    for (let chunk = 1; chunk <= chunkCount; chunk++) {
      while (mappingIndex + 1 < mappings.length && mappings[mappingIndex + 1].first <= chunk) {
        mappingIndex++
      }
      const mapping = mappings[mappingIndex]
      if (mapping.count > sampleCount - sampleIndex) throw new Error("Too many samples")
      const offsetIndex = stco.data + 8 + (chunk - 1) * width
      let offset = width === 8 ? Number(view.getBigUint64(offsetIndex)) : u32(offsetIndex)
      for (let i = 0; i < mapping.count; i++, sampleIndex++) {
        const size = sizes[sampleIndex]
        if (!Number.isSafeInteger(offset) || offset < 0 ||
            !containsSample(offset, size)) {
          throw new Error("Sample outside file")
        }
        if (descriptions[mapping.description - 1].type === "tx3g") {
          if (size < 2) throw new Error("Truncated text sample")
          const textLength = view.getUint16(offset)
          if (textLength > size - 2) throw new Error("Truncated text")
          const text = decodeText(bytes.subarray(offset + 2, offset + 2 + textLength))
          if (text.trim()) cues.push({ text, start: time / scale, end: (time + durations[sampleIndex]) / scale })
        }
        time += durations[sampleIndex]
        offset += size
      }
    }
    if (sampleIndex !== sampleCount) throw new Error("Missing samples")
    const edited = applyEdits(track, movie, scale, cues)
    return edited.length ? { codec: "tx3g", language, cues: edited } : null
  }
  try {
    const topLevel = boxes(0, buffer.byteLength)
    mediaData = topLevel.filter(box => box.type === "mdat")
    const moov = topLevel.find(box => box.type === "moov")
    if (!moov) return []
    return children(moov).filter(box => box.type === "trak").flatMap(track => {
      try {
        const result = readTrack(track, moov)
        return result ? [result] : []
      } catch {
        return []
      }
    })
  } catch {
    return []
  }
}
