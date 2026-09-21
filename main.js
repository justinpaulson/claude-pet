const { app, BrowserWindow, Tray, Menu, nativeImage, screen, Notification, ipcMain } = require('electron');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const https = require('https');

const PORT = 47823;
// Sized for the card at its tallest (all four rows) plus the headroom the pet
// pops up into above it. The window is docked to the bottom of the screen and
// never moves vertically; the card slides within it, so the height has to cover
// the fully expanded state even though most of it is empty most of the time.
// That empty space stays click-through.
const WIN_W = 216;
// The four-row card plus the pet's clip box, with a little slack for font
// metrics varying between displays.
const WIN_H = 328;
const MARGIN = 20;
const USAGE_INTERVAL_MS = 3000;
const CONFIG_PATH = path.join(app.getPath('userData'), 'pet-config.json');
const LIMITS_PATH = path.join(os.homedir(), '.claude', 'pet-limits.json');
// Claude's own usage windows, polled straight from the API. The status line was
// the only source before, which meant the rows went dark any time you spent a
// few hours without a terminal session rendering one.
const USAGE_POLL_MS = 5 * 60 * 1000;
// Backed off to this after a failed poll so a rate-limited or down endpoint
// doesn't get hammered every five minutes.
const USAGE_BACKOFF_MS = 15 * 60 * 1000;
const USAGE_API = 'https://api.anthropic.com/api/oauth/usage';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
// Count a token as due for renewal slightly before it actually lapses, so a slow
// request can't land on the far side of the expiry.
const TOKEN_SKEW_MS = 60 * 1000;
// The pet never refreshes the token itself and never writes to the keychain. The
// server rotates the refresh token on every refresh, so whoever refreshes has to
// persist the rotated value back or the *other* holder of that credential is
// silently logged out — which is exactly what this app used to do to the CLI.
// So renewal is handed to the tool that owns the credential: run a cheap
// authenticated CLI command, let Claude Code refresh and store the result the
// way it already knows how, then read back what it wrote. `doctor` is the light
// one (under a second, no inference, no MCP servers started); `mcp list` is a
// fallback in case `doctor` ever stops making an authenticated call.
const CLAUDE_REFRESH_ARGS = [['doctor'], ['mcp', 'list']];
// A GUI launch inherits almost no PATH, so the CLI is found by absolute path
// first and only then left to PATH.
const CLAUDE_BIN_CANDIDATES = [
  path.join(os.homedir(), '.local', 'bin', 'claude'),
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude',
];
// Floor between renewal attempts. A renewal that fails usually means a signed-out
// CLI, which running it again won't fix.
const REFRESH_COOLDOWN_MS = 5 * 60 * 1000;
// Last good response, so a restart shows numbers immediately instead of waiting
// out a poll interval with empty rows.
const USAGE_CACHE_PATH = path.join(app.getPath('userData'), 'usage-cache.json');
const CLAUDE_BUNDLE_ID = 'com.anthropic.claudefordesktop';

