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
  with the pet's own Claude login. See "Usage limit rows" below.
- Those two rows are always drawn — they're the reason the card exists. When the
  numbers can't be refreshed the row dims and its detail line says how old they
  are ("3h old") instead of the reset time. It only asks you to sign in when the
  pet has no login of its own and your CLI's token isn't current either.
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
Show/Hide, Reset Position, Sign In for Usage Limits, Start at Login, and Quit.

This replaces the standalone `usage-hud` menu-bar app — quit that one, and turn
off its login item, so you don't end up with two cards on screen.

**Hooks are configured separately** — see the `hooks` block that should be
merged into `~/.claude/settings.json` so Claude Code actually reports events
to this app. If you asked Claude to set this up for you, it's likely already
done; otherwise see `hooks-snippet.json` in this repo.

## Usage limit rows

Sign in once: **Sign In for Usage Limits…** in the menu-bar menu opens Terminal
on `claude auth login --claudeai`, pointed at a config directory only the pet
uses (`~/Library/Application Support/claude-pet/claude-login`). Approve it in the
browser and the rows fill in within a minute. That's the only setup, and it
doesn't touch the login your terminal `claude` uses.

**Why the pet has its own login.** Every token refresh rotates the refresh token.
A login shared by two programs is one lost response away from being dead for
both: the rotated token never gets stored, the next refresh comes back
`invalid_grant`, and Claude Code blanks its keychain entry. That's the "please
log in" you then see. Earlier versions of the pet shared the CLI's login. First
they refreshed it without saving the result. Later they ran `claude doctor`
whenever its token lapsed, so Claude Code did the refresh. That was safer, but
it still meant the pet was refreshing your login around the clock, and on
2026-10-16 one of those refreshes is what blanked it, at a point when the pet was
the only thing refreshing it.

With `CLAUDE_CONFIG_DIR` set, Claude Code stores a login under its own keychain
entry, `Claude Code-credentials-<first 8 hex of sha256(dir)>`, so the pet's login
is a separate grant that nothing else ever refreshes. When its token is within a
minute of expiring, the pet runs `claude doctor` against that directory, a cheap
authenticated command that makes Claude Code refresh and store the result the way
it already knows how, then reads back what the CLI wrote. `claude mcp list` is
kept as a fallback in case `doctor` ever stops making an authenticated call.
Renewals are serialised and rate-limited to one attempt per 5 minutes. A 401 is
never answered with a forced refresh: a token rejected before its expiry belongs
to a revoked login, and refreshing it is what makes the CLI blank it.

The pet never writes to the keychain itself. Things worth knowing:

- **Your CLI login is only ever read.** Until the pet is signed in, it borrows
  the token in `Claude Code-credentials`, but only while it's current. It never
  renews it, so once it lapses the rows go stale until you next use `claude` in a
  terminal, or until you sign the pet in.
- **If the pet's own login ever dies**, only the pet is affected. The card says
  "sign in from the menu bar", and signing in again replaces it.
- **The status-line file is still read, as a fallback.** Setups with no
  subscription token at all (Bedrock, Vertex, a plain API key) have no keychain
  entry to poll, so if `~/.claude/pet-limits.json` exists the pet will use it —
  see `statusline-command.sh` for the shape. Its numbers are only used until the
  API answers once, and they carry the file's own timestamp so old data is shown
  as old rather than as current.

## Packaging and starting at login

`npm start` is a foreground Electron process owned by whatever terminal launched
it, so it dies with that terminal and doesn't survive a restart. For a copy that
comes back on its own, build the bundle and install it:

```bash
npm run install-app
```

That packages `ClaudePet.app` into `dist/` and copies it to `~/Applications`.
Then turn on **Start at Login** in the menu-bar menu (or run the app once and
toggle it) and it will be there after the next restart.

Two details the build script exists to handle:

- **Re-signing.** `@electron/packager` leaves the Electron binary's
  linker-signed ad-hoc signature in place, which no longer matches the rewritten
  bundle — `codesign -v` reports "code has no resources but signature indicates
  they must be present" and macOS may refuse to launch it. The build re-signs
  ad-hoc afterwards.
- **`electron-builder` is not used.** Its current release pulls in an ESM-only
  `@noble/hashes`, which Node 20.18 can't `require()`. `@electron/packager` is
  all this needs, since there's no installer to produce.

### How "Start at Login" works

It writes `~/Library/LaunchAgents/com.justinpaulson.claudepet.plist`, a
`RunAtLoad` agent that runs `open -a ~/Applications/ClaudePet.app`.

It deliberately does **not** use `app.setLoginItemSettings`, which registers
`process.execPath` with no arguments. From a packaged app that happens to be
right, but from `npm start` that path is the bare Electron helper inside
`node_modules` — so login brought up an empty default Electron window instead of
the pet, while the checkbox sat there looking like it had worked. Naming the
command in a plist is correct in both modes, and the checkbox just reflects
whether the file is there.

Rebuilding changes the ad-hoc code signature but not the bundle path, so the
login agent keeps working across rebuilds; re-run `npm run install-app` and the
next login picks up the new build.
