const { app, BrowserWindow, desktopCapturer, ipcMain, net, session, shell, Menu } = require('electron');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

app.setPath('userData', path.join(app.getPath('appData'), 'gogys-fluxer'));

const ALLOWED_PERMISSIONS = new Set([
  'audioCapture',
  'captured-surface-control',
  'clipboard-read',
  'clipboard-sanitized-write',
  'display-capture',
  'fullscreen',
  'idle-detection',
  'media',
  'notifications',
  'pointerLock',
  'screen-capture',
  'speaker-selection',
  'window-management',
]);

const WEB_UPDATE_CHECK_MS = Number(process.env.FLUXER_UPDATE_CHECK_MS || 5 * 60 * 1000);
const APP_UPDATE_CHECK_MS = Number(process.env.FLUXER_APP_UPDATE_CHECK_MS || 6 * 60 * 60 * 1000);
const APP_UPDATE_FIRST_MS = Number(process.env.FLUXER_APP_UPDATE_FIRST_CHECK_MS || 5000);
const AUTO_RELOAD = process.env.FLUXER_AUTO_RELOAD !== '0';
const AUTO_UPDATE = process.env.FLUXER_AUTO_UPDATE !== '0';
const ACCOUNT_NAME_MAX = 40;

let mainWindow = null;
let connectionsWindow = null;
let startingApp = false;
let shellSignature = null;
let reloadPending = false;
let appUpdater = null;
let appUpdateTimer = null;
let appUpdate = { state: 'idle', message: 'Update address not set.', version: '' };
let store = null;

function readJson(file, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temp, file);
}

function connectionsFile() {
  return path.join(app.getPath('userData'), 'connections.json');
}

function newId(prefix) {
  return `${prefix}_${randomBytes(4).toString('hex')}`;
}

function normalizeServer(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  let candidate = trimmed;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(candidate)) candidate = `https://${candidate}`;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (!parsed.hostname.includes('.') && parsed.hostname !== 'localhost') return null;
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

