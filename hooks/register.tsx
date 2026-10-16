import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

const PANE = 'file-tree'
const SKIP = new Set(['.git', 'node_modules', '.DS_Store'])
const expanded = atom({ plugin: 'file-tree', key: 'expanded' } as const, [] as string[])
const tick = atom({ plugin: 'file-tree', key: 'tick' } as const, 0)
const selected = atom({ plugin: 'file-tree', key: 'selected' } as const, '')
const cursor = atom({ plugin: 'file-tree', key: 'cursor' } as const, '')
// Mirrors of what the last draw showed, so the ui.scroll hook can move the cursor without redrawing first.
let order: string[] = []
let at = ''
let top = 0
// Preview window: first visible row, its last offset, and the body row where the box starts (Infinity: no box).
let pTop = 0
let pMax = 0
let previewFrom = Infinity
let shown = ''

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
const sizes = new Map<string, { w: number; h: number } | null>()
const pngs = new Map<string, string | null>()
// The wrapped text of the previewed file, so a wheel tick slices rows instead of re-reading the file.
let loaded: { sig: string; rows: string[]; opaque: string } | undefined

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
const cells = (cp: number) =>
  (cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f)
    ? 0
    : cp >= 0x1100 && WIDE.some(([lo, hi]) => cp >= lo && cp <= hi)
      ? 2
      : 1

