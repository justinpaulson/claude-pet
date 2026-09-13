const { app, BrowserWindow, Tray, Menu, nativeImage, screen, Notification } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs');

const PORT = 47823;
const WIN_SIZE = 140;
const CONFIG_PATH = path.join(app.getPath('userData'), 'pet-config.json');

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
  const icons = { idle: '\u{1F43E}', working: '⚙️', alert: '\u{1F6A8}' };
  tray.setTitle(icons[state] || icons.idle);
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

function createWindow() {
  const cfg = loadConfig();
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const x = Number.isFinite(cfg.x) ? cfg.x : sw - WIN_SIZE - 24;
  const y = Number.isFinite(cfg.y) ? cfg.y : sh - WIN_SIZE - 24;

  mainWindow = new BrowserWindow({
    width: WIN_SIZE,
    height: WIN_SIZE,
    x,
    y,
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
  mainWindow.loadFile('index.html');

  let moveTimeout;
  mainWindow.on('moved', () => {
    clearTimeout(moveTimeout);
    moveTimeout = setTimeout(() => {
      const [px, py] = mainWindow.getPosition();
      saveConfig({ x: px, y: py });
    }, 300);
  });

  mainWindow.webContents.on('did-finish-load', broadcastState);
}

// 1x1 transparent PNG — the tray icon is really just the emoji title on macOS;
// this is only here because Tray requires a non-empty image.
const BLANK_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function createTray() {
  const icon = nativeImage.createFromDataURL(BLANK_PNG);
  tray = new Tray(icon);
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
        const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
        mainWindow.setPosition(sw - WIN_SIZE - 24, sh - WIN_SIZE - 24);
        saveConfig({ x: sw - WIN_SIZE - 24, y: sh - WIN_SIZE - 24 });
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
  createWindow();
  createTray();
  setInterval(sweepStaleSessions, 5 * 60 * 1000);
});

app.on('window-all-closed', (e) => e.preventDefault());