// "Start at Login" is a LaunchAgent rather than `app.setLoginItemSettings`,
// which registers `process.execPath` with no arguments. For an unpackaged run
// that path is the bare Electron helper under node_modules, so login brought up
// an empty default Electron window instead of the pet — and the checkbox looked
// like it had worked. A plist names the real command, which is correct both
// from a dev run and from the installed .app.
const LOGIN_LABEL = 'com.justinpaulson.claudepet';
const LOGIN_PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LOGIN_LABEL}.plist`);

// A session is "stale" (probably crashed/closed without a SessionEnd hook firing)
// if we haven't heard from it in this long. Swept periodically so the pet
// doesn't get stuck alerting/working forever for a dead session.
const STALE_MS = 30 * 60 * 1000;

let mainWindow;
let tray;
const sessions = new Map(); // session_id -> { state, cwd, lastSeen }
const notifiedToolUses = new Set(); // dedupe OS notifications per tool_use_id

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig(cfg) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg));
  } catch {
    // best-effort; losing the remembered position isn't fatal
  }
}

const BYTES_PER_GB = 1e9;

function diskUsage() {
  try {
    const s = fs.statfsSync('/');
    const total = s.blocks * s.bsize;
    const available = s.bavail * s.bsize;
    if (!(total > 0)) return null;
    return { percent: ((total - available) / total) * 100, usedGB: (total - available) / BYTES_PER_GB, totalGB: total / BYTES_PER_GB };
  } catch {
    return null;
  }
}

// macOS "memory used" is active + wired + compressed, which is what Activity
// Monitor shows. Node's os.freemem() only counts genuinely free pages, so it
// reads as ~100% used on any warm machine — hence shelling out to vm_stat.
function memoryUsage(cb) {
  execFile('vm_stat', (err, stdout) => {
    const total = os.totalmem();
    if (err || !total) return cb(null);
    const pageSize = Number(/page size of (\d+) bytes/.exec(stdout)?.[1]) || 4096;
    const pages = (label) => Number(new RegExp(`${label}:\\s+(\\d+)`).exec(stdout)?.[1] || 0);
    const used = (pages('Pages active') + pages('Pages wired down') + pages('Pages occupied by compressor')) * pageSize;
    if (!used) return cb(null);
    cb({ percent: (used / total) * 100, usedGB: used / BYTES_PER_GB, totalGB: total / BYTES_PER_GB });
  });
}

// The API hands back `utilization` already scaled 0-100, and `resets_at` as an
// ISO-8601 string. The status-line file used different names and a unix epoch,
// so both sources get normalised to this shape before anything else sees them.
function normalizeWindow(percent, resetsAt) {
  if (!Number.isFinite(percent)) return null;
  let resetsAtMs = null;
  if (typeof resetsAt === 'string') {
    const parsed = Date.parse(resetsAt);
    if (Number.isFinite(parsed)) resetsAtMs = parsed;
  } else if (Number.isFinite(resetsAt)) {
    // Epoch seconds from the status-line file; epoch millis would be ~1e12.
    resetsAtMs = resetsAt < 1e11 ? resetsAt * 1000 : resetsAt;
  }
  return { percent, resetsAtMs };
}

// Claude Code stores its OAuth credentials in the login keychain. The pet only
// ever reads them, at the moment of use, and never logs them or writes them back.
// `state` distinguishes a signed-out CLI (nothing stored) from the pet simply
// being unable to read what is there — only the first is the user's to fix.
function readCredentials(cb) {
  execFile('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], { timeout: 3000 }, (err, stdout, stderr) => {
    if (err) {
      // `security` exits 44 when the item isn't there at all.
      const missing = err.code === 44 || /could not be found/i.test(stderr || '');
      return cb(null, missing ? 'missing' : 'unreadable');
    }
    try {
      const blob = JSON.parse(stdout);
      if (!blob?.claudeAiOauth?.accessToken) return cb(null, 'missing');
      cb(blob, 'ok');
    } catch {
      cb(null, 'unreadable');
    }
  });
}

function usableToken(blob) {
  const oauth = blob?.claudeAiOauth;
  if (!oauth?.accessToken || !Number.isFinite(oauth.expiresAt)) return null;
  if (oauth.expiresAt <= Date.now() + TOKEN_SKEW_MS) return null;
  return oauth.accessToken;
}

let claudeBin;
function resolveClaudeBin() {
  if (claudeBin !== undefined) return claudeBin;
  claudeBin = CLAUDE_BIN_CANDIDATES.find((candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }) || 'claude';
  return claudeBin;
}

// Guards against two renewals racing, and against retrying one that isn't going
// to work.
let refreshInFlight = null;
let lastRefreshAt = 0;

// Asks the CLI to renew its own credential, then reports whether a usable token
// actually appeared. The command's exit status is ignored on purpose — the only
// thing that matters is what ended up in the keychain afterwards.
function refreshViaCli(cb) {
  if (refreshInFlight) return refreshInFlight.push(cb);
  if (Date.now() - lastRefreshAt < REFRESH_COOLDOWN_MS) {
    return cb(new Error('waiting out the renewal cooldown'));
  }
  refreshInFlight = [cb];
  const settle = (err) => {
    lastRefreshAt = Date.now();
    const waiting = refreshInFlight;
    refreshInFlight = null;
    for (const fn of waiting) fn(err);
  };

  const bin = resolveClaudeBin();
  // Run from the home directory so no project's settings or trust state is in play.
  const attempt = (i) => {
    if (i >= CLAUDE_REFRESH_ARGS.length) return settle(new Error("the CLI didn't renew the token"));
    execFile(bin, CLAUDE_REFRESH_ARGS[i], { timeout: 90000, cwd: os.homedir() }, () => {
      readCredentials((blob) => (usableToken(blob) ? settle(null) : attempt(i + 1)));
    });
  };
  attempt(0);
}

function withAccessToken(forceRefresh, cb) {
  readCredentials((blob, state) => {
    const token = usableToken(blob);
    if (token && !forceRefresh) return cb(null, token);
    if (state === 'missing') {
      // Nothing stored: a signed-out CLI, or a setup that never had a
      // subscription token at all (Bedrock, Vertex, a plain API key).
      const err = new Error('no Claude Code credentials in the keychain');
      err.signedOut = true;
      return cb(err);
    }
    refreshViaCli((refreshErr) => {
      if (refreshErr) {
        // A token we already hold beats failing outright, even when the 401 that
        // sent us here says it probably won't work.
        if (token) return cb(null, token);
        return cb(refreshErr);
      }
      readCredentials((renewed) => {
        const fresh = usableToken(renewed);
        if (fresh) return cb(null, fresh);
        cb(new Error('no usable token after the CLI renewed it'));
      });
    });
  });
}

// Deliberately vague on failure: the token must never reach a log line.
function fetchUsage(token, cb) {
  const req = https.request(USAGE_API, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'Content-Type': 'application/json',
    },
    timeout: 5000,
  }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
      if (res.statusCode !== 200) {
        const err = new Error(`usage API ${res.statusCode}`);
        err.statusCode = res.statusCode;
        return cb(err);
      }
      try {
        cb(null, JSON.parse(body));
      } catch {
        cb(new Error('usage API returned malformed JSON'));
      }
    });
  });
  req.on('timeout', () => req.destroy(new Error('usage API timed out')));
  req.on('error', cb);
  req.end();
}

function loadUsageCache() {
  try {
    const cached = JSON.parse(fs.readFileSync(USAGE_CACHE_PATH, 'utf8'));
    if (Number.isFinite(cached?.fetchedAt)) return cached;
  } catch {
    // no cache yet, or it's unreadable; we'll have numbers after the first poll
  }
  return null;
}

function saveUsageCache(usage) {
  try {
    fs.writeFileSync(USAGE_CACHE_PATH, JSON.stringify(usage));
  } catch {
    // best-effort; the in-memory copy is what actually drives the display
  }
}

// Seeded from disk so a restart draws real numbers immediately rather than
// blank rows until the first poll lands.
let claudeUsage = loadUsageCache();

// Past this the numbers are old enough that they shouldn't be read as current.
// The rows stay put either way — they're the reason the card exists, and a row
// that removes itself just looks like the pet is broken. It goes dim and says
// why instead.
const USAGE_MAX_AGE_MS = 60 * 60 * 1000;

// Why the last poll didn't land, phrased for a 200px-wide card. Signed-out is
// tracked apart from every other failure because it is the only one the user can
// do anything about — and telling them to log in when they aren't logged out is
// how this card spent a day crying wolf.
let usageNote = null;
let usageSignedOut = false;

// "12m old" / "3h old" / "2d old" — an age the card has room for.
function ageNote(ms) {
  const mins = Math.max(Math.round(ms / 60000), 1);
  if (mins < 60) return `${mins}m old`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h old`;
  return `${Math.round(hours / 24)}d old`;
}

