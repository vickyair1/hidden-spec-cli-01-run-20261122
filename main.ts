// main.ts is mend, the CLI SPEC.md specifies (MIT). It applies an edit an AI model wrote, in one of four
// formats (unified diff, SEARCH/REPLACE blocks, V4A patches, JSON tool calls), to a tree of text files: it finds
// the lines an edit names at the first of three matching tiers (section 5), writes every change or none
// (section 10), and prints what it changed or why it failed (section 2). Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves a successful edit made: the old path to the new one, for the `R` output line. */
  readonly moves: { old: string; new: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Section 5: matching lines ----

/** The leading spaces and tabs of a line. */
function leadingWS(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/** A line as a tier reads it: 0 exact, 1 trailing spaces/tabs off, 2 leading and trailing off. */
function tierKey(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function matchesAt(O: string[], lines: string[], at: number, tier: number): boolean {
  for (let j = 0; j < O.length; j++) {
    if (tierKey(O[j]!, tier) !== tierKey(lines[at + j]!, tier)) return false;
  }
  return true;
}

/** Every 0-based position where O occurs in lines at a tier; occurrences may overlap. */
function occurrences(O: string[], lines: string[], tier: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + O.length <= lines.length; i++) {
    if (matchesAt(O, lines, i, tier)) out.push(i);
  }
  return out;
}

function tiersToTry(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** The first tier at which O occurs at least once, with all its occurrences; null when it occurs at none. */
function findTier(O: string[], lines: string[], strict: boolean): { tier: number; occs: number[] } | null {
  for (const t of tiersToTry(strict)) {
    const occs = occurrences(O, lines, t);
    if (occs.length > 0) return { tier: t, occs };
  }
  return null;
}

/** The first occurrence of O at or after `from`, at the first tier with one; null when there is none. */
function findTierFrom(O: string[], lines: string[], from: number, strict: boolean): { tier: number; occ: number } | null {
  for (const t of tiersToTry(strict)) {
    for (let i = from; i + O.length <= lines.length; i++) {
      if (matchesAt(O, lines, i, t)) return { tier: t, occ: i };
    }
  }
  return null;
}

/** The first line at or after `from` equal to a single line, at the first tier with one; null when none. */
function findSingle(line: string, lines: string[], from: number, strict: boolean): number | null {
  for (const t of tiersToTry(strict)) {
    for (let i = from; i < lines.length; i++) {
      if (tierKey(line, t) === tierKey(lines[i]!, t)) return i;
    }
  }
  return null;
}

/** One line of N: a context line (written as the file's own matched line, `ctx` its index in O) or a new line. */
interface NLine {
  text: string;
  ctx?: number;
}

/** Write N at occurrence `occ` of O: context lines as the file's own lines, other lines re-indented at tier 2. */
function writeN(N: NLine[], O: string[], fileLines: string[], occ: number, tier: number): string[] {
  let F = '';
  let P = '';
  if (tier === 2) {
    F = leadingWS(fileLines[occ]!);
    P = leadingWS(O[0]!);
  }
  return N.map((e) => {
    if (e.ctx !== undefined) return fileLines[occ + e.ctx]!;
    if (tier === 2) {
      const t = e.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(P)) return F + t.slice(P.length);
    }
    return e.text;
  });
}

// ---- Files: lines and breaks (section 3) ----

interface FileLines {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

// ---- Section 6: unified diffs ----

interface Hunk {
  A: number;
  O: string[];
  N: NLine[];
  suppressed: boolean;
  body: string[];
}

interface USection {
  oldPath: string | null;
  newPath: string | null;
  gitOld: string | null;
  gitNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** A hunk body read into O (context and `-` lines) and N (context and `+` lines). */
function parseHunkBody(body: string[]): { O: string[]; N: NLine[]; suppressed: boolean } {
  const O: string[] = [];
  const N: NLine[] = [];
  let lastCtxOrPlus = -1;
  for (let k = 0; k < body.length; k++) {
    const b = body[k]!;
    if (b === '') {
      O.push('');
      N.push({ text: '', ctx: O.length - 1 });
      lastCtxOrPlus = k;
    } else if (b.startsWith(' ')) {
      const t = b.slice(1);
      O.push(t);
      N.push({ text: t, ctx: O.length - 1 });
      lastCtxOrPlus = k;
    } else if (b.startsWith('-')) {
      O.push(b.slice(1));
    } else if (b.startsWith('+')) {
      N.push({ text: b.slice(1) });
      lastCtxOrPlus = k;
    }
    // a `\` line refers to the body line before it and adds nothing to O or N
  }
  const suppressed = lastCtxOrPlus >= 0 && lastCtxOrPlus + 1 < body.length && body[lastCtxOrPlus + 1]!.startsWith('\\');
  return { O, N, suppressed };
}

/** Apply a section's hunks in order to a file's lines; `d` tracks the drift the hunks caused so far. */
function applyHunks(f: FileLines, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    if (h.O.length === 0) {
      const oldLen = f.lines.length;
      const at = Math.max(0, Math.min(h.A + d, oldLen));
      const written = h.N.map((e) => e.text);
      f.lines.splice(at, 0, ...written);
      if (at === oldLen) f.final = !h.suppressed;
      d += h.N.length;
      continue;
    }
    const found = findTier(h.O, f.lines, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.A - 1 + d;
    let occ = found.occs[0]!;
    let best = Math.abs(occ - target);
    for (const o of found.occs) {
      const dist = Math.abs(o - target);
      if (dist < best) {
        occ = o;
        best = dist;
      }
    }
    const touchesEnd = occ + h.O.length === f.lines.length;
    const written = writeN(h.N, h.O, f.lines, occ, found.tier);
    f.lines.splice(occ, h.O.length, ...written);
    if (touchesEnd) f.final = !h.suppressed;
    d += h.N.length - h.O.length;
  }
}

function parseDiffGit(line: string): [string, string] | null {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) return null;
  const idx = rest.indexOf(' b/', 2);
  if (idx < 0) return null;
  const x = rest.slice(2, idx);
  const y = rest.slice(idx + 3);
  if (x === '' || y === '') return null;
  return [x, y];
}

/** A `--- ` or `+++ ` line's path: the text after the four characters, up to the first tab, trimmed, prefix off. */
function headerPath(line: string): string {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

function unifiedEdit(sec: USection, strict: boolean): Edit {
  return (tree) => {
    let oldP: string;
    let newP: string;
    if (sec.oldPath !== null && sec.newPath !== null) {
      oldP = sec.oldPath;
      newP = sec.newPath;
    } else {
      oldP = sec.renameFrom ?? sec.gitOld ?? '';
      newP = sec.renameTo ?? sec.gitNew ?? '';
    }
    const isCreate = oldP === '/dev/null' || sec.newFile;
    const isDelete = !isCreate && (newP === '/dev/null' || sec.deletedFile);
    if (isCreate) {
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const out: string[] = [];
      for (const h of sec.hunks) {
        for (const e of h.N) {
          if (e.ctx === undefined) out.push(e.text);
        }
      }
      let noBreak = false;
      outer: for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
        const body = sec.hunks[hi]!.body;
        for (let k = body.length - 1; k >= 0; k--) {
          if (body[k]!.startsWith('+')) {
            noBreak = k + 1 < body.length && body[k + 1]!.startsWith('\\');
            break outer;
          }
        }
      }
      tree.now.set(newP, out.length === 0 ? '' : out.join('\n') + (noBreak ? '' : '\n'));
      return;
    }
    if (isDelete) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    if (oldP !== newP && !safe(newP)) throw new Fail('unsafe', newP);
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    if (oldP !== newP && tree.get(newP) !== null) throw new Fail('exists', newP);
    const f = splitFile(before);
    applyHunks(f, sec.hunks, strict, oldP);
    const out = joinFile(f);
    if (oldP !== newP) {
      tree.now.set(oldP, null);
      tree.now.set(newP, out);
      tree.moves.push({ old: oldP, new: newP });
    } else {
      tree.now.set(oldP, out);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  const fresh = (gitOld: string | null, gitNew: string | null): USection => ({
    oldPath: null,
    newPath: null,
    gitOld,
    gitNew,
    renameFrom: null,
    renameTo: null,
    newFile: false,
    deletedFile: false,
    hunks: [],
  });
  let sec: USection | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const g = parseDiffGit(line);
      if (g === null) throw new Exit2(`error: parse ${i + 1}`);
      sec = fresh(g[0], g[1]);
      sections.push(sec);
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (sec === null || sec.hunks.length > 0) {
        sec = fresh(null, null);
        sections.push(sec);
      }
      sec.oldPath = headerPath(line);
      sec.newPath = headerPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const A = Number(m[1]);
      i++;
      const body: string[] = [];
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
          body.push(b);
          i++;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      const parsed = parseHunkBody(body);
      sec.hunks.push({ A, O: parsed.O, N: parsed.N, suppressed: parsed.suppressed, body });
      continue;
    }
    if (sec !== null && sec.hunks.length === 0) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) sec.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) sec.renameTo = line.slice(10).trim();
      else if (line === 'new file mode' || line.startsWith('new file mode ')) sec.newFile = true;
      else if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) sec.deletedFile = true;
      i++;
      continue;
    }
    i++;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

// ---- Section 7: SEARCH/REPLACE blocks ----

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j >= prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const f = splitFile(before);
      const found = findTier(oldLines, f.lines, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.occs.length > 1) throw new Fail('ambiguous', p);
      const occ = found.occs[0]!;
      const nw: NLine[] = newLines.map((t) => ({ text: t }));
      const written = writeN(nw, oldLines, f.lines, occ, found.tier);
      f.lines.splice(occ, oldLines.length, ...written);
      tree.now.set(p, joinFile(f));
    });
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

