// main.ts is mend, the CLI SPEC.md specifies. It does all ten sections of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, three-tier line matching, unified diffs, SEARCH/REPLACE blocks, V4A
// patches, JSON edits and the all-or-nothing write. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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
/** Successful move edits, as (old path, new path), in the patch's order. */
type Moves = [string, string][];

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

// ---------------------------------------------------------------------------
// Lines of a file (SPEC.md section 3) and three-tier matching (section 5).
// ---------------------------------------------------------------------------

interface FileText {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileText {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const fin = text.endsWith(br);
  if (fin) parts.pop();
  return { lines: parts, br, final: fin };
}

function joinFile(lines: string[], br: string, fin: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (fin ? br : '');
}

const leadingWs = (s: string): string => /^[ \t]*/.exec(s)![0]!;

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Positions where O occurs in lines at one tier; occurrences may overlap. */
function tierOccurrences(lines: string[], O: string[], tier: number): number[] {
  const occ: number[] = [];
  if (O.length === 0) return occ;
  const nO = O.map((l) => normLine(l, tier));
  outer: for (let i = 0; i + O.length <= lines.length; i++) {
    for (let j = 0; j < O.length; j++) {
      if (normLine(lines[i + j]!, tier) !== nO[j]) continue outer;
    }
    occ.push(i);
  }
  return occ;
}

/** The first tier (0, then 1, then 2; only 0 when strict) at which O occurs, with its positions. */
function findTier(lines: string[], O: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = tierOccurrences(lines, O, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One body line of a unified hunk or a V4A chunk: ' ' context, '-' old, '+' new, '\' marker. */
interface BodyLine {
  kind: string;
  text: string;
}
interface OLine {
  text: string;
  ctx: boolean;
}
interface NLine {
  text: string;
  ctx: boolean;
  oIndex: number;
}

/** Split a body into old lines O (context and '-') and new lines N (context and '+'). */
function splitON(body: BodyLine[]): { O: OLine[]; N: NLine[] } {
  const O: OLine[] = [];
  const N: NLine[] = [];
  for (const b of body) {
    if (b.kind === ' ') {
      O.push({ text: b.text, ctx: true });
      N.push({ text: b.text, ctx: true, oIndex: O.length - 1 });
    } else if (b.kind === '-') {
      O.push({ text: b.text, ctx: false });
    } else if (b.kind === '+') {
      N.push({ text: b.text, ctx: false, oIndex: -1 });
    }
  }
  return { O, N };
}

/**
 * The lines N writes when it replaces O at position pos of the file's lines: context lines are the file's own
 * matched lines; at tier 2 the other lines are re-indented from O's first line's leading whitespace to the file's.
 */
function replacementLines(N: NLine[], fl: string[], pos: number, O: OLine[], tier: number): string[] {
  if (O.length === 0) return N.map((n) => n.text);
  const F = leadingWs(fl[pos] ?? '');
  const P = leadingWs(O[0]!.text);
  return N.map((n) => {
    if (n.ctx) return fl[pos + n.oIndex]!;
    if (tier === 2) {
      const t = n.text;
      if (t !== '' && !/^[ \t]+$/.test(t) && t.startsWith(P)) return F + t.slice(P.length);
    }
    return n.text;
  });
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6).
// ---------------------------------------------------------------------------

interface Hunk {
  a: number;
  body: BodyLine[];
  noBreak: boolean;
}
interface Section {
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_RE = /^diff --git a\/(.+) b\/(.+)$/;

/** Apply one hunk to (lines, final break); d is the line drift of this section's earlier hunks. */
function applyUnifiedHunk(state: FileText, hunk: Hunk, d: number, strict: boolean, path: string): FileText {
  const { O, N } = splitON(hunk.body);
  const cur = state.lines;
  if (O.length === 0) {
    const idx = Math.min(Math.max(hunk.a + d, 0), cur.length);
    const ins = replacementLines(N, cur, idx, O, 0);
    const lines = [...cur.slice(0, idx), ...ins, ...cur.slice(idx)];
    return { lines, br: state.br, final: idx === cur.length ? !hunk.noBreak : state.final };
  }
  const found = findTier(cur, O.map((o) => o.text), strict);
  if (!found) throw new Fail('no-match', path);
  const target = hunk.a - 1 + d;
  let pos = found.occ[0]!;
  let best = Math.abs(pos - target);
  for (const p of found.occ) {
    const dd = Math.abs(p - target);
    if (dd < best) {
      best = dd;
      pos = p;
    }
  }
  const repl = replacementLines(N, cur, pos, O, found.tier);
  const lines = [...cur.slice(0, pos), ...repl, ...cur.slice(pos + O.length)];
  return { lines, br: state.br, final: pos + O.length === cur.length ? !hunk.noBreak : state.final };
}

function applySectionHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  let state = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    const { O, N } = splitON(h.body);
    state = applyUnifiedHunk(state, h, d, strict, path);
    d += N.length - O.length;
  }
  return joinFile(state.lines, state.br, state.final);
}

function unifiedEdit(sec: Section, strict: boolean, moves: Moves): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && newP !== oldP && !safe(newP)) throw new Fail('unsafe', newP);
    if (sec.isDelete) {
      const t = tree.get(oldP!);
      if (t === null) throw new Fail('missing', oldP!);
      tree.now.set(oldP!, null);
      return;
    }
    if (sec.isCreate) {
      if (tree.get(newP!) !== null) throw new Fail('exists', newP!);
      const plus: string[] = [];
      let noBreak = false;
      for (const h of sec.hunks) {
        for (let i = 0; i < h.body.length; i++) {
          if (h.body[i]!.kind === '+') {
            plus.push(h.body[i]!.text);
            noBreak = h.body[i + 1]?.kind === '\\';
          }
        }
      }
      tree.now.set(newP!, plus.length === 0 ? '' : plus.join('\n') + (noBreak ? '' : '\n'));
      return;
    }
    if (oldP !== newP) {
      const t = tree.get(oldP!);
      if (t === null) throw new Fail('missing', oldP!);
      if (tree.get(newP!) !== null) throw new Fail('exists', newP!);
      tree.now.set(newP!, applySectionHunks(t, sec.hunks, strict, oldP!));
      tree.now.set(oldP!, null);
      moves.push([oldP!, newP!]);
      return;
    }
    const t = tree.get(oldP!);
    if (t === null) throw new Fail('missing', oldP!);
    tree.now.set(oldP!, applySectionHunks(t, sec.hunks, strict, oldP!));
  };
}