function currentClaudeUsage() {
  if (!claudeUsage) {
    return { session: null, weekly: null, stale: true, note: usageNote || 'waiting for first poll' };
  }
  const age = Date.now() - claudeUsage.fetchedAt;
  const stale = age > USAGE_MAX_AGE_MS;
  return {
    session: claudeUsage.session,
    weekly: claudeUsage.weekly,
    stale,
    // Being signed out is worth naming; anything else, the honest thing to show
    // is how old the numbers on screen actually are.
    note: stale ? (usageSignedOut ? 'run claude auth login' : ageNote(age)) : null,
  };
}

// Fallback for the case the API can't cover: Bedrock/Vertex/API-key setups have
// no subscription windows and no keychain entry, but a status line may still
// have left something behind.
function statusLineLimits() {
  try {
    const file = JSON.parse(fs.readFileSync(LIMITS_PATH, 'utf8'));
    const limits = file?.rate_limits;
    const session = normalizeWindow(limits?.five_hour?.used_percentage, limits?.five_hour?.resets_at);
    const weekly = normalizeWindow(limits?.seven_day?.used_percentage, limits?.seven_day?.resets_at);
    if (!session && !weekly) return null;
    // The file's own timestamp, not now — otherwise a status line that last ran
    // yesterday would look like a fresh reading and sail past the staleness gate.
    if (!Number.isFinite(file?.ts)) return null;
    return { session, weekly, fetchedAt: file.ts * 1000 };
  } catch {
    return null;
  }
}

