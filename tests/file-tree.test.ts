import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { FsEntry, On } from 'claude-code'

// The kit has no mock for fs or process; the test's own hooks on 'fs.*' and 'process.run'
// sit beneath the plugin and answer for the engine, so this file models a small disk.
type Node =
  | { kind: 'file'; text: string; size?: number; deny?: string; px?: { w: number; h: number } }
  | { kind: 'dir'; children: Tree }
  | { kind: 'link'; to: string }
  | { kind: 'fifo' }
type Tree = Record<string, Node>

const file = (text = '', extra: { size?: number; deny?: string; px?: { w: number; h: number } } = {}): Node => ({ kind: 'file', text, ...extra })
const dir = (children: Tree = {}): Node => ({ kind: 'dir', children })
const link = (to: string): Node => ({ kind: 'link', to })
const fifo = (): Node => ({ kind: 'fifo' })

const utf8 = (s: string) => {
  let n = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
  }
  return n
}

type World = { tree: Tree; reads: string[]; runs: string[][]; lists: number; root: string; pngs: Set<string> }
const TMP = '/tmp/file-tree-test'
const PNG1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

const install = (on: On, tree: Tree, opts: { entries?: FsEntry[] } = {}): World => {
  const w: World = { tree, reads: [], runs: [], lists: 0, root: '', pngs: new Set() }
  // The engine hands hooks absolute paths under the session cwd; the first listing is the root.
  const rel = (p: string) => (p === w.root ? '' : p.startsWith(w.root + '/') ? p.slice(w.root.length + 1) : p)
  const step = (at: Node | undefined, name: string): Node | undefined =>
    at && at.kind === 'dir' ? at.children[name] : undefined
  // Follows links in every segment (and the last one when `follow`); returns the node and where it landed.
  const find = (path: string, follow: boolean, hops = 0): { node: Node; real: string } | undefined => {
    if (hops > 40) return undefined
    const parts = path.split('/').filter(Boolean)
    let node: Node | undefined = { kind: 'dir', children: w.tree }
    let real: string[] = []
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i] ?? ''
      node = step(node, name)
      if (!node) return undefined
      real.push(name)
      if (node.kind === 'link' && (follow || i < parts.length - 1)) {
        const to = find(node.to, true, hops + 1)
        if (!to) return undefined
        node = to.node
        real = to.real.split('/').filter(Boolean)
      }
    }
    return node ? { node, real: real.join('/') } : undefined
  }
  const entryKind = (n: Node) => (n.kind === 'file' ? 'file' : n.kind === 'dir' ? 'dir' : 'other') as FsEntry['kind']
  const sizeOf = (n: Node) => (n.kind === 'file' ? n.size ?? utf8(n.text) : 0)

  on('fs.list', async (_$, e) => {
    if (!w.root) w.root = e.path
    w.lists++
    if (opts.entries && e.path === w.root) return { value: opts.entries }
    const at = find(rel(e.path), true)
    if (!at || at.node.kind !== 'dir') return { deny: at ? 'ENOTDIR' : 'ENOENT' }
    return {
      value: Object.entries(at.node.children).map(([name, n]) => ({
        name,
        kind: entryKind(n),
        size: sizeOf(n),
        mtimeMs: n.kind === 'file' ? 1 : 0,
        isLink: n.kind === 'link',
      })),
    }
  })
  on('fs.stat', async (_$, e) => {
    const path = rel(e.path)
    const own = find(path, false)
    if (!own) return { deny: 'ENOENT' }
    const isLink = own.node.kind === 'link'
    const to = isLink ? find(path, true) : own
    if (!to) return { value: { kind: 'other', size: 0, mtimeMs: 0, isLink: true } }
    const realPath = e.resolve ? `${w.root}/${to.real}` : undefined
    return { value: { kind: entryKind(to.node), size: sizeOf(to.node), mtimeMs: 1, isLink, ...(realPath ? { realPath } : {}) } }
  })
  on('fs.read', async (_$, e) => {
    // The PNG sips wrote into the mktemp folder (see process.run); a real 1x1 PNG stands in for it.
    if (e.path.startsWith(`${TMP}/`)) return w.pngs.has(e.path) ? { value: { base64: PNG1 } } : { deny: 'ENOENT' }
    const path = rel(e.path)
    w.reads.push(path)
    const at = find(path, true)
    if (!at) return { deny: 'ENOENT' }
    if (at.node.kind !== 'file') return { deny: 'EISDIR' }
    if (at.node.deny) return { deny: at.node.deny }
    return { value: at.node.text }
  })
  on('process.run', async (_$, e) => {
    const argv = [...e.argv]
    w.runs.push(argv)
    const at = argv[0] === 'head' && argv[1] === '-c' ? find(rel(argv[argv.length - 1] ?? ''), true) : undefined
    const out = (exitCode: number, stdout = '') =>
      ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as const
    if (at && at.node.kind === 'file') return out(0, at.node.text.slice(0, Number(argv[2])))
    // sips -g pixelWidth -g pixelHeight <path>: answers a file's `px`, as sips reads an image's header.
    if (argv[0] === 'sips' && argv[1] === '-g') {
      const img = find(rel(argv[argv.length - 1] ?? ''), true)
      if (img && img.node.kind === 'file' && img.node.px) return out(0, `/x\n  pixelWidth: ${img.node.px.w}\n  pixelHeight: ${img.node.px.h}\n`)
    }
    if (argv[0] === 'mktemp' && argv[1] === '-d') return out(0, `${TMP}\n`)
    // sips -s format png -Z <edge> <path> --out <out>: writes a PNG where the file has a `px`.
    if (argv[0] === 'sips' && argv[1] === '-s') {
      const img = find(rel(argv[6] ?? ''), true)
      if (img && img.node.kind === 'file' && img.node.px) {
        w.pngs.add(argv[8] ?? '')
        return out(0)
      }
    }
    if (argv[0] === 'rm') return out(0)
    return out(1)
  })
  return w
}

// Removes a path from the model, as a delete on disk would.
const remove = (w: World, path: string) => {
  const parts = path.split('/')
  const last = parts.pop() ?? ''
  let at: Tree = w.tree
  for (const p of parts) {
    const n = at[p]
    if (!n || n.kind !== 'dir') return
    at = n.children
  }
  delete at[last]
}

// Puts a node at a path, as a write, a rename or a replace on disk would.
const put = (w: World, path: string, node: Node) => {
  const parts = path.split('/')
  const last = parts.pop() ?? ''
  let at: Tree = w.tree
  for (const p of parts) {
    const n = at[p]
    if (!n || n.kind !== 'dir') return
    at = n.children
  }
  at[last] = node
}

// Rows an element takes as the plugin lays it out (it pre-wraps every line): a column Box stacks, a border adds two.
const height = (x: unknown): number => {
  if (!isEl(x)) return 0
  const kids = (x.children ?? []).filter(isEl)
  if (x.type === 'Box') {
    if (typeof x.props?.height === 'number') return x.props.height
    const inner = x.props?.flexDirection === 'row' ? Math.max(0, ...kids.map(height)) : kids.reduce((n, k) => n + height(k), 0)
    return inner + (x.props?.borderStyle ? 2 : 0)
  }
  if (x.type === 'Code') return String(x.props?.source ?? '').split('\n').length
  if (x.type === 'Image') return Number(x.props?.rows ?? 0)
  if (x.type === 'Button') return String(x.props?.label ?? textOf(x)).split('\n').length
  return textOf(x).split('\n').length
}

// Wide cells as a terminal draws them (East Asian Wide/Fullwidth and emoji presentation).
const WIDE_BMP = new Set([0x231a, 0x231b, 0x23f0, 0x23f3, 0x2614, 0x2615, 0x26a1, 0x26bd, 0x26be, 0x2705, 0x270a, 0x270b, 0x2728, 0x274c, 0x2753, 0x2757, 0x2b50, 0x2b55])
const cellsOf = (cp: number) =>
  (cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f)
    ? 0
    : (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
        (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0x1f300 && cp <= 0x1faff) ||
        (cp >= 0x20000 && cp <= 0x3fffd) || WIDE_BMP.has(cp)
      ? 2
      : 1
const width = (s: string) => [...s].reduce((n, ch) => n + cellsOf(ch.codePointAt(0) ?? 0), 0)
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/
const LONE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/

type El = { type: string; props?: Record<string, unknown>; children?: unknown[] }
const isEl = (x: unknown): x is El => typeof x === 'object' && x !== null && 'type' in x
const textOf = (x: unknown): string =>
  typeof x === 'string' ? x : isEl(x) ? (x.children ?? []).map(textOf).join('') : ''
const all = (x: unknown, out: El[] = []): El[] => {
  if (isEl(x)) {
    out.push(x)
    for (const c of x.children ?? []) all(c, out)
  }
  return out
}

const PANE = 'file-tree'
// The text preview's row is gutter, text column, then the scrollbar's column of `sb-` cells when the file overflows.
const isBar = (x: El) => all(x).some(k => String(k.props?.key ?? '').startsWith('sb-'))
const textColumn = (kids: El[]) => kids.find(k => k.type === 'Box' && !isBar(k))
// Row keys as register.tsx spells them; the test presses rows by path through this.
const K = (path: string) =>
  `r:${encodeURIComponent(path.replace(/\ufffe|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, c => `\ufffe${c.charCodeAt(0).toString(16).padStart(4, '0')}`))}`
const unK = (key: string) => (key.startsWith('r:') ? decodeURIComponent(key.slice(2)) : key)
declare const console: { log: (...a: unknown[]) => void }
const props = (bodyColumns: number, bodyRows: number) => ({
  title: 'Files',
  isFocused: true,
  bodyColumns,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows },
  view: {},
})

const open = async ($: Engine, cols = 40, rows = 20, surface: 'terminal' | 'desktop' = 'terminal') => {
  const ui = await $.ui.mount({ plugin: PANE, surface, component: 'Pane', requestId: PANE, props: props(cols, rows) })
  const read = async () => {
    const top = (await ui.drawn()) as unknown as El
    const kids = (top.children ?? []).filter(isEl)
    // Under 6 body rows the hint gives its row to the tree and is not drawn.
    const hint = kids[0]?.type === 'Text' ? textOf(kids[0]) : ''
    const treeBox = kids.find(k => k.type === 'Box' && !k.props?.borderStyle)
    const box = kids.find(k => k.props?.borderStyle === 'round')
    const tree = (treeBox?.children ?? []).filter(isEl)
    const rows = tree
      .filter(k => k.type === 'Button')
      .map(b => ({ key: String(b.props?.key), path: unK(String(b.props?.key)), label: String(b.props?.label ?? textOf(b)) }))
    const treeHeight = tree.reduce((n, k) => n + (k.type === 'Button' ? String(k.props?.label ?? textOf(k)).split('\n').length : 1), 0)
    const inBox = box ? all(box) : []
    const code = inBox.find(e => e.type === 'Code')
    const source = code ? String(code.props?.source ?? '') : undefined
    const title = box ? String(inBox.find(e => e.props?.key === 'close-preview')?.props?.label ?? '') : undefined
    const footer = inBox.some(e => e.props?.key === 'jump-top')
    const boxText = box ? textOf(box) : undefined
    const range = boxText?.match(/(\d+-\d+\/\d+)/)?.[1]
    const count = hint.replace(/\n/g, '').match(/^(\d+)\/(\d+)/)
    return {
      top,
      hint,
      at: count ? Number(count[1]) : NaN,
      of: count ? Number(count[2]) : NaN,
      rows,
      treeHeight,
      cursor: rows.find(r => r.label.startsWith('›'))?.path,
      box,
      source,
      title,
      footer,
      range,
      boxText,
      codeLines: source === undefined ? 0 : source.split('\n').length,
    }
  }
  return { ui, read }
}

const scroll = ($: Engine, by: number, bodyRows: number, row?: number) =>
  $.ui.scroll({
    component: 'Pane',
    requestId: PANE,
    offset: 0,
    by,
    bodyRows,
    contentRows: bodyRows + 1,
    origin: { kind: 'person' },
    ...(row === undefined ? {} : { pointer: { column: 2, row } }),
  })