function hostOf(url) {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

function sessionFor(account) {
  return account.partition ? session.fromPartition(account.partition) : session.defaultSession;
}

function emptyStore() {
  return { version: 1, servers: [], activeServerId: '', activeAccountId: '', updateFeed: '' };
}

function cleanStore(raw) {
  const result = emptyStore();
  if (!raw || !Array.isArray(raw.servers)) return result;

  for (const entry of raw.servers) {
    if (!entry || typeof entry.url !== 'string') continue;
    const url = normalizeServer(entry.url);
    if (!url) continue;
    const accounts = [];
    for (const account of Array.isArray(entry.accounts) ? entry.accounts : []) {
      if (!account || typeof account.id !== 'string') continue;
      const name = typeof account.name === 'string' ? account.name.trim().slice(0, ACCOUNT_NAME_MAX) : '';
      accounts.push({
        id: account.id,
        name: name.length > 0 ? name : 'Account',
        partition: typeof account.partition === 'string' && account.partition.length > 0 ? account.partition : null,
      });
    }
    if (accounts.length === 0) continue;
    result.servers.push({
      id: typeof entry.id === 'string' && entry.id.length > 0 ? entry.id : newId('s'),
      url,
      accounts,
      activeAccountId: typeof entry.activeAccountId === 'string' ? entry.activeAccountId : '',
    });
  }

  if (typeof raw.activeServerId === 'string') result.activeServerId = raw.activeServerId;
  if (typeof raw.activeAccountId === 'string') result.activeAccountId = raw.activeAccountId;
  if (typeof raw.updateFeed === 'string') result.updateFeed = normalizeServer(raw.updateFeed) ?? '';
  return result;
}

function adopt(result) {
  store = result;
  for (const server of store.servers) {
    if (!server.accounts.some((account) => account.id === server.activeAccountId)) {
      server.activeAccountId = server.accounts[0].id;
    }
  }
  const server = store.servers.find((entry) => entry.id === store.activeServerId);
  if (!server || !server.accounts.some((account) => account.id === store.activeAccountId)) {
    store.activeServerId = server ? server.id : '';
    store.activeAccountId = server ? server.activeAccountId : '';
  }
  return store;
}

function loadStore() {
  const file = connectionsFile();
  if (fs.existsSync(file)) return adopt(cleanStore(readJson(file, null)));

  const legacy = readJson(path.join(app.getPath('userData'), 'server.json'), null);
  const url = legacy && typeof legacy.serverUrl === 'string' ? normalizeServer(legacy.serverUrl) : null;
  if (!url) return adopt(emptyStore());

  const account = { id: newId('a'), name: 'Account 1', partition: null };
  const server = { id: newId('s'), url, accounts: [account], activeAccountId: account.id };
  adopt({ ...emptyStore(), servers: [server], activeServerId: server.id, activeAccountId: account.id });
  saveStore();
  return store;
}

function saveStore() {
  writeJson(connectionsFile(), store);
}

function findServer(serverId) {
  return store.servers.find((server) => server.id === serverId) ?? null;
}

function activePair() {
  const server = findServer(store.activeServerId);
  if (!server) return null;
  const account = server.accounts.find((entry) => entry.id === store.activeAccountId);
  if (!account) return null;
  return { server, account };
}

function isTrusted(url) {
  const server = findServer(store.activeServerId);
  if (!server || typeof url !== 'string' || url.length === 0) return false;
  try {
    return new URL(url).origin === new URL(server.url).origin;
  } catch {
    return false;
  }
}

function stateForUi() {
  const active = activePair();
  return {
    servers: store.servers.map((server) => ({
      id: server.id,
      url: server.url,
      isActive: active !== null && active.server.id === server.id && active.account.id === store.activeAccountId,
      accounts: server.accounts.map((account) => ({
        id: account.id,
        name: account.name,
        isActive: active !== null && active.server.id === server.id && account.id === store.activeAccountId,
      })),
    })),
    update: { feed: store.updateFeed, ...appUpdate },
  };
}

function sendToConnections(error, state) {
  const win = connectionsWindow;
  if (!win || win.isDestroyed()) return;
  const payload = { type: 'result', error: error ?? '', state: state ?? stateForUi() };
  win.webContents
    .executeJavaScript(`window.__connEvent && window.__connEvent(${JSON.stringify(payload)})`)
    .catch(() => {});
}

function isFrom(win, event) {
  return Boolean(win) && !win.isDestroyed() && event.sender === win.webContents;
}

function permissionAllowed(contents, permission) {
  try {
    return Boolean(contents) && isTrusted(contents.getURL()) && ALLOWED_PERMISSIONS.has(permission);
  } catch {
    return false;
  }
}

function frameAllowed(frame) {
  try {
    return Boolean(frame) && isTrusted(frame.url);
  } catch {
    return false;
  }
}

async function configureSession(sess, server) {
  await sess.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] });
  await sess.clearCache();

  sess.setPermissionRequestHandler((contents, permission, callback) => {
    callback(permissionAllowed(contents, permission));
  });
  sess.setPermissionCheckHandler((contents, permission) => permissionAllowed(contents, permission));
  sess.setDisplayMediaRequestHandler((request, callback) => {
    if (!frameAllowed(request.frame)) {
      callback({});
      return;
    }
    desktopCapturer
      .getSources({ types: ['screen', 'window'] })
      .then((sources) => {
        const source = sources.find((entry) => entry.id.startsWith('screen:')) ?? sources[0];
        callback(source ? { video: source, audio: 'loopback' } : {});
      })
      .catch(() => callback({}));
  });

  const origin = new URL(server.url).origin;
  sess.webRequest.onHeadersReceived((details, callback) => {
    if (details.url.startsWith(origin)) {
      details.responseHeaders = { ...details.responseHeaders, 'Cache-Control': 'no-cache' };
    }
    callback({ responseHeaders: details.responseHeaders });
  });
}

