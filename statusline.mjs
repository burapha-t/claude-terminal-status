#!/usr/bin/env node
/**
 * Claude Code status line - a responsive dashboard rendered under the prompt.
 *
 * Wired up in ~/.claude/settings.json:
 *   "statusLine": {
 *     "type": "command",
 *     "command": "node ~/.claude/statusline.mjs",
 *     "refreshInterval": 30
 *   }
 *
 * Claude Code pipes session JSON to stdin; each line printed becomes one row.
 * Field reference: https://code.claude.com/docs/en/statusline
 *
 * LAYOUT: everything sits on ONE line on a normal-width terminal. As the
 * terminal narrows (split screen), the line progressively tightens - shorter
 * bars, tighter separators, less detail - and only when even the tightest
 * single line won't fit does it break into two rows.
 *
 * WIDTH IS LOAD-BEARING: if a printed row is wider than the terminal it wraps,
 * Claude Code reserves fewer rows than the content occupies, and the UI draws
 * over itself. Every row is measured with displayWidth() (which counts
 * double-width glyphs as 2) and kept strictly inside the budget.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

/* ════ CONFIG ═══════════════════════════════════════════════════════════ */
const SHOW = {
  // identity & mode - "what am I driving, and where"
  model:       true,   // Opus / Sonnet / Haiku
  effort:      true,   // low | medium | high | xhigh | max
  fastMode:    true,   // marker when fast mode is on
  thinking:    false,  // extended thinking on/off
  vim:         true,   // NORMAL / INSERT - only when vim mode is enabled
  agent:       true,   // --agent name
  sessionName: false,  // /rename value or AI-generated title
  dir:         true,   // current directory
  worktree:    true,   // --worktree name
  git:         true,   // branch + staged/modified/untracked counts
  gitSync:     true,   // ahead/behind upstream
  pr:          true,   // open PR number + review state
  diffStat:    true,   // +/- lines changed this session (blast radius)

  // budgets - "which wall do I hit first"
  context:     true,   // context window bar + %
  ctxTokens:   true,   // 94k/200k beside the bar
  cacheHit:    false,  // % of input served from prompt cache
  fiveHour:    true,   // 5-hour rate limit + reset countdown
  sevenDay:    true,   // weekly rate limit + reset countdown
  cost:        true,   // estimated session cost (USD)
  duration:    true,   // session wall-clock time
  clock:       false,  // current time of day (needs refreshInterval)
};

const MAX_ROWS     = 2;      // 1 = never wrap, drop segments instead
const WIDTH_MARGIN = 2;      // columns held back so a row can never wrap
const FALLBACK_COLS= 80;     // used only if Claude Code doesn't export COLUMNS
const WARN_AT      = 70;     // context % -> yellow
const DANGER_AT    = 90;     // context % -> red
const GIT_CACHE_MS = 3000;   // don't re-run `git status` more often than this
const ASCII_ONLY   = false;  // true -> plain ASCII glyphs everywhere

/* ════ glyphs ══════════════════════════════════════════════════════════ */
// Deliberately excludes anything with Emoji_Presentation (e.g. U+26A1 high
// voltage), which terminals draw two columns wide and which silently broke
// the width math in the previous version.
const G = ASCII_ONLY
  ? { full: '#', empty: '-', sep: '|', branch: 'git', up: '^', down: 'v',
      reset: '@', warn: '!', fast: '>>', dir: '>', dot: '/' }
  : { full: '█', empty: '░', sep: '│', branch: '⎇', up: '↑', down: '↓',
      reset: '↻', warn: '!', fast: '>>', dir: '▸', dot: '·' };

/* ════ presentation helpers ════════════════════════════════════════════ */
const A = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', gray: '\x1b[90m',
};

const paint = (color, text) => `${color}${text}${A.reset}`;
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