// Every line of a tree row, as the terminal draws a Button: "[ " + label + " ]".
const rowLinesFit = (rows: { label: string }[], cols: number) =>
  rows.flatMap(r => r.label.split('\n')).filter(l => width(l) + 4 > cols)

const SURFACES = ['terminal', 'desktop'] as const

describe('tree', () => {
  for (const surface of SURFACES) {
    test(`empty folder shows 0/0 and no rows (${surface})`, async ($, on) => {
      install(on, {})
      const { read } = await open($, 40, 20, surface)
      const v = await read()
      expect([v.at, v.of]).toEqual([0, 0])
      expect(v.rows).toHaveLength(0)
      expect(v.box).toBeUndefined()
    })

    test(`folder with one file shows 1/1 and the file (${surface})`, async ($, on) => {
      install(on, { 'a.txt': file('hi') })
      const { read } = await open($, 40, 20, surface)
      const v = await read()
      expect([v.at, v.of]).toEqual([1, 1])
      expect(v.rows.map(r => r.path)).toEqual(['a.txt'])
      expect(v.rows[0]?.label).toBe('›· a.txt')
    })
  }

  test('folders sort before files and .git, node_modules, .DS_Store are hidden', async ($, on) => {
    install(on, { 'b.txt': file(), 'a.txt': file(), z: dir(), '.git': dir(), node_modules: dir(), '.DS_Store': file(), m: dir() })
    const { read } = await open($)
    expect((await read()).rows.map(r => r.path)).toEqual(['m', 'z', 'a.txt', 'b.txt'])
  })

  test('control characters in names (ESC, newline, tab, DEL, C1) draw as symbols', async ($, on) => {
    const names = ['esc\u001b[31mred', 'new\nline', 'tab\there', 'del\u007fete', 'c1\u0085x']
    install(on, Object.fromEntries(names.map(n => [n, file('body')])))
    const { ui, read } = await open($)
    const v = await read()
    expect(v.rows).toHaveLength(names.length)
    for (const r of v.rows) {
      for (const l of r.label.split('\n')) expect(CONTROL.test(l), `control char in ${JSON.stringify(l)}`).toBe(false)
      expect(CONTROL.test(r.key), `control char in key ${JSON.stringify(r.key)}`).toBe(false)
    }
    const labels = v.rows.map(r => r.label).join('|')
    for (const sym of ['␛', '␊', '␉', '␡', '�']) expect(labels).toContain(sym)
    // Selecting one draws its name in the box title and its path on Code without a refusal.
    await ui.press({ key: K('esc\u001b[31mred') })
    const after = await read()
    expect(after.source).toBe('body')
    expect(CONTROL.test(after.title ?? '')).toBe(false)
  })

  test('a name with a lone surrogate draws as U+FFFD and does not break the render', async ($, on) => {
    install(on, { 'lone\ud800x': file('body'), 'ok.txt': file() })
    const { ui, read } = await open($)
    const v = await read()
    expect(v.rows).toHaveLength(2)
    const row = v.rows.find(r => r.label.includes('�'))
    expect(row).toBeDefined()
    expect(LONE.test((row?.label ?? '') + (row?.key ?? ''))).toBe(false)
    await ui.press({ key: row?.key ?? '' })
    // The engine turns a lone surrogate into U+FFFD in transit, so the file cannot be addressed again; what matters is the render survives.
    const after = await read()
    expect(after.box).toBeDefined()
    expect(LONE.test(after.boxText ?? '')).toBe(false)
  })

  test('emoji and CJK names wrap by display width within bodyColumns and keep every character', async ($, on) => {
    const emoji = '😀'.repeat(25) + '.txt'
    const cjk = '漢字'.repeat(20) + '.md'
    install(on, { [emoji]: file(), [cjk]: file() })
    const cols = 40
    const { read } = await open($, cols)
    const v = await read()
    expect(rowLinesFit(v.rows, cols)).toEqual([])
    for (const name of [cjk, emoji]) {
      const r = v.rows.find(x => x.path === name)
      const lines = (r?.label ?? '').split('\n')
      expect(lines.length).toBeGreaterThan(1)
      expect(lines.map((l, i) => (i ? l.trimStart() : l.slice(3))).join('')).toBe(name)
    }
  })

  test('emoji-presentation BMP symbols (✅ ⚡) count as two cells when wrapping', async ($, on) => {
    install(on, { ['✅⚡'.repeat(15) + '.txt']: file() })
    const cols = 40
    const { read } = await open($, cols)
    expect(rowLinesFit((await read()).rows, cols)).toEqual([])
  })

  test('a very long name wraps, each line inside bodyColumns, nothing lost', async ($, on) => {
    const name = 'x'.repeat(150) + '.log'
    install(on, { [name]: file() })
    // Tall enough for the whole name: a row taller than the window is clipped to it.
    for (const cols of [40, 23, 15]) {
      const { ui, read } = await open($, cols, 60)
      const v = await read()
      expect(rowLinesFit(v.rows, cols), `cols ${cols}`).toEqual([])
      expect((v.rows[0]?.label ?? '').split('\n').map((l, i) => (i ? l.trimStart() : l.slice(3))).join('')).toBe(name)
      await ui.unmount()
    }
  })

  test('a single unbreakable name wider than the pane still fits per line', async ($, on) => {
    const name = 'W'.repeat(300)
    install(on, { [name]: file() })
    const { read } = await open($, 20)
    const v = await read()
    expect(v.rows[0]?.label.split('\n').length).toBeGreaterThan(10)
    expect(rowLinesFit(v.rows, 20)).toEqual([])
  })

  test('deep nesting: indent stops growing so the name keeps at least 8 cells', async ($, on) => {
    const depth = 30
    let leaf: Tree = { 'deepest-file-name.txt': file('x') }
    for (let i = depth - 1; i >= 0; i--) leaf = { [`d${i}`]: dir(leaf) }
    install(on, leaf)
    const cols = 41
    const { ui, read } = await open($, cols, 80)
    let path = ''
    for (let i = 0; i < depth; i++) {
      path = path ? `${path}/d${i}` : `d${i}`
      await ui.press({ key: K(path) })
    }
    const v = await read()
    const last = v.rows.find(r => r.path.endsWith('deepest-file-name.txt'))
    expect(last).toBeDefined()
    const first = (last?.label ?? '').split('\n')[0] ?? ''
    const nameCells = width(first) - width(first.replace(/[^│ ›·▸▾].*$/, ''))
    expect(nameCells).toBeGreaterThanOrEqual(8)
    expect(rowLinesFit(v.rows, cols)).toEqual([])
    const pads = v.rows.map(r => (r.label.match(/│ /g) ?? []).length)
    expect(Math.max(...pads)).toBe(Math.floor((cols - 15) / 2))
  })

  test('a symlink to a folder is a folder and expands', async ($, on) => {
    install(on, { real: dir({ 'inner.txt': file('in') }), lnk: link('real'), 'a.txt': file() })
    const { ui, read } = await open($)
    const v = await read()
    expect(v.rows.map(r => r.path)).toEqual(['lnk', 'real', 'a.txt'])
    expect(v.rows[0]?.label).toBe('›▸ lnk')
    await ui.press({ key: K('lnk') })
    expect((await read()).rows.map(r => r.path)).toContain('lnk/inner.txt')
  })

  test('a broken symlink is a row; its preview says Broken link and nothing is read', async ($, on) => {
    const w = install(on, { dangling: link('gone/nowhere') })
    const { ui, read } = await open($)
    expect((await read()).rows.map(r => r.label)).toEqual(['›· dangling'])
    await ui.press({ key: K('dangling') })
    expect((await read()).boxText).toContain('Broken link')
    expect(w.reads).toEqual([])
    expect(w.runs).toEqual([])
  })

  test('a FIFO (kind other, not a link) is never read; preview says Not a regular file', async ($, on) => {
    const w = install(on, { pipe: fifo(), 'sock.log': fifo() })
    const { ui, read } = await open($)
    for (const path of ['pipe', 'sock.log']) {
      await ui.press({ key: K(path) })
      expect((await read()).boxText).toContain('Not a regular file')
    }
    expect(w.reads).toEqual([])
    expect(w.runs).toEqual([])
  })

  test('a FIFO with an image extension is never handed to a process', async ($, on) => {
    const w = install(on, { 'cam.png': fifo() })
    const { ui, read } = await open($)
    await ui.press({ key: K('cam.png') })
    expect((await read()).boxText).toContain('Not a regular file')
    expect(w.reads).toEqual([])
    expect(w.runs.filter(a => a.some(x => x.endsWith('cam.png')))).toEqual([])
  })

  test('a symlink to a FIFO says Not a regular file, not Broken link', async ($, on) => {
    const w = install(on, { pipe: fifo(), 'pipe-link': link('pipe') })
    const { ui, read } = await open($)
    await ui.press({ key: K('pipe-link') })
    const v = await read()
    expect(v.boxText).toContain('Not a regular file')
    expect(v.boxText).not.toContain('Broken link')
    expect(w.reads).toEqual([])
  })

  test('two names that clean to the same symbols still get distinct row keys', async ($, on) => {
    install(on, { 'a\u001bb': file('one'), 'a␛b': file('two') })
    const { ui, read } = await open($)
    const keys = (await read()).rows.map(r => r.key)
    expect(new Set(keys).size).toBe(2)
    await ui.press({ key: K('a␛b') })
    expect((await read()).source).toBe('two')
  })

  test('a root file named like a preview button is selectable while a preview is open', async ($, on) => {
    install(on, { 'a.txt': file('aaa'), reveal: file('the reveal file') })
    const { ui, read } = await open($)
    await ui.press({ key: K('a.txt') })
    await ui.press({ key: K('reveal') })
    expect((await read()).source).toBe('the reveal file')
  })

  test('a preview title cut after an emoji keeps whole code points', async ($, on) => {
    const name = 'a'.repeat(10) + '😀😀😀😀.txt'
    install(on, { [name]: file('x') })
    const { ui, read } = await open($, 40)
    await ui.press({ key: K(name) })
    const title = (await read()).title ?? ''
    expect(title).toContain('…')
    expect(LONE.test(title), JSON.stringify(title)).toBe(false)
    expect(title).not.toContain('�')
  })
})