function parseUnified(lines: string[], strict: boolean, moves: Moves): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let hunk: Hunk | null = null;
  let state = 'outside';
  let pairSeen = false;

  const finishHunk = (): void => {
    if (!hunk) return;
    const b = hunk.body;
    while (b.length > 0 && b[b.length - 1]!.kind === ' ' && b[b.length - 1]!.text === '') b.pop();
    let nb = false;
    for (let i = b.length - 1; i >= 0; i--) {
      const k = b[i]!.kind;
      if (k === ' ' || k === '+') {
        nb = b[i + 1]?.kind === '\\';
        break;
      }
    }
    hunk.noBreak = nb;
    hunk = null;
  };
  const startSection = (oldP: string | null, newP: string | null): void => {
    finishHunk();
    cur = { oldPath: oldP, newPath: newP, isCreate: false, isDelete: false, hunks: [] };
    sections.push(cur);
    pairSeen = false;
    state = 'header';
  };
  const parseDiffGit = (line: string, idx: number): [string, string] => {
    const m = DIFF_RE.exec(line.trimEnd());
    if (!m) throw new Exit2(`error: parse ${idx + 1}`);
    return [m[1]!, m[2]!];
  };
  const headerPath = (line: string): string => {
    let p = line.slice(4).split('\t')[0]!.trim();
    if (p.startsWith('a/')) p = p.slice(2);
    else if (p.startsWith('b/')) p = p.slice(2);
    return p;
  };
  const pairPaths = (line: string, next: string): [string | null, string | null] => {
    const o = headerPath(line);
    const n = headerPath(next);
    return [o === '/dev/null' ? null : o, n === '/dev/null' ? null : n];
  };
  const startHunk = (line: string, idx: number): void => {
    const m = HUNK_RE.exec(line);
    if (!m) throw new Exit2(`error: parse ${idx + 1}`);
    finishHunk();
    hunk = { a: parseInt(m[1]!, 10), body: [], noBreak: false };
    cur!.hunks.push(hunk);
    state = 'body';
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const [x, y] = parseDiffGit(line, i);
      startSection(x, y);
      continue;
    }
    if (state === 'outside') {
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        const [o, n] = pairPaths(line, lines[i + 1]!);
        startSection(o, n);
        pairSeen = true;
        i++;
        continue;
      }
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      continue;
    }
    if (state === 'header') {
      if (line.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          if (!pairSeen) {
            const [o, n] = pairPaths(line, lines[i + 1]!);
            cur!.oldPath = o;
            cur!.newPath = n;
            pairSeen = true;
          }
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (line.startsWith('rename from ')) {
        if (!pairSeen) cur!.oldPath = line.slice('rename from '.length).trim();
        continue;
      }
      if (line.startsWith('rename to ')) {
        if (!pairSeen) cur!.newPath = line.slice('rename to '.length).trim();
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur!.isCreate = true;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur!.isDelete = true;
        continue;
      }
      if (line.startsWith('@@')) {
        startHunk(line, i);
        continue;
      }
      continue;
    }
    if (state === 'body') {
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        const [o, n] = pairPaths(line, lines[i + 1]!);
        startSection(o, n);
        pairSeen = true;
        i++;
        continue;
      }
      if (line.startsWith('@@')) {
        startHunk(line, i);
        continue;
      }
      const c = line === '' ? ' ' : line[0]!;
      if (c === ' ' || c === '-' || c === '+' || c === '\\') {
        hunk!.body.push({ kind: c, text: line === '' ? '' : line.slice(1) });
        continue;
      }
      finishHunk();
      state = 'after';
      continue;
    }
    // state === 'after': prose after a body; a new section or hunk may still follow.
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const [o, n] = pairPaths(line, lines[i + 1]!);
      startSection(o, n);
      pairSeen = true;
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      startHunk(line, i);
      continue;
    }
  }
  finishHunk();
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedEdit(s, strict, moves));
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7).
// ---------------------------------------------------------------------------

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const t = tree.get(path);
    if (t === null) throw new Fail('missing', path);
    const f = splitFile(t);
    const found = findTier(f.lines, oldLines, strict);
    if (!found) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const O: OLine[] = oldLines.map((l) => ({ text: l, ctx: false }));
    const N: NLine[] = newLines.map((l) => ({ text: l, ctx: false, oIndex: -1 }));
    const repl = replacementLines(N, f.lines, pos, O, found.tier);
    const lines = [...f.lines.slice(0, pos), ...repl, ...f.lines.slice(pos + oldLines.length)];
    tree.now.set(path, joinFile(lines, f.br, f.final));
  };
}