/** Terminal columns occupied by a code point (CJK, emoji and fullwidth = 2). */
function charWidth(cp) {
  if (cp === 0x200d) return 0;                        // zero-width joiner
  if (cp >= 0xfe00 && cp <= 0xfe0f) return 0;         // variation selectors
  if (cp >= 0x0300 && cp <= 0x036f) return 0;         // combining marks
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||                 // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) ||                 // CJK radicals / punctuation
    (cp >= 0x3041 && cp <= 0x33ff) ||                 // kana .. CJK compatibility
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||                 // CJK unified ideographs
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||                 // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||                 // fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f9ff) ||               // emoji
    (cp >= 0x1fa00 && cp <= 0x1faff) ||
    cp === 0x26a0 || cp === 0x26a1                    // warning / high voltage
  ) return 2;
  return 1;
}

/** True rendered width of a string, ignoring ANSI colour codes. */
function displayWidth(s) {
  let w = 0;
  for (const ch of strip(s)) w += charWidth(ch.codePointAt(0));
  return w;
}

function heat(pct) {
  if (pct >= DANGER_AT) return A.red;
  if (pct >= WARN_AT) return A.yellow;
  return A.green;
}

function bar(pct, width) {
  let filled = Math.min(width, Math.max(0, Math.round((pct / 100) * width)));
  // On short bars a small percentage rounds to zero cells and reads as "unused",
  // and a large one rounds to full and reads as "maxed". Reserve one cell each way.
  if (pct > 0 && filled === 0) filled = 1;
  if (pct < 100 && filled === width) filled = width - 1;
  return G.full.repeat(filled) + G.empty.repeat(width - filled);
}

function tok(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (n >= 1000) return Math.round(n / 1000) + 'k';
  return String(n);
}

/** Compact duration: 4d2h / 2h13m / 18m / 45s. */
function span(seconds) {
  let s = Math.max(0, Math.round(seconds));
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600);  s -= h * 3600;
  const m = Math.floor(s / 60);    s -= m * 60;
  if (d) return `${d}d${h}h`;
  if (h) return `${h}h${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m`;
  return `${s}s`;
}

const dur = (ms) => span(ms / 1000);
const until = (epochSec) => span(epochSec - Date.now() / 1000);

/**
 * Project a rate-limit window forward from the current burn rate.
 *   proj       - % consumed by the time the window resets.
 *   exhaustsIn - seconds until you hit the cap, or null if you never do.
 * 80% ten minutes before a reset is fine; 40% in the first hour is not.
 */
function pace(usedPct, resetsAt, windowSec) {
  if (!resetsAt || !usedPct) return { proj: usedPct || 0, exhaustsIn: null };
  const remaining = Math.max(0, resetsAt - Date.now() / 1000);
  // Floor elapsed at 5% of the window so a fresh window can't project wildly.
  const elapsed = Math.max(windowSec * 0.05, windowSec - remaining);
  const proj = usedPct * (windowSec / elapsed);
  const secsToCap = (elapsed * (100 - usedPct)) / usedPct;
  // Only flag running dry with real time left; landing exactly on the reset is
  // ideal use, not a warning.
  const early = secsToCap < remaining - windowSec * 0.1;
  return { proj, exhaustsIn: early ? secsToCap : null };
}

function paceColor(proj) {
  if (proj > 150) return A.red;
  if (proj > 110) return A.yellow;
  return A.green;
}

/* ════ git ═════════════════════════════════════════════════════════════ */
function parseStatus(out) {
  const res = { branch: '', ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, conflicts: 0 };
  for (const line of out.split('\n')) {
    if (!line) continue;
    if (line.startsWith('## ')) {
      let head = line.slice(3);
      const a = head.match(/ahead (\d+)/);  if (a) res.ahead = +a[1];
      const b = head.match(/behind (\d+)/); if (b) res.behind = +b[1];
      const brk = head.lastIndexOf(' [');
      if (brk !== -1) head = head.slice(0, brk);
      head = head.split('...')[0].trim();
      if (head.startsWith('No commits yet on ')) head = head.slice(18);
      if (head === 'HEAD (no branch)') head = 'detached';
      res.branch = head;
      continue;
    }
    const x = line[0], y = line[1];
    if (x === '?' && y === '?') { res.untracked++; continue; }
    if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) {
      res.conflicts++; continue;
    }
    if (x !== ' ' && x !== '?') res.staged++;
    if (y !== ' ' && y !== '?') res.modified++;
  }
  return res;
}

