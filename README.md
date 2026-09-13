# Claude Pet

A tiny desktop pet that lives in the corner of your screen. It bobs when idle,
bounces while any Claude Code session is working, and flashes red with an OS
notification when a session needs your permission/approval.

## How it works

- The app runs a local HTTP server on `127.0.0.1:47823` that only accepts
  connections from your own machine.
- Claude Code [hooks](https://code.claude.com/docs/en/hooks) (configured in
  `~/.claude/settings.json`) POST their event payload to that server on
  `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PermissionDenied`,
  `Stop`, and `SessionEnd`.
- The pet tracks per-session state (`idle` / `working` / `alert`) and shows
  the most urgent state across all your open sessions.

No project files, prompts, or code are sent anywhere — only the hook
metadata (session id, tool name, cwd, event name) to your own machine's
loopback address.

## Setup

```bash
npm install
npm start
```

The pet appears in the bottom-right corner of your main display and a small
icon appears in the macOS menu bar (🐾 idle, ⚙️ working, 🚨 needs approval).
Drag the pet anywhere; its position is remembered. Right-click the menu bar
icon for Show/Hide, Reset Position, Start at Login, and Quit.

**Hooks are configured separately** — see the `hooks` block that should be
merged into `~/.claude/settings.json` so Claude Code actually reports events
to this app. If you asked Claude to set this up for you, it's likely already
done; otherwise see `hooks-snippet.json` in this repo.

## Packaging (optional)

To get a real `.app` you can drop in `~/Applications` and enable "Start at
Login" without keeping a terminal open:

```bash
npm install --save-dev electron-builder
npx electron-builder --mac --dir
```