// Hard-wraps by display cells so every item's row count is known before it is drawn.
const chunk = (text: string, width: number) => {
  const w = Math.max(1, width)
  const out: string[] = []
  let line = ''
  let used = 0
  for (const ch of text) {
    const c = cells(ch.codePointAt(0)!)
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
  let out = ''
  let used = 0
  for (const ch of text) {
    const c = cells(ch.codePointAt(0)!)
    if (used + c > width) return Array.from(out).slice(0, -1).join('') + '…'
    out += ch
    used += c
  }
  return text
}

// encodeURIComponent is one-to-one and free of control characters, so two names never share a key or collide with a button's.
// A lone surrogate would make encodeURIComponent throw and take the whole render with it, so it is spelled out first.
const rowKey = (path: string) =>
  `r:${encodeURIComponent(path.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, c => `\ufffe${c.charCodeAt(0).toString(16)}`))}`

// The engine wraps an OS refusal in its own prefix and sets no `code`; the errno is the E-token in the message.
const errno = (err: unknown) => {
  const e = err as { code?: string; message?: string }
  const msg = String(e?.code ?? e?.message ?? '')
  return msg.match(/\bE[A-Z0-9]{3,}\b[^,'()\n]*/)?.[0] ?? ''
}

type Row = { path: string; name: string; depth: number; isDir: boolean; lines: string[] }
type Stat = { kind: 'file' | 'dir' | 'other'; size: number; mtimeMs: number; isLink: boolean; realPath?: string }

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'tree', description: 'Show the project file tree in a pane' })
    void $.ui.open({ id: PANE, title: 'Files' })
    // The pane takes the keys only through ctrl+x Tab; naming it where the prompt is makes it findable.
    $.ui.status('files: ctrl+x Tab to enter, Esc to return')
    return next(e)
  })

  on('command.run', { command: 'tree' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Files' })
    return { text: 'File tree opened.' }
  })

  // The engine scrolls a focused pane with the arrows; taking the move here lets them walk the rows instead.
  on('ui.scroll', { requestId: PANE }, async ($, e) => {
    // A wheel over the preview box scrolls the box; everywhere else it walks the tree.
    if (e.pointer && e.pointer.row >= previewFrom) {
      pTop = Math.max(0, Math.min(pMax, pTop + e.by))
      await update($, tick, n => n + 1)
      return {}
    }
    if (order.length === 0) return {}
    const from = Math.max(0, order.indexOf(at))
    at = order[Math.min(order.length - 1, Math.max(0, from + e.by))] ?? at
    await update($, cursor, () => at)
    void $.ui.focus({ requestId: PANE, key: rowKey(at) }).catch(() => undefined)
    return {}
  })

  // Redraw after any tool that can add, rename or delete files.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    await update($, tick, n => n + 1)
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Code, Image } = $.ui.resolve(e) as ReturnType<typeof $.ui.resolve> & { Image?: any }
    const open = new Set(await read($, expanded))
    const chosen = await read($, selected)
    at = (await read($, cursor)) || at
    await read($, tick)
    if (chosen !== shown) {
      shown = chosen
      pTop = 0
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
        rows.push({ path, name: x.name, depth, isDir, lines: chunk(cleanName(x.name), cols - 4 - lead) })
        if (isDir && open.has(path)) await walk(path, depth + 1)
      }
    }
    await walk('', 0)
    order = rows.map(r => r.path)

    // A folder collapsed or a file deleted under the cursor leaves it on its nearest row that still exists.
    while (at && !order.includes(at)) at = at.includes('/') ? at.slice(0, at.lastIndexOf('/')) : ''

    const toggle = (path: string) =>
      update($, expanded, list =>
        list.includes(path) ? list.filter(p => p !== path) : [...list, path],
      )

    const hintRows = chunk(`${order.length ? Math.max(0, order.indexOf(at)) + 1 : 0}/${rows.length} · ↑↓ move · Enter open · Tab also walks · Esc back`, cols - 1)
    // Title, one line and the border are the least a box can be; above that it takes up to 60% and leaves the tree three rows.
    const maxBox = Math.max(4, Math.min(Math.floor(bodyRows * 0.6), bodyRows - hintRows.length - 3))

    let st: Stat | undefined
    let statErr = ''
    if (chosen) {
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
    if (isImage && st && !sizes.has(chosen)) {
      const out = await $.process
        .run(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', real])
        .catch(() => undefined)
      const w = Number(out?.stdout.match(/pixelWidth:\s*(\d+)/)?.[1])
      const h = Number(out?.stdout.match(/pixelHeight:\s*(\d+)/)?.[1])
      sizes.set(chosen, w && h ? { w, h } : null)
    }
    const dim = sizes.get(chosen)

    // Real pixels via the terminal's own image support; sips makes a PNG, shrunk until it fits the 2 MiB the Image takes.
    if (isImage && dim && Image && !pngs.has(chosen)) {
      let b64: string | null = null
      const dir = (await $.process.run(['mktemp', '-d']).catch(() => undefined))?.stdout.trim()
      if (dir) {
        for (const edge of [900, 600, 400, 256, 128]) {
          const out = `${dir}/p.png`
          await $.process.run(['sips', '-s', 'format', 'png', '-Z', String(edge), real, '--out', out]).catch(() => undefined)
          const raw = await $.fs.read(out, { as: 'bytes' }).catch(() => undefined)
          if (raw && typeof raw !== 'string' && (raw.base64.length * 3) / 4 <= IMAGE_MAX) {
            b64 = raw.base64
            break
          }
        }
        await $.process.run(['rm', '-rf', dir]).catch(() => undefined)
      }
      pngs.set(chosen, b64)
    }
    const png = pngs.get(chosen)

    // What the box holds: wrapped text rows, or (opaque) the reason no preview is drawn.
    let textRows: string[] = []
    let opaque = ''
    if (chosen && !isImage) {
      const sig = `${cols}|${chosen}|${st?.mtimeMs}|${st?.size}|${statErr}`
      if (loaded?.sig !== sig) {
        const made = await loadText($, chosen, st, statErr, cols - 6)
        loaded = { sig, ...made }
      }
      textRows = loaded.rows
      opaque = loaded.opaque
    }

    const pathRows = chunk(cleanName(real), cols - 6)
    const headline = `${isImage ? (dim ? `${dim.w} × ${dim.h} px` : 'size unknown') : opaque}${st && st.kind === 'file' ? `  ·  ${human(st.size)}` : ''}`
    const headRows = chunk(headline, cols - 6)
    const imgCols = Math.max(8, Math.min(80, cols - 6))
    const drawImg = !!(isImage && dim && png && Image)
    // Border and title, headline and path rows, and the two buttons share the box with the picture.
    const chrome = 3 + headRows.length + pathRows.length + 2
    const imgRows = drawImg && dim ? Math.max(1, Math.min(maxBox - chrome, Math.round((imgCols * dim.h) / dim.w / 2))) : 0
    const boxRows = !chosen
      ? 0
      : isImage
        ? chrome + imgRows
        : opaque
          ? Math.min(maxBox, chrome + 1)
          : Math.min(maxBox, textRows.length + 3)
    // A long text gets a footer row for the jump buttons: a wheel tick moves a few rows, too slow to cross a big file.
    const footer = !isImage && !opaque && textRows.length > boxRows - 3 && boxRows >= 6
    const previewRoom = Math.max(1, boxRows - 3 - (footer ? 1 : 0))
    pMax = Math.max(0, textRows.length - previewRoom)
    pTop = Math.min(pTop, pMax)

    // The tree takes whatever the box leaves, so a short preview sits at the bottom and a long one grows upward.
    const treeRoom = Math.max(3, bodyRows - hintRows.length - boxRows)
    previewFrom = chosen ? hintRows.length + treeRoom : Infinity

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
      shownRows.push(r)
      used += r.lines.length
    }

    // The close button unmounts with the box and the engine hands its focus to whichever row now sits there; put it back on the cursor.
    const closePreview = async () => {
      await update($, selected, () => '')
      void $.ui.focus({ requestId: PANE, key: rowKey(at) }).catch(() => undefined)
    }

    const launch = async (tries: string[][], done: string, fail: string) => {
      for (const argv of tries) {
        const r = await $.process.run(argv).catch(() => undefined)
        // explorer and start report 1 on success.
        if (r && (r.exitCode === 0 || argv[0] === 'explorer' || argv[0] === 'cmd')) return $.ui.toast(done)
      }
      $.ui.toast(fail)
    }
    const reveal = () =>
      launch(
        [['open', '-R', real], ['xdg-open', real.replace(/\/[^/]*$/, '')], ['explorer', `/select,${real}`]],
        'Shown in your file manager',
        'Could not open a file manager',
      )
    const openDefault = () =>
      launch([['open', real], ['xdg-open', real], ['cmd', '/c', 'start', '', real]], 'Opened', 'No app could open this file')

    const range = fit(`${pTop + 1}-${Math.min(textRows.length, pTop + previewRoom)}/${textRows.length}`, Math.max(1, cols - 6 - 12))
    const jump = async (to: number) => {
      pTop = to
      await update($, tick, n => n + 1)
    }
    const title = fit(cleanName(chosen), Math.max(6, cols - 6 - 4 - 17))

    return (
      <Box flexDirection="column">
        <Text dimColor>{hintRows.join('\n')}</Text>
        <Box flexDirection="column">
          {shownRows.map(r => {
            const pad = '│ '.repeat(Math.min(r.depth, maxDepth))
            // The engine inverts whatever row rests under the pointer, so the cursor row also underlines to stay distinct from it.
            const here = r.path === at
            const glyph = r.isDir ? (open.has(r.path) ? '▾ ' : '▸ ') : '· '
            const indent = ' '.repeat(1 + pad.length + glyph.length)
            const name = r.lines.map((l, i) => (i ? indent + l : l)).join('\n')
            return r.isDir ? (
              <Button key={rowKey(r.path)} onPress={() => { at = r.path; void update($, cursor, () => r.path); toggle(r.path) }}>
                <Text dimColor>{here ? '›' : ' '}{pad}</Text>
                <Text color="cyan" weight="bold" underline={here}>
                  {glyph}
                  {name}
                </Text>
              </Button>
            ) : (
              <Button key={rowKey(r.path)} onPress={() => { at = r.path; void update($, cursor, () => r.path); void update($, selected, () => r.path) }}>
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
        {chosen && (
          <Box flexDirection="column" borderStyle="round" paddingX={1}>
            <Button key="close-preview" onPress={() => closePreview()}>
              <Text weight="bold">{title} </Text>
              <Text dimColor>(press to close)</Text>
            </Button>
            {isImage || opaque ? (
              <Box flexDirection="column">
                <Text>{headRows.join('\n')}</Text>
                <Text dimColor>{pathRows.join('\n')}</Text>
                {drawImg && (
                  <Image
                    source={{ png }}
                    columns={imgCols}
                    rows={imgRows}
                    alt="(your terminal cannot draw images here)"
                  />
                )}
                <Button key="open-default" onPress={() => void openDefault()}>
                  <Text color="cyan">Open</Text>
                </Button>
                <Button key="reveal" onPress={() => void reveal()}>
                  <Text color="cyan">Show in file manager</Text>
                </Button>
              </Box>
            ) : (
              <Code
                source={textRows.slice(pTop, pTop + previewRoom).join('\n')}
                language={LANG[ext(chosen)]}
                path={cleanName(chosen)}
                wrap="truncate-end"
              />
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
  })
}

// Reads one file for the box: wrapped rows, or the reason it has none. Never reads a pipe or device, which can block.
async function loadText($: any, path: string, st: Stat | undefined, statErr: string, width: number) {
  const none = (opaque: string) => ({ rows: [] as string[], opaque })
  if (!st) return none(statErr.startsWith('ENOENT') ? 'File not found' : statErr ? `Cannot read this file (${clean(statErr)})` : 'Cannot read this file')
  if (st.kind !== 'file') return none(st.isLink && !st.realPath ? 'Broken link' : 'Not a regular file')
  if (OPAQUE.has(ext(path))) return none('No preview in the terminal')
  if (st.size === 0) return { rows: ['(empty file)'], opaque: '' }
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
  const rows = lines.flatMap(l => chunk(clean(l.replace(/\t/g, '  ')), width))
  if (cut) rows.push(`… first ${READ_MAX.toLocaleString()} of ${st.size.toLocaleString()} bytes shown`)
  return { rows, opaque: '' }
}
