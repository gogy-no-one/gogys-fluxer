const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = new Set([
  'ready',
  'open',
  'add-server',
  'add-account',
  'remove-server',
  'remove-account',
  'set-feed',
  'check-updates',
  'install-update',
  'cancel',
]);

contextBridge.exposeInMainWorld('gogysConnections', {
  send: (channel, payload) => {
    if (!CHANNELS.has(channel)) return;
    ipcRenderer.send(`connections:${channel}`, payload ?? {});
  },
});
