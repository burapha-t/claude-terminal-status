# claude-terminal-status

A responsive status line for [Claude Code](https://code.claude.com). It shows your model, git state, context window, rate limits, and session cost under the prompt, and fits whatever width your terminal has.

It is a single Node.js file with no dependencies. Copy it to `~/.claude/` and point your settings at it.

## Preview

Wide terminal: everything on one line:

```text
Opus 5.5·xhigh  │  ▸ my-app  │  ⎇ main +2 ~3 ?1  │  +212/-37  │  ctx █████░░░░░ 47% 94k/200k  │  5h ██░░░░ 38% ↻1h59m  │  7d █░░░░░ 22% ↻3d23h  │  $1.84  │  43m
```

Narrow split pane: the line tightens first, and splits into two rows only when it has to:

```text
Opus 5.5·xhigh │ ▸ my-app │ ⎇ main +2 ~3 ?1 │ +212/-37
ctx ██░░ 47% 5h █░░ 38% ↻1h59m 7d █░░ 22% ↻3d23h $1.84 43m
```

Heavy session: context almost full, and on pace to hit the 5-hour limit in 30 minutes, well before it resets:

```text
Opus 5.5·xhigh  │  ▸ my-app  │  ⎇ main +2 ~3 ?1  │  +212/-37  │  ctx █████████░ 92% 184k/200k !compact  │  5h █████░ 80% ↻2h59m !30m  │  7d █░░░░░ 22% ↻3d23h  │  $6.10  │  2h10m
```

*(Colors are stripped above. In the terminal, each segment is colored and the bars go green → yellow → red.)*

## Requirements

- **Claude Code**
- **Node.js 18+** on your `PATH`. Check with `node --version`.
- **Git** (optional), for the branch / changes segment
- A terminal font with block and box-drawing characters (`█ ░ │ ⎇ ↻`). Almost every modern font has them; if yours doesn't, see [Troubleshooting](#troubleshooting).

## Install

### 1. Download the script into `~/.claude/`

**macOS / Linux**

```bash
mkdir -p ~/.claude
curl -fsSL https://raw.githubusercontent.com/burapha-t/claude-terminal-status/main/statusline.mjs -o ~/.claude/statusline.mjs
```

**Windows (PowerShell)**

```powershell
New-Item -ItemType Directory -Force "$HOME\.claude" | Out-Null
Invoke-WebRequest -UseBasicParsing https://raw.githubusercontent.com/burapha-t/claude-terminal-status/main/statusline.mjs -OutFile "$HOME\.claude\statusline.mjs"
```

Or clone this repo and copy `statusline.mjs` into `~/.claude/` yourself.

### 2. Point Claude Code at it

Open `~/.claude/settings.json` (`%USERPROFILE%\.claude\settings.json` on Windows) and add the `statusLine` block. If the file already has other settings, **merge this block in** instead of replacing the file:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node ~/.claude/statusline.mjs",
    "refreshInterval": 30
  }
}
```

- The same command works on macOS, Linux, and Windows: Claude Code expands `~` to your home directory on every platform.
- **Windows:** if you write a full path, use **forward slashes**, e.g. `node C:/Users/<you>/.claude/statusline.mjs`. Backslashes are dropped when the command runs through Git Bash, and the status line silently stays blank.
- `refreshInterval: 30` re-runs the script every 30 seconds, so the reset countdowns and session timer stay current while Claude is idle. Remove it if you only want updates on activity.

### 3. Start a new Claude Code session

The status line appears under the prompt. If the folder isn't trusted yet, accept the workspace trust prompt first: Claude Code won't run the status line until you do.

## Check that it works

Pipe some sample session JSON into the script:

**macOS / Linux**

```bash
echo '{"model":{"display_name":"Opus"},"context_window":{"used_percentage":42,"total_input_tokens":84000,"context_window_size":200000}}' | node ~/.claude/statusline.mjs
```

**Windows (PowerShell)**

```powershell
'{"model":{"display_name":"Opus"},"context_window":{"used_percentage":42,"total_input_tokens":84000,"context_window_size":200000}}' | node "$HOME\.claude\statusline.mjs"
```

You should see something like `Opus  │  ctx ████░░░░░░ 42% 84k/200k`. To see how it handles narrow terminals, set the `COLUMNS` environment variable before running it.

## What each segment means

| Segment | Example | Meaning |
| --- | --- | --- |
| Model · effort | `Opus 5.5·xhigh` | Current model and reasoning effort. `>>` is appended when fast mode is on. |
| Vim mode | `NORMAL` | Shown only when vim mode is enabled. |
| Agent | `@reviewer` | Shown when running with `--agent`. |
| Directory | `▸ my-app` | Name of the current directory. |
| Worktree | `wt:feature-x` | Shown when inside a git worktree. |
| Git | `⎇ main +2 ~3 ?1 ↑1 ↓2` | Branch, then counts of **+** staged, **~** modified, **?** untracked, **!** conflicted files, then **↑** ahead / **↓** behind upstream. |
| Pull request | `PR#42` | Open PR for the branch. Green = approved, red = changes requested, yellow = pending, gray = draft. |
| Diff | `+212/-37` | Lines added / removed during this session. |
| Context | `ctx █████░░░░░ 47% 94k/200k` | Context window usage. Green below 70%, yellow from 70%, red from 90% with a `!compact` hint. |
| 5-hour / weekly limits | `5h ██░░░░ 38% ↻1h59m` | Rate-limit usage, with **↻** time until the window resets. See below. |
| Cost | `$1.84` | Estimated session cost in USD (Claude Code's client-side estimate; it may differ from your bill). |
| Duration | `43m` | How long the session has been running. |

### How the rate-limit colors work

The 5h / 7d bars are colored by **where you're heading, not where you are**. The script projects your current burn rate to the end of the window:

- **Green**: you'll finish the window at ≤ 110% of the limit at this pace
- **Yellow**: projected to reach more than 110%
- **Red**: projected to reach more than 150%

So 80% used ten minutes before reset is green, while 40% used in the first hour is red. When you're on track to hit the cap well before the reset, a countdown appears: `!30m` means "about 30 minutes left at this pace".

> Rate limits only show for claude.ai **Pro / Max** subscribers, and only after the first response in a session. On API-key billing these segments simply don't appear.

## Configuration

All settings are at the top of `statusline.mjs`. Open it in any editor.

**Toggle segments** in the `SHOW` block (`true` / `false`):

```js
const SHOW = {
  model: true, effort: true, fastMode: true, thinking: false, vim: true,
  agent: true, sessionName: false, dir: true, worktree: true, git: true,
  gitSync: true, pr: true, diffStat: true, context: true, ctxTokens: true,
  cacheHit: false, fiveHour: true, sevenDay: true, cost: true, duration: true,
  clock: false,
};
```

Off by default: `thinking` (extended-thinking flag), `sessionName` (the `/rename` title), `cacheHit` (% of input served from prompt cache), and `clock` (time of day).

**Tune behavior** with the constants below it:

| Constant | Default | Effect |
| --- | --- | --- |
| `MAX_ROWS` | `2` | `1` = never wrap; drop the least important segments instead. |
| `WARN_AT` / `DANGER_AT` | `70` / `90` | Context % where the bar turns yellow / red. |
| `ASCII_ONLY` | `false` | `true` replaces the bars and icons with plain ASCII (`#`, `-`, `^`, `v`) for fonts that lack them. |
| `WIDTH_MARGIN` | `2` | Columns held back from the terminal width so a row can never wrap. |
| `GIT_CACHE_MS` | `3000` | Minimum time between `git status` calls. |
| `FALLBACK_COLS` | `80` | Width to assume if Claude Code doesn't report one. |

> Updating with the download command from [Install](#install) **overwrites your edits**. Back up your customized copy first, or keep your own fork.

## How it adapts to width

Claude Code sends the session data as JSON on stdin and reports the terminal width in `COLUMNS`. The script tries a series of layouts, from roomiest to tightest, and uses the first one that fits on one line. Each step changes one thing: narrower separators, shorter bars, dropping the `▸` / `⎇` icons, dropping the token counts, then hiding cost and time, and finally the reset countdowns. Only when even the tightest single line doesn't fit does it split into two rows (identity on top, budgets below).

Every row is measured and kept strictly inside the terminal width. A row that wrapped would make Claude Code's UI draw over itself.

`git status` results are cached in your OS temp directory (`cc-statusline-git-*.json`) for 3 seconds, so frequent redraws stay fast in large repos.

## Troubleshooting

**The status line is blank**

1. Run the [check command](#check-that-it-works). If that fails, the problem is Node or the file path, not Claude Code.
2. Make sure `node` is on the `PATH` of the shell Claude Code uses. On Windows that's Git Bash if it's installed, otherwise PowerShell.
3. On Windows, use forward slashes (or `~`) in the `command` path, never backslashes.
4. Accept the workspace trust prompt for the folder you're in.
5. Check that `disableAllHooks` isn't set to `true` in your settings; it also disables the status line.
6. Run `claude --debug` to see the script's errors.

**It shows `statusline: <message>` in gray.** The script caught an error and printed the first part of it rather than blocking the prompt. The message tells you what went wrong.

**It shows `ctx ░░░░░░░░░░ --`.** Normal at the start of a session: Claude Code doesn't have context data until the first response.

**Boxes or `?` instead of bars.** Your terminal font is missing the glyphs. Switch to a font that has them, or set `ASCII_ONLY = true`.

**No git segment.** You're not in a git repository, `git` isn't on your `PATH`, or `git status` took longer than 1.5 s and was skipped.

**The line wraps or the UI flickers.** Increase `WIDTH_MARGIN` to `3` or `4`. Some terminals reserve an extra column.

## Uninstall

Delete the `statusLine` block from `~/.claude/settings.json` (or run `/statusline delete` inside Claude Code), then delete `~/.claude/statusline.mjs`.

## Reference

- [Claude Code status line documentation](https://code.claude.com/docs/en/statusline): every field Claude Code sends to the script.