async function shellFingerprint() {
  const active = activePair();
  if (!active) return null;
  try {
    const response = await net.fetch(active.server.url, {
      method: 'GET',
      cache: 'no-store',
      headers: { 'cache-control': 'no-cache', pragma: 'no-cache' },
    });
    if (!response.ok) return null;
    const html = await response.text();
    const assets = [...html.matchAll(/\/assets\/[a-z0-9]+\.(?:js|css)/g)].map((match) => match[0]);
    return assets.length > 0 ? assets.sort().join('|') : null;
  } catch {
    return null;
  }
}

function watchWebBuild(win) {
  let timer = null;

  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  const check = async () => {
    if (win.isDestroyed()) {
      stop();
      return;
    }
    const fingerprint = await shellFingerprint();
    if (!fingerprint || win.isDestroyed()) return;
    if (shellSignature === null) {
      shellSignature = fingerprint;
      return;
    }
    if (fingerprint === shellSignature) return;
    shellSignature = fingerprint;
    if (AUTO_RELOAD && win.isFocused()) {
      win.reload();
    } else {
      reloadPending = true;
    }
  };

  win.on('closed', stop);

  win.on('focus', () => {
    if (reloadPending && !win.isDestroyed()) {
      reloadPending = false;
      win.reload();
    }
  });

  win.webContents.on('did-finish-load', () => {
    shellFingerprint().then((fingerprint) => {
      if (fingerprint && !win.isDestroyed()) shellSignature = fingerprint;
    });
  });

  timer = setInterval(check, WEB_UPDATE_CHECK_MS);
}