function pollClaudeUsage() {
  const reschedule = (ms) => setTimeout(pollClaudeUsage, ms);
  const failed = (reason, signedOut) => {
    // Only fall back to the status-line file while we've never had a good poll;
    // once the API has answered, its numbers are strictly fresher.
    if (!claudeUsage) {
      const fromFile = statusLineLimits();
      if (fromFile) claudeUsage = fromFile;
    }
    usageSignedOut = Boolean(signedOut);
    usageNote = signedOut ? 'run claude auth login' : null;
    console.error(`[pet] usage poll failed: ${reason}`);
    reschedule(USAGE_BACKOFF_MS);
  };

  const succeeded = (data) => {
    const session = normalizeWindow(data?.five_hour?.utilization, data?.five_hour?.resets_at);
    const weekly = normalizeWindow(data?.seven_day?.utilization, data?.seven_day?.resets_at);
    if (!session && !weekly) return failed('no subscription windows in response');
    claudeUsage = { session, weekly, fetchedAt: Date.now() };
    usageNote = null;
    usageSignedOut = false;
    saveUsageCache(claudeUsage);
    reschedule(USAGE_POLL_MS);
  };

  // A 401 on a token we believed was current means it was revoked or rotated out
  // from under us, so force one refresh and try again before giving up.
  const attempt = (forceRefresh) => {
    withAccessToken(forceRefresh, (tokenErr, token) => {
      if (tokenErr) return failed(tokenErr.message, tokenErr.signedOut);
      fetchUsage(token, (err, data) => {
        if (err && err.statusCode === 401 && !forceRefresh) return attempt(true);
        if (err) return failed(err.message);
        succeeded(data);
      });
    });
  };

  attempt(false);
}

function sampleUsage() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const disk = diskUsage();
  const { session, weekly, stale, note } = currentClaudeUsage();
  memoryUsage((memory) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('pet-usage', { disk, memory, session, weekly, stale, note });
  });
}

function computeGlobalState() {
  let hasAlert = false;
  let hasWorking = false;
  for (const s of sessions.values()) {
    if (s.state === 'alert') hasAlert = true;
    if (s.state === 'working') hasWorking = true;
  }
  if (hasAlert) return 'alert';
  if (hasWorking) return 'working';
  return 'idle';
}

function projectNameFromCwd(cwd) {
  if (!cwd) return 'a project';
  return path.basename(cwd);
}

function updateTray() {
  if (!tray) return;
  const state = computeGlobalState();
  const alertCount = [...sessions.values()].filter((s) => s.state === 'alert').length;
  tray.setImage(TRAY_ICONS[state] || TRAY_ICONS.idle);
  tray.setToolTip(
    state === 'alert'
      ? `Claude Pet — ${alertCount} session${alertCount === 1 ? '' : 's'} need approval`
      : state === 'working'
      ? 'Claude Pet — working…'
      : 'Claude Pet — idle'
  );
}

function broadcastState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const alertCount = [...sessions.values()].filter((s) => s.state === 'alert').length;
  mainWindow.webContents.send('pet-state', {
    state: computeGlobalState(),
    alertCount,
    sessionCount: sessions.size,
  });
  updateTray();
}

