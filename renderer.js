const { ipcRenderer } = require('electron');

const badge = document.getElementById('badge');
const petWrap = document.getElementById('pet-wrap');

// How far the cursor has to travel before a press counts as dragging the pet
// rather than clicking it.
const DRAG_THRESHOLD = 4;

// A press anywhere on the card or the pet can drag the window, but only a press
// that starts on the pet itself opens Claude.
let press = null;

petWrap.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  press = {
    x: e.screenX,
    y: e.screenY,
    // Where inside the window the pet was grabbed; the main process keeps this
    // point under the cursor for the rest of the drag.
    grabX: e.clientX,
    grabY: e.clientY,
    onPet: Boolean(e.target.closest('#pet')),
    dragging: false,
  };
});

window.addEventListener('mousemove', (e) => {
  if (!press) {
    trackHover(e);
    return;
  }
  if (press.dragging) return;
  if (Math.abs(e.screenX - press.x) < DRAG_THRESHOLD && Math.abs(e.screenY - press.y) < DRAG_THRESHOLD) return;
  press.dragging = true;
  ipcRenderer.send('pet-drag-start', { grabX: press.grabX, grabY: press.grabY });
});

window.addEventListener('mouseup', () => {
  if (!press) return;
  const { dragging, onPet } = press;
  press = null;
  if (dragging) ipcRenderer.send('pet-drag-end');
  else if (onPet) ipcRenderer.send('pet-click');
});

// The window is mostly empty space for the pet to pop up into, and it ignores
// the mouse there so clicks reach whatever is underneath. Mouse-move events are
// still forwarded to us while it does, so they're what we use to decide when the
// cursor has reached something solid and the window should accept clicks again.
// Never turn it off mid-press: a window that's ignoring the mouse won't deliver
// the mouseup that ends a drag.
let interactive = false;

function setInteractive(next) {
  if (next === interactive) return;
  interactive = next;
  ipcRenderer.send('pet-interactive', next);
}

function trackHover(e) {
  const el = document.elementFromPoint(e.clientX, e.clientY);
  setInteractive(Boolean(el && el.closest('#hud, #pet')));
}

// While the window is accepting clicks it gets ordinary mouse-move events, and
// a fast enough exit can leave the last one still inside the window — so give
// up interactivity on the way out too, or the empty space keeps eating clicks.
document.addEventListener('mouseleave', () => {
  if (!press) setInteractive(false);
});

ipcRenderer.on('pet-state', (_event, data) => {
  document.body.classList.remove('idle', 'working', 'alert');
  document.body.classList.add(data.state);

  if (data.state === 'alert' && data.alertCount > 0) {
    badge.textContent = data.alertCount > 1 ? String(data.alertCount) : '!';
    badge.classList.add('show');
  } else {
    badge.classList.remove('show');
  }
});

const rows = {
  disk: {
    pct: document.getElementById('disk-pct'),
    fill: document.getElementById('disk-fill'),
    detail: document.getElementById('disk-detail'),
  },
  memory: {
    pct: document.getElementById('mem-pct'),
    fill: document.getElementById('mem-fill'),
    detail: document.getElementById('mem-detail'),
  },
  session: {
    pct: document.getElementById('session-pct'),
    fill: document.getElementById('session-fill'),
    detail: document.getElementById('session-detail'),
    row: document.getElementById('row-session'),
  },
  weekly: {
    pct: document.getElementById('week-pct'),
    fill: document.getElementById('week-fill'),
    detail: document.getElementById('week-detail'),
    row: document.getElementById('row-weekly'),
  },
};

function renderRow(row, info) {
  if (!info) {
    row.pct.textContent = '—';
    row.fill.style.width = '0';
    row.detail.textContent = '— / — GB';
    return;
  }
  const percent = Math.min(Math.max(info.percent, 0), 100);
  row.pct.textContent = `${Math.round(percent)}% used`;
  row.fill.style.width = `${percent}%`;
  row.detail.textContent = `${Math.round(info.usedGB)} / ${Math.round(info.totalGB)} GB`;
}

// "3d 4h" / "4h 12m" / "12m" — two units is enough to be useful in 9px type.
function untilReset(resetsAt) {
  const secs = resetsAt * 1000 - Date.now();
  if (!Number.isFinite(secs) || secs <= 0) return '';
  const mins = Math.floor(secs / 60000);
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  if (days > 0) return `resets in ${days}d ${hours}h`;
  if (hours > 0) return `resets in ${hours}h ${mins % 60}m`;
  return `resets in ${Math.max(mins, 1)}m`;
}

// A Claude usage window, which unlike the machine rows disappears entirely when
// there's nothing to report — a blank bar would look like 0% used.
function renderLimitRow(row, info) {
  row.row.classList.toggle('hidden', !info);
  if (!info) return;
  const percent = Math.min(Math.max(info.percent, 0), 100);
  row.pct.textContent = `${Math.round(percent)}% used`;
  row.fill.style.width = `${percent}%`;
  row.detail.textContent = untilReset(info.resetsAt);
}

ipcRenderer.on('pet-usage', (_event, data) => {
  renderRow(rows.disk, data.disk);
  renderRow(rows.memory, data.memory);
  renderLimitRow(rows.session, data.session);
  renderLimitRow(rows.weekly, data.weekly);
});