describe('preview', () => {
  test('empty file says (empty file) without reading it', async ($, on) => {
    const w = install(on, { 'e.txt': file('') })
    const { ui, read } = await open($)
    await ui.press({ key: K('e.txt') })
    expect((await read()).source).toBe('(empty file)')
    expect(w.reads).toEqual([])
  })

  test('CRLF text draws without carriage returns', async ($, on) => {
    install(on, { 'w.txt': file('one\r\ntwo\r\nthree\r\n') })
    const { ui, read } = await open($)
    await ui.press({ key: K('w.txt') })
    expect((await read()).source).toBe('one\ntwo\nthree')
  })

  test('a file with NUL says Binary file', async ($, on) => {
    install(on, { 'b.dat': file('ab\u0000cd') })
    const { ui, read } = await open($)
    await ui.press({ key: K('b.dat') })
    const v = await read()
    expect(v.boxText).toContain('Binary file')
    expect(v.source).toBeUndefined()
  })

  test('mp4, MP4 and pdf say No preview in the terminal with no fs.read', async ($, on) => {
    const w = install(on, { 'clip.mp4': file('x'.repeat(10)), 'Big.MP4': file('y'), 'doc.pdf': file('%PDF') })
    const { ui, read } = await open($)
    for (const path of ['clip.mp4', 'Big.MP4', 'doc.pdf']) {
      await ui.press({ key: K(path) })
      expect((await read()).boxText, path).toContain('No preview in the terminal')
    }
    expect(w.reads).toEqual([])
    expect(w.runs).toEqual([])
  })

  test('the box offers Open and Show in file manager for every kind, and nothing else', async ($, on) => {
    install(on, { 'clip.mp4': file('x'), 'doc.pdf': file('%PDF'), 'pic.png': file('p') })
    const { ui, read } = await open($)
    for (const path of ['clip.mp4', 'doc.pdf', 'pic.png']) {
      await ui.press({ key: K(path) })
      const box = (await read()).box
      const keys = (box ? all(box) : []).filter(e => e.type === 'Button').map(e => String(e.props?.key))
      expect(keys, path).toEqual(['close-preview', 'open-default', 'reveal'])
    }
  })

  const MiB4 = 4 * 1024 * 1024
  const big = (bytes: number) => {
    const line = 'y'.repeat(63) + '\n'
    return line.repeat(Math.floor(bytes / 64)) + 'z'.repeat(bytes % 64)
  }

  test('exactly 4 MiB is read with fs.read and no head', { timeoutMs: 20000 }, async ($, on) => {
    const w = install(on, { 'four.txt': file(big(MiB4)) })
    const { ui, read } = await open($)
    await ui.press({ key: K('four.txt') })
    expect(w.reads).toEqual(['four.txt'])
    expect(w.runs).toEqual([])
    expect((await read()).source?.split('\n')[0]).toMatch(/^y+$/)
  })

  test('4 MiB + 1 is read with head -c 4194304 -- and the footer says it is cut', { timeoutMs: 20000 }, async ($, on) => {
    const w = install(on, { 'over.txt': file(big(MiB4 + 1)) })
    const rows = 20
    const { ui, read } = await open($, 40, rows)
    await ui.press({ key: K('over.txt') })
    expect(w.reads).toEqual([])
    expect(w.runs).toEqual([['head', '-c', '4194304', '--', 'over.txt']])
    const v = await read()
    expect(v.footer).toBe(true)
    expect(v.boxText).toMatch(/· cut/)
  })

  test('a >4 MiB file whose name starts with "-" reaches head after --', { timeoutMs: 20000 }, async ($, on) => {
    const w = install(on, { '-dash.log': file(big(MiB4 + 1)) })
    const { ui, read } = await open($)
    await ui.press({ key: K('-dash.log') })
    expect(w.runs.find(a => a[0] === 'head')).toEqual(['head', '-c', '4194304', '--', '-dash.log'])
    expect((await read()).source?.split('\n')[0]).toMatch(/^y+$/)
  })

  test('fs.read refused with EACCES: preview says Cannot read this file (EACCES)', async ($, on) => {
    // The kit's refusal is a HooksError whose message ends in the deny reason; the plugin parses the E-token from it.
    install(on, { 'secret.txt': file('x', { deny: 'EACCES' }) })
    const { ui, read } = await open($)
    await ui.press({ key: K('secret.txt') })
    expect((await read()).boxText).toContain('Cannot read this file (EACCES)')
  })

  test('fs.read refused with no errno token: preview says plain Cannot read this file', async ($, on) => {
    install(on, { 'secret.txt': file('x', { deny: 'blocked by policy' }) })
    const { ui, read } = await open($)
    await ui.press({ key: K('secret.txt') })
    const text = (await read()).boxText ?? ''
    expect(text).toContain('Cannot read this file')
    expect(text).not.toContain('Cannot read this file (')
  })

  test('selected file deleted: preview says File not found', async ($, on) => {
    const w = install(on, { 'a.txt': file('here'), 'b.txt': file() })
    const { ui, read } = await open($)
    await ui.press({ key: K('a.txt') })
    expect((await read()).source).toBe('here')
    remove(w, 'a.txt')
    await ui.redraw()
    expect((await read()).boxText).toContain('File not found')
  })

  const LONG = (n: number, p = 'line ') => Array.from({ length: n }, (_, i) => `${p}${i}`).join('\n')

  test('long file: box ≤ 60% of bodyRows and tree ≥ 3 rows, bodyRows 10..60', async ($, on) => {
    install(on, { 'long.txt': file(LONG(500)), 'x.txt': file() })
    const { ui, read } = await open($, 40, 10)
    await ui.press({ key: K('long.txt') })
    for (let rows = 10; rows <= 60; rows++) {
      await ui.redraw(props(40, rows))
      const v = await read()
      const boxRows = v.codeLines + 3 + (v.footer ? 1 : 0)
      expect(boxRows, `box at bodyRows ${rows}`).toBeLessThanOrEqual(Math.floor(rows * 0.6))
      expect(v.treeHeight, `tree at bodyRows ${rows}`).toBeGreaterThanOrEqual(3)
    }
  })

  test('long file: box ≤ 60% of bodyRows at the smallest bodyRows (8, 9)', async ($, on) => {
    install(on, { 'long.txt': file(LONG(500)) })
    const { ui, read } = await open($, 40, 8)
    await ui.press({ key: K('long.txt') })
    for (const rows of [8, 9]) {
      await ui.redraw(props(40, rows))
      const v = await read()
      const boxRows = v.codeLines + 3 + (v.footer ? 1 : 0)
      expect(boxRows, `box at bodyRows ${rows}`).toBeLessThanOrEqual(Math.floor(rows * 0.6))
    }
  })

  test('preview scroll offset never passes its max or goes below 0', async ($, on) => {
    install(on, { 'long.txt': file(LONG(100)) })
    const rows = 20
    const { ui, read } = await open($, 40, rows)
    await ui.press({ key: K('long.txt') })
    const room = (await read()).codeLines
    for (const by of [1e6, 5, 1]) {
      await scroll($, by, rows, rows - 1)
      const v = await read()
      expect(v.range).toBe(`${100 - room + 1}-100/100`)
      expect(v.source?.split('\n').pop()).toBe('line 99')
    }
    await scroll($, -1e6, rows, rows - 1)
    const v = await read()
    expect(v.range).toBe(`1-${room}/100`)
    expect(v.source?.split('\n')[0]).toBe('line 0')
  })

  test('the jump buttons go to the end and back to the top', async ($, on) => {
    install(on, { 'long.txt': file(LONG(100)) })
    const { ui, read } = await open($, 40, 20)
    await ui.press({ key: K('long.txt') })
    const room = (await read()).codeLines
    await ui.press({ key: 'jump-end' })
    expect((await read()).range).toBe(`${100 - room + 1}-100/100`)
    await ui.press({ key: 'jump-top' })
    expect((await read()).range).toBe(`1-${room}/100`)
  })
})

describe('ui.scroll', () => {
  test('wheel over the preview box scrolls the box, not the tree cursor', async ($, on) => {
    install(on, { 'a.txt': file(), 'long.txt': file(Array.from({ length: 100 }, (_, i) => `L${i}`).join('\n')), 'z.txt': file() })
    const rows = 20
    const { ui, read } = await open($, 40, rows)
    await ui.press({ key: K('long.txt') })
    const before = await read()
    await scroll($, 3, rows, rows - 1)
    const after = await read()
    expect(after.cursor).toBe(before.cursor)
    expect(after.at).toBe(before.at)
    expect(after.source?.split('\n')[0]).toBe('L3')
    // A wheel over the tree rows walks the cursor instead.
    await scroll($, 1, rows, 2)
    const tree = await read()
    expect(tree.cursor).toBe('z.txt')
    expect(tree.source?.split('\n')[0]).toBe('L3')
  })

  test('arrows (no pointer) move the cursor and clamp at the first and last row', async ($, on) => {
    install(on, Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map(n => [`${n}.txt`, file()])))
    const rows = 20
    const { read } = await open($, 40, rows)
    await scroll($, -1, rows)
    let v = await read()
    expect([v.cursor, v.at]).toEqual(['a.txt', 1])
    await scroll($, -5, rows)
    expect((await read()).cursor).toBe('a.txt')
    for (let i = 0; i < 10; i++) await scroll($, 1, rows)
    v = await read()
    expect([v.cursor, v.at, v.of]).toEqual(['e.txt', 5, 5])
    await scroll($, 100, rows)
    expect((await read()).cursor).toBe('e.txt')
    await scroll($, -2, rows)
    expect((await read()).cursor).toBe('c.txt')
  })

  test('↓ after closing a preview moves one row down from the file that was open', async ($, on) => {
    install(on, { 'a.txt': file(), 'long.txt': file(Array.from({ length: 100 }, (_, i) => `L${i}`).join('\n')), 'm.txt': file(), 'z.txt': file() })
    const rows = 20
    const { ui, read } = await open($, 40, rows)
    await ui.press({ key: K('long.txt') })
    const opened = await read()
    expect([opened.cursor, opened.at, opened.box !== undefined]).toEqual(['long.txt', 2, true])
    await ui.press({ key: 'close-preview' })
    const closed = await read()
    expect([closed.cursor, closed.at, closed.box]).toEqual(['long.txt', 2, undefined])
    await scroll($, 1, rows)
    const v = await read()
    expect([v.cursor, v.at]).toEqual(['m.txt', 3])
    expect(v.rows.filter(r => r.label.startsWith('›'))).toHaveLength(1)
  })

  test('only the cursor row underlines, files and folders alike, so it stays distinct from the pointer hover', async ($, on) => {
    install(on, { d: dir({ 'in.txt': file() }), 'a.txt': file(), 'b.txt': file() })
    const { ui, read } = await open($)
    const underlined = async () => {
      const v = await read()
      const rows = all(v.top).filter(e => e.type === 'Button' && String(e.props?.key).startsWith('r:'))
      return rows.filter(b => all(b).some(t => t.type === 'Text' && t.props?.underline === true)).map(b => unK(String(b.props?.key)))
    }
    // The cursor starts on the first row.
    expect(await underlined()).toEqual(['d'])
    await ui.press({ key: K('b.txt') })
    expect(await underlined()).toEqual(['b.txt'])
    await ui.press({ key: K('d') })
    expect(await underlined()).toEqual(['d'])
    await scroll($, 1, 20)
    expect(await underlined()).toHaveLength(1)
  })

  test('a cursor on a path that no longer exists falls back to its nearest existing ancestor', async ($, on) => {
    const w = install(on, { d: dir({ e: dir({ 'f.txt': file('f') }) }), 'top.txt': file() })
    const { ui, read } = await open($)
    await ui.press({ key: K('d') })
    await ui.press({ key: K('d/e') })
    await ui.press({ key: K('d/e/f.txt') })
    expect((await read()).cursor).toBe('d/e/f.txt')
    remove(w, 'd/e/f.txt')
    await ui.redraw()
    expect((await read()).cursor).toBe('d/e')
    remove(w, 'd/e')
    await ui.redraw()
    const v = await read()
    expect([v.cursor, v.at]).toEqual(['d', 1])
  })
})

describe('sizes', () => {
  const NAMES: Tree = {
    'a.txt': file('hello\tworld\nline two'),
    ['漢字'.repeat(10)]: file(),
    ['😀'.repeat(10)]: file(),
    deep: dir({ inner: dir({ 'f.txt': file('f') }) }),
  }

  test('a very narrow pane (bodyColumns 8) draws without throwing', async ($, on) => {
    install(on, NAMES)
    const { ui, read } = await open($, 8, 20)
    await ui.press({ key: K('deep') })
    await ui.press({ key: K('deep/inner') })
    // At 8 columns the hint alone wraps to a dozen rows, so most rows are off screen; the count still holds every entry.
    const v = await read()
    expect(v.of).toBe(6)
    await scroll($, 1, 20)
    await scroll($, 1, 20, 19)
    await read()
  })

  test('a very short pane (bodyRows 4) keeps a tree row and the preview title', async ($, on) => {
    install(on, NAMES)
    const { ui, read } = await open($, 40, 4)
    await ui.press({ key: K('a.txt') })
    const v = await read()
    expect(v.title).toContain('a.txt')
    expect(v.treeHeight).toBeGreaterThanOrEqual(1)
    expect(height(v.top)).toBe(5)
    await ui.redraw(props(40, 5))
    expect((await read()).source).toContain('hello  world')
    await scroll($, 1, 4, 3)
    await scroll($, 1, 4)
    await read()
  })

  test('50,000 entries render within a couple of seconds', { timeoutMs: 30000 }, async ($, on) => {
    const entries: FsEntry[] = Array.from({ length: 50000 }, (_, i) => ({
      name: `file-${String(i).padStart(5, '0')}.txt`,
      kind: 'file',
      size: 1,
      mtimeMs: 1,
      isLink: false,
    }))
    install(on, {}, { entries })
    const t0 = Date.now()
    const { read } = await open($, 40, 30)
    const v = await read()
    const first = Date.now() - t0
    expect(v.of).toBe(50000)
    const t1 = Date.now()
    await scroll($, 49999, 30)
    const end = await read()
    const move = Date.now() - t1
    console.log(`50,000 entries: first draw ${first} ms, jump to last row ${move} ms`)
    expect(end.cursor).toBe('file-49999.txt')
    expect(end.at).toBe(50000)
    expect(first).toBeLessThan(2500)
    expect(move).toBeLessThan(2500)
  })
})

