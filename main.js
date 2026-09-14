const { app, BrowserWindow, Tray, Menu, nativeImage, screen, Notification, ipcMain } = require('electron');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const PORT = 47823;
// Sized for the card at its tallest (all four rows) plus the headroom the pet
// pops up into above it. The card is pinned to the bottom of the window, so when
// the Claude usage rows are hidden the slack just becomes more click-through
// empty space.
const WIN_W = 216;
// 320 is what the four-row card plus the pet's clip box measures; the extra 8
// matches the inset at the bottom and leaves room for font metrics to vary.
const WIN_H = 328;
const MARGIN = 20;
const USAGE_INTERVAL_MS = 3000;
const CONFIG_PATH = path.join(app.getPath('userData'), 'pet-config.json');
const LIMITS_PATH = path.join(os.homedir(), '.claude', 'pet-limits.json');
const CLAUDE_BUNDLE_ID = 'com.anthropic.claudefordesktop';

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

// Nothing refreshes the limits file until the next status line renders, so a
// window that has already rolled over would be showing a stale percentage of a
// limit that no longer applies. Better to show nothing than a wrong number.
function usageWindow(w) {
  if (!w || !Number.isFinite(w.used_percentage)) return null;
  if (Number.isFinite(w.resets_at) && w.resets_at * 1000 <= Date.now()) return null;
  return { percent: w.used_percentage, resetsAt: w.resets_at };
}

// Claude's subscription usage windows are only handed to Claude Code's status
// line — they're in no hook payload — so the status line writes them to this file
// and we just read whatever is there. Nothing here means don't show those rows at
// all: Bedrock and Vertex sessions have no subscription windows, and an
// unconfigured status line never writes the file in the first place.
function claudeLimits() {
  let limits;
  try {
    limits = JSON.parse(fs.readFileSync(LIMITS_PATH, 'utf8'))?.rate_limits;
  } catch {
    return { session: null, weekly: null };
  }
  return { session: usageWindow(limits?.five_hour), weekly: usageWindow(limits?.seven_day) };
}

function sampleUsage() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const disk = diskUsage();
  const { session, weekly } = claudeLimits();
  memoryUsage((memory) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('pet-usage', { disk, memory, session, weekly });
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

// Top-right, where the standalone usage HUD used to sit. The card is at the
// bottom of the window, so this leaves the pet's pop-up headroom on screen.
function defaultPosition() {
  const { x: wx, y: wy, width: ww } = screen.getPrimaryDisplay().workArea;
  return { x: wx + ww - WIN_W - MARGIN, y: wy + MARGIN };
}

// A position saved by an earlier (smaller) window can put the pet partly off
// screen, and so can unplugging a display, so pull it back into the work area.
function clampToWorkArea(x, y) {
  const area = screen.getDisplayNearestPoint({ x, y }).workArea;
  return {
    x: Math.min(Math.max(x, area.x), area.x + area.width - WIN_W),
    y: Math.min(Math.max(y, area.y), area.y + area.height - WIN_H),
  };
}

function createWindow() {
  const cfg = loadConfig();
  const saved = Number.isFinite(cfg.x) && Number.isFinite(cfg.y) ? clampToWorkArea(cfg.x, cfg.y) : defaultPosition();

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
      const [px, py] = mainWindow.getPosition();
      saveConfig({ x: px, y: py });
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
  const grabY = Number.isFinite(grab?.grabY) ? grab.grabY : WIN_H / 2;
  dragTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      stopDrag();
      return;
    }
    const p = screen.getCursorScreenPoint();
    mainWindow.setPosition(Math.round(p.x - grabX), Math.round(p.y - grabY));
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
        const { x, y } = defaultPosition();
        mainWindow.setPosition(x, y);
        saveConfig({ x, y });
      },
    },
    { type: 'separator' },
    {
      label: 'Start at Login',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
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
  setInterval(sweepStaleSessions, 5 * 60 * 1000);
  setInterval(sampleUsage, USAGE_INTERVAL_MS);
});

app.on('window-all-closed', (e) => e.preventDefault());
