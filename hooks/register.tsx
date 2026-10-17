import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

const PANE = 'file-tree'
// The dock width asked for; one the person dragged wins, and without a request the dock can leave the chat a sliver.
const DOCK_COLUMNS = 56
const SKIP = new Set(['.git', 'node_modules', '.DS_Store'])
const expanded = atom({ plugin: 'file-tree', key: 'expanded' } as const, [] as string[])
const tick = atom({ plugin: 'file-tree', key: 'tick' } as const, 0)
const selected = atom({ plugin: 'file-tree', key: 'selected' } as const, '')
const cursor = atom({ plugin: 'file-tree', key: 'cursor' } as const, '')
// Mirrors of what the last draw showed, so the ui.scroll hook can move the cursor without redrawing first.
let order: string[] = []
let at = ''
// The cursor atom only carries `at` across a reload of this module; after the first render `at` leads.
let cursorRead = false
let shown = ''
// Each surface has its own window: tree top, preview top and last offset, and the body row where the box starts
// (Infinity: no box). ui.scroll names no surface, so it finds its window by bodyRows.
// `anchor` is the preview's top row as a place in the file (line and offset), so a new width finds the same place.
type Geo = {
  bodyRows: number
  top: number
  pTop: number
  pMax: number
  page: number
  previewFrom: number
  anchor?: { sig: string; width: number; line: number; at: number }
  // Its box holds a text taller than itself.
  tall?: boolean
}
const geos = new Map<string, Geo>()
// Tab from the tree puts the arrows, Home/End and the wheel on the text preview, with the ring resting on the box's
// title; any other move of the ring (Tab again, a click) hands them back. `scrollable`: the last box drawn held a text
// taller than itself, the only kind Tab goes into.
let inPreview = false
let scrollable = false
const PREVIEW_KEYS = new Set(['close-preview', 'jump-top', 'jump-end'])
const isPreviewKey = (key: string) => PREVIEW_KEYS.has(key) || key.startsWith('sb-')
// Renders run one at a time: one slowed by sips that finished after a newer one left the engine holding
// buttons from a drawing it no longer showed, and presses on them did nothing.
let drawing: Promise<unknown> = Promise.resolve()

// $.fs.read and the stdout of $.process.run both stop at 4 MiB, so that is how much of a file one preview holds.
const READ_MAX = 4 * 1024 * 1024
// Image sources are capped at 2 MiB decoded.
const IMAGE_MAX = 2 * 1024 * 1024
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'tiff', 'webp', 'heic'])
// Containers whose bytes are never text; skipping them saves a read that would only end at a NUL.
const OPAQUE = new Set([
  'mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm', 'mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'pdf',
  'zip', 'gz', 'tar', 'tgz', '7z', 'rar', 'dmg', 'iso', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'pages', 'numbers', 'key', 'psd', 'sketch', 'fig', 'sqlite', 'db', 'exe', 'bin', 'woff', 'woff2', 'ttf', 'otf',
])
// Keyed by path, mtime and size, so a file rewritten on disk is measured and read again; each keeps its newest few.
const sizes = new Map<string, { w: number; h: number } | null>()
// A PNG is up to 2.7 MB of base64, so only the last few previewed stay.
const pngs = new Map<string, string | null>()
// The lines of the previewed file and the mode each starts in, so a wheel tick slices them instead of re-reading
// the file. A 4 MiB log is over 100 MB of lines, so only two stay.
type Loaded = { lines: string[]; modes: string[]; ext: string; opaque: string; cut: boolean; gutter: boolean }
const loaded = new Map<string, Loaded>()
// One drawn row of a text preview: the line it belongs to, its number in the gutter (0 on a continuation row), its
// text and what it starts inside of.
type TextRow = { line: number; at: number; n: number; text: string; kind: Kind }
const wraps = new Map<string, TextRow[]>()

// Code colours each line on its own, so a line inside a block comment or a multi-line string comes out coloured
// as code. `scan` follows /* */, JS template literals and regexes, Go raw strings and Python triple quotes, so the
// rows that start inside a comment or string are drawn plain instead, dim for a comment.
type Kind = 0 | 1 | 2
const C_LIKE = new Set('js mjs cjs ts tsx jsx css scss less c h cc cpp hpp java kt swift go rs cs dart php'.split(' '))
const JS = new Set('js mjs cjs ts tsx jsx'.split(' '))
// After one of these a "/" starts a regex literal, which can hold "/*" or a backtick; anywhere else it divides.
const REGEX_PREV = '(,=:[!&|?{};+-*%<>~^'
const REGEX_WORDS = new Set('return typeof case do else in of new delete void throw yield await'.split(' '))
const kindOf = (mode: string): Kind => (mode === '*/' ? 1 : mode ? 2 : 0)
// Scans one line from the mode it starts in ('' code, '*/', '`', '"""', "'''"): the mode it ends in, and the kind at each
// of `stops` (ascending offsets into the line).
const scan = (line: string, start: string, e: string, stops: number[] = []) => {
  const c = C_LIKE.has(e)
  const js = JS.has(e)
  const go = e === 'go'
  const py = e === 'py'
  const at: Kind[] = []
  let mode = start
  let q = ''
  let prev = ''
  let word = ''
  let s = 0
  let i = 0
  let comment = false
  for (; i < line.length; i++) {
    while (s < stops.length && (stops[s] ?? 0) <= i) at.push(q ? 2 : kindOf(mode)), s++
    const ch = line[i] ?? ''
    if (mode) {
      // A Go raw string has no escapes, nor does a comment.
      if (mode !== '*/' && !go && ch === '\\') i++
      else if (line.startsWith(mode, i)) {
        i += mode.length - 1
        mode = ''
        prev = ch
      }
    } else if (q) {
      if (ch === '\\') i++
      else if (ch === q) (q = ''), (prev = ch)
    } else if ((c && e !== 'css' && line.startsWith('//', i)) || (py && ch === '#')) {
      comment = true
      break
    } else if (js && ch === '/' && line[i + 1] !== '*' && (prev === '' || REGEX_PREV.includes(prev) || REGEX_WORDS.has(word))) {
      // Skip the regex: to the next "/" that is neither escaped nor inside a [class].
      for (let cls = false; ++i < line.length; ) {
        if (line[i] === '\\') i++
        else if (line[i] === '[') cls = true
        else if (line[i] === ']') cls = false
        else if (line[i] === '/' && !cls) break
      }
      prev = '/'
      word = ''
    } else if (c && line.startsWith('/*', i)) {
      mode = '*/'
      i++
    } else if (py && (line.startsWith('"""', i) || line.startsWith("'''", i))) {
      mode = line.slice(i, i + 3)
      i += 2
    } else if ((js || go) && ch === '`') mode = '`'
    else if (ch === '"' || ch === "'") q = ch
    else if (ch.trim()) {
      word = /\w/.test(ch) ? (/\w/.test(line[i - 1] ?? '') ? word + ch : ch) : ''
      // `a++ / 2` divides: a ++ or -- ends a value, as ")" does.
      prev = (ch === '+' || ch === '-') && line[i - 1] === ch ? ')' : ch
    }
  }
  while (s < stops.length) at.push(comment ? 1 : q ? 2 : kindOf(mode)), s++
  return { mode, at }
}

