# Claude Pet

A usage readout that lives in the corner of your screen — disk, memory, and your
Claude subscription's 5-hour and weekly limits — with a tiny desktop pet hiding
behind it. He lurks out of sight while Claude Code is idle, leans up over the
card while a session is working, and pops all the way up waving — plus an OS
notification — when a session needs your approval.

## How it works

- The app runs a local HTTP server on `127.0.0.1:47823` that only accepts
  connections from your own machine.
- Claude Code [hooks](https://code.claude.com/docs/en/hooks) (configured in
  `~/.claude/settings.json`) POST their event payload to that server on
  `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PermissionDenied`,
  `Stop`, and `SessionEnd`.
- The pet tracks per-session state (`idle` / `working` / `alert`) and shows
  the most urgent state across all your open sessions.
- The usage card refreshes every 3s: disk from `statfs` on `/`, memory from
  `vm_stat` (active + wired + compressed, which is what Activity Monitor calls
  "used" — Node's `os.freemem()` counts only free pages and reads as ~100%
  used on any warm machine).
- The SESSION and WEEKLY rows are your Claude subscription's 5-hour and 7-day
  usage windows. Those numbers reach exactly one place: Claude Code's **status
  line** payload (`rate_limits.five_hour` / `.seven_day`) — no hook carries
  them. So the status line writes them to `~/.claude/pet-limits.json` and the
  pet reads that file. See "Usage limit rows" below.
- Either row hides itself entirely when there's no number for it, rather than
  showing an empty bar that reads as 0% used. That covers sessions with no
  subscription window at all (Bedrock, Vertex, plain API keys), a status line
  that isn't wired up, and a window whose `resets_at` has already passed —
  stale data would be a percentage of a limit that no longer applies.
- The window is only click-through where it's empty: the space the pet pops up
  into passes clicks to whatever is underneath, and the window starts taking
  clicks again once the cursor reaches the card or the pet.

No project files, prompts, or code are sent anywhere — only the hook
metadata (session id, tool name, cwd, event name) to your own machine's
loopback address.

## Setup

```bash
npm install
npm start
```

The card appears in the top-right corner of your main display and a small
colored dot appears in the macOS menu bar (grey idle, orange working, red needs
approval). Drag the card or the pet to move them anywhere; the position is
remembered. Click the pet to bring the Claude desktop app to the front,
launching it if it isn't already running. Right-click the menu bar icon for
Show/Hide, Reset Position, Start at Login, and Quit.

This replaces the standalone `usage-hud` menu-bar app — quit that one so you
don't end up with two cards on screen.

**Hooks are configured separately** — see the `hooks` block that should be
merged into `~/.claude/settings.json` so Claude Code actually reports events
to this app. If you asked Claude to set this up for you, it's likely already
done; otherwise see `hooks-snippet.json` in this repo.

## Usage limit rows

The two Claude rows need a status line, because that payload is the only thing
that carries `rate_limits`. Point `statusLine` in `~/.claude/settings.json` at a
script, and have that script stash the limits where the pet can find them:

```bash
limits=$(echo "$input" | jq -c '.rate_limits // empty') || return 0
[ -n "$limits" ] || return 0    # nothing to report; leave the old file alone
printf '{"ts":%s,"rate_limits":%s}\n' "$(date +%s)" "$limits" > "$tmp" && mv -f "$tmp" "$out"
```

Two details worth keeping:

- **Bail out when `rate_limits` is empty.** Sessions that don't run on a
  subscription (Bedrock, Vertex, API key) render a status line with no usage
  windows in it. Writing the file anyway would blank the rows every time one of
  those sessions redrew.
- **Write via a temp file and `mv`.** The pet re-reads the file every 3s and
  shouldn't be able to catch a half-written one.

The rows appear on their own once the file shows up, and stay hidden until then.

## Packaging (optional)

To get a real `.app` you can drop in `~/Applications` and enable "Start at
Login" without keeping a terminal open:

```bash
npm install --save-dev electron-builder
npx electron-builder --mac --dir
```