describe('hooks', () => {
  test('session.start registers /tree and leaves the pane closed until it is run', async ($, on) => {
    const seen: { command?: string; opened: string[]; status: string[] } = { opened: [], status: [] }
    on('command.register', async (_$, e) => {
      seen.command = e.name
      return { value: { command: e.name } }
    })
    on('ui.open', async (_$, e) => {
      seen.opened.push(e.id)
      return { value: { isPlaced: true } }
    })
    on('ui.status', async (_$, e) => {
      seen.status.push(e.text ?? '')
      return { value: undefined }
    })
    // Nothing answers beneath the test's hooks, so the session's own start is the test's.
    on('session.start', async (_$, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: '/tmp/x', surface: 'terminal', isInteractive: true })
    expect(seen.command).toBe('tree')
    expect(seen.opened).toEqual([])
    expect(seen.status.join(' ')).toContain('/tree')
  })

  test('/tree opens the pane and answers', async ($, on) => {
    mock.store(on)
    const opened: string[] = []
    on('ui.open', async (_$, e) => {
      opened.push(e.id)
      return { value: { isPlaced: true } }
    })
    const r = await $.command.run({
      command: 'tree',
      args: '',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: true, columns: 120 },
    })
    // Nothing is saved yet: the pane opens on the defaults with a one-time tip.
    expect(r.text).toBe('File tree opened. Tip: /tree setup lets you change its width and when it opens.')
    expect(opened).toEqual([PANE])
  })

  test('/tree takes a width, clamps it, and ignores junk', async ($, on) => {
    mock.store(on)
    const widths: (number | undefined)[] = []
    on('ui.open', async (_$, e) => {
      widths.push(e.columns)
      return { value: { isPlaced: true } }
    })
    for (const args of ['80', '5', '999', 'wide', ' 70 ', '']) {
      await $.command.run({ command: 'tree', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })
    }
    expect(widths).toEqual([80, 30, 120, 56, 70, 56])
  })

  test('the tip about /tree setup shows once, and a dismissed setup saves nothing', async ($, on) => {
    mock.store(on)
    on('ui.open', async () => ({ value: { isPlaced: true } }))
    const run = (args: string) =>
      $.command.run({ command: 'tree', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })
    expect((await run('')).text).toContain('Tip: /tree setup')
    expect((await run('')).text).toBe('File tree opened.')
    // No one answers the questions here, so they come back dismissed.
    expect((await run('setup')).text).toBe('File tree opened. Setup skipped.')
  })

  test('ui.scroll for another pane is not taken', async ($, on) => {
    let passed = 0
    on('ui.scroll', async () => {
      passed++
      return {}
    })
    install(on, { 'a.txt': file() })
    await open($)
    await $.ui.scroll({ component: 'Pane', requestId: 'other', offset: 0, by: 1, bodyRows: 20, contentRows: 30, origin: { kind: 'person' } })
    expect(passed).toBe(1)
    await scroll($, 1, 20)
    expect(passed).toBe(1)
  })
})

// Failing tests from the audit: each names a bug in hooks/register.tsx. They fail on the code as it stands.
describe('audit', () => {
  const LINES = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n')

  test('sanity: with no preview and with a text preview the body is bodyRows + 1 tall', async ($, on) => {
    install(on, { 'a.txt': file(), 'long.txt': file(LINES(200)) })
    const rows = 20
    const { ui, read } = await open($, 40, rows)
    expect(height((await read()).top)).toBe(rows + 1)
    await ui.press({ key: K('long.txt') })
    expect(height((await read()).top)).toBe(rows + 1)
  })

  test('an image edited on disk shows its new size (sizes/pngs are keyed by path only)', async ($, on) => {
    const w = install(on, { 'chart.png': file('v1', { px: { w: 300, h: 200 } }) })
    const { ui, read } = await open($, 40, 20)
    await ui.press({ key: K('chart.png') })
    expect((await read()).boxText).toContain('300 × 200 px')
    // A tool rewrites the chart; tool.call bumps tick and the pane redraws.
    put(w, 'chart.png', file('version two', { px: { w: 600, h: 400 } }))
    await ui.redraw()
    expect((await read()).boxText).toContain('600 × 400 px')
  })

  test('an image whose first sips call failed is measured again once it can be', async ($, on) => {
    // Selected while still being written: sips fails, and null is cached for the path for the life of the module.
    const w = install(on, { 'shot.png': file('partial') })
    const { ui, read } = await open($, 40, 20)
    await ui.press({ key: K('shot.png') })
    expect((await read()).boxText).toContain('size unknown')
    put(w, 'shot.png', file('complete png', { px: { w: 64, h: 32 } }))
    await ui.redraw()
    expect((await read()).boxText).toContain('64 × 32 px')
  })

  test('an opaque preview (mp4) keeps the body bodyRows + 1 tall, as the arrow keys need', async ($, on) => {
    install(on, { 'a.txt': file(), 'clip.mp4': file('x') })
    for (const rows of [20, 30]) {
      const { ui, read } = await open($, 60, rows)
      await ui.press({ key: K('clip.mp4') })
      expect(height((await read()).top), `bodyRows ${rows}`).toBe(rows + 1)
      await ui.unmount()
    }
  })

  test('an opaque preview with a long real path fits a short pane (Open/Show buttons stay on screen)', async ($, on) => {
    install(on, { 'a.txt': file(), 'clip.mp4': file('x') })
    const rows = 12
    const { ui, read } = await open($, 40, rows)
    await ui.press({ key: K('clip.mp4') })
    expect(height((await read()).top)).toBeLessThanOrEqual(rows + 1)
  })

  test('a text preview fits inside small panes (bodyRows 4..9)', async ($, on) => {
    install(on, { 'long.txt': file(LINES(200)) })
    const { ui, read } = await open($, 40, 4)
    await ui.press({ key: K('long.txt') })
    for (let rows = 4; rows <= 9; rows++) {
      await ui.redraw(props(40, rows))
      expect(height((await read()).top), `bodyRows ${rows}`).toBeLessThanOrEqual(rows + 1)
    }
  })

  test('a wrapped tree row taller than the tree room does not push the preview out of the pane', async ($, on) => {
    const name = 'x'.repeat(150) + '.log'
    install(on, { [name]: file(LINES(200)) })
    const rows = 12
    const { ui, read } = await open($, 40, rows)
    await ui.press({ key: K(name) })
    const v = await read()
    expect(v.box).toBeDefined()
    expect(height(v.top)).toBeLessThanOrEqual(rows + 1)
  })

  test('a wheel tick over the first row of the preview box scrolls the preview, even under a tall tree row', async ($, on) => {
    const name = 'x'.repeat(150) + '.log'
    install(on, { [name]: file(LINES(200)) })
    const rows = 12
    const { ui, read } = await open($, 40, rows)
    await ui.press({ key: K(name) })
    const v = await read()
    const kids = (v.top.children ?? []).filter(isEl)
    // The row the box's first line lands on, as drawn.
    const boxRow = height(kids[0]) + height(kids[1])
    await scroll($, 2, rows, boxRow - 1)
    // A tick over the tall row (above the box) must not scroll the preview.
    expect((await read()).source?.split('\n')[0]).toBe('line 0')
  })

  test('End (by = contentRows) takes the cursor to the last row', async ($, on) => {
    install(on, Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`f${String(i).padStart(3, '0')}.txt`, file()])))
    const rows = 20
    const { read } = await open($, 40, rows)
    // The engine sends End as by = contentRows; the plugin pads content to bodyRows + 1, so End moves 21 rows.
    await scroll($, rows + 1, rows)
    expect((await read()).cursor).toBe('f099.txt')
  })

  test('a root-level file deleted under the cursor leaves the cursor on a neighbouring row', async ($, on) => {
    const w = install(on, { 'a.txt': file(), 'b.txt': file(), 'c.txt': file() })
    const { ui, read } = await open($)
    await ui.press({ key: K('b.txt') })
    expect((await read()).cursor).toBe('b.txt')
    remove(w, 'b.txt')
    await ui.redraw()
    const v = await read()
    // The cursor falls back to '' (no row marked) while the hint still claims 1/2.
    expect(v.cursor).toBeDefined()
  })

  test('two surfaces showing the pane do not share the wheel geometry', async ($, on) => {
    install(on, { 'a.txt': file(), 'long.txt': file(LINES(200)), 'z.txt': file() })
    const big = await open($, 40, 30, 'terminal')
    await big.ui.press({ key: K('long.txt') })
    // A second, shorter surface draws after it; its previewFrom overwrites the terminal's.
    const small = await open($, 40, 10, 'desktop')
    await small.read()
    // Row 8 is a tree row on the 30-row terminal (its box starts lower), so the wheel walks the cursor.
    await scroll($, 1, 30, 8)
    const v = await big.read()
    expect(v.source?.split('\n')[0]).toBe('line 0')
    expect(v.cursor).toBe('z.txt')
  })

  test('row keys stay distinct for a name with a lone surrogate and one spelling its escape', async ($, on) => {
    install(on, { 'a\ud800': file('one'), 'a￾d800': file('two') })
    const { read } = await open($)
    const keys = (await read()).rows.map(r => r.key)
    expect(new Set(keys).size).toBe(2)
  })
})

// Fixes for what the end-user run found, which the audit tests above do not cover.
describe('e2e', () => {
  test('blank lines in a text preview keep their rows', async ($, on) => {
    install(on, { 'blank.txt': file('a\n\nb\n\n\nc\n') })
    const { ui, read } = await open($, 40, 20)
    await ui.press({ key: K('blank.txt') })
    const v = await read()
    expect(v.source?.split('\n')).toEqual(['a', ' ', 'b', ' ', ' ', 'c'])
    expect(height(v.top)).toBe(21)
  })

  test('Home (by = -contentRows) takes the cursor to the first row', async ($, on) => {
    install(on, Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`f${String(i).padStart(3, '0')}.txt`, file()])))
    const { read } = await open($, 40, 20)
    await scroll($, 21, 20)
    expect((await read()).cursor).toBe('f099.txt')
    await scroll($, -21, 20)
    expect((await read()).cursor).toBe('f000.txt')
  })

  test('/tree asks the dock for a width', async ($, on) => {
    mock.store(on)
    const asked: (number | undefined)[] = []
    on('ui.open', async (_$, e) => {
      asked.push(e.columns)
      return { value: { isPlaced: true } }
    })
    await $.command.run({ command: 'tree', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
    expect(asked[0]).toBeGreaterThan(0)
  })

  test('Open never goes through cmd, which would parse the name again', async ($, on) => {
    const w = install(on, { 'a&calc.mp4': file('x'), '-dash.mp4': file('y') })
    const { ui } = await open($, 60, 20)
    for (const name of ['a&calc.mp4', '-dash.mp4']) {
      await ui.press({ key: K(name) })
      await ui.press({ key: 'open-default' })
    }
    expect(w.runs.some(r => r[0] === 'cmd')).toBe(false)
    // Every launcher gets the name as a path, never as an option.
    expect(w.runs.filter(r => r[0] === 'open' || r[0] === 'xdg-open').every(r => !r[r.length - 1]?.startsWith('-'))).toBe(true)
  })
})

