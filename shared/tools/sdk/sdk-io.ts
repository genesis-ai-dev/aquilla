/**
 * Aquilla extension SDK — part 10 (SDK 1.1, apiRev 7): reading what an
 * importer fetches, inside the sandbox, with no privilege:
 *
 *   aq.zip.read(arrayBuffer)  → { entries, names, text(name), bytes(name) }
 *       a zip archive (a repository zipball from aquilla.web.fetch(url,
 *       { as: "bytes" })). Stored and deflated members; inflated with the
 *       browser's DecompressionStream("deflate-raw"). No zip64.
 *   aq.parse.tsv(text)        → { header, rows:[{ column: value }] }
 *   aq.parse.usfm(text)       → { book, verses:[{ ref, chapter, verse, text, words }] }
 *       USFM 3: chapters, verses (and bridges), \w word|attributes\w* words and
 *       \zaln-s … \zaln-e\* (or any …-s/…-e) milestones. Each word carries its
 *       attributes, its occurrence/occurrences in the verse and the stack of
 *       milestones around it (outermost first), so word alignment and per-word
 *       data survive. Notes (\f, \x) and headings are not verse text.
 *   aq.parse.mdBlocks(text)   → [{ kind, level, text, section }]
 *       markdown split into headings, paragraphs, lists and code; `section`
 *       is the slug of the nearest heading above (a stable cell key).
 */