function browserUserAgent() {
  const real = process.versions.chrome;
  if (!real) return null;
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${real} Safari/537.36`;
}

function createWindow() {
  Menu.setApplicationMenu(null);

  const active = activePair();
  if (!active) return;
  const { server, account } = active;

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 480,
    minHeight: 480,
    title: `${account.name} - ${hostOf(server.url)}`,
    autoHideMenuBar: true,
    backgroundColor: '#1a0173',
    webPreferences: {
      session: sessionFor(account),
      preload: path.join(__dirname, 'web-ui.js'),
      additionalArguments: [`--gogys-server=${server.url}`, `--gogys-account=${account.name}`],
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });

  win.setMenu(null);
  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  const userAgent = browserUserAgent();
  if (userAgent) win.webContents.userAgent = userAgent;

  win.webContents.on('did-fail-load', (event, errorCode, description, url, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;
    openConnections(`Could not reach ${url} (${description}).`);
    win.destroy();
  });

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !input.control || !input.shift) return;
    if (input.key !== 'S' && input.key !== 's') return;
    event.preventDefault();
    openConnections();
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isTrusted(url)) return { action: 'allow' };
    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (isTrusted(url)) return;
    event.preventDefault();
    shell.openExternal(url).catch(() => {});
  });

  watchWebBuild(win);
  win.loadURL(server.url);
}

async function startApp() {
  const active = activePair();
  if (!active) {
    startingApp = false;
    openConnections();
    return;
  }
  await configureSession(sessionFor(active.account), active.server);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
  createWindow();
  startingApp = false;
}

function openAccount(serverId, accountId) {
  const server = findServer(serverId);
  if (!server) return false;
  const account = server.accounts.find((entry) => entry.id === accountId);
  if (!account) return false;

  if (store.activeServerId === serverId && store.activeAccountId === accountId && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus();
    return true;
  }

  store.activeServerId = serverId;
  store.activeAccountId = accountId;
  server.activeAccountId = accountId;
  saveStore();
  shellSignature = null;
  reloadPending = false;
  startingApp = true;
  closeConnections();
  startApp();
  return true;
}

function addServer(rawUrl) {
  const url = normalizeServer(rawUrl);
  if (!url) return { error: 'That does not look like a valid address.' };
  const existing = store.servers.find((server) => server.url === url);
  if (existing) return { error: `${hostOf(url)} is already in the list.`, serverId: existing.id, accountId: existing.activeAccountId };

  const account = { id: newId('a'), name: 'Account 1', partition: `persist:gogys-${newId('p')}` };
  const server = { id: newId('s'), url, accounts: [account], activeAccountId: account.id };
  store.servers.push(server);
  saveStore();
  return { serverId: server.id, accountId: account.id };
}

function addAccount(serverId, rawName) {
  const server = findServer(serverId);
  if (!server) return { error: 'That server is no longer in the list.' };
  const trimmed = typeof rawName === 'string' ? rawName.trim().slice(0, ACCOUNT_NAME_MAX) : '';
  const name = trimmed.length > 0 ? trimmed : `Account ${server.accounts.length + 1}`;
  if (server.accounts.some((account) => account.name.toLowerCase() === name.toLowerCase())) {
    return { error: `There is already an account called ${name}.` };
  }
  const account = { id: newId('a'), name, partition: `persist:gogys-${newId('p')}` };
  server.accounts.push(account);
  saveStore();
  return { accountId: account.id };
}

async function wipeAccountData(account) {
  const sess = sessionFor(account);
  try {
    await sess.clearStorageData();
    await sess.clearCache();
  } catch {
    return;
  }
}

async function removeServer(serverId) {
  const server = findServer(serverId);
  if (!server) return;
  for (const account of server.accounts) await wipeAccountData(account);
  store.servers = store.servers.filter((entry) => entry.id !== serverId);
  const wasActive = store.activeServerId === serverId;
  if (wasActive) {
    store.activeServerId = store.servers[0]?.id ?? '';
    store.activeAccountId = store.servers[0]?.activeAccountId ?? '';
  }
  saveStore();
  if (wasActive && mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
}

async function removeAccount(serverId, accountId) {
  const server = findServer(serverId);
  if (!server) return;
  const account = server.accounts.find((entry) => entry.id === accountId);
  if (!account) return;

  await wipeAccountData(account);
  server.accounts = server.accounts.filter((entry) => entry.id !== accountId);
  if (server.accounts.length === 0) {
    await removeServer(serverId);
    return;
  }
  if (server.activeAccountId === accountId) server.activeAccountId = server.accounts[0].id;

  if (store.activeServerId === serverId && store.activeAccountId === accountId) {
    store.activeAccountId = server.activeAccountId;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
  }
  saveStore();
}

function setUpdateFeed(rawUrl) {
  const trimmed = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (trimmed.length === 0) {
    store.updateFeed = '';
    saveStore();
    appUpdate = { state: 'idle', message: 'Update address not set.', version: '' };
    return { error: 'Enter the address of the folder that holds the update files.' };
  }
  const feed = normalizeServer(trimmed);
  if (!feed) return { error: 'That does not look like a valid address.' };
  store.updateFeed = feed;
  saveStore();
  appUpdate = { state: 'idle', message: 'Update address saved.', version: '' };
  if (AUTO_UPDATE && appUpdater) {
    setTimeout(() => checkAppUpdate(false), 1000);
    if (!appUpdateTimer) appUpdateTimer = setInterval(() => checkAppUpdate(false), APP_UPDATE_CHECK_MS);
  }
  return {};
}

function feedFolder(feed) {
  return feed.endsWith('/') ? feed : `${feed}/`;
}

async function checkAppUpdate(manual) {
  if (!appUpdater) return { error: 'Updates only work in a packaged build.' };
  if (!store.updateFeed) {
    if (manual) return { error: 'Set an update address first.' };
    return {};
  }

  appUpdater.setFeedURL({ provider: 'generic', url: feedFolder(store.updateFeed) });
  appUpdate = { state: 'checking', message: 'Checking for updates...', version: '' };
  sendToConnections();

  try {
    const result = await appUpdater.checkForUpdates();
    const latest = result && result.updateInfo ? result.updateInfo.version : '';
    appUpdate =
      latest && latest !== app.getVersion()
        ? { state: 'downloading', message: `Version ${latest} is downloading...`, version: latest }
        : { state: 'current', message: `Version ${app.getVersion()} is up to date.`, version: '' };
  } catch (error) {
    appUpdate = { state: 'error', message: error.message, version: '' };
  }

  sendToConnections();
  return { state: appUpdate };
}

function setupAppUpdater() {
  if (!app.isPackaged) return;
  try {
    ({ autoUpdater: appUpdater } = require('electron-updater'));
  } catch {
    return;
  }

  appUpdater.autoDownload = true;
  appUpdater.autoInstallOnAppQuit = true;
  appUpdater.logger = null;

  appUpdater.on('update-downloaded', (info) => {
    appUpdate = { state: 'ready', message: `Version ${info.version} is ready. Restart to install it.`, version: info.version };
    sendToConnections();
  });

  appUpdater.on('error', (error) => {
    console.log(`[gogys] update check failed: ${error.message}`);
  });

  if (AUTO_UPDATE && store.updateFeed) {
    setTimeout(() => checkAppUpdate(false), APP_UPDATE_FIRST_MS);
    appUpdateTimer = setInterval(() => checkAppUpdate(false), APP_UPDATE_CHECK_MS);
  }
}

function connectionsHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Connections</title>
<style>
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 18px;
  overflow-y: auto;
  font: 13px/1.45 system-ui, -apple-system, 'Segoe UI', sans-serif;
  background: #140a3d;
  color: #ece9ff;
}
h1 { margin: 0 0 4px; font-size: 16px; }
.sub { margin: 0 0 16px; color: #a79fd6; font-size: 12px; }
.card {
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.05);
  border-radius: 8px;
  margin-bottom: 10px;
  overflow: hidden;
}
.server-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  background: rgba(255, 255, 255, 0.04);
}
.host { font-weight: 600; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: #4b3a8f; flex: 0 0 auto; }
.dot.on { background: #49d17c; }
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-top: 1px solid rgba(255, 255, 255, 0.07);
}
.name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tag { font-size: 10px; text-transform: uppercase; letter-spacing: 0.6px; color: #8fe3ad; }
button {
  font: inherit;
  color: #ece9ff;
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 6px;
  padding: 5px 10px;
  cursor: pointer;
}
button:hover { background: rgba(255, 255, 255, 0.2); }
button.link { background: none; border: 0; color: #b9aef5; padding: 4px 2px; }
button.danger:hover { background: rgba(220, 60, 90, 0.32); }
button.primary { background: #4a2fd0; border-color: #6f56e8; }
button.primary:hover { background: #5a3fe0; }
input {
  font: inherit;
  width: 100%;
  color: #ece9ff;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 6px;
  padding: 8px 10px;
}
input::placeholder { color: #837bb0; }
form { margin: 0 0 10px; display: flex; flex-direction: column; gap: 8px; }
.note { font-size: 11px; color: #a79fd6; margin: 0 0 10px; }
.error { color: #ff9db0; min-height: 17px; margin: 0 0 8px; font-size: 12px; }
.status { font-size: 12px; color: #a79fd6; flex: 1; }
hr { border: 0; border-top: 1px solid rgba(255, 255, 255, 0.1); margin: 16px 0 12px; }
.actions { display: flex; justify-content: flex-end; gap: 8px; }
.plain { border: 0; padding: 0; }
</style>
</head>
<body>
<h1>Connections</h1>
<p class="sub">Every account keeps its own login, cookies and cache.</p>
<div class="error" id="error"></div>
<form id="server-form" hidden>
  <input id="server-url" type="text" spellcheck="false" autocomplete="off" placeholder="server address, for example chat.example.com">
  <div class="actions">
    <button type="button" id="server-cancel">Cancel</button>
    <button type="submit" class="primary">Add server</button>
  </div>
</form>
<form id="account-form" hidden>
  <input id="account-name" type="text" spellcheck="false" autocomplete="off" maxlength="40" placeholder="name for this account">
  <div class="actions">
    <button type="button" id="account-cancel">Cancel</button>
    <button type="submit" class="primary">Add account</button>
  </div>
</form>
<div id="list"></div>
<button id="add-server" type="button">+ Add server</button>
<hr>
<div class="row plain">
  <input id="feed" type="text" spellcheck="false" autocomplete="off" placeholder="update address, for example https://example.com/updates">
</div>
<div class="row plain" style="margin-top: 8px;">
  <div class="status" id="status">Update address not set.</div>
  <button id="check" type="button">Check</button>
  <button id="install" type="button" class="primary" hidden>Restart</button>
</div>
<div class="actions" style="margin-top: 14px;">
  <button id="close" type="button">Close</button>
</div>
<script>
(function () {
  var bridge = window.gogysConnections;
  var list = document.getElementById('list');
  var errorBox = document.getElementById('error');
  var serverForm = document.getElementById('server-form');
  var serverInput = document.getElementById('server-url');
  var accountForm = document.getElementById('account-form');
  var accountInput = document.getElementById('account-name');
  var feedInput = document.getElementById('feed');
  var statusBox = document.getElementById('status');
  var installButton = document.getElementById('install');
  var accountFor = '';
  var submittedForm = '';
  var state = { servers: [], update: { feed: '', state: 'idle', message: '', version: '' } };

  function say(message) {
    errorBox.textContent = message || '';
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function button(label, className, handler) {
    var node = el('button', className, label);
    node.type = 'button';
    node.addEventListener('click', handler);
    return node;
  }

  function host(url) {
    try { return new URL(url).host || url; } catch (err) { return url; }
  }

  function render() {
    list.textContent = '';

    if (state.servers.length === 0) {
      list.appendChild(el('p', 'note', 'No servers yet. Add one to get started.'));
    }

    state.servers.forEach(function (server) {
      var card = el('div', 'card');

      var head = el('div', 'server-head');
      head.appendChild(el('span', 'dot' + (server.isActive ? ' on' : '')));
      head.appendChild(el('span', 'host', host(server.url)));
      head.appendChild(button('Remove', 'danger', function () {
        say('');
        bridge.send('remove-server', { serverId: server.id });
      }));
      card.appendChild(head);

      server.accounts.forEach(function (account) {
        var row = el('div', 'row');
        row.appendChild(el('span', 'name', account.name));
        if (account.isActive) row.appendChild(el('span', 'tag', 'in use'));
        row.appendChild(button(account.isActive ? 'Open' : 'Switch to', account.isActive ? '' : 'primary', function () {
          say('');
          bridge.send('open', { serverId: server.id, accountId: account.id });
        }));
        if (!account.isActive && server.accounts.length > 1) {
          row.appendChild(button('Remove', 'link', function () {
            say('');
            bridge.send('remove-account', { serverId: server.id, accountId: account.id });
          }));
        }
        card.appendChild(row);
      });

      var add = el('div', 'row');
      add.appendChild(button('+ Add account', 'link', function () {
        say('');
        accountFor = server.id;
        accountInput.value = '';
        accountForm.hidden = false;
        serverForm.hidden = true;
        accountInput.focus();
      }));
      card.appendChild(add);

      list.appendChild(card);
    });

    var update = state.update || {};
    statusBox.textContent = update.message || 'Update address not set.';
    installButton.hidden = update.state !== 'ready';
    if (document.activeElement !== feedInput) feedInput.value = update.feed || '';
  }

  window.__connEvent = function (payload) {
    if (!payload || payload.type !== 'result') return;
    if (payload.state) {
      state = payload.state;
      render();
    }
    say(payload.error);
    if (!payload.error && submittedForm) {
      serverForm.hidden = true;
      accountForm.hidden = true;
      submittedForm = '';
    }
  };

  document.getElementById('add-server').addEventListener('click', function () {
    say('');
    submittedForm = '';
    serverInput.value = '';
    serverForm.hidden = false;
    accountForm.hidden = true;
    serverInput.focus();
  });

  document.getElementById('server-cancel').addEventListener('click', function () {
    serverForm.hidden = true;
  });

  document.getElementById('account-cancel').addEventListener('click', function () {
    accountForm.hidden = true;
  });

  serverForm.addEventListener('submit', function (event) {
    event.preventDefault();
    say('');
    submittedForm = 'server';
    bridge.send('add-server', { url: serverInput.value });
  });

  accountForm.addEventListener('submit', function (event) {
    event.preventDefault();
    say('');
    submittedForm = 'account';
    bridge.send('add-account', { serverId: accountFor, name: accountInput.value });
  });

  document.getElementById('close').addEventListener('click', function () {
    bridge.send('cancel');
  });

  feedInput.addEventListener('change', function () {
    bridge.send('set-feed', { url: feedInput.value });
  });

  document.getElementById('check').addEventListener('click', function () {
    say('');
    bridge.send('check-updates');
  });

  installButton.addEventListener('click', function () {
    bridge.send('install-update');
  });

  bridge.send('ready');
})();
</script>
</body>
</html>`;
}