// Re-audit of the fix commit. The first test is coverage for the image Box (it passes); each other one names a bug still there.
describe('re-audit', () => {
  const LINES = (n: number, p = 'line ') => Array.from({ length: n }, (_, i) => `${p}${i}`).join('\n')
  // Cells a box line may take: the border and paddingX={1} take two on each side.
  const boxWidths = (top: El, cols: number) => {
    const box = (top.children ?? []).filter(isEl).find(k => k.props?.borderStyle === 'round')
    if (!box) return [] as string[]
    const inner = cols - 4
    const bad: string[] = []
    for (const el of all(box)) {
      if (el.type === 'Button') {
        for (const l of String(el.props?.label ?? textOf(el)).split('\n')) if (width(l) + 4 > inner) bad.push(`button ${JSON.stringify(l)}`)
      } else if (el.type === 'Box' && el.props?.flexDirection === 'row' && all(el).some(k => k.props?.key === 'jump-top')) {
        const w = (el.children ?? []).filter(isEl).reduce((n, k) => n + width(textOf(k)) + (k.type === 'Button' ? 4 : 0), 0)
        if (w > inner) bad.push(`footer ${w} cells`)
      }
    }
    return bad
  }

  test('an image preview mounts on terminal and desktop with the body bodyRows + 1 tall', async ($, on) => {
    install(on, { 'a.txt': file(), 'pic.png': file('png', { px: { w: 800, h: 600 } }) })
    for (const surface of SURFACES) {
      // In a short pane the path rows come before the picture and can leave it no room, on purpose.
      for (const rows of [20, 40]) {
        const { ui, read } = await open($, 56, rows, surface)
        await ui.press({ key: K('pic.png') })
        const v = await read()
        // Only the terminal has an Image element; the desktop box keeps the headline, path and buttons.
        expect(all(v.top).some(e => e.type === 'Image'), `${surface} ${rows}: image drawn`).toBe(surface === 'terminal')
        expect(height(v.top), `${surface} bodyRows ${rows}`).toBe(rows + 1)
        await ui.press({ key: 'close-preview' })
        await ui.unmount()
      }
    }
  })

  // Heights all hold; what fails is width: under 28 columns "[ Show in file manager ]" (24 cells) and under 16 the
  // footer wrap past the box's inner width, adding rows the layout never counted.
  test('the body is bodyRows + 1 tall and every box line fits, at bodyRows 4..40 and narrow columns', { timeoutMs: 120000 }, async ($, on) => {
    // Twelve files make the hint "n/12 …"; the mp4's real path is long (the test root), as a real project's is.
    const tree: Tree = { 'long.txt': file(LINES(300)), 'clip.mp4': file('x'), 'pic.png': file('png', { px: { w: 400, h: 300 } }) }
    for (let i = 0; i < 9; i++) tree[`f${i}.txt`] = file()
    install(on, tree)
    const bad: string[] = []
    for (const cols of [8, 10, 14, 20, 24, 28, 40, 56]) {
      const { ui, read } = await open($, cols, 4)
      for (const pick of ['', 'long.txt', 'clip.mp4', 'pic.png']) {
        // Pressed in a tall pane, where every row is drawn.
        await ui.redraw(props(cols, 400))
        if (pick) await ui.press({ key: K(pick) })
        for (let rows = 4; rows <= 40; rows++) {
          await ui.redraw(props(cols, rows))
          const v = await read()
          const h = height(v.top)
          if (h !== rows + 1) bad.push(`${pick || 'none'} ${cols}x${rows}: height ${h}`)
          for (const b of boxWidths(v.top, cols)) bad.push(`${pick || 'none'} ${cols}x${rows}: ${b}`)
        }
        // Under 14 columns no box is drawn, so there is nothing to close.
        if (pick && (await read()).box) await ui.press({ key: 'close-preview' })
      }
      await ui.unmount()
    }
    // Grouped so the failure reads as a short list of ranges.
    const groups = new Map<string, number[]>()
    for (const b of bad) {
      const m = b.match(/^(\S+) (\d+)x(\d+): (.*?)(?: \d+| "[^"]*")?$/)
      const k = m ? `${m[1]} cols ${m[2]}: ${m[4]}` : b
      groups.set(k, [...(groups.get(k) ?? []), m ? Number(m[3]) : 0])
    }
    const summary = [...groups].map(([k, r]) => `${k} @ bodyRows ${Math.min(...r)}..${Math.max(...r)} (${r.length})`)
    expect(summary).toEqual([])
  })

  test('two surfaces with the same bodyRows but different widths each route the wheel by their own box', async ($, on) => {
    // Five 90-character lines wrap to 15 rows at 40 columns and stay 5 at 100, so the two boxes start on different rows.
    install(on, { 'a.txt': file(), 'wide.txt': file(LINES(5, 'w'.repeat(88))), 'z.txt': file() })
    const rows = 20
    const narrow = await open($, 40, rows, 'terminal')
    await narrow.ui.press({ key: K('wide.txt') })
    await narrow.read()
    const wide = await open($, 100, rows, 'desktop')
    const before = await wide.read()
    const kids = (before.top.children ?? []).filter(isEl)
    const boxRow = height(kids[0]) + height(kids[1])
    // On the 100-column surface this row is a tree row, two above its box; the 40-column surface's box starts higher.
    await scroll($, 1, rows, boxRow - 2)
    const after = await wide.read()
    expect(after.cursor, 'the wheel over a tree row walks the cursor').toBe('z.txt')
  })

  test('a cursor inside a deleted folder lands near that folder, not on the first row', async ($, on) => {
    const w = install(on, { a: dir(), b: dir(), d: dir({ 'x.txt': file() }), m: dir(), 'z.txt': file() })
    const { ui, read } = await open($)
    await ui.press({ key: K('d') })
    await ui.press({ key: K('d/x.txt') })
    expect((await read()).cursor).toBe('d/x.txt')
    remove(w, 'd')
    await ui.redraw()
    // Its parent is the root, which is no row, so the fallback ends at order[0] ('a') three rows away.
    expect((await read()).cursor).toBe('m')
  })
})

// Round three: what the second end-user run and the re-audit found.
describe('round 3', () => {
  test('a burst of wheel ticks moves the cursor by all of them', async ($, on) => {
    install(on, Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`f${String(i).padStart(2, '0')}.txt`, file()])))
    const { read } = await open($, 40, 20)
    await Promise.all([scroll($, 1, 20, 3), scroll($, 1, 20, 3), scroll($, 1, 20, 3)])
    expect((await read()).cursor).toBe('f03.txt')
  })

  test('the cursor follows the focus ring when the person Tabs onto a row', async ($, on) => {
    // The kit has no focus ring; this answers for it, beneath the plugin.
    on('ui.focus', async () => ({}))
    install(on, { 'a.txt': file(), 'b.txt': file(), 'c.txt': file() })
    const { read } = await open($)
    await $.ui.focus({ component: 'Pane', requestId: PANE, plugin: PANE, element: K('c.txt'), origin: { kind: 'person' } })
    const v = await read()
    expect([v.cursor, v.at]).toEqual(['c.txt', 3])
  })

  test('a file that could not be read is read again once it can be', async ($, on) => {
    const w = install(on, { 'a.txt': file('secret', { deny: 'EACCES' }) })
    const { ui, read } = await open($)
    await ui.press({ key: K('a.txt') })
    expect((await read()).boxText).toContain('EACCES')
    // A chmod: same bytes, same mtime and size.
    put(w, 'a.txt', file('secret'))
    await ui.redraw()
    expect((await read()).source).toBe('secret')
  })

  test('a short pane keeps the reason there is no preview', async ($, on) => {
    install(on, { 'a.txt': file('x', { deny: 'EACCES' }), 'clip.mp4': file('x') })
    for (const [name, why] of [['a.txt', 'EACCES'], ['clip.mp4', 'No preview']] as const) {
      for (const rows of [6, 7, 8]) {
        const { ui, read } = await open($, 40, rows)
        await ui.press({ key: K(name) })
        expect((await read()).boxText, `${name} bodyRows ${rows}`).toContain(why)
        await ui.press({ key: 'close-preview' })
        await ui.unmount()
      }
    }
  })

  test('a narrow box names the reveal button short so it stays on one line', async ($, on) => {
    install(on, { 'clip.mp4': file('x') })
    const { ui, read } = await open($, 24, 20)
    await ui.press({ key: K('clip.mp4') })
    const v = await read()
    expect(v.boxText).toContain('Show')
    expect(v.boxText).not.toContain('Show in file manager')
  })
})

describe('big files', () => {
  // A source file the size of a real module: numbered so the window's first and last rows are checkable.
  const SOURCE = (n: number) =>
    Array.from({ length: n }, (_, i) => (i % 10 === 0 ? '' : `export const v${i} = ${i} // line ${i + 1}`)).join('\n')

  for (const n of [500, 1000, 5000]) {
    test(`a ${n}-line file opens, scrolls by the wheel and jumps to its end`, { timeoutMs: 30000 }, async ($, on) => {
      const w = install(on, { 'a.txt': file(), 'big.ts': file(SOURCE(n)) })
      const { ui, read } = await open($, 60, 30)
      const t0 = Date.now()
      await ui.press({ key: K('big.ts') })
      const v = await read()
      const first = Date.now() - t0
      expect(v.footer).toBe(true)
      expect(v.range).toBe(`1-${v.codeLines}/${n}`)
      expect(height(v.top)).toBe(31)
      // Ten wheel ticks over the box move its window ten rows and read the file no more.
      const reads = w.reads.length
      const boxRow = height((v.top.children ?? []).filter(isEl)[0]) + height((v.top.children ?? []).filter(isEl)[1]) + 1
      const t1 = Date.now()
      for (let i = 0; i < 10; i++) await scroll($, 1, 30, boxRow)
      const wheel = (Date.now() - t1) / 10
      expect((await read()).range?.startsWith('11-')).toBe(true)
      expect(w.reads.length).toBe(reads)
      await ui.press({ key: 'jump-end' })
      const end = await read()
      expect(end.range?.endsWith(`-${n}/${n}`)).toBe(true)
      expect(end.source?.split('\n').pop()).toContain(`line ${n}`)
      await ui.press({ key: 'jump-top' })
      expect((await read()).range?.startsWith('1-')).toBe(true)
      console.log(`${n} lines: open ${first} ms, wheel tick ${wheel.toFixed(1)} ms`)
      expect(first).toBeLessThan(2000)
      expect(wheel).toBeLessThan(200)
    })
  }
})

// Re-audit of 61968f0: each test names a bug still there.
describe('round 4', () => {
  const LINES = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n')

  test('two surfaces whose boxes start on the same row both scroll their preview on a wheel over it', async ($, on) => {
    // 40 and 41 columns: the same hint, box and previewFrom, so the wheel takes the first surface's window only.
    install(on, { 'a.txt': file(), 'long.txt': file(LINES(200)) })
    const rows = 20
    const one = await open($, 40, rows, 'terminal')
    await one.ui.press({ key: K('long.txt') })
    const two = await open($, 41, rows, 'desktop')
    await two.read()
    await scroll($, 1, rows, rows - 1)
    const a = await one.read()
    const b = await two.read()
    expect([a.source?.split('\n')[0], b.source?.split('\n')[0]]).toEqual(['line 1', 'line 1'])
  })

  test('under 14 columns, where no box is drawn, selecting an image runs no sips and a text file is not read', async ($, on) => {
    const w = install(on, { 'big.txt': file(LINES(1000)), 'pic.png': file('png', { px: { w: 800, h: 600 } }) })
    const { ui, read } = await open($, 12, 200)
    await ui.press({ key: K('pic.png') })
    await ui.press({ key: K('big.txt') })
    expect((await read()).box).toBeUndefined()
    expect({ runs: w.runs.map(r => r[0]), reads: w.reads }).toEqual({ runs: [], reads: [] })
  })
})