// Soft-wraps one line to `width` cells, at the last space that leaves the row at least half full, else mid-word.
// Continuation rows are indented past the line's own indent, so code keeps its shape; `at` is each row's offset.
const wrapLine = (line: string, width: number, cap = Infinity) => {
  // A line of one-cell characters (most are) is wrapped on string offsets, skipping the per-character walk that a
  // 4 MiB log feels on every resize.
  const narrow = !/[\u0300-\u036f\u1100-\uffff]/.test(line)
  if (narrow && line.length <= width) return [{ at: 0, text: line }]
  const chars = narrow ? line.split('') : units(line)
  const lead = line.length - line.trimStart().length
  const pad = ' '.repeat(Math.min(lead + 2, Math.floor(width / 2)))
  const rows: { at: number; text: string }[] = []
  let start = 0
  let offset = 0
  while (start < chars.length || rows.length === 0) {
    const room = rows.length ? width - pad.length : width
    let end = start
    let used = 0
    if (narrow) end = Math.min(chars.length, start + room)
    else while (end < chars.length && used + textCells(chars[end]!) <= room) used += textCells(chars[end++]!)
    if (end === start && end < chars.length) end++
    if (end < chars.length) {
      for (let k = end - 1; k > start + (end - start) / 2; k--) {
        if (chars[k] === ' ') {
          end = k + 1
          break
        }
      }
    }
    const piece = chars.slice(start, end).join('')
    rows.push({ at: offset, text: (rows.length ? pad : '') + piece })
    offset += piece.length
    start = end
    if (start >= chars.length || rows.length > cap) break
  }
  return rows
}