export const SDK_IO = String.raw`
  function u16(v, o) { return v.getUint16(o, true); }
  function u32(v, o) { return v.getUint32(o, true); }
  function inflateRaw(bytes) {
    if (typeof DecompressionStream === "undefined") return Promise.reject(new Error("this browser cannot unzip (no DecompressionStream)"));
    var ds = new DecompressionStream("deflate-raw");
    var stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Response(stream).arrayBuffer();
  }
  function zipRead(buf) {
    return Promise.resolve().then(function () {
      if (!(buf instanceof ArrayBuffer)) throw new Error("aq.zip.read needs an ArrayBuffer (web.fetch with { as: \"bytes\" })");
      var v = new DataView(buf);
      var eocd = -1;
      for (var i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
        if (u32(v, i) === 0x06054b50) { eocd = i; break; }
      }
      if (eocd < 0) throw new Error("not a zip archive");
      var count = u16(v, eocd + 10), at = u32(v, eocd + 16);
      var entries = [], byName = Object.create(null), dec = new TextDecoder();
      for (var n = 0; n < count; n++) {
        if (u32(v, at) !== 0x02014b50) throw new Error("corrupt zip directory");
        var method = u16(v, at + 10), csize = u32(v, at + 20), size = u32(v, at + 24);
        var nlen = u16(v, at + 28), xlen = u16(v, at + 30), clen = u16(v, at + 32), local = u32(v, at + 42);
        var name = dec.decode(new Uint8Array(buf, at + 46, nlen));
        at += 46 + nlen + xlen + clen;
        if (name.charAt(name.length - 1) === "/") continue;
        var e = { name: name, size: size, method: method, csize: csize, local: local };
        entries.push(e);
        byName[name] = e;
      }
      function bytesOf(name) {
        var e = byName[name];
        if (!e) return Promise.reject(new Error("no " + name + " in the archive"));
        var lnlen = u16(v, e.local + 26), lxlen = u16(v, e.local + 28);
        var data = new Uint8Array(buf, e.local + 30 + lnlen + lxlen, e.csize);
        if (e.method === 0) return Promise.resolve(data.slice().buffer);
        if (e.method === 8) return inflateRaw(data);
        return Promise.reject(new Error("unsupported compression in " + name));
      }
      return {
        entries: entries.map(function (e) { return { name: e.name, size: e.size }; }),
        names: entries.map(function (e) { return e.name; }),
        bytes: bytesOf,
        text: function (name) { return bytesOf(name).then(function (b) { return dec.decode(b); }); },
      };
    });
  }

  function parseTsv(text) {
    var lines = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/);
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    var header = (lines.shift() || "").split("\t");
    return {
      header: header,
      rows: lines.filter(function (l) { return l.length > 0; }).map(function (l) {
        var f = l.split("\t"), row = {};
        header.forEach(function (h, i) { row[h] = f[i] !== undefined ? f[i] : ""; });
        return row;
      }),
    };
  }

  function usfmAttrs(s, defaultKey) {
    var out = {}, m, re = /([\w-]+)\s*=\s*"([^"]*)"/g, any = false;
    while ((m = re.exec(s))) { out[m[1]] = m[2]; any = true; }
    var bare = s.trim();
    if (!any && bare && defaultKey) out[defaultKey] = bare;
    return out;
  }
  var USFM_LINE_MARKERS = /^(id|ide|h|toc\d?|mt\d?|ms\d?|mr|s\d?|sr|r|d|cl|rem|usfm|sts|is\d?|ip|iot|io\d?|imt\d?)$/;
  function parseUsfm(src) {
    var text = String(src || "").replace(/^\uFEFF/, "");
    var re = /\\(\+?[A-Za-z0-9-]*)(\*?)|([^\\]+)/g, m;
    var book = "", chapter = "0", verses = [], cur = null, stack = [];
    var mode = null, buf = "", skipNote = null, word = null;
    function flushVerse() {
      if (!cur) return;
      cur.text = cur.text.replace(/\s+/g, " ").replace(/\s+([,.;:!?)\]»”’׃])/g, "$1").trim();
      var seen = {}, totals = {};
      cur.words.forEach(function (w) { totals[w.text] = (totals[w.text] || 0) + 1; });
      cur.words.forEach(function (w) {
        seen[w.text] = (seen[w.text] || 0) + 1;
        w.occurrence = Number(w.attrs["x-occurrence"] || seen[w.text]);
        w.occurrences = Number(w.attrs["x-occurrences"] || totals[w.text]);
      });
      verses.push(cur);
      cur = null;
    }
    function addText(s) { if (cur) cur.text += s; }
    while ((m = re.exec(text))) {
      if (m[3] !== undefined) {
        var chunk = m[3];
        if (skipNote) continue;
        if (mode === "line") { var nl = chunk.indexOf("\n"); if (nl < 0) { if (book === "" && buf === "id") book = chunk.trim().split(/\s+/)[0]; continue; } if (buf === "id" && book === "") book = chunk.slice(0, nl).trim().split(/\s+/)[0]; mode = null; chunk = chunk.slice(nl); }
        if (mode === "c") { var cm = /^\s*(\S+)/.exec(chunk); if (cm) { flushVerse(); chapter = cm[1]; chunk = chunk.slice(cm[0].length); } mode = null; }
        if (mode === "v") {
          var vm = /^\s*(\S+)\s?/.exec(chunk);
          if (vm) { flushVerse(); cur = { ref: (book ? book + " " : "") + chapter + ":" + vm[1], chapter: chapter, verse: vm[1], text: "", words: [] }; chunk = chunk.slice(vm[0].length); }
          mode = null;
        }
        if (mode === "ms") { buf += chunk; continue; }
        if (word) { word.raw += chunk; continue; }
        addText(chunk);
        continue;
      }
      var name = m[1].replace(/^\+/, ""), closing = m[2] === "*";
      if (skipNote) { if (closing && name === skipNote) skipNote = null; continue; }
      if (mode === "ms" && name === "" && closing) {
        var mattrs = usfmAttrs(buf.replace(/^\s*\|?/, ""));
        stack.push({ marker: pendingMs, attrs: mattrs });
        mode = null; buf = "";
        continue;
      }
      if (name === "" && closing) continue;
      if (name === "f" || name === "fe" || name === "x") { if (!closing) skipNote = name; continue; }
      if (name === "w") {
        if (!closing) { word = { raw: "" }; continue; }
        if (word) {
          var bar = word.raw.indexOf("|");
          var wtext = (bar >= 0 ? word.raw.slice(0, bar) : word.raw).trim();
          var wattrs = bar >= 0 ? usfmAttrs(word.raw.slice(bar + 1), "lemma") : {};
          if (cur && wtext) {
            cur.words.push({ text: wtext, attrs: wattrs, milestones: stack.map(function (s) { return s.attrs; }) });
            cur.text += wtext;
          }
          word = null;
        }
        continue;
      }
      var msm = /^(.+)-s$/.exec(name);
      if (msm) { mode = "ms"; buf = ""; var pendingMs = msm[1]; continue; }
      if (/-e$/.test(name)) { stack.pop(); continue; }
      if (name === "c") { mode = "c"; continue; }
      if (name === "v") { mode = "v"; continue; }
      if (USFM_LINE_MARKERS.test(name)) { mode = "line"; buf = name; continue; }
      if (cur && !closing && /^(p|m|pi\d?|q\d?|qr|qc|li\d?|b|nb|mi|pc)$/.test(name)) addText(" ");
    }
    flushVerse();
    return { book: book, verses: verses };
  }

  function slug(s) { return String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "section"; }
  function mdBlocks(text) {
    var lines = String(text || "").replace(/\r\n/g, "\n").split("\n"), out = [], para = [], section = "", inCode = false, code = [];
    function flush() {
      if (!para.length) return;
      var t = para.join("\n").trim();
      if (t) out.push({ kind: /^\s*([-*+]|\d+[.)])\s/.test(para[0]) ? "list" : "p", level: 0, text: t, section: section });
      para = [];
    }
    lines.forEach(function (line) {
      if (/^\s*` + "```" + String.raw`/.test(line)) {
        if (inCode) { out.push({ kind: "code", level: 0, text: code.join("\n"), section: section }); code = []; inCode = false; }
        else { flush(); inCode = true; }
        return;
      }
      if (inCode) { code.push(line); return; }
      var h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) { flush(); section = slug(h[2]); out.push({ kind: "heading", level: h[1].length, text: h[2].trim(), section: section }); return; }
      if (!line.trim()) { flush(); return; }
      para.push(line);
    });
    if (inCode) out.push({ kind: "code", level: 0, text: code.join("\n"), section: section });
    flush();
    return out;
  }
  var io = { zip: { read: zipRead }, parse: { tsv: parseTsv, usfm: parseUsfm, mdBlocks: mdBlocks } };
`
