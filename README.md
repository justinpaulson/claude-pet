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
  usage windows, polled every 5 minutes from `api.anthropic.com/api/oauth/usage`
  with the OAuth token Claude Code keeps in your login keychain. See "Usage limit
  rows" below.
- Those two rows are always drawn — they're the reason the card exists. When the
  numbers can't be refreshed the row dims and its detail line says how old they
  are ("3h old") instead of the reset time. It only tells you to log in when
  Claude Code genuinely has no credentials stored.
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

These need no setup. The pet reads Claude Code's OAuth access token from the
`Claude Code-credentials` keychain item and polls the usage endpoint directly.

**The pet never writes to the keychain, and never refreshes the token itself.**
That matters more than it sounds. The server rotates the refresh token on every
refresh, so whoever refreshes has to store the rotated value back — otherwise the
*other* holder of that credential is silently logged out. An earlier version of
this app refreshed without persisting, which logged the CLI out roughly every
8 hours and had the card telling you to run `claude auth login` over and over.

So renewal is delegated to the tool that owns the credential. When the stored
token is within a minute of expiring, the pet runs `claude doctor` — a cheap
authenticated command, well under a second, no inference and no MCP servers
started — which makes Claude Code refresh and store the result the way it already
knows how. The pet then reads back what the CLI wrote. `claude mcp list` is kept
as a fallback in case `doctor` ever stops making an authenticated call. Renewals
are serialised and rate-limited to one attempt per 5 minutes.

Two consequences worth knowing:

- **Nothing to configure, and no re-login cycle.** It keeps working whether you
  live in the terminal or the desktop app.
- **The status-line file is still read, as a fallback.** Setups with no
  subscription token at all (Bedrock, Vertex, a plain API key) have no keychain
  entry to poll, so if `~/.claude/pet-limits.json` exists the pet will use it —
  see `statusline-command.sh` for the shape. Its numbers are only used until the
  API answers once, and they carry the file's own timestamp so old data is shown
  as old rather than as current.

## Packaging (optional)

To get a real `.app` you can drop in `~/Applications` and enable "Start at
Login" without keeping a terminal open:

```bash
npm install --save-dev electron-builder
npx electron-builder --mac --dir
```