describe('code preview', () => {
  // The box's lines as drawn: the gutter's numbers, and each run as Code (code) or Text (plain, dim for a comment).
  const preview = (box: El | undefined) => {
    const row = box ? all(box).find(e => e.type === 'Box' && e.props?.flexDirection === 'row' && !all(e).some(k => k.props?.key === 'jump-top')) : undefined
    const kids = (row?.children ?? []).filter(isEl)
    const gutter = kids[0]?.type === 'Text' ? textOf(kids[0]).split('\n').map(s => s.trim()) : []
    const runs = (textColumn(kids)?.children ?? []).filter(isEl).map(r => ({
      as: r.type === 'Code' ? 'code' : r.props?.dimColor ? 'comment' : 'plain',
      lines: (r.type === 'Code' ? String(r.props?.source ?? '') : textOf(r)).split('\n'),
    }))
    return { gutter, runs }
  }

  test('lines inside a block comment or a template literal are drawn plain, not through the highlighter', async ($, on) => {
    install(on, { 'a.ts': file('/**\n * function const return 42\n */\nconst a = 1 // tail\nconst s = `one\ntwo function 7\n`\nconst b = 2') })
    const { ui, read } = await open($, 60, 30)
    await ui.press({ key: K('a.ts') })
    const { gutter, runs } = preview((await read()).box)
    expect(gutter).toEqual(['1', '2', '3', '4', '5', '6', '7', '8'])
    expect(runs.map(r => [r.as, r.lines.length])).toEqual([['code', 1], ['comment', 2], ['code', 2], ['plain', 2], ['code', 1]])
  })

  test('a Python docstring is drawn plain, and # or a quote in code opens nothing', async ($, on) => {
    install(on, { 'b.py': file('def f():\n    """doc\n    def class return\n    """\n    s = "it\'s # not"  # a """ in a comment\n    return 1') })
    const { ui, read } = await open($, 60, 30)
    await ui.press({ key: K('b.py') })
    const { runs } = preview((await read()).box)
    expect(runs.map(r => [r.as, r.lines.length])).toEqual([['code', 2], ['plain', 2], ['code', 2]])
  })

  test('the gutter numbers the lines shown, from where the window starts', async ($, on) => {
    install(on, { 'n.txt': file(Array.from({ length: 300 }, (_, i) => `row ${i + 1}`).join('\n')) })
    const { ui, read } = await open($, 40, 20)
    await ui.press({ key: K('n.txt') })
    await ui.press({ key: 'jump-end' })
    const v = await read()
    const { gutter, runs } = preview(v.box)
    expect(gutter[gutter.length - 1]).toBe('300')
    expect(runs[0]?.lines[0]).toBe(`row ${gutter[0]}`)
  })

  test('PageDown and PageUp scroll an open text preview by its height; with none they page the tree', async ($, on) => {
    install(on, { 'long.txt': file(Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n')), ...Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`f${String(i).padStart(2, '0')}.txt`, file()])) })
    const rows = 20
    const { ui, read } = await open($, 40, rows)
    await scroll($, rows, rows)
    expect((await read()).at).toBe(21)
    // End brings long.txt, the last row, into the window.
    await scroll($, rows + 1, rows)
    await ui.press({ key: K('long.txt') })
    const room = (await read()).codeLines
    await scroll($, rows, rows)
    expect((await read()).range).toBe(`${room}-${2 * room - 1}/200`)
    await scroll($, -rows, rows)
    expect((await read()).range).toBe(`1-${room}/200`)
    expect((await read()).cursor).toBe('long.txt')
  })

  test('a 200 KB one-line minified file wraps, stays under the 100,000 characters a drawing takes, and scrolls to its end', async ($, on) => {
    install(on, { 'min.js': file('var a=1;'.repeat(25000)) })
    const { ui, read } = await open($, 60, 30)
    await ui.press({ key: K('min.js') })
    const v = await read()
    expect(textOf(v.top).length).toBeLessThan(100000)
    expect(v.range).toBe('1-1/1')
    expect(v.codeLines).toBeGreaterThan(1)
    await ui.press({ key: 'jump-end' })
    expect((await read()).source?.split('\n').pop()?.trimEnd()).toMatch(/var a=1;$/)
  })

  test('the range counts the file\'s lines, not wrapped rows', async ($, on) => {
    install(on, { 'wide.ts': file(Array.from({ length: 1000 }, (_, i) => `const x${i} = '${'w'.repeat(290)}'`).join('\n')) })
    const { ui, read } = await open($, 60, 30)
    await ui.press({ key: K('wide.ts') })
    expect((await read()).range).toMatch(/^1-\d+\/1000$/)
  })
})

// Re-audit of 8adc96b: each test names a bug still there.
describe('round 5', () => {
  // How the box draws its lines: each run as code (through Code), comment (dim Text) or plain (Text).
  const runsOf = (box: El | undefined) => {
    const row = box ? all(box).find(e => e.type === 'Box' && e.props?.flexDirection === 'row' && !all(e).some(k => k.props?.key === 'jump-top')) : undefined
    const kids = (row?.children ?? []).filter(isEl)
    return (kids[kids.length - 1]?.children ?? []).filter(isEl).map(r => [r.type === 'Code' ? 'code' : r.props?.dimColor ? 'comment' : 'plain', (r.type === 'Code' ? String(r.props?.source ?? '') : textOf(r)).split('\n').length])
  }
  const show = async ($: Engine, on: On, name: string, text: string) => {
    install(on, { [name]: file(text) })
    const { ui, read } = await open($, 80, 30)
    await ui.press({ key: K(name) })
    return runsOf((await read()).box)
  }

  test('a regex literal holding "/*" does not grey out the code after it', async ($, on) => {
    // `/\/*$/` trims trailing slashes; the scanner takes its "/*" for a block comment that never closes.
    const runs = await show($, on, 'trim.ts', "const trim = (s: string) => s.replace(/\\/*$/, '')\nexport const a = 1\nexport const b = 2")
    expect(runs).toEqual([['code', 3]])
  })

  test('a regex literal holding a backtick does not turn the code after it into a string', async ($, on) => {
    // Markdown escaping: the backtick in the character class opens a template literal that never closes.
    const runs = await show($, on, 'md.ts', "const esc = (s: string) => s.replace(/[`*_]/g, '\\\\$&')\nexport const a = 1\nexport const b = 2")
    expect(runs).toEqual([['code', 3]])
  })

  test('a Go raw string ending in a backslash closes there', async ($, on) => {
    // Raw strings have no escapes; the scanner skips the closing backtick after the backslash.
    const runs = await show($, on, 'p.go', 'package main\n\nconst sep = `\\`\n\nfunc main() {}\nfunc other() {}')
    expect(runs).toEqual([['code', 6]])
  })

  test('in CSS, "//" in an unquoted url() does not hide a block comment opened after it', async ($, on) => {
    // "//" is no comment in CSS; breaking there misses the "/*" that follows, so the comment's next line is coloured as code.
    const runs = await show($, on, 's.css', 'a { background: url(//cdn.example/x.png); } /* note\n   still the comment\n*/\nb { color: red; }')
    expect(runs).toEqual([['code', 1], ['comment', 2], ['code', 1]])
  })

  test('a tall box of long lines keeps its footer and every line (a drawing is cut at 100,000 characters)', { timeoutMs: 30000 }, async ($, on) => {
    // 300 lines of 1,000 characters: each is under the per-line cap, but a 200-row pane hands 116 of them to Code
    // whole. The engine cuts the drawing at 100,000 characters: the source ends "… N more" and the footer is dropped,
    // while the gutter still numbers the rows that were cut.
    install(on, { 'rows.txt': file(Array.from({ length: 300 }, (_, i) => `${i}:`.padEnd(1000, 'x')).join('\n')) })
    const { ui, read } = await open($, 80, 200)
    await ui.press({ key: K('rows.txt') })
    const v = await read()
    expect(v.box, 'the box is drawn').toBeDefined()
    const src = all(v.top).filter(e => e.type === 'Code').map(e => String(e.props?.source ?? '')).join('\n').split('\n')
    expect(src[src.length - 1] ?? '', 'last line drawn').not.toMatch(/more$/)
    expect(v.footer, 'footer drawn').toBe(true)
  })

  test('a file cut at 4 MiB says so in a short pane, where no footer is drawn', { timeoutMs: 20000 }, async ($, on) => {
    install(on, { 'over.txt': file(('y'.repeat(63) + '\n').repeat(65536) + 'z') })
    const { ui, read } = await open($, 40, 9)
    await ui.press({ key: K('over.txt') })
    const v = await read()
    expect(v.box).toBeDefined()
    expect(v.boxText ?? '', 'the cut is mentioned somewhere in the box').toMatch(/cut|first/)
  })
})

describe('wrapping', () => {
  const rowsOf = (box: El | undefined) => {
    const row = box ? all(box).find(e => e.type === 'Box' && e.props?.flexDirection === 'row' && !all(e).some(k => k.props?.key === 'jump-top')) : undefined
    const kids = (row?.children ?? []).filter(isEl)
    const gutter = kids[0]?.type === 'Text' ? textOf(kids[0]).split('\n') : []
    const runs = (textColumn(kids)?.children ?? []).filter(isEl)
    const lines = runs.flatMap(r => (r.type === 'Code' ? String(r.props?.source ?? '') : textOf(r)).split('\n').map(text => ({ text, as: r.type === 'Code' ? 'code' : r.props?.dimColor ? 'comment' : 'plain' })))
    return { gutter, lines }
  }

  test('a long line wraps inside the box, at spaces, and none of it is lost', async ($, on) => {
    const words = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ')
    const line = `    const text = ${words}`
    install(on, { 'w.ts': file(`${line}\nconst after = 1`) })
    const cols = 50
    const { ui, read } = await open($, cols, 40)
    await ui.press({ key: K('w.ts') })
    const { gutter, lines } = rowsOf((await read()).box)
    const mine = lines.slice(0, -1)
    expect(mine.length).toBeGreaterThan(3)
    // Every row fits the box beside the gutter.
    for (const l of lines) expect(width(l.text) + (gutter[0]?.length ?? 0)).toBeLessThanOrEqual(cols - 4)
    // Only the first row is numbered; continuation rows are indented past the line's own indent.
    expect(gutter.map(g => g.trim())).toEqual(['1', ...mine.slice(1).map(() => ''), '2'])
    for (const l of mine.slice(1)) expect(l.text.startsWith('      ')).toBe(true)
    // Rows break after a space, never inside a word, and together they are the whole line.
    for (const l of mine.slice(0, -1)) expect(l.text.endsWith(' ')).toBe(true)
    expect(mine.map((l, i) => (i ? l.text.trimStart() : l.text)).join('')).toBe(line)
  })

  test('a continuation row that starts inside a string or a line comment is drawn plain, not highlighted', async ($, on) => {
    const long = Array.from({ length: 30 }, () => 'function const return').join(' ')
    install(on, { 's.ts': file(`const s = "${long}"\nconst t = 1 // ${long}\nconst u = 2`) })
    const { ui, read } = await open($, 50, 60)
    await ui.press({ key: K('s.ts') })
    const { gutter, lines } = rowsOf((await read()).box)
    const starts = gutter.map((g, i) => (g.trim() ? i : -1)).filter(i => i >= 0)
    const [s1 = 0, s2 = 0, s3 = 0] = starts
    expect(lines[s1]?.as).toBe('code')
    for (const l of lines.slice(s1 + 1, s2)) expect(l.as).toBe('plain')
    expect(lines[s2]?.as).toBe('code')
    for (const l of lines.slice(s2 + 1, s3)) expect(l.as).toBe('comment')
    expect(lines[s3]?.as).toBe('code')
  })

  test('a window that starts on a continuation row says which line it is in', async ($, on) => {
    const long = Array.from({ length: 80 }, (_, i) => `w${i}`).join(' ')
    install(on, { 'r.txt': file(`${long}\n${long}\nshort`) })
    const rows = 12
    const { ui, read } = await open($, 40, rows)
    await ui.press({ key: K('r.txt') })
    const v = await read()
    const kids = (v.top.children ?? []).filter(isEl)
    const boxRow = height(kids[0]) + height(kids[1]) + 2
    await scroll($, 3, rows, boxRow)
    expect((await read()).range).toMatch(/^1-\d\/3$/)
  })
})

describe('round 6', () => {
  test('PageDown over a text preview that cannot scroll leaves the tree cursor where it is', async ($, on) => {
    install(on, { 'one.txt': file('just one line'), ...Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`f${String(i).padStart(2, '0')}.txt`, file()])) })
    const rows = 20
    const { ui, read } = await open($, 40, rows)
    await ui.press({ key: K('f00.txt') })
    await scroll($, rows, rows)
    expect((await read()).cursor).toBe('f00.txt')
  })

  test('PageDown with an opaque preview open still pages the tree', async ($, on) => {
    install(on, { 'a.mp4': file('x'), ...Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`f${String(i).padStart(2, '0')}.txt`, file()])) })
    const rows = 20
    const { ui, read } = await open($, 40, rows)
    await ui.press({ key: K('a.mp4') })
    await scroll($, rows, rows)
    expect((await read()).at).toBe(21)
  })
})