function handleEvent(payload) {
  const { hook_event_name, session_id, tool_name, tool_use_id, cwd } = payload || {};
  if (!session_id || typeof hook_event_name !== 'string') return;

  if (hook_event_name === 'SessionEnd') {
    sessions.delete(session_id);
    broadcastState();
    return;
  }

  const existing = sessions.get(session_id) || { state: 'idle' };
  existing.cwd = cwd || existing.cwd;
  existing.lastSeen = Date.now();

  switch (hook_event_name) {
    case 'UserPromptSubmit':
    case 'PreToolUse':
      existing.state = 'working';
      break;
    case 'PermissionRequest': {
      existing.state = 'alert';
      const key = tool_use_id || `${session_id}:${tool_name}:${Date.now()}`;
      if (!notifiedToolUses.has(key)) {
        notifiedToolUses.add(key);
        const proj = projectNameFromCwd(existing.cwd);
        new Notification({
          title: 'Claude needs your approval',
          body: `${tool_name || 'A tool'} call in ${proj}`,
          silent: false,
        }).show();
      }
      break;
    }
    case 'PermissionDenied':
      existing.state = 'working';
      break;
    case 'Stop':
    case 'StopFailure':
      existing.state = 'idle';
      break;
    default:
      break;
  }
  sessions.set(session_id, existing);
  broadcastState();
}

function sweepStaleSessions() {
  const now = Date.now();
  let changed = false;
  for (const [id, s] of sessions) {
    if (now - (s.lastSeen || 0) > STALE_MS) {
      sessions.delete(id);
      changed = true;
    }
  }
  if (changed) broadcastState();
}

function startServer() {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/event') {
      res.writeHead(404);
      res.end();
      return;
    }
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        handleEvent(JSON.parse(body));
      } catch {
        // malformed payload from a hook; ignore rather than crash the server
      }
      res.writeHead(204);
      res.end();
    });
  });
  server.on('error', (e) => {
    console.error('Pet server failed to start (port in use / another instance running?):', e.message);
  });
  server.listen(PORT, '127.0.0.1');
}

// Over on the right, out of the way of anything centred. Only x is ever chosen:
// the window is pinned to the bottom of the screen and the card sits below that
// edge until the pet is hovered, so vertical position isn't the pet's to pick.
function defaultX() {
  const { x: wx, width: ww } = screen.getPrimaryDisplay().workArea;
  return wx + ww - WIN_W - MARGIN;
}

// The work area rather than the full display, so the pet peeks above the Dock
// instead of behind it. Resolved against whichever display that x lands on, and
// clamped there — a saved position can outlive the display it was saved on.
function dockedPosition(x) {
  const wanted = Number.isFinite(x) ? Math.round(x) : defaultX();
  const primary = screen.getPrimaryDisplay().workArea;
  const area = screen.getDisplayNearestPoint({
    x: wanted + Math.round(WIN_W / 2),
    y: primary.y + primary.height - 1,
  }).workArea;
  return {
    x: Math.min(Math.max(wanted, area.x), area.x + area.width - WIN_W),
    y: area.y + area.height - WIN_H,
  };
}

// Resolution changes, a display being unplugged, and the Dock being shown or
// hidden all move the bottom edge out from under the pet, so re-dock whenever
// the screen layout shifts.
function redock() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const [px] = mainWindow.getPosition();
  const { x, y } = dockedPosition(px);
  mainWindow.setPosition(x, y);
}

function createWindow() {
  const cfg = loadConfig();
  const saved = dockedPosition(cfg.x);

  mainWindow = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x: saved.x,
    y: saved.y,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  mainWindow.setAlwaysOnTop(true, 'floating');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Most of the window is empty space for the pet to pop up into; ignore clicks
  // there so it isn't a big invisible shield over the desktop. `forward` keeps
  // mouse-move events coming to the renderer, which turns this back off while
  // the cursor is actually over the card or the pet.
  mainWindow.setIgnoreMouseEvents(true, { forward: true });
  mainWindow.loadFile('index.html');

  let moveTimeout;
  mainWindow.on('moved', () => {
    clearTimeout(moveTimeout);
    moveTimeout = setTimeout(() => {
      const [px] = mainWindow.getPosition();
      saveConfig({ x: px });
    }, 300);
  });

  mainWindow.webContents.on('did-finish-load', () => {
    broadcastState();
    sampleUsage();
  });
}

// Launches the Claude desktop app, or just brings it to the front if it's
// already running — `open` does both. Matching on the bundle id survives the
// app being installed somewhere other than /Applications; the name is a
// fallback in case the bundle id ever changes.
function openClaudeApp() {
  if (process.platform !== 'darwin') return;
  execFile('open', ['-b', CLAUDE_BUNDLE_ID], (err) => {
    if (!err) return;
    execFile('open', ['-a', 'Claude'], (fallbackErr) => {
      if (fallbackErr) console.error('Could not open the Claude app:', fallbackErr.message);
    });
  });
}

