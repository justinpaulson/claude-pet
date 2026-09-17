const { ipcRenderer } = require('electron');

const badge = document.getElementById('badge');
const petWrap = document.getElementById('pet-wrap');
const hud = document.getElementById('hud');

// The card is parked below the bottom of the screen by exactly its own height,
// so the stack's slide distance has to follow it as rows appear and disappear.
// Measuring beats hard-coding: the Claude rows come and go at runtime.
new ResizeObserver(() => {
  document.documentElement.style.setProperty('--hud-h', `${hud.offsetHeight}px`);
  // Animating only from here on, so the first correction isn't a visible slide.
  if (!document.body.classList.contains('ready')) {
    requestAnimationFrame(() => document.body.classList.add('ready'));
  }
}).observe(hud);

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

let expanded = false;

function setExpanded(next) {
  if (next === expanded) return;
  expanded = next;
  document.body.classList.toggle('expanded', next);
}

function trackHover(e) {
  const el = document.elementFromPoint(e.clientX, e.clientY);
  // Clicks are only ever accepted over something solid, whatever the card is
  // currently doing.
  setInteractive(Boolean(el && el.closest('#hud, #pet')));
  // Deliberately asymmetric: it takes the pet himself to pull the card up, but
  // anywhere in the stack — including the transparent headroom he pops up
  // into — holds it there. A tight trigger keeps it out of the way; a loose
  // hold stops it snapping shut while the cursor crosses from pet to card.
  setExpanded(Boolean(el && el.closest(expanded ? '#stack' : '#pet')));
}

// While the window is accepting clicks it gets ordinary mouse-move events, and
// a fast enough exit can leave the last one still inside the window — so give
// up interactivity on the way out too, or the empty space keeps eating clicks.
document.addEventListener('mouseleave', () => {
  if (press) return;
  setInteractive(false);
  setExpanded(false);
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
function untilReset(resetsAtMs) {
  const secs = resetsAtMs - Date.now();
  if (!Number.isFinite(secs) || secs <= 0) return '';
  const mins = Math.floor(secs / 60000);
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  if (days > 0) return `resets in ${days}d ${hours}h`;
  if (hours > 0) return `resets in ${hours}h ${mins % 60}m`;
  return `resets in ${Math.max(mins, 1)}m`;
}

// These rows are the point of the card, so they're always drawn. When the
// numbers can't be trusted the row dims and the detail line carries the reason
// instead of the reset time — an empty slot where a bar used to be reads as the
// pet being broken, which is exactly the wrong signal when the fix is one
// command.
function renderLimitRow(row, info, stale, note) {
  row.row.classList.toggle('stale', Boolean(stale));
  if (!info) {
    row.pct.textContent = '—';
    row.fill.style.width = '0';
    row.detail.textContent = note || '—';
    return;
  }
  const percent = Math.min(Math.max(info.percent, 0), 100);
  row.pct.textContent = `${Math.round(percent)}% used`;
  row.fill.style.width = `${percent}%`;
  row.detail.textContent = stale ? note || 'out of date' : untilReset(info.resetsAtMs);
}

ipcRenderer.on('pet-usage', (_event, data) => {
  renderRow(rows.disk, data.disk);
  renderRow(rows.memory, data.memory);
  renderLimitRow(rows.session, data.session, data.stale, data.note);
  renderLimitRow(rows.weekly, data.weekly, data.stale, data.note);
});