// Re-audit of f50ddb7: the first two tests name bugs still there; the last two are coverage (they pass).
describe('round 6', () => {
  const runsOf = (box: El | undefined) => {
    const row = box ? all(box).find(e => e.type === 'Box' && e.props?.flexDirection === 'row' && !all(e).some(k => k.props?.key === 'jump-top')) : undefined
    const kids = (row?.children ?? []).filter(isEl)
    return (kids[kids.length - 1]?.children ?? []).filter(isEl).map(r => [r.type === 'Code' ? 'code' : r.props?.dimColor ? 'comment' : 'plain', (r.type === 'Code' ? String(r.props?.source ?? '') : textOf(r)).split('\n').length])
  }
  const BIG = ('y'.repeat(63) + '\n').repeat(65536) + 'z'

  test('a division after ++ is not read as a regex that resyncs inside a string', async ($, on) => {
    // The skip runs from "/ 2" to the "/" inside 'a/b', then reads the string's "/*" as a comment that never closes.
    install(on, { 'd.ts': file("x = a++ / 2; s = 'a/b /* not'\nexport const a = 1\nexport const b = 2") })
    const { ui, read } = await open($, 80, 30)
    await ui.press({ key: K('d.ts') })
    expect(runsOf((await read()).box)).toEqual([['code', 3]])
  })

  test('the "· cut" title mark fits the box at 14 and 15 columns', { timeoutMs: 30000 }, async ($, on) => {
    // With no footer under 20 columns the mark goes on the title, but the name is only shrunk to 1 cell:
    // "[ … · cut ]" plus the trailing space is 12 cells against an inner width of 10 and 11.
    install(on, { 'over.txt': file(BIG) })
    const bad: string[] = []
    for (const cols of [14, 15, 16, 20]) {
      const { ui, read } = await open($, cols, 400)
      await ui.press({ key: K('over.txt') })
      await ui.redraw(props(cols, 20))
      const v = await read()
      const label = String(all(v.box ?? v.top).find(e => e.props?.key === 'close-preview')?.props?.label ?? textOf(all(v.box ?? v.top).find(e => e.props?.key === 'close-preview')))
      if (width(label) + 4 > cols - 4) bad.push(`cols ${cols}: ${JSON.stringify(label)} is ${width(label) + 4} cells, room ${cols - 4}`)
      await ui.unmount()
    }
    expect(bad).toEqual([])
  })

  test('soft-wrapped previews keep the body bodyRows + 1 tall and every row inside the column', { timeoutMs: 120000 }, async ($, on) => {
    const src = [
      '/* a block comment that runs long enough to wrap onto a second and a third row of the box',
      '   and goes on */',
      "export const s = 'a string literal that is long enough to wrap across rows, with // and /* inside'",
      '    const 漢字 = "全角文字列全角文字列全角文字列全角文字列全角文字列全角文字列全角文字列"',
      ' '.repeat(90),
      'const t = `template ' + 'x'.repeat(120) + '`',
    ].join('\n')
    install(on, { 'w.ts': file(src), ...Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`f${i}.txt`, file()])) })
    const bad: string[] = []
    for (const cols of [14, 16, 20, 28, 40, 56]) {
      const { ui, read } = await open($, cols, 400)
      await ui.press({ key: K('w.ts') })
      for (let rows = 4; rows <= 40; rows++) {
        await ui.redraw(props(cols, rows))
        const v = await read()
        if (height(v.top) !== rows + 1) bad.push(`${cols}x${rows}: height ${height(v.top)}`)
        const col = v.box ? all(v.box).find(e => e.type === 'Box' && typeof e.props?.width === 'number') : undefined
        const w = Number(col?.props?.width ?? 0)
        for (const k of (col?.children ?? []).filter(isEl))
          for (const l of (k.type === 'Code' ? String(k.props?.source ?? '') : textOf(k)).split('\n')) if (width(l) > w) bad.push(`${cols}x${rows}: row ${width(l)} > ${w}`)
      }
      await ui.unmount()
    }
    expect(bad).toEqual([])
  })

  test('a 4 MiB log lays out again within a second at each new width', { timeoutMs: 60000 }, async ($, on) => {
    install(on, { 'big.log': file(BIG) })
    const { ui, read } = await open($, 60, 30)
    let t = Date.now()
    await ui.press({ key: K('big.log') })
    await read()
    const times = [Date.now() - t]
    for (const cols of [61, 62, 63, 64, 65]) {
      t = Date.now()
      await ui.redraw(props(cols, 30))
      await read()
      times.push(Date.now() - t)
    }
    console.log(`4 MiB log: open then 5 widths, ms ${times.join(' ')}`)
    expect(Math.max(...times)).toBeLessThan(1000)
  })
})

// Audit of e1d230e (FE0F as one cell, cut-mark guard): these name bugs that diff introduced.
describe('round 7', () => {
  // A U+FE0F at the start of a line, or after the indent, has been cut from the emoji it belongs to.
  const stranded = (lines: string[]) => lines.filter(l => /(^|\s)️/.test(l)).map(l => JSON.stringify(l))
  const BIG = ('y'.repeat(63) + '\n').repeat(65536) + 'z'

  test('a tree name never wraps between ❤ and its U+FE0F', async ($, on) => {
    // At 20 columns a depth-0 name gets 13 cells: twelve letters and ❤ fill them, and FE0F (now one cell) wraps alone.
    install(on, { 'abcdefghijkl❤️x.txt': file() })
    const v = await (await open($, 20, 20)).read()
    expect(stranded(v.rows.flatMap(r => r.label.split('\n')))).toEqual([])
  })

  test('a wrapped preview line never splits ❤ from its U+FE0F', async ($, on) => {
    // 40 columns leave 34 cells beside a 2-cell gutter: 33 x's and ❤ fill row one, FE0F starts row two.
    install(on, { 'h.txt': file('x'.repeat(33) + '❤️' + 'y'.repeat(10)) })
    const { ui, read } = await open($, 40, 20)
    await ui.press({ key: K('h.txt') })
    expect(stranded(((await read()).source ?? '').split('\n'))).toEqual([])
  })

  test('a cut file with no footer keeps "· cut" in the title wherever it fits (16 and 33 columns)', { timeoutMs: 30000 }, async ($, on) => {
    // The label has cols - 8 cells: at 16 "… · cut " is 8, at 33 "… · cut (press to close)" is 24 of 25, yet the guard drops the mark.
    install(on, { 'over.txt': file(BIG) })
    const bad: string[] = []
    for (const [cols, rows] of [[16, 20], [33, 8]] as const) {
      const { ui, read } = await open($, cols, 400)
      await ui.press({ key: K('over.txt') })
      await ui.redraw(props(cols, rows))
      const v = await read()
      const el = all(v.box ?? v.top).find(e => e.props?.key === 'close-preview')
      const label = String(el?.props?.label ?? textOf(el))
      if (v.footer) bad.push(`cols ${cols}: has a footer, test setup is wrong`)
      else if (!label.includes('cut')) bad.push(`cols ${cols}: ${JSON.stringify(label)} (${width(label)} of ${cols - 8} cells) has no cut mark`)
      await ui.unmount()
    }
    expect(bad).toEqual([])
  })
})

describe('round 8', () => {
  test('a resize keeps the preview on the line it showed', async ($, on) => {
    install(on, { 'wide.ts': file(Array.from({ length: 300 }, (_, i) => `const line${i + 1} = '${'word '.repeat(50)}'`).join('\n')) })
    const rows = 30
    const { ui, read } = await open($, 120, rows)
    await ui.press({ key: K('wide.ts') })
    for (let i = 0; i < 6; i++) await scroll($, rows, rows)
    const before = (await read()).range?.split('-')[0]
    for (const cols of [80, 60, 140, 120]) {
      await ui.redraw(props(cols, rows))
      expect((await read()).range?.split('-')[0], `cols ${cols}`).toBe(before)
    }
  })
})