// Dragging is done here rather than with `-webkit-app-region: drag` because
// that region swallows the mouse events the renderer needs to tell a click
// apart from a drag. The renderer says when a drag starts/ends; we follow the
// cursor in the meantime.
let dragTimer = null;

function startDrag(_event, grab) {
  if (dragTimer || !mainWindow || mainWindow.isDestroyed()) return;
  // The window is frameless, so the point the pet was grabbed at is just the
  // click's position within the page. Holding that point under the cursor keeps
  // the drag exact: anchoring to the cursor's position now would instead shift
  // the pet by however far it travelled before we heard about the drag.
  const grabX = Number.isFinite(grab?.grabX) ? grab.grabX : WIN_W / 2;
  dragTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      stopDrag();
      return;
    }
    // Horizontal only. The pet lives on the bottom edge, so a drag slides him
    // along it to a less annoying spot rather than lifting him off it.
    const p = screen.getCursorScreenPoint();
    const { x, y } = dockedPosition(p.x - grabX);
    mainWindow.setPosition(x, y);
  }, 16);
}

function stopDrag() {
  clearInterval(dragTimer);
  dragTimer = null;
}

function registerIpc() {
  ipcMain.on('pet-drag-start', startDrag);
  ipcMain.on('pet-drag-end', stopDrag);
  ipcMain.on('pet-click', openClaudeApp);
  ipcMain.on('pet-interactive', (_event, interactive) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (interactive) mainWindow.setIgnoreMouseEvents(false);
    else mainWindow.setIgnoreMouseEvents(true, { forward: true });
  });
}

// Small filled-circle PNGs (32x32 @2x) — one per pet state. A plain colored
// dot rendered directly as the tray image, rather than relying on an emoji
// title (which didn't reliably render as a real status item on this setup).
const TRAY_ICON_DATA = {
  idle: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAQAAADZc7J/AAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAACYktHRAD/h4/MvwAAAAd0SU1FB+oJDQcEFYiPH4IAAAAldEVYdGRhdGU6Y3JlYXRlADIwMjYtMDktMTNUMDc6MDQ6MjErMDA6MDCeinT1AAAAJXRFWHRkYXRlOm1vZGlmeQAyMDI2LTA5LTEzVDA3OjA0OjIxKzAwOjAw79fMSQAAACh0RVh0ZGF0ZTp0aW1lc3RhbXAAMjAyNi0wOS0xM1QwNzowNDoyMSswMDowMLjC7ZYAAAEPSURBVEjH7ZUxjoMwEEXfpky7ooaWGzgXoLDCGVZKlz0QZaRwBSQXXGC5AW1SW2lTb4GCjbOAp0gT7XTG858+ePyB//qY29ApBXt2JFg6GlpzjQZoxYn86XHPwXSrAL2l4mvWcc3R3BcA+pOeZPGlLbm5zQD0lsuKfEBkzsVmslVFyCGh+tOBVvxEyIfaPT6n7+AULfd6Rwc65SIAQDbMhXNQiORjvwOUQkAZApQQoEJAzAH6lYQAKwTYENAJAU9z0AgBTQhohYA2AJgrvUDeP+LFH+WDADD2egDTUUfKzy6Zptf5GHWYlm+3mADMnXwVYcn9UJs6wNzIOC/IazI/0F6RyiMkpaBErf0X3qB+AX2xR43/yvtLAAAAAElFTkSuQmCC',
  working: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgBAMAAACBVGfHAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAqUExURQAAAMJBDMJBDMJBDMJBDMJBDMJBDMJBDMJBDMJBDMJBDMJBDMJBDP///wVdxtwAAAAMdFJOUwAfZbHqsjjWCqChE2RPKioAAAABYktHRA32tGH1AAAAB3RJTUUH6gkNBwQViI8fggAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wOS0xM1QwNzowNDoyMSswMDowMJ6KdPUAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDktMTNUMDc6MDQ6MjErMDA6MDDv18xJAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTA5LTEzVDA3OjA0OjIxKzAwOjAwuMLtlgAAAIRJREFUKM9jYKAaEDI5EiSAxE8/AwTHE+D8zjNgcKoByuf2gQic8YYKtED5Z45AlcyBCZyZAOazwflnjoEF2BECx8ECMgiBM2C36CAJKIAEYpAEAkACPkgCDiABJP6ZA1hVYJiBYQuGOzBciuEXhjVovsUMD4wQwwhTzFAHxksIaryQBAAumb4L9djWGwAAAABJRU5ErkJggg==',
  alert: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgBAMAAACBVGfHAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAqUExURQAAANwmJtwmJtwmJtwmJtwmJtwmJtwmJtwmJtwmJtwmJtwmJtwmJv///yBfpdUAAAAMdFJOUwAfZbHqsjjWCqChE2RPKioAAAABYktHRA32tGH1AAAAB3RJTUUH6gkNBwQViI8fggAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wOS0xM1QwNzowNDoyMSswMDowMJ6KdPUAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDktMTNUMDc6MDQ6MjErMDA6MDDv18xJAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTA5LTEzVDA3OjA0OjIxKzAwOjAwuMLtlgAAAIRJREFUKM9jYKAaEDI5EiSAxE8/AwTHE+D8zjNgcKoByuf2gQic8YYKtED5Z45AlcyBCZyZAOazwflnjoEF2BECx8ECMgiBM2C36CAJKIAEYpAEAkACPkgCDiABJP6ZA1hVYJiBYQuGOzBciuEXhjVovsUMD4wQwwhTzFAHxksIaryQBAAumb4L9djWGwAAAABJRU5ErkJggg==',
};
const TRAY_ICONS = Object.fromEntries(
  Object.entries(TRAY_ICON_DATA).map(([k, v]) => [k, nativeImage.createFromDataURL(v)])
);

