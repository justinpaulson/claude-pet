const { ipcRenderer } = require('electron');

const badge = document.getElementById('badge');

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