/** `git status` can be slow in big repos, so cache it briefly on disk. */
let gitMemo;  // layout probes several levels per run; only look once
function gitInfo(cwd) {
  if (gitMemo !== undefined) return gitMemo;
  if (!cwd) return (gitMemo = null);
  const key = crypto.createHash('md5').update(cwd).digest('hex').slice(0, 12);
  const cacheFile = path.join(os.tmpdir(), `cc-statusline-git-${key}.json`);
  try {
    if (Date.now() - fs.statSync(cacheFile).mtimeMs < GIT_CACHE_MS) {
      return (gitMemo = JSON.parse(fs.readFileSync(cacheFile, 'utf8')));
    }
  } catch { /* no usable cache */ }

  let info = null;
  try {
    const out = execFileSync(
      'git',
      ['status', '--porcelain=v1', '-b', '--untracked-files=normal'],
      { cwd, encoding: 'utf8', timeout: 1500, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    info = parseStatus(out);
  } catch { info = null; }  // not a repo, or git unavailable

  try { fs.writeFileSync(cacheFile, JSON.stringify(info)); } catch { /* best effort */ }
  return (gitMemo = info);
}

/* ════ segments ════════════════════════════════════════════════════════
 * Each builder returns {text, prio} items. Lower prio = keep longer when
 * space runs out. `lv` is the current compaction level.
 * ═══════════════════════════════════════════════════════════════════════ */
function buildIdentity(d, lv) {
  const seg = [];
  const push = (text, prio) => text && seg.push({ text, prio });

  const mode = [];
  if (SHOW.model && d.model?.display_name) mode.push(paint(A.bold + A.magenta, d.model.display_name));
  if (SHOW.effort && d.effort?.level) mode.push(paint(A.magenta, d.effort.level));
  if (SHOW.thinking && d.thinking?.enabled) mode.push(paint(A.gray, 'think'));
  if (SHOW.fastMode && d.fast_mode) mode.push(paint(A.yellow, G.fast));
  push(mode.join(paint(A.dim, G.dot)), 1);

  if (SHOW.vim && d.vim?.mode) {
    push(paint(d.vim.mode === 'INSERT' ? A.green : A.blue, d.vim.mode), 1);
  }
  if (SHOW.agent && d.agent?.name) push(paint(A.cyan, `@${d.agent.name}`), 2);
  if (SHOW.sessionName && d.session_name) push(paint(A.gray, d.session_name), 6);

  const cwd = d.workspace?.current_dir || d.cwd;
  if (SHOW.dir && cwd) {
    const leaf = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || cwd;
    push(paint(A.blue, lv.terse ? leaf : `${G.dir} ${leaf}`), 2);
  }
  if (SHOW.worktree && (d.worktree?.name || d.workspace?.git_worktree)) {
    push(paint(A.cyan, `wt:${d.worktree?.name || d.workspace.git_worktree}`), 3);
  }

  if (SHOW.git) {
    const g = gitInfo(cwd);
    if (g?.branch) {
      const bits = [paint(A.green, lv.terse ? g.branch : `${G.branch} ${g.branch}`)];
      if (g.staged)    bits.push(paint(A.green,  `+${g.staged}`));
      if (g.modified)  bits.push(paint(A.yellow, `~${g.modified}`));
      if (g.untracked) bits.push(paint(A.gray,   `?${g.untracked}`));
      if (g.conflicts) bits.push(paint(A.red,    `!${g.conflicts}`));
      if (SHOW.gitSync && g.ahead)  bits.push(paint(A.cyan, `${G.up}${g.ahead}`));
      if (SHOW.gitSync && g.behind) bits.push(paint(A.cyan, `${G.down}${g.behind}`));
      push(bits.join(' '), 2);
    }
  }

  if (SHOW.pr && d.pr?.number) {
    const stateColor = { approved: A.green, changes_requested: A.red, pending: A.yellow, draft: A.gray };
    push(paint(stateColor[d.pr.review_state] || A.gray, `PR#${d.pr.number}`), 4);
  }

  if (SHOW.diffStat) {
    const add = d.cost?.total_lines_added ?? 0;
    const del = d.cost?.total_lines_removed ?? 0;
    if (add || del) push(`${paint(A.green, `+${add}`)}${paint(A.dim, '/')}${paint(A.red, `-${del}`)}`, 3);
  }

  return seg;
}

function buildBudgets(d, lv) {
  const seg = [];
  const push = (text, prio) => text && seg.push({ text, prio });

  const cw = d.context_window;
  if (SHOW.context && cw && cw.used_percentage != null) {
    const pct = Math.round(cw.used_percentage);
    const col = heat(pct);
    let s = `${paint(A.dim, 'ctx')} ${paint(col, bar(pct, lv.ctxBar))} ${paint(col, String(pct).padStart(2) + '%')}`;
    if (SHOW.ctxTokens && lv.tokens && cw.context_window_size) {
      s += ' ' + paint(A.dim, `${tok(cw.total_input_tokens ?? 0)}/${tok(cw.context_window_size)}`);
    }
    if (pct >= DANGER_AT) s += ' ' + paint(A.red + A.bold, `${G.warn}compact`);
    push(s, 1);
  } else if (SHOW.context) {
    push(paint(A.dim, `ctx ${bar(0, lv.ctxBar)} --`), 1);
  }

  if (SHOW.cacheHit && lv.tokens && cw?.current_usage) {
    const u = cw.current_usage;
    const total = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    if (total > 0) push(paint(A.dim, `cache ${Math.round((u.cache_read_input_tokens ?? 0) / total * 100)}%`), 5);
  }

  // Rate limits coloured by projected exhaustion, with a countdown to the cap
  // whenever you're on track to hit it before the window resets.
  const limit = (obj, label, windowSec, prio) => {
    if (!obj || obj.used_percentage == null) return;
    const pct = Math.round(obj.used_percentage);
    const { proj, exhaustsIn } = pace(obj.used_percentage, obj.resets_at, windowSec);
    const col = paceColor(proj);
    let s = `${paint(A.dim, label)} ${paint(col, bar(pct, lv.limBar))} ${paint(col, String(pct).padStart(2) + '%')}`;
    if (obj.resets_at && lv.resets) s += ' ' + paint(A.dim, `${G.reset}${until(obj.resets_at)}`);
    if (exhaustsIn != null) s += ' ' + paint(col, `${G.warn}${span(exhaustsIn)}`);
    push(s, prio);
  };
  if (SHOW.fiveHour) limit(d.rate_limits?.five_hour, '5h', 5 * 3600, 1);
  if (SHOW.sevenDay) limit(d.rate_limits?.seven_day, '7d', 7 * 86400, 2);

  if (SHOW.cost && lv.costTime && d.cost?.total_cost_usd != null) {
    push(paint(A.dim, `$${d.cost.total_cost_usd.toFixed(2)}`), 4);
  }
  if (SHOW.duration && lv.costTime && d.cost?.total_duration_ms) {
    push(paint(A.dim, dur(d.cost.total_duration_ms)), 4);
  }
  if (SHOW.clock && lv.costTime) {
    push(paint(A.dim, new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })), 6);
  }

  return seg;
}