const layoutText = (made: Loaded, width: number): TextRow[] => {
  const out: TextRow[] = []
  made.lines.forEach((line, k) => {
    const parts = wrapLine(line, width)
    const mode = made.modes[k] ?? ''
    // A line with no quote, slash, star or hash keeps its starting mode throughout, so it needs no scan.
    const plain = !/["'`/*#\\]/.test(line)
    const later = parts.length < 2 ? [] : plain ? parts.map(() => kindOf(mode)) : scan(line, mode, made.ext, parts.slice(1).map(p => p.at)).at
    parts.forEach((p, j) =>
      // Code drops empty lines, so a blank one is drawn as a space and keeps its row.
      out.push({ line: k, at: p.at, n: made.gutter && j === 0 ? k + 1 : 0, text: p.text || ' ', kind: j ? later[j - 1] ?? 0 : kindOf(mode) }),
    )
  })
  return out
}
// Whether a file takes more than `limit` rows at `width`, without laying all of it out: each line is a row at least, and
// a line of one-cell characters ceil(length / width) of them, so only text that might fit is wrapped, and only until it
// no longer does. Laying out a second width for this cost a minified file a full layout per wheel tick.
const talls = new Map<string, boolean>()
const overflows = (made: Loaded, width: number, limit: number, sig: string) => {
  const key = `${sig}|${width}|${limit}`
  let got = talls.get(key)
  if (got === undefined) {
    let n = made.lines.length
    if (n <= limit) {
      n = 0
      for (const line of made.lines) n += /[\u0300-\u036f\u1100-\uffff]/.test(line) ? 1 : Math.max(1, Math.ceil(line.length / width))
    }
    if (n <= limit) {
      n = 0
      for (const line of made.lines) if ((n += wrapLine(line, width, limit - n).length) > limit) break
    }
    got = n > limit
    remember(talls, key, got, 16)
  }
  return got
}
const remember = <V,>(map: Map<string, V>, key: string, value: V, max: number) => {
  map.delete(key)
  map.set(key, value)
  for (const old of map.keys()) {
    if (map.size <= max) break
    map.delete(old)
  }
}

const human = (n: number) =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`

const LANG: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', ts: 'typescript', tsx: 'tsx', jsx: 'jsx',
  json: 'json', css: 'css', html: 'html', md: 'markdown', py: 'python',
  sh: 'bash', command: 'bash', yml: 'yaml', yaml: 'yaml', toml: 'toml',
}
const ext = (name: string) => name.split('.').pop()?.toLowerCase() ?? ''
// Colour says what a file is for, as ls and eza do; source and docs stay plain, and blue is the selection background.
const TINT: Record<string, string> = {}
const tint = (color: string, list: string) => list.split(' ').forEach(x => (TINT[x] = color))
tint('magenta', 'png jpg jpeg gif bmp tiff webp heic svg mp4 mov m4v avi mkv webm mp3 wav flac aac m4a ogg')
tint('green', 'sh command bash zsh')
tint('yellow', 'json yaml yml toml ini env plist lock')
tint('red', 'zip gz tar tgz 7z rar dmg iso')

// Text and Code refuse every control character but tab and newline, and an unpaired surrogate draws as U+FFFD.
const clean = (s: string) =>
  s
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, c => {
      const n = c.charCodeAt(0)
      return n <= 0x1f ? String.fromCharCode(0x2400 + n) : n === 0x7f ? '␡' : '�'
    })
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '�')
// A name is one line, so tab and newline are symbols too.
const cleanName = (s: string) => clean(s).replace(/[\t\n]/g, c => (c === '\t' ? '␉' : '␊'))

// The terminal has no width API here; wide (CJK, emoji) cells take two columns and combining marks none.
const WIDE: [number, number][] = [
  [0x1100, 0x115f], [0x2e80, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6],
  // Emoji that default to emoji presentation; the rest of 0x2600-0x27bf stays one cell.
  [0x231a, 0x231b], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3], [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653],
  [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce],
  [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705],
  [0x270a, 0x270b], [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55],
  [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a], [0x1f200, 0x1f251], [0x1f300, 0x1faff], [0x20000, 0x3fffd],
]
// U+FE0F asks for the emoji form, two cells wide, so it adds the cell its one-cell base (❤, ✔) lacks.
const cells = (cp: number) =>
  cp === 0xfe0f
    ? 1
    : (cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0e)
    ? 0
    : cp >= 0x1100 && WIDE.some(([lo, hi]) => cp >= lo && cp <= hi)
      ? 2
      : 1

const textCells = (text: string) => Array.from(text).reduce((n, ch) => n + cells(ch.codePointAt(0)!), 0)
// Code points, with a U+FE0F kept on its base, so no wrap or cut parts ❤ from the selector that makes it an emoji.
const units = (text: string) => {
  const out: string[] = []
  for (const ch of text) {
    if (ch === '\ufe0f' && out.length) out[out.length - 1] += ch
    else out.push(ch)
  }
  return out
}

// Hard-wraps by display cells so every item's row count is known before it is drawn.
const chunk = (text: string, width: number) => {
  const w = Math.max(1, width)
  const out: string[] = []
  let line = ''
  let used = 0
  for (const ch of units(text)) {
    const c = textCells(ch)
    if (used + c > w && line) {
      out.push(line)
      line = ''
      used = 0
    }
    line += ch
    used += c
  }
  out.push(line)
  return out
}
const fit = (text: string, width: number) => {
  const kept: [string, number][] = []
  let used = 0
  for (const ch of units(text)) {
    const c = textCells(ch)
    if (used + c > width) {
      // Drop back until the ellipsis fits: a dropped combining mark frees no cell.
      while (kept.length && used + 1 > width) used -= kept.pop()![1]
      return kept.map(k => k[0]).join('') + '…'
    }
    kept.push([ch, c])
    used += c
  }
  return text
}
// The first n of a wrapped text's lines, the last marked as cut when lines were left over.
const clip = (lines: string[], n: number, width: number) =>
  lines.length <= n ? lines : n <= 0 ? [] : [...lines.slice(0, n - 1), fit(`${lines[n - 1]} …`, width)]

// encodeURIComponent is one-to-one and free of control characters, so two names never share a key or collide with a button's.
// It throws on a lone surrogate, so those are spelled U+FFFE plus four hex digits first; a U+FFFE in the name is
// spelled the same way, so no spelling can equal another name.
const rowKey = (path: string) =>
  `r:${encodeURIComponent(path.replace(/\ufffe|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, c => `\ufffe${c.charCodeAt(0).toString(16).padStart(4, '0')}`))}`

// The engine wraps an OS refusal in its own prefix and sets no `code`; the errno is the E-token in the message.
const errno = (err: unknown) => {
  const e = err as { code?: string; message?: string }
  const msg = String(e?.code ?? e?.message ?? '')
  return msg.match(/\bE[A-Z0-9]{3,}\b[^,'()\n]*/)?.[0] ?? ''
}

// Image work runs beside the renders, not in one: a render waiting on sips held every other render and press
// behind it. The box says "measuring…" until the work lands and a tick redraws.
const imaging = new Set<string>()
const measure = ($: any, key: string, arg: string, withPng: boolean) => {
  if (imaging.has(key)) return
  imaging.add(key)
  void (async () => {
    if (!sizes.has(key)) {
      const out = await $.process.run(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', arg], { timeoutMs: 5000 }).catch(() => undefined)
      const w = Number(out?.stdout.match(/pixelWidth:\s*(\d+)/)?.[1])
      const h = Number(out?.stdout.match(/pixelHeight:\s*(\d+)/)?.[1])
      remember(sizes, key, w && h ? { w, h } : null, 256)
    }
    // Real pixels via the terminal's own image support; sips makes a PNG, shrunk until it fits the 2 MiB the Image takes.
    if (withPng && sizes.get(key) && !pngs.has(key)) {
      let b64: string | null = null
      const dir = (await $.process.run(['mktemp', '-d']).catch(() => undefined))?.stdout.trim()
      if (dir) {
        for (const edge of [900, 600, 400, 256, 128]) {
          const out = `${dir}/p.png`
          await $.process.run(['sips', '-s', 'format', 'png', '-Z', String(edge), arg, '--out', out], { timeoutMs: 10000 }).catch(() => undefined)
          const raw = await $.fs.read(out, { as: 'bytes' }).catch(() => undefined)
          if (raw && typeof raw !== 'string' && (raw.base64.length * 3) / 4 <= IMAGE_MAX) {
            b64 = raw.base64
            break
          }
        }
        await $.process.run(['rm', '-rf', dir]).catch(() => undefined)
      }
      remember(pngs, key, b64, 8)
    }
  })()
    .catch(() => undefined)
    .finally(() => {
      imaging.delete(key)
      void update($, tick, (n: number) => n + 1).catch(() => undefined)
    })
}

const pathOf = (key: string) =>
  key.startsWith('r:') ? decodeURIComponent(key.slice(2)).replace(/\ufffe([0-9a-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))) : undefined

type Row = { path: string; name: string; depth: number; isDir: boolean; lines: string[]; width: number }
type Stat = { kind: 'file' | 'dir' | 'other'; size: number; mtimeMs: number; isLink: boolean; realPath?: string }

// Focus calls run in order and each names the cursor as it is by then, so a burst of wheel ticks ends on the last row.
// A ring move that came first denies one; it is tried again, since Enter presses whatever holds the ring.
let focusing: Promise<unknown> = Promise.resolve()
// The key is read when the move runs, from the mode as it is by then, so a move queued before a Tab never undoes it.
const focusCursor = ($: any) => {
  focusing = focusing
    .then(async () => {
      for (let i = 0; i < 3; i++) if (!(await $.ui.focus({ requestId: PANE, key: inPreview ? 'close-preview' : rowKey(at) }))?.deny) break
    })
    .catch(() => undefined)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'tree', description: 'Show the project file tree in a pane' })
    void $.ui.open({ id: PANE, title: 'Files', columns: DOCK_COLUMNS })
    // The pane takes the keys only through ctrl+x Tab; naming it where the prompt is makes it findable.
    $.ui.status('files: ctrl+x Tab to enter, Esc to return')
    return next(e)
  })

  on('command.run', { command: 'tree' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Files', columns: DOCK_COLUMNS })
    return { text: 'File tree opened.' }
  })

  // The engine scrolls a focused pane with the arrows; taking the move here lets them walk the rows instead.
  on('ui.scroll', { requestId: PANE }, async ($, e, next) => {
    // The plugin's own scroll (back to the top after a resize) moves the window as asked; the test kit hands it
    // over with no origin.
    if (e.origin?.kind !== 'person') return next(e)
    // Two surfaces of one height that disagree about the row under the pointer walk the tree: the event names
    // no surface, and walking the cursor is the move that can't scroll a preview the person isn't looking at.
    const fits = [...geos.values()].filter(x => x.bodyRows === e.bodyRows)
    const g = fits.every(x => x.previewFrom === fits[0]?.previewFrom) ? fits[0] : undefined
    // Home and End ask for contentRows, which the padding keeps near bodyRows, far short of a long list's ends.
    const ends = !e.pointer && Math.abs(e.by) >= e.contentRows
    const paging = !e.pointer && !ends && Math.abs(e.by) === e.bodyRows
    // The preview scrolls (on every surface it could be) under a wheel over the box, under the page keys while a text
    // preview is open, and under every key and wheel once Tab has put the keys in it; elsewhere the cursor walks the tree.
    const text = !!g && g.page > 0
    if ((g && e.pointer && e.pointer.row >= g.previewFrom) || (text && (inPreview || paging))) {
      for (const x of fits) {
        const step = ends ? Math.sign(e.by) * x.pMax : paging ? Math.sign(e.by) * Math.max(1, x.page - 1) : e.by
        x.pTop = Math.max(0, Math.min(x.pMax, x.pTop + step))
      }
      await update($, tick, n => n + 1).catch(() => undefined)
      // Back from Esc the pane draws no ring until something moves it, and Enter would press nothing.
      if (inPreview && !e.pointer) focusCursor($)
      return {}
    }
    if (order.length === 0) return {}
    const from = Math.max(0, order.indexOf(at))
    const to = ends ? (e.by > 0 ? order.length - 1 : 0) : from + e.by
    at = order[Math.min(order.length - 1, Math.max(0, to))] ?? at
    await update($, cursor, () => at).catch(() => undefined)
    focusCursor($)
    return {}
  })

  // Tab and clicks move the engine's focus ring; the cursor follows it onto a row, so Enter and › agree.
  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    const el = e.element ?? ''
    const into = (yes: boolean) => {
      if (inPreview === yes) return
      inPreview = yes
      void update($, tick, n => n + 1).catch(() => undefined)
    }
    // The plugin's own moves say where the keys are: on the title in the preview, on a row in the tree.
    if (e.origin.kind !== 'person') {
      const r = await next(e)
      if (!r.deny) into(el === 'close-preview')
      return r
    }
    // The ring moves by Tab here (a click presses without moving it), so every move from the tree goes into a
    // preview that scrolls, and every move from the title goes back. A move to one of the engine's stops cannot be
    // sent elsewhere (next() refuses an element there), so it is kept from happening and the ring goes back itself.
    if (inPreview && !e.element) {
      into(false)
      focusCursor($)
      return {}
    }
    if ((!inPreview && scrollable && (isPreviewKey(el) || pathOf(el) !== undefined)) || (inPreview && el !== 'close-preview')) {
      // Switched before the move lands: an arrow handled while next() is pending would act in the old mode.
      const entering = !inPreview
      into(entering)
      const r = await next({ ...e, element: entering ? 'close-preview' : rowKey(at) })
      if (r.deny) into(!entering)
      return r
    }
    const r = await next(e)
    const path = pathOf(el)
    if (!r.deny && path !== undefined && path !== at && order.includes(path)) {
      at = path
      await update($, cursor, () => at).catch(() => undefined)
    }
    return r
  })

  // Redraw after any tool that can add, rename or delete files.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    await update($, tick, n => n + 1).catch(() => undefined)
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) => {
    const turn = drawing.then(() => draw())
    drawing = turn.catch(() => undefined)
    return turn

    async function draw() {
      const { Box, Text, Button, Code, Image } = $.ui.resolve(e) as ReturnType<typeof $.ui.resolve> & { Image?: any }
      const g: Geo = geos.get(e.surface) ?? { bodyRows: 0, top: 0, pTop: 0, pMax: 0, page: 0, previewFrom: Infinity }
      geos.set(e.surface, g)
      const open = new Set(await read($, expanded))
      const chosen = await read($, selected)
      // Read every time, so a cursor write redraws; adopted once, as a render reading it mid-burst of wheel
      // ticks sees the write before last and would pull the cursor back a row.
      const kept = await read($, cursor)
      if (!cursorRead) {
        cursorRead = true
        at = kept || at
      }
      await read($, tick)
      if (chosen !== shown) {
        shown = chosen
        for (const x of geos.values()) x.pTop = 0
      }

      // The pane's own body size, not the terminal's: a taller tree makes the engine scroll the window.
      const body = (e.props as { scroll?: { bodyRows?: number }; bodyColumns?: number }) ?? {}
      const bodyRows = Math.max(4, body.scroll?.bodyRows ?? (e.viewport?.rows ?? 24) - 4)
      const cols = Math.max(8, body.bodyColumns ?? e.viewport?.columns ?? 80)
      // Indent stops growing once the name would have under 8 cells left, so a deep folder stays readable.
      const maxDepth = Math.max(0, Math.floor((cols - 4 - 3 - 8) / 2))

      const rows: Row[] = []
      const walk = async (dir: string, depth: number) => {
        const entries = await $.fs.list(dir || undefined).catch(() => [])
        const kept = entries.filter(x => !SKIP.has(x.name))
        // A link is `other` in the listing; one that leads to a folder is walked as a folder.
        const dirs = new Set<string>()
        for (const x of kept) {
          if (x.kind === 'dir') dirs.add(x.name)
          else if (x.isLink && (await $.fs.stat(dir ? `${dir}/${x.name}` : x.name).catch(() => undefined))?.kind === 'dir') dirs.add(x.name)
        }
        kept.sort((a, b) => {
          const da = dirs.has(a.name)
          const db = dirs.has(b.name)
          return da === db ? a.name.localeCompare(b.name) : da ? -1 : 1
        })
        for (const x of kept) {
          const path = dir ? `${dir}/${x.name}` : x.name
          const isDir = dirs.has(x.name)
          // Cells before the name: the marker, the indent and the glyph; "[ " and " ]" take four more.
          const lead = 1 + 2 * Math.min(depth, maxDepth) + 2
          rows.push({ path, name: x.name, depth, isDir, lines: chunk(cleanName(x.name), cols - 4 - lead), width: cols - 4 - lead })
          if (isDir && open.has(path)) await walk(path, depth + 1)
        }
      }
      await walk('', 0)
      const before = order
      order = rows.map(r => r.path)

      // A file deleted under the cursor leaves it on the next (or previous) sibling; with none, on its folder.
      // A deleted folder passes the same question up: its siblings, then its own folder.
      const parent = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf('/')))
      for (let c = at; c && !order.includes(at); c = parent(c)) {
        const i = before.indexOf(c)
        const near = i < 0 ? undefined : [...before.slice(i + 1), ...before.slice(0, i).reverse()].find(p => order.includes(p) && parent(p) === parent(c))
        at = near ?? parent(c)
      }
      if (!order.includes(at)) at = order[0] ?? ''

      // A press on a row puts the cursor and the keys there; a click next to the cursor was first taken for Tab.
      const pick = (path: string) => {
        at = path
        inPreview = false
        void update($, cursor, () => path)
        focusCursor($)
      }
      const toggle = (path: string) =>
        update($, expanded, list =>
          list.includes(path) ? list.filter(p => p !== path) : [...list, path],
        )

      // Under 14 columns a box's buttons cannot fit on one line, so the selection shows in the tree alone.
      const boxed = !!chosen && cols >= 14
      // "[ " and " ]" around a label inside the border and padding: cols - 8 cells for it.
      const revealLabel = cols - 8 >= 20 ? 'Show in file manager' : 'Show'

      let st: Stat | undefined
      let statErr = ''
      if (boxed) {
        try {
          st = await $.fs.stat(chosen, { resolve: true })
        } catch {
          // realpath can fail where a plain stat still answers, so ask again without it before giving up.
          try {
            st = await $.fs.stat(chosen)
          } catch (err) {
            statErr = errno(err)
          }
        }
      }
      // Only a regular file reaches sips; a pipe named .png would block it until the 30 s timeout.
      const isImage = IMAGE.has(ext(chosen)) && st?.kind === 'file'
      const real = st?.realPath ?? chosen
      // A relative name starting with a dash would read as an option to sips, open and xdg-open.
      const arg = real.startsWith('-') ? `./${real}` : real
      const imgKey = `${chosen}|${st?.mtimeMs}|${st?.size}`
      if (boxed && isImage && st && (!sizes.has(imgKey) || (Image && sizes.get(imgKey) && !pngs.has(imgKey)))) measure($, imgKey, arg, !!Image)
      const dim = sizes.get(imgKey)
      const png = pngs.get(imgKey)

      // What the box holds: the file's lines wrapped to the box, or (opaque) the reason no preview is drawn.
      let made: Loaded = { lines: [], modes: [], ext: '', opaque: '', cut: false, gutter: false }
      const sig = `${chosen}|${st?.mtimeMs}|${st?.size}|${statErr}`
      if (boxed && !isImage) {
        made = loaded.get(sig) ?? (await loadText($, chosen, st, statErr))
        // A refusal is asked again each time: a chmod changes neither mtime nor size.
        if (!made.opaque.startsWith('Cannot read')) remember(loaded, sig, made, 2)
      }
      const opaque = made.opaque
      const text = boxed && !isImage && !opaque

      // Under 12 rows the hint keeps to one line, and under 6 it gives its row to the tree.
      const hintOf = (keys: string) => {
        const hint = `${order.indexOf(at) + 1}/${rows.length} · ${keys}`
        return bodyRows >= 12 ? chunk(hint, cols - 1) : bodyRows >= 6 ? [fit(hint, cols - 1)] : []
      }
      const plainKeys = '↑↓ move · Enter open · Esc back'
      // The box is sized for the longest hint it may show; both text hints are 45 cells, so Tab between tree and
      // preview never changes the hint's rows and with them the box.
      const hintN = hintOf(text ? '↑↓ move · Enter open · Tab preview · Esc back' : plainKeys).length
      // The box takes up to 60% and leaves the tree three rows (one in a small pane); title and border are its least.
      const avail = bodyRows - hintN
      const maxBox = Math.max(3, Math.min(avail - (avail >= 10 ? 3 : 1), Math.max(4, Math.floor(bodyRows * 0.6))))

      // Line numbers take the gutter; the rest of the box's inner width (cols - 4) holds the wrapped rows, less a
      // column for the scrollbar when the file is taller than the box.
      const gutterW = made.gutter ? String(made.lines.length).length + 1 : 0
      const fullW = Math.max(1, cols - 4 - gutterW)
      // A text taller than the box has these rows of it in view (the footer takes one), and in a tiny pane none.
      const tallRoom = maxBox - 3 - (maxBox >= 6 && cols >= 20 ? 1 : 0)
      const tall = text && tallRoom > 0 && overflows(made, fullW, maxBox - 3, sig)
      // The bar needs three cells to say top, middle and end, and a desktop draws each plain Button as a native button.
      const bar = tall && fullW > 1 && tallRoom >= 3 && e.surface === 'terminal'
      const lineW = bar ? fullW - 1 : fullW
      const wrapKey = `${sig}|${lineW}`
      const textRows = wraps.get(wrapKey) ?? layoutText(made, lineW)
      if (made.lines.length) remember(wraps, wrapKey, textRows, 2)
      // A surface too narrow for a box leaves the mode to the one showing it.
      // Each surface says whether its own box scrolls; one too narrow for a box leaves its last word.
      if (boxed || !chosen) g.tall = tall
      scrollable = [...geos.values()].some(x => x.tall)
      if (!scrollable) inPreview = false
      const keys = !tall ? plainKeys : inPreview ? '↑↓ scroll · Enter close · Tab tree · Esc back' : '↑↓ move · Enter open · Tab preview · Esc back'
      const hintRows = hintOf(keys)
      while (hintRows.length < hintN) hintRows.push(' ')

      const pathRows = chunk(cleanName(real), cols - 6)
      const headline = `${isImage ? (dim ? `${dim.w} × ${dim.h} px` : imaging.has(imgKey) ? 'measuring…' : 'size unknown') : opaque}${st && st.kind === 'file' ? `  ·  ${human(st.size)}` : ''}`
      const headRows = chunk(headline, cols - 6)
      const imgCols = Math.max(8, Math.min(80, cols - 6))
      const drawImg = !!(isImage && dim && png && Image)
      // Every row counted here is drawn, so the body stays bodyRows + 1 tall, as the arrow keys need.
      // Past border and title the box fills in order: the headline's first line (why there is no preview), the two
      // buttons, the rest of the headline, the path, the picture.
      let room = maxBox - 3
      const head1 = Math.min(1, room)
      room -= head1
      const buttons = Math.min(2, room)
      room -= buttons
      const headShown = clip(headRows, head1 + room, cols - 6)
      room -= headShown.length - head1
      const pathShown = clip(pathRows, room, cols - 6)
      room -= pathShown.length
      const imgRows = drawImg && dim ? Math.min(room, 255, Math.max(1, Math.round((imgCols * dim.h) / dim.w / 2))) : 0
      const textBox = Math.min(maxBox, textRows.length + 3)
      const boxRows = !boxed ? 0 : isImage || opaque ? 3 + buttons + headShown.length + pathShown.length + imgRows : textBox
      // A long text gets a footer row for the jump buttons: a wheel tick moves a few rows, too slow to cross a big file.
      const footer = !isImage && !opaque && (textRows.length > boxRows - 3 || made.cut) && boxRows >= 6 && cols >= 20
      const previewRoom = Math.max(0, boxRows - 3 - (footer ? 1 : 0))
      const pMax = Math.max(0, textRows.length - previewRoom)
      // Rows are per width, so after a resize the window starts on the row now holding the place it showed before.
      const a = g.anchor
      const moved = !!a && a.sig === sig && a.width !== lineW
      // The last row that starts at or before the anchored place.
      const after = !moved ? -1 : textRows.findIndex(r => r.line > a.line || (r.line === a.line && r.at > a.at))
      const pTop = Math.min(moved ? Math.max(0, (after < 0 ? textRows.length : after) - 1) : g.pTop, pMax)

      // The tree takes whatever the box leaves, so a short preview sits at the bottom and a long one grows upward.
      const treeRoom = Math.max(1, bodyRows - hintRows.length - boxRows)
      let top = g.top

      // Keep the cursor inside the window; rows may be several cells tall, so the window counts cells.
      const idx = Math.max(0, order.indexOf(at))
      const cum: number[] = [0]
      for (const r of rows) cum.push((cum[cum.length - 1] ?? 0) + r.lines.length)
      const span = (a: number, b: number) => (cum[b + 1] ?? 0) - (cum[a] ?? 0)
      if (idx < top) top = idx
      top = Math.min(top, Math.max(0, rows.length - 1))
      while (top < idx && span(top, idx) > treeRoom) top++
      while (top > 0 && span(top - 1, rows.length - 1) <= treeRoom) top--
      const shownRows: Row[] = []
      let used = 0
      for (const r of rows.slice(top)) {
        if (used + r.lines.length > treeRoom && shownRows.length) break
        // A row taller than the whole window keeps the lines that fit.
        const lines = clip(r.lines, treeRoom - used, r.width)
        shownRows.push({ ...r, lines })
        used += lines.length
      }
      // A pane resized while open can keep the engine's window offset, with the hint scrolled off the top.
      if (g.bodyRows && g.bodyRows !== bodyRows) void $.ui.scroll({ in: PANE, to: 'start' }).catch(() => undefined)
      const topRow = textRows[pTop]
      g.anchor = topRow ? { sig, width: lineW, line: topRow.line, at: topRow.at } : undefined
      Object.assign(g, { bodyRows, top, pTop, pMax, page: !isImage && !opaque ? previewRoom : 0, previewFrom: boxed ? hintRows.length + treeRoom : Infinity })

      // The close button unmounts with the box and the engine hands its focus to whichever row now sits there; put it back on the cursor.
      const closePreview = async () => {
        inPreview = false
        await update($, selected, () => '')
        focusCursor($)
      }

      const launch = async (tries: string[][], done: string, fail: string) => {
        for (const argv of tries) {
          const r = await $.process.run(argv).catch(() => undefined)
          // explorer reports 1 on success.
          if (r && (r.exitCode === 0 || argv[0] === 'explorer')) return $.ui.toast(done)
        }
        $.ui.toast(fail)
      }
      const reveal = () =>
        launch(
          [['open', '-R', arg], ['xdg-open', real.includes('/') ? real.slice(0, real.lastIndexOf('/')) || '/' : '.'], ['explorer', `/select,${real}`]],
          'Shown in your file manager',
          'Could not open a file manager',
        )
      const openDefault = () =>
        // Not `cmd /c start`: cmd parses the name again, and a file named `a&calc` would run calc.
        launch([['open', arg], ['xdg-open', arg], ['explorer', real]], 'Opened', 'No app could open this file')

      // The range names file lines, though the window moves by drawn rows.
      const lastRow = textRows[Math.min(textRows.length, pTop + previewRoom) - 1]
      const shownRange = `${(textRows[pTop]?.line ?? 0) + 1}-${(lastRow?.line ?? 0) + 1}/${made.lines.length}`
      const rangeW = Math.max(1, cols - 6 - 12)
      // A file past 4 MiB says so in the footer, in the long words where they fit.
      const range = fit(!made.cut ? shownRange : textCells(`${shownRange} · cut at 4 MiB`) <= rangeW ? `${shownRange} · cut at 4 MiB` : `${shownRange} · cut`, rangeW)
      // Each run of rows of one kind: code through Code, comment and string interiors plain.
      const runs: { kind: Kind; from: number; rows: TextRow[] }[] = []
      for (const row of textRows.slice(pTop, pTop + previewRoom)) {
        const last = runs[runs.length - 1]
        if (last && last.kind === row.kind) last.rows.push(row)
        else runs.push({ kind: row.kind, from: runs.reduce((n, r) => n + r.rows.length, pTop), rows: [row] })
      }
      // A press on the scrollbar or a jump button scrolls there and puts the keys in the preview, as Tab does.
      const jump = async (to: number) => {
        g.pTop = to
        inPreview = true
        await update($, tick, n => n + 1)
        // Refused while the pane does not hold the keys: then there are none to put in the preview.
        const r = await $.ui.focus({ requestId: PANE, key: 'close-preview' }).catch(() => undefined)
        if (r?.deny && inPreview) {
          inPreview = false
          await update($, tick, n => n + 1)
        }
      }
      // The thumb's length is the share of the file in view, its place the share above it; a cell pressed opens the file
      // that far down.
      const thumb = Math.max(1, Math.round((previewRoom * previewRoom) / Math.max(1, textRows.length)))
      // Rounded down, and a press rounded up, so the thumb takes the last cell only at the end and sits on the cell pressed.
      // Products before quotients: 15 / 22 * 330 is 224.99999999999997, and the thumb lit the cell above.
      const thumbAt = pMax ? Math.floor((pTop * (previewRoom - thumb)) / pMax) : 0
      const cellTo = (i: number) => Math.ceil((i * pMax) / Math.max(1, previewRoom - 1))
      // The title button's label gets cols - 8 cells: the title, a space, then "(press to close)" (16), which a narrow
      // box drops before the title would wrap.
      const closeHint = cols - 9 - 16 >= 6
      // With no footer to say so, a file cut at 4 MiB says it in the title.
      const titleW = cols - 9 - (closeHint ? 16 : 0)
      const cutMark = made.cut && !footer && titleW - 6 >= 1 ? ' · cut' : ''
      const title = fit(cleanName(chosen), Math.max(1, titleW - cutMark.length)) + cutMark

      return (
        <Box flexDirection="column">
          {hintRows.length > 0 && <Text dimColor>{hintRows.join('\n')}</Text>}
          <Box flexDirection="column">
            {shownRows.map(r => {
              const pad = '│ '.repeat(Math.min(r.depth, maxDepth))
              // The engine inverts whatever row rests under the pointer, so the cursor row also underlines to stay distinct from it.
              const here = r.path === at
              const glyph = r.isDir ? (open.has(r.path) ? '▾ ' : '▸ ') : '· '
              const indent = ' '.repeat(1 + pad.length + glyph.length)
              const name = r.lines.map((l, i) => (i ? indent + l : l)).join('\n')
              return r.isDir ? (
                <Button key={rowKey(r.path)} onPress={() => { pick(r.path); toggle(r.path) }}>
                  <Text dimColor>{here ? '›' : ' '}{pad}</Text>
                  <Text color="cyan" weight="bold" underline={here}>
                    {glyph}
                    {name}
                  </Text>
                </Button>
              ) : (
                <Button key={rowKey(r.path)} onPress={() => { pick(r.path); void update($, selected, () => r.path) }}>
                  <Text dimColor>{here ? '›' : ' '}{pad}</Text>
                  <Text
                    color={r.path === chosen ? 'white' : TINT[ext(r.name)]}
                    dimColor={r.name.startsWith('.') && r.path !== chosen}
                    backgroundColor={r.path === chosen ? 'blue' : undefined}
                    underline={here}
                  >
                    {glyph}
                    {name}
                  </Text>
                </Button>
              )
            })}
            {/* Padding keeps the body one row taller than the pane, so arrow keys always reach the ui.scroll hook. */}
            {Array.from({ length: Math.max(0, treeRoom - used) }, (_, i) => <Text key={`pad-${i}`}> </Text>)}
          </Box>
          {boxed && (
            <Box flexDirection="column" borderStyle="round" paddingX={1}>
              <Button key="close-preview" onPress={() => closePreview()}>
                <Text weight="bold">{title} </Text>
                {closeHint && <Text dimColor>(press to close)</Text>}
              </Button>
              {isImage || opaque ? (
                <Box flexDirection="column">
                  {headShown.length > 0 && <Text>{headShown.join('\n')}</Text>}
                  {pathShown.length > 0 && <Text dimColor>{pathShown.join('\n')}</Text>}
                  {imgRows > 0 && (
                    // Where the terminal cannot draw pictures the engine draws the alt on one line; the height keeps the rest.
                    <Box height={imgRows} flexShrink={0}>
                      <Image
                        source={{ png }}
                        columns={imgCols}
                        rows={imgRows}
                        alt="(your terminal cannot draw images here)"
                      />
                    </Box>
                  )}
                  {buttons >= 1 && (
                    <Button key="open-default" onPress={() => void openDefault()}>
                      <Text color="cyan">Open</Text>
                    </Button>
                  )}
                  {buttons >= 2 && (
                    <Button key="reveal" onPress={() => void reveal()}>
                      <Text color="cyan">{revealLabel}</Text>
                    </Button>
                  )}
                </Box>
              ) : previewRoom > 0 && (
                <Box flexDirection="row">
                  {gutterW > 0 && (
                    <Text dimColor>
                      {runs.flatMap(r => r.rows.map(x => `${x.n ? String(x.n) : ''}`.padStart(gutterW - 1) + ' ')).join('\n')}
                    </Text>
                  )}
                  <Box flexDirection="column" width={lineW}>
                    {runs.map(r =>
                      r.kind === 0 ? (
                        <Code
                          key={`run-${r.from}`}
                          source={r.rows.map(x => x.text).join('\n')}
                          language={LANG[ext(chosen)]}
                          path={cleanName(chosen)}
                          wrap="truncate-end"
                        />
                      ) : (
                        <Text key={`run-${r.from}`} dimColor={r.kind === 1}>
                          {r.rows.map(x => x.text).join('\n')}
                        </Text>
                      ),
                    )}
                  </Box>
                  {bar && (
                    <Box flexDirection="column" width={1}>
                      {Array.from({ length: previewRoom }, (_, i) => {
                        const lit = i >= thumbAt && i < thumbAt + thumb
                        return <Button key={`sb-${i}`} plain label={lit ? '█' : '│'} dimColor={!lit} onPress={() => void jump(cellTo(i))} />
                      })}
                    </Box>
                  )}
                </Box>
              )}
              {footer && (
                <Box flexDirection="row">
                  <Button key="jump-top" onPress={() => void jump(0)}>
                    <Text color="cyan">⇱</Text>
                  </Button>
                  <Button key="jump-end" onPress={() => void jump(pMax)}>
                    <Text color="cyan">⇲</Text>
                  </Button>
                  <Text dimColor> {range}</Text>
                </Box>
              )}
            </Box>
          )}
          <Text> </Text>
        </Box>
      )
    }
  })
}

// Reads one file for the box: wrapped rows, or the reason it has none. Never reads a pipe or device, which can block.
async function loadText($: any, path: string, st: Stat | undefined, statErr: string): Promise<Loaded> {
  const none = (opaque: string): Loaded => ({ lines: [], modes: [], ext: '', opaque, cut: false, gutter: false })
  if (!st) return none(statErr.startsWith('ENOENT') ? 'File not found' : statErr ? `Cannot read this file (${clean(statErr)})` : 'Cannot read this file')
  if (st.kind !== 'file') return none(st.isLink && !st.realPath ? 'Broken link' : 'Not a regular file')
  if (OPAQUE.has(ext(path))) return none('No preview in the terminal')
  if (st.size === 0) return { lines: ['(empty file)'], modes: [''], ext: '', opaque: '', cut: false, gutter: false }
  let text: string | undefined
  let cut = false
  try {
    if (st.size <= READ_MAX) text = await $.fs.read(path)
    else {
      // fs.read refuses past 4 MiB; head hands back the first 4 MiB where it exists.
      const r = await $.process.run(['head', '-c', String(READ_MAX), '--', path])
      if (r.exitCode === 0) {
        text = r.stdout
        cut = true
      }
    }
  } catch (err) {
    const os = errno(err)
    return none(os ? `Cannot read this file (${clean(os)})` : 'Cannot read this file')
  }
  if (text === undefined) return none('Too large to read here')
  if (text.includes('\0')) return none('Binary file')
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  const rows = lines.map(l => clean(l.replace(/\t/g, '  ')))
  const e = ext(path)
  const modes: string[] = []
  let mode = ''
  for (const line of rows) {
    modes.push(mode)
    mode = scan(line, mode, e).mode
  }
  return { lines: rows, modes, ext: e, opaque: '', cut, gutter: true }
}
