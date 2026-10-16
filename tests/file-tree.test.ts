import { describe, expect, test } from 'claude-code/testing'
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

type World = { tree: Tree; reads: string[]; runs: string[][]; lists: number; root: string }

const install = (on: On, tree: Tree, opts: { entries?: FsEntry[] } = {}): World => {
  const w: World = { tree, reads: [], runs: [], lists: 0, root: '' }
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
// Row keys as register.tsx spells them; the test presses rows by path through this.
const K = (path: string) =>
  `r:${encodeURIComponent(path.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, c => `\ufffe${c.charCodeAt(0).toString(16)}`))}`
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
    const hint = textOf(kids[0])
    const treeBox = kids[1]
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
      expect(v.rows[0]?.label).toBe(' · a.txt')
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
    for (const cols of [40, 23, 15]) {
      const { ui, read } = await open($, cols)
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
    expect(v.rows[0]?.label).toBe(' ▸ lnk')
    await ui.press({ key: K('lnk') })
    expect((await read()).rows.map(r => r.path)).toContain('lnk/inner.txt')
  })

  test('a broken symlink is a row; its preview says Broken link and nothing is read', async ($, on) => {
    const w = install(on, { dangling: link('gone/nowhere') })
    const { ui, read } = await open($)
    expect((await read()).rows.map(r => r.label)).toEqual([' · dangling'])
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
    expect((await read()).source?.split('\n')[0]).toBe('y'.repeat(34))
  })

  test('4 MiB + 1 is read with head -c 4194304 -- and the last row says it is truncated', { timeoutMs: 20000 }, async ($, on) => {
    const w = install(on, { 'over.txt': file(big(MiB4 + 1)) })
    const rows = 20
    const { ui, read } = await open($, 40, rows)
    await ui.press({ key: K('over.txt') })
    expect(w.reads).toEqual([])
    expect(w.runs).toEqual([['head', '-c', '4194304', '--', 'over.txt']])
    await scroll($, 1e9, rows, rows - 1)
    const last = (await read()).source?.split('\n').pop() ?? ''
    expect(last).toBe('… first 4,194,304 of 4,194,305 bytes shown')
  })

  test('a >4 MiB file whose name starts with "-" reaches head after --', { timeoutMs: 20000 }, async ($, on) => {
    const w = install(on, { '-dash.log': file(big(MiB4 + 1)) })
    const { ui, read } = await open($)
    await ui.press({ key: K('-dash.log') })
    expect(w.runs.find(a => a[0] === 'head')).toEqual(['head', '-c', '4194304', '--', '-dash.log'])
    expect((await read()).source?.split('\n')[0]).toBe('y'.repeat(34))
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
    expect(await underlined()).toEqual([])
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

  test('a very short pane (bodyRows 4) draws without throwing', async ($, on) => {
    install(on, NAMES)
    const { ui, read } = await open($, 40, 4)
    await ui.press({ key: K('a.txt') })
    const v = await read()
    expect(v.source).toContain('hello  world')
    expect(v.treeHeight).toBeGreaterThanOrEqual(3)
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
  test('session.start registers /tree, opens the pane and names the keys in the status', async ($, on) => {
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
    expect(seen.opened).toContain(PANE)
    expect(seen.status.join(' ')).toContain('ctrl+x Tab')
  })

  test('/tree opens the pane and answers', async ($, on) => {
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
    expect(r.text).toBe('File tree opened.')
    expect(opened).toEqual([PANE])
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