/* ════ layout ══════════════════════════════════════════════════════════ */
// Tried in order. The first level whose segments fit on a single row wins, so
// a wide terminal gets the roomy version and a split pane gets a tight one.
// One knob changes per step so the layout degrades smoothly instead of
// collapsing 25 columns at a time and leaving the terminal half empty.
const LEVELS = [
  { sep: `  ${G.sep}  `, ctxBar: 10, limBar: 6, tokens: true,  resets: true,  costTime: true,  terse: false },
  { sep: `  ${G.sep}  `, ctxBar: 8,  limBar: 5, tokens: true,  resets: true,  costTime: true,  terse: false },
  { sep: ` ${G.sep} `,   ctxBar: 8,  limBar: 5, tokens: true,  resets: true,  costTime: true,  terse: false },
  { sep: ` ${G.sep} `,   ctxBar: 6,  limBar: 4, tokens: true,  resets: true,  costTime: true,  terse: false },
  { sep: ` ${G.sep} `,   ctxBar: 6,  limBar: 4, tokens: true,  resets: true,  costTime: true,  terse: true  },
  { sep: ` ${G.sep} `,   ctxBar: 5,  limBar: 3, tokens: true,  resets: true,  costTime: true,  terse: true  },
  { sep: ` ${G.sep} `,   ctxBar: 5,  limBar: 3, tokens: false, resets: true,  costTime: true,  terse: true  },
  { sep: '  ',    ctxBar: 5,  limBar: 3, tokens: false, resets: true,  costTime: true,  terse: true  },
  { sep: ' ',     ctxBar: 4,  limBar: 3, tokens: false, resets: true,  costTime: true,  terse: true  },
  { sep: ' ',     ctxBar: 4,  limBar: 3, tokens: false, resets: true,  costTime: false, terse: true  },
  { sep: ' ',     ctxBar: 4,  limBar: 3, tokens: false, resets: false, costTime: false, terse: true  },
];