function openConnections(message) {
  if (connectionsWindow && !connectionsWindow.isDestroyed()) {
    connectionsWindow.focus();
    if (message) sendToConnections(message);
    return;
  }

  const win = new BrowserWindow({
    width: 540,
    height: 660,
    minWidth: 420,
    minHeight: 420,
    title: 'Connections',
    autoHideMenuBar: true,
    backgroundColor: '#140a3d',
    webPreferences: {
      preload: path.join(__dirname, 'connections-preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  connectionsWindow = win;
  win.setMenu(null);
  win.on('closed', () => {
    if (connectionsWindow === win) connectionsWindow = null;
  });

  win.webContents.on('did-finish-load', () => {
    sendToConnections(message);
  });

  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(connectionsHtml())}`);
}

function closeConnections() {
  if (connectionsWindow && !connectionsWindow.isDestroyed()) connectionsWindow.destroy();
}

const CONNECTION_CHANNELS = ['ready', 'open', 'add-server', 'add-account', 'remove-server', 'remove-account', 'set-feed', 'check-updates', 'install-update', 'cancel'];

function onConnectionMessage(channel, event, payload) {
  if (!isFrom(connectionsWindow, event)) return;
  const data = payload && typeof payload === 'object' ? payload : {};
  const pushState = (result) => sendToConnections(result && result.error ? result.error : '');

  if (channel === 'ready') {
    sendToConnections();
    return;
  }
  if (channel === 'open') {
    openAccount(String(data.serverId ?? ''), String(data.accountId ?? ''));
    return;
  }
  if (channel === 'add-server') {
    pushState(addServer(data.url));
    return;
  }
  if (channel === 'add-account') {
    pushState(addAccount(String(data.serverId ?? ''), data.name));
    return;
  }
  if (channel === 'remove-server') {
    removeServer(String(data.serverId ?? '')).then(() => pushState({}));
    return;
  }
  if (channel === 'remove-account') {
    removeAccount(String(data.serverId ?? ''), String(data.accountId ?? '')).then(() => pushState({}));
    return;
  }
  if (channel === 'set-feed') {
    pushState(setUpdateFeed(data.url));
    return;
  }
  if (channel === 'check-updates') {
    checkAppUpdate(true).then((result) => sendToConnections(result && result.error ? result.error : ''));
    return;
  }
  if (channel === 'install-update') {
    if (appUpdater) appUpdater.quitAndInstall(false, true);
    return;
  }
  if (channel === 'cancel') closeConnections();
}

for (const channel of CONNECTION_CHANNELS) {
  ipcMain.on(`connections:${channel}`, (event, payload) => onConnectionMessage(channel, event, payload));
}

process.on('unhandledRejection', (reason) => {
  console.log(`[gogys] background task failed: ${reason instanceof Error ? reason.message : String(reason)}`);
});

ipcMain.on('connections:open-connections', (event) => {
  if (!isFrom(mainWindow, event)) return;
  openConnections();
});

app.whenReady().then(async () => {
  loadStore();
  setupAppUpdater();

  const override = process.env.FLUXER_URL ? normalizeServer(process.env.FLUXER_URL) : null;
  if (override) {
    const existing = store.servers.find((server) => server.url === override);
    if (existing) {
      startingApp = true;
      openAccount(existing.id, existing.activeAccountId);
      return;
    }
    const added = addServer(override);
    startingApp = true;
    openAccount(added.serverId, added.accountId);
    return;
  }

  if (activePair()) {
    startingApp = true;
    await startApp();
    return;
  }
  openConnections();
});

app.on('window-all-closed', () => {
  if (connectionsWindow || startingApp) return;
  if (process.platform !== 'darwin') app.quit();
});