// ---- Section 8: V4A patches ----

interface VChunk {
  anchor: string | null;
  eof: boolean;
  O: string[];
  N: NLine[];
}

interface VUpdate {
  moveTo: string | null;
  chunks: VChunk[];
}

interface RawLine {
  text: string;
  no: number;
}

function finishVChunk(body: RawLine[], anchor: string | null, eof: boolean): VChunk {
  const O: string[] = [];
  const N: NLine[] = [];
  for (const r of body) {
    const b = r.text;
    if (b === '') {
      O.push('');
      N.push({ text: '', ctx: O.length - 1 });
    } else if (b.startsWith(' ')) {
      const t = b.slice(1);
      O.push(t);
      N.push({ text: t, ctx: O.length - 1 });
    } else if (b.startsWith('-')) {
      O.push(b.slice(1));
    } else if (b.startsWith('+')) {
      N.push({ text: b.slice(1) });
    }
  }
  return { anchor, eof, O, N };
}

function parseUpdateBody(raw: RawLine[], updateNo: number): VUpdate {
  let idx = 0;
  let moveTo: string | null = null;
  if (idx < raw.length && raw[idx]!.text.startsWith('*** Move to: ')) {
    moveTo = raw[idx]!.text.slice(12).trim();
    idx++;
  }
  const chunks: VChunk[] = [];
  let cur: { anchor: string | null; eof: boolean; body: RawLine[] } | null = null;
  const close = (): void => {
    if (cur !== null) {
      chunks.push(finishVChunk(cur.body, cur.anchor, cur.eof));
      cur = null;
    }
  };
  for (; idx < raw.length; idx++) {
    const r = raw[idx]!;
    const line = r.text;
    if (line.startsWith('@@')) {
      close();
      const anchor = line.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
    } else if (line.trim() === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${r.no}`);
      cur.eof = true;
      close();
    } else if (line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+')) {
      if (cur === null) cur = { anchor: null, eof: false, body: [] };
      cur.body.push(r);
    } else {
      throw new Exit2(`error: parse ${r.no}`);
    }
  }
  close();
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateNo}`);
  return { moveTo, chunks };
}

function v4aUpdateEdit(path: string, upd: VUpdate, strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    const moveTo = upd.moveTo;
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(before);
    let cursor = 0;
    for (const ch of upd.chunks) {
      if (ch.anchor !== null) {
        const at = findSingle(ch.anchor, f.lines, cursor, strict);
        if (at === null) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      if (ch.O.length === 0) {
        const written = ch.N.map((e) => e.text);
        const at = ch.eof ? f.lines.length : cursor;
        f.lines.splice(at, 0, ...written);
        cursor = at + written.length;
        continue;
      }
      if (ch.eof) {
        const occ = f.lines.length - ch.O.length;
        if (occ < cursor) throw new Fail('no-match', path);
        let tier: number | null = null;
        for (const t of tiersToTry(strict)) {
          if (matchesAt(ch.O, f.lines, occ, t)) {
            tier = t;
            break;
          }
        }
        if (tier === null) throw new Fail('no-match', path);
        const written = writeN(ch.N, ch.O, f.lines, occ, tier);
        f.lines.splice(occ, ch.O.length, ...written);
        cursor = occ + written.length;
        continue;
      }
      const found = findTierFrom(ch.O, f.lines, cursor, strict);
      if (found === null) throw new Fail('no-match', path);
      const written = writeN(ch.N, ch.O, f.lines, found.occ, found.tier);
      f.lines.splice(found.occ, ch.O.length, ...written);
      cursor = found.occ + written.length;
    }
    const out = joinFile(f);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push({ old: path, new: moveTo });
    } else {
      tree.now.set(path, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isMarker = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ') || l.trim() === '*** End Patch';
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice(14).trim();
      i++;
      const raw: RawLine[] = [];
      while (i < last && !lines[i]!.startsWith('*** ')) {
        raw.push({ text: lines[i]!, no: i + 1 });
        i++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      // A section's lines are the file's lines: a leading `+` off where one is there, anything else as it is.
      const fileLines = raw.map((r) => (r.text.startsWith('+') ? r.text.slice(1) : r.text));
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice(17).trim();
      i++;
      const raw: RawLine[] = [];
      while (i < last && !lines[i]!.startsWith('*** ')) {
        raw.push({ text: lines[i]!, no: i + 1 });
        i++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      const bad = raw.find((r) => !blank(r.text));
      if (bad !== undefined) throw new Exit2(`error: parse ${bad.no}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice(17).trim();
      const updateNo = i + 1;
      i++;
      const raw: RawLine[] = [];
      while (i < last && !isMarker(lines[i]!)) {
        raw.push({ text: lines[i]!, no: i + 1 });
        i++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      const upd = parseUpdateBody(raw, updateNo);
      edits.push(v4aUpdateEdit(path, upd, strict));
      continue;
    }
    if (line.trim() === '*** End Patch') break;
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

// ---- Sections 1, 2 and 10: the command line, its output, and the all-or-nothing write ----

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed: { path: string; was: string | null; now: string | null }[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push({ path: p, was, now });
  }
  // A move that succeeded prints one `R <old> -> <new>` line, in place of that pair's `D` and `A` lines,
  // and sorts by `<new>`; every other changed path prints `A`, `D` or `M` and sorts by its path.
  const rows: { key: string; text: string }[] = [];
  const consumedOld = new Set<string>();
  const consumedNew = new Set<string>();
  for (const m of tree.moves) {
    const o = changed.find((c) => c.path === m.old);
    const n = changed.find((c) => c.path === m.new);
    if (o !== undefined && n !== undefined && o.was !== null && o.now === null && n.was === null && n.now !== null) {
      rows.push({ key: m.new, text: `R ${m.old} -> ${m.new}` });
      consumedOld.add(m.old);
      consumedNew.add(m.new);
    }
  }
  for (const c of changed) {
    if (consumedOld.has(c.path) || consumedNew.has(c.path)) continue;
    rows.push({ key: c.path, text: `${c.was === null ? 'A' : c.now === null ? 'D' : 'M'} ${c.path}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const c of changed) {
      if (c.now === null) rmSync(c.path, { force: true });
      else {
        mkdirSync(dirname(c.path), { recursive: true });
        writeFileSync(c.path, c.now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