const joinSegs = (segs, sep) => segs.map((s) => s.text).join(paint(A.dim, sep));

/** Join segments, dropping the highest-prio (least important) until it fits. */
function fitRow(segments, sep, cols) {
  const segs = segments.slice();
  while (segs.length > 1 && displayWidth(joinSegs(segs, sep)) > cols) {
    let worst = 0;
    for (let i = 1; i < segs.length; i++) if (segs[i].prio >= segs[worst].prio) worst = i;
    segs.splice(worst, 1);
  }
  return joinSegs(segs, sep);
}

/** Hard guarantee: never emit a row wider than the budget, so it cannot wrap. */
function clamp(row, cols) {
  if (displayWidth(row) <= cols) return row;
  let out = '', w = 0;
  // Walk the string, keeping ANSI sequences (zero width) and counting glyphs.
  const re = /(\x1b\[[0-9;]*m)|([\s\S])/gu;
  for (const m of row.matchAll(re)) {
    if (m[1]) { out += m[1]; continue; }
    const cwid = charWidth(m[2].codePointAt(0));
    if (w + cwid > cols) break;
    out += m[2]; w += cwid;
  }
  return out + A.reset;
}

/* ════ main ════════════════════════════════════════════════════════════ */
try {
  const raw = (() => { try { return fs.readFileSync(0, 'utf8'); } catch { return ''; } })().trim();
  const d = raw ? JSON.parse(raw) : {};

  // Claude Code exports the real terminal size; `tput cols` can't see it here.
  const cols = Math.max(20, (Number(process.env.COLUMNS) || FALLBACK_COLS) - WIDTH_MARGIN);

  let rows = null;
  for (const lv of LEVELS) {
    const all = [...buildIdentity(d, lv), ...buildBudgets(d, lv)];
    const one = joinSegs(all, lv.sep);
    if (displayWidth(one) <= cols) { rows = [one]; break; }
  }

  if (!rows) {
    if (MAX_ROWS < 2) {
      // Single row demanded: tightest level, shedding segments until it fits.
      const lv = LEVELS[LEVELS.length - 1];
      rows = [fitRow([...buildIdentity(d, lv), ...buildBudgets(d, lv)], lv.sep, cols)];
    } else {
      // Too narrow for one line - split into identity / budgets rows. Each row
      // picks its own density, so a wide budgets row can't force the identity
      // row into cramped separators it doesn't need.
      const pickRow = (build) => {
        for (const lv of LEVELS) {
          const r = joinSegs(build(d, lv), lv.sep);
          if (displayWidth(r) <= cols) return r;
        }
        const lv = LEVELS[LEVELS.length - 1];
        return fitRow(build(d, lv), lv.sep, cols);
      };
      rows = [pickRow(buildIdentity), pickRow(buildBudgets)];
    }
  }

  for (const row of rows) if (row) console.log(clamp(row, cols));
} catch (err) {
  // Never let a broken status line block the prompt.
  console.log(`${A.dim}statusline: ${String(err.message).slice(0, 50)}${A.reset}`);
}