function parseSR(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchNo = i + 1;
      let path: string | null = null;
      for (let j = i - 1; j >= prevEnd; j--) {
        const l = lines[j]!;
        if (blank(l)) continue;
        if (l.trim().startsWith('```')) continue;
        path = l.trim();
        break;
      }
      if (path === null) {
        if (prevPath !== null) path = prevPath;
        else throw new Exit2(`error: parse ${searchNo}`);
      }
      let k = i + 1;
      while (k < lines.length && lines[k]!.trimEnd() !== '=======') {
        const t = lines[k]!.trimEnd();
        if (t === '<<<<<<< SEARCH' || t === '>>>>>>> REPLACE') throw new Exit2(`error: parse ${searchNo}`);
        k++;
      }
      if (k >= lines.length) throw new Exit2(`error: parse ${searchNo}`);
      let m = k + 1;
      while (m < lines.length && lines[m]!.trimEnd() !== '>>>>>>> REPLACE') {
        if (lines[m]!.trimEnd() === '<<<<<<< SEARCH') throw new Exit2(`error: parse ${searchNo}`);
        m++;
      }
      if (m >= lines.length) throw new Exit2(`error: parse ${searchNo}`);
      edits.push(srEdit(path, lines.slice(i + 1, k), lines.slice(k + 1, m), strict));
      prevPath = path;
      prevEnd = m + 1;
      i = m + 1;
    } else {
      i++;
    }
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8).
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string;
  eof: boolean;
  body: BodyLine[];
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean, moves: Moves): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && moveTo !== path && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const t = tree.get(path);
    if (t === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(t);
    let lines = f.lines;
    let cursor = 0;
    const tiers = strict ? [0] : [0, 1, 2];
    for (const ch of chunks) {
      if (ch.anchor !== '') {
        let found = -1;
        for (const tier of tiers) {
          for (let idx = cursor; idx < lines.length; idx++) {
            if (normLine(lines[idx]!, tier) === normLine(ch.anchor, tier)) {
              found = idx;
              break;
            }
          }
          if (found >= 0) break;
        }
        if (found < 0) throw new Fail('no-match', path);
        cursor = found + 1;
      }
      const { O, N } = splitON(ch.body);
      if (O.length === 0) {
        const insPos = ch.eof ? lines.length : cursor;
        const ins = N.map((n) => n.text);
        lines = [...lines.slice(0, insPos), ...ins, ...lines.slice(insPos)];
        cursor = insPos + ins.length;
      } else {
        const oTexts = O.map((o) => o.text);
        let hit: { tier: number; pos: number } | null = null;
        for (const tier of tiers) {
          const occ = tierOccurrences(lines, oTexts, tier).filter(
            (p) => p >= cursor && (!ch.eof || p + O.length === lines.length),
          );
          if (occ.length > 0) {
            hit = { tier, pos: occ[0]! };
            break;
          }
        }
        if (!hit) throw new Fail('no-match', path);
        const repl = replacementLines(N, lines, hit.pos, O, hit.tier);
        lines = [...lines.slice(0, hit.pos), ...repl, ...lines.slice(hit.pos + O.length)];
        cursor = hit.pos + repl.length;
      }
    }
    const out = joinFile(lines, f.br, f.final);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function parseV4A(lines: string[], strict: boolean, moves: Moves): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      const raw: string[] = [];
      let j = i + 1;
      while (j < last && !isSectionStart(lines[j]!)) {
        raw.push(lines[j]!);
        j++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      const fileLines: string[] = [];
      for (let k = 0; k < raw.length; k++) {
        const rl = raw[k]!;
        if (rl === '') fileLines.push('');
        else if (rl.startsWith('+')) fileLines.push(rl.slice(1));
        else throw new Exit2(`error: parse ${i + 2 + k}`);
      }
      edits.push(v4aAddEdit(path, fileLines));
      i = j;
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      let j = i + 1;
      while (j < last && !isSectionStart(lines[j]!)) {
        if (!blank(lines[j]!)) throw new Exit2(`error: parse ${j + 1}`);
        j++;
      }
      edits.push(v4aDeleteEdit(path));
      i = j;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const raw: string[] = [];
      let j = i + 1;
      while (j < last && !isSectionStart(lines[j]!)) {
        raw.push(lines[j]!);
        j++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      let k = 0;
      let moveTo: string | null = null;
      if (raw.length > 0 && raw[0]!.startsWith('*** Move to: ')) {
        moveTo = raw[0]!.slice('*** Move to: '.length).trim();
        k = 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      for (; k < raw.length; k++) {
        const rl = raw[k]!;
        const lineNo = i + 2 + k;
        if (rl.startsWith('@@')) {
          if (cur) chunks.push(cur);
          cur = { anchor: rl.slice(2).trim(), eof: false, body: [] };
        } else if (rl.trimEnd() === '*** End of File') {
          if (!cur) throw new Exit2(`error: parse ${lineNo}`);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
        } else if (rl.startsWith('*** Move to: ')) {
          throw new Exit2(`error: parse ${lineNo}`);
        } else if (rl === '' || rl[0] === ' ' || rl[0] === '-' || rl[0] === '+') {
          if (!cur) cur = { anchor: '', eof: false, body: [] };
          cur.body.push({ kind: rl === '' ? ' ' : rl[0]!, text: rl === '' ? '' : rl.slice(1) });
        } else {
          throw new Exit2(`error: parse ${lineNo}`);
        }
      }
      if (cur) chunks.push(cur);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict, moves));
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9).
// ---------------------------------------------------------------------------

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
  const moves: Moves = [];
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict, moves);
    else if (kind === 'search-replace') edits = parseSR(lines, strict);
    else edits = parseV4A(lines, strict, moves);
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
  // Output rows: one per changed path, byte-sorted; a successful move prints `R <old> -> <new>` (sorted by
  // <new>) in place of that pair's D and A lines.
  const rOld = new Set<string>();
  const rNew = new Set<string>();
  interface Row {
    key: string;
    line: string;
    path: string;
    now: string | null;
  }
  const rows: Row[] = [];
  for (const [oldP, newP] of moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}`, path: '', now: null });
      rOld.add(oldP);
      rNew.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (was !== null && now === null && rOld.has(p)) continue;
    if (was === null && now !== null && rNew.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`, path: p, now });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    // Deletes first, then writes: a move's old path may be the new path's parent and vice versa.
    const writes: { path: string; now: string | null }[] = [];
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      writes.push({ path: p, now });
    }
    for (const w of writes) {
      if (w.now === null) rmSync(w.path, { force: true });
    }
    for (const w of writes) {
      if (w.now !== null) {
        mkdirSync(dirname(w.path), { recursive: true });
        writeFileSync(w.path, w.now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