// `open -a <bundle>` for the installed app, which activates the copy that's
// already running instead of starting a second one; the Electron binary plus
// this project's directory when running from the repo.
function loginArgs() {
  if (app.isPackaged) {
    return ['/usr/bin/open', '-a', path.resolve(path.dirname(process.execPath), '..', '..')];
  }
  return [process.execPath, app.getAppPath()];
}

function loginPlist() {
  const args = loginArgs().map((a) => `        <string>${a}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LOGIN_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${args}
    </array>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
`;
}

function setStartAtLogin(on) {
  const domain = `gui/${process.getuid()}`;
  if (on) {
    fs.mkdirSync(path.dirname(LOGIN_PLIST), { recursive: true });
    fs.writeFileSync(LOGIN_PLIST, loginPlist());
    // Bootstrapping now registers it with the login-items database, so it shows
    // up in System Settings straight away rather than only after a restart.
    execFile('launchctl', ['bootstrap', domain, LOGIN_PLIST], () => {});
  } else {
    execFile('launchctl', ['bootout', `${domain}/${LOGIN_LABEL}`], () => {
      fs.rmSync(LOGIN_PLIST, { force: true });
    });
  }
}

function createTray() {
  tray = new Tray(TRAY_ICONS.idle);
  const menu = Menu.buildFromTemplate([
    {
      label: 'Show/Hide Pet',
      click: () => {
        if (mainWindow.isVisible()) mainWindow.hide();
        else mainWindow.show();
      },
    },
    {
      label: 'Reset Position',
      click: () => {
        const { x, y } = dockedPosition(defaultX());
        mainWindow.setPosition(x, y);
        saveConfig({ x });
      },
    },
    { type: 'separator' },
    {
      label: 'Start at Login',
      type: 'checkbox',
      checked: fs.existsSync(LOGIN_PLIST),
      click: (item) => setStartAtLogin(item.checked),
    },
    { type: 'separator' },
    { label: 'Quit Claude Pet', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  updateTray();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

app.whenReady().then(() => {
  if (!gotLock) return;
  if (process.platform === 'darwin' && app.dock) app.dock.hide();
  startServer();
  registerIpc();
  createWindow();
  createTray();
  for (const event of ['display-metrics-changed', 'display-added', 'display-removed']) {
    screen.on(event, redock);
  }
  setInterval(sweepStaleSessions, 5 * 60 * 1000);
  setInterval(sampleUsage, USAGE_INTERVAL_MS);
  pollClaudeUsage();
});

app.on('window-all-closed', (e) => e.preventDefault());