describe('round 9', () => {
  const bar = (box: El | undefined) =>
    (box ? all(box) : []).filter(e => String(e.props?.key ?? '').startsWith('sb-')).map(e => String(e.props?.label))
  const ring = (on: On) => on('ui.focus', async () => ({}))
  const tab = ($: Engine, element: string) =>
    $.ui.focus({ component: 'Pane', requestId: PANE, plugin: PANE, element, origin: { kind: 'person' } })
  const long = () => file(Array.from({ length: 300 }, (_, i) => `row ${i + 1}`).join('\n'))

  test('a file taller than the box gets a scrollbar whose thumb follows the window', async ($, on) => {
    install(on, { 'n.txt': long() })
    const rows = 20
    const { ui, read } = await open($, 40, rows)
    await ui.press({ key: K('n.txt') })
    let v = await read()
    const cells = bar(v.box)
    expect(cells.length).toBe(v.codeLines)
    expect(cells[0]).toBe('█')
    expect(cells[cells.length - 1]).toBe('│')
    expect(height(v.top)).toBe(rows + 1)
    await ui.press({ key: 'jump-end' })
    v = await read()
    expect(bar(v.box)[0]).toBe('│')
    expect(bar(v.box).at(-1)).toBe('█')
  })

  test('the thumb is one box for any file length, so Terminal.app shows one bar and not a stack', async ($, on) => {
    install(on, { 'mid.txt': file(Array.from({ length: 40 }, (_, i) => `row ${i + 1}`).join('\n')), 'long.txt': long() })
    const { ui, read } = await open($, 40, 20)
    for (const name of ['mid.txt', 'long.txt']) {
      await ui.press({ key: K(name) })
      for (const jump of [undefined, 'jump-end']) {
        if (jump) await ui.press({ key: jump })
        const cells = bar((await read()).box)
        expect(cells.filter(c => c === '█'), `${name} ${jump ?? 'top'}`).toHaveLength(1)
      }
    }
  })

  test('the scrollbar takes a column from the text, and a file that fits has none', async ($, on) => {
    const line = 'x'.repeat(200)
    install(on, { 'tall.txt': file(Array.from({ length: 40 }, () => line).join('\n')), 'short.txt': file(line) })
    const cols = 40
    const { ui, read } = await open($, cols, 30)
    await ui.press({ key: K('tall.txt') })
    let v = await read()
    expect(bar(v.box).length).toBeGreaterThan(0)
    // Gutter "NN " is 3 cells, the bar 1: 40 - 4 - 3 - 1.
    expect(Math.max(...(v.source ?? '').split('\n').map(width))).toBe(cols - 4 - 3 - 1)
    await ui.press({ key: K('short.txt') })
    v = await read()
    expect(bar(v.box)).toHaveLength(0)
    expect(Math.max(...(v.source ?? '').split('\n').map(width))).toBe(cols - 4 - 2)
  })

  test('pressing a scrollbar cell opens the file that far down', async ($, on) => {
    install(on, { 'n.txt': long() })
    const { ui, read } = await open($, 40, 20)
    await ui.press({ key: K('n.txt') })
    const n = bar((await read()).box).length
    await ui.press({ key: `sb-${n - 1}` })
    expect((await read()).range).toMatch(/-300\/300$/)
    await ui.press({ key: `sb-${Math.floor((n - 1) / 2)}` })
    const mid = Number((await read()).range?.split('-')[0])
    expect(mid).toBeGreaterThan(100)
    expect(mid).toBeLessThan(200)
    await ui.press({ key: 'sb-0' })
    expect((await read()).range).toMatch(/^1-/)
  })

  test('Tab into the preview: the arrows, Home/End and the wheel scroll the file; Tab again walks the tree', async ($, on) => {
    ring(on)
    install(on, { 'a.txt': file(), 'n.txt': long(), 'z.txt': file() })
    const rows = 20
    const { ui, read } = await open($, 50, rows)
    await ui.press({ key: K('n.txt') })
    expect((await read()).hint).toContain('Tab preview')
    // Tab from the cursor's row lands on the next row; the plugin turns it into the preview.
    await tab($, K('z.txt'))
    let v = await read()
    expect(v.hint).toContain('↑↓ scroll')
    expect(v.cursor).toBe('n.txt')
    await scroll($, 1, rows)
    await scroll($, 1, rows)
    expect((await read()).range).toMatch(/^3-/)
    // A wheel over the tree scrolls the file too while the keys are in the preview.
    await scroll($, 3, rows, 2)
    expect((await read()).range).toMatch(/^6-/)
    await scroll($, rows + 1, rows)
    expect((await read()).range).toMatch(/-300\/300$/)
    await scroll($, -(rows + 1), rows)
    expect((await read()).range).toMatch(/^1-/)
    expect((await read()).cursor).toBe('n.txt')
    // Tab out of the title: back on the cursor's row, and the arrows walk the tree again.
    await tab($, 'sb-0')
    v = await read()
    expect(v.hint).toContain('Tab preview')
    await scroll($, 1, rows)
    expect((await read()).cursor).toBe('z.txt')
  })

  test('a press on a row hands the keys back to the tree', async ($, on) => {
    ring(on)
    install(on, { 'a.txt': file(), 'n.txt': long() })
    const rows = 20
    const { ui, read } = await open($, 50, rows)
    await ui.press({ key: K('n.txt') })
    await ui.press({ key: 'jump-end' })
    expect((await read()).hint).toContain('↑↓ scroll')
    await ui.press({ key: K('a.txt') })
    await scroll($, 1, rows)
    const v = await read()
    expect(v.hint).toContain('↑↓ move')
    expect(v.cursor).toBe('n.txt')
  })

  test('with no text preview Tab walks the rows as before', async ($, on) => {
    ring(on)
    install(on, { 'a.txt': file(), 'b.mp4': file('x'), 'c.txt': file() })
    const { ui, read } = await open($)
    await ui.press({ key: K('b.mp4') })
    await tab($, K('c.txt'))
    const v = await read()
    expect(v.cursor).toBe('c.txt')
    expect(v.hint).not.toContain('scroll')
  })

  test('Tab between tree and preview keeps the hint and the box the same height', async ($, on) => {
    ring(on)
    install(on, { 'a.txt': file(), 'n.txt': long() })
    for (const cols of [20, 30, 47, 60]) {
      const { ui, read } = await open($, cols, 20)
      await ui.press({ key: K('n.txt') })
      await tab($, K('a.txt'))
      const before = await read()
      await tab($, K('a.txt'))
      const after = await read()
      expect(before.hint.split('\n').length, `cols ${cols}`).toBe(after.hint.split('\n').length)
      expect(before.codeLines, `cols ${cols}`).toBe(after.codeLines)
      expect(height(after.top), `cols ${cols}`).toBe(21)
      await ui.unmount?.()
    }
  })

  // Audit of 25bcc25.
  test('a text file that fits its box has no scrollbar and Tab walks the rows as before', async ($, on) => {
    ring(on)
    install(on, { 'a.txt': file(), 'b.txt': file('one\ntwo'), 'c.txt': file() })
    const { ui, read } = await open($, 50, 20)
    await ui.press({ key: K('b.txt') })
    let v = await read()
    expect(bar(v.box)).toHaveLength(0)
    expect(v.hint).not.toContain('Tab preview')
    await tab($, K('c.txt'))
    v = await read()
    expect(v.cursor).toBe('c.txt')
    expect(v.hint).not.toContain('scroll')
  })

  test('a file that shrinks to fit while the keys are in the preview gives them back to the tree', async ($, on) => {
    ring(on)
    const w = install(on, { 'a.txt': file(), 'n.txt': long(), 'z.txt': file() })
    const rows = 20
    const { ui, read } = await open($, 50, rows)
    await ui.press({ key: K('n.txt') })
    await tab($, K('z.txt'))
    expect((await read()).hint).toContain('↑↓ scroll')
    put(w, 'n.txt', { kind: 'file', text: 'short now', size: 9 })
    await ui.redraw()
    await scroll($, 1, rows)
    const v = await read()
    expect(v.cursor).toBe('z.txt')
    expect(v.hint).not.toContain('scroll')
  })

  test('a pane too short for a three-cell bar draws none, keeps the text its width, and Tab still scrolls the file', async ($, on) => {
    ring(on)
    install(on, { 'a.txt': file(), 'n.txt': long() })
    for (const rows of [5, 6, 7, 8]) {
      const { ui, read } = await open($, 40, rows)
      await ui.press({ key: K('n.txt') })
      let v = await read()
      expect(bar(v.box), `rows ${rows}`).toHaveLength(0)
      expect(height(v.top), `rows ${rows}`).toBe(rows + 1)
      // The window carries over from the last size, so the check is one row on from wherever it starts.
      const first = Number(v.source?.split('\n')[0]?.slice(4))
      await tab($, K('a.txt'))
      await scroll($, 1, rows)
      v = await read()
      expect(v.source?.split('\n')[0], `rows ${rows}`).toBe(`row ${first + 1}`)
      await tab($, K('a.txt'))
      await ui.unmount?.()
    }
  })

  test('a desktop surface draws no scrollbar (a plain Button is a native button there)', async ($, on) => {
    install(on, { 'n.txt': long() })
    const { ui, read } = await open($, 50, 20, 'desktop')
    await ui.press({ key: K('n.txt') })
    expect(bar((await read()).box)).toHaveLength(0)
  })

  test('a surface too narrow for a box leaves the other surface in the preview', async ($, on) => {
    ring(on)
    install(on, { 'a.txt': file(), 'n.txt': long(), 'z.txt': file() })
    const rows = 20
    const one = await open($, 50, rows)
    await one.ui.press({ key: K('n.txt') })
    await tab($, K('z.txt'))
    const two = await open($, 12, 15, 'desktop')
    await two.read()
    await scroll($, 1, rows)
    const v = await one.read()
    expect(v.cursor).toBe('n.txt')
    expect(v.range).toMatch(/^2-/)
  })

  test('a one-line minified file on two surfaces scrolls without laying the file out on every tick', { timeoutMs: 60000 }, async ($, on) => {
    const words = Array.from({ length: 400000 }, (_, i) => `v${i % 97}`).join(',')
    install(on, { 'm.js': file(words) })
    const one = await open($, 60, 20)
    await one.ui.press({ key: K('m.js') })
    await one.read()
    const two = await open($, 70, 24, 'desktop')
    await two.read()
    const times: number[] = []
    for (let i = 0; i < 4; i++) {
      const t = Date.now()
      await scroll($, 1, 20, 18)
      await one.read()
      await two.read()
      times.push(Date.now() - t)
    }
    console.log(`minified on two surfaces, ms per tick ${times.join(' ')}`)
    expect(Math.max(...times)).toBeLessThan(50)
  })

  // End-user test of 25bcc25.
  test('Tab from the title toward one of the engine stops goes back to the tree, not onto the stop', async ($, on) => {
    ring(on)
    install(on, { 'a.txt': file(), 'n.txt': long(), 'z.txt': file() })
    const rows = 7
    const { ui, read } = await open($, 40, rows)
    await ui.press({ key: K('n.txt') })
    await tab($, K('z.txt'))
    expect((await read()).hint).toContain('↑↓ scroll')
    // No bar or footer at 7 rows: the next stop after the title is the pane's own close mark.
    const r = await $.ui.focus({ component: 'Pane', requestId: PANE, origin: { kind: 'person' } })
    expect(r).toEqual({})
    await scroll($, 1, rows)
    const v = await read()
    expect(v.hint).not.toContain('↑↓ scroll')
    expect(v.cursor).toBe('z.txt')
  })

  test('Tab onto any row (the first, when no ring is drawn) goes into a preview that scrolls', async ($, on) => {
    ring(on)
    const many = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`f${i}.txt`, file()]))
    install(on, { ...many, 'n.txt': long() })
    const { ui, read } = await open($, 50, 30)
    await ui.press({ key: K('n.txt') })
    await tab($, K('f0.txt'))
    const v = await read()
    expect(v.hint).toContain('↑↓ scroll')
    expect(v.cursor).toBe('n.txt')
  })

  test('the thumb takes the last cell only at the end, and sits on the cell pressed', async ($, on) => {
    install(on, { 'n.txt': file(Array.from({ length: 5000 }, (_, i) => `row ${i + 1}`).join('\n')) })
    const rows = 30
    const { ui, read } = await open($, 50, rows)
    await ui.press({ key: K('n.txt') })
    await ui.press({ key: 'jump-end' })
    await scroll($, -1, rows)
    const v = await read()
    expect(v.range).toMatch(/-4999\/5000$/)
    let cells = bar(v.box)
    expect(cells.at(-1)).toBe('│')
    for (const i of [1, 5, 9, cells.length - 2]) {
      await ui.press({ key: `sb-${i}` })
      cells = bar((await read()).box)
      expect(cells.indexOf('█'), `cell ${i}`).toBe(i)
    }
  })

  test('a box with no room for text keeps Tab in the tree', async ($, on) => {
    ring(on)
    install(on, { 'a.txt': file(), 'n.txt': long(), 'z.txt': file() })
    const rows = 4
    const { ui, read } = await open($, 40, rows)
    await ui.press({ key: K('n.txt') })
    expect((await read()).codeLines).toBe(0)
    await tab($, K('z.txt'))
    expect((await read()).cursor).toBe('z.txt')
  })

  // Audit of 0e8910a.
  for (const order of ['desktop last', 'terminal last'] as const) {
    test(`a surface where the file fits leaves the preview mode of one where it scrolls (${order})`, async ($, on) => {
      ring(on)
      install(on, { 'a.txt': file(), 'n.txt': file(Array.from({ length: 20 }, (_, i) => `row ${i + 1}`).join('\n')), 'z.txt': file() })
      const rows = 20
      const two = order === 'terminal last' ? await open($, 50, 60, 'desktop') : undefined
      const one = await open($, 50, rows)
      await one.ui.press({ key: K('n.txt') })
      const desk = two ?? (await open($, 50, 60, 'desktop'))
      await desk.read()
      await one.read()
      await tab($, K('z.txt'))
      await desk.read()
      await scroll($, 1, rows)
      const v = await one.read()
      expect(v.cursor).toBe('n.txt')
      expect(v.range).toMatch(/^2-/)
    })
  }

  test('the thumb lands on the cell pressed for every cell of a 23-cell bar', async ($, on) => {
    install(on, { 'n.txt': file(Array.from({ length: 353 }, (_, i) => `r${i + 1}`).join('\n')) })
    const { ui, read } = await open($, 50, 45)
    await ui.press({ key: K('n.txt') })
    const n = bar((await read()).box).length
    expect(n).toBe(23)
    for (let i = 0; i < n; i++) {
      await ui.press({ key: `sb-${i}` })
      expect(bar((await read()).box).indexOf('█'), `cell ${i}`).toBe(i)
    }
  })
})
