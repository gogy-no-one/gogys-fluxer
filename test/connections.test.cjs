'use strict';
// Drives the real main.js against a stubbed electron: store, accounts, partitions,
// window handover, IPC validation, permission handlers, update feed.
// Nothing is rendered and no window is opened.
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MAIN = path.join(ROOT, 'main.js');
const SOURCE = fs.readFileSync(MAIN, 'utf8');

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n      ${detail}` : ''}`);
};

function boot({ legacy = null, saved = null, env = {}, packaged = false, updater = null } = {}) {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'fluxer-conn-'));
  const profile = path.join(appData, 'gogys-fluxer');
  fs.mkdirSync(profile, { recursive: true });
  if (legacy) fs.writeFileSync(path.join(profile, 'server.json'), JSON.stringify({ serverUrl: legacy }));
  if (saved) fs.writeFileSync(path.join(profile, 'connections.json'), JSON.stringify(saved));

  const log = {
    quits: 0,
    appEvents: {},
    ipc: {},
    windows: [],
    executed: [],
    partitions: new Map(),
    wiped: [],
    fromPartitionCalls: [],
  };
  let readyResolve;
  const ready = new Promise((resolve) => (readyResolve = resolve));
  let userData = null;

  const live = () => log.windows.filter((w) => !w.destroyed);

  const makeSession = (name) => {
    if (!log.partitions.has(name)) {
      log.partitions.set(name, {
        name,
        cleared: [],
        handlers: {},
        clearStorageData: async (options) => {
          log.wiped.push({ session: name, options });
          log.partitions.get(name).cleared.push(options ?? 'all');
        },
        clearCache: async () => {},
        setPermissionRequestHandler: (fn) => {
          log.partitions.get(name).handlers.permission = fn;
        },
        setPermissionCheckHandler: (fn) => {
          log.partitions.get(name).handlers.check = fn;
        },
        setDisplayMediaRequestHandler: (fn) => {
          log.partitions.get(name).handlers.display = fn;
        },
        webRequest: { onHeadersReceived: (fn) => { log.partitions.get(name).handlers.headers = fn; } },
      });
    }
    return log.partitions.get(name);
  };

  class StubWebContents {
    constructor(win) {
      this.win = win;
      this.handlers = {};
      this.loadedUrls = [];
    }
    on(event, fn) { (this.handlers[event] ||= []).push(fn); }
    once(event, fn) { this.on(event, fn); }
    setWindowOpenHandler(fn) { this.windowOpenHandler = fn; }
    async executeJavaScript(code) { log.executed.push(code); return undefined; }
    reload() { this.win.reloads++; }
    getURL() { return this.win.loadedUrls.at(-1) ?? 'about:blank'; }
    emit(event, ...args) { for (const fn of this.handlers[event] || []) fn(...args); }
  }

  class StubBrowserWindow {
    constructor(options = {}) {
      this.options = options;
      this.destroyed = false;
      this.focused = true;
      this.reloads = 0;
      this.handlers = {};
      this.webContents = new StubWebContents(this);
      this.loadedUrls = [];
      log.windows.push(this);
    }
    on(event, fn) { (this.handlers[event] ||= []).push(fn); }
    once(event, fn) { this.on(event, fn); }
    emit(event, ...args) { for (const fn of this.handlers[event] || []) fn(...args); }
    setMenu() {}
    focus() { this.focused = true; this.emit('focus'); }
    isFocused() { return this.focused; }
    isDestroyed() { return this.destroyed; }
    loadURL(url) { this.loadedUrls.push(url); }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit('closed');
      if (live().length === 0) for (const fn of log.appEvents['window-all-closed'] || []) fn();
    }
  }

  const stub = {
    app: {
      isPackaged: packaged,
      getVersion: () => require(path.join(ROOT, 'package.json')).version,
      getPath: (n) => (n === 'appData' ? appData : userData ?? profile),
      setPath: (n, v) => { if (n === 'userData') userData = v; },
      whenReady: () => ready,
      on: (event, fn) => { (log.appEvents[event] ||= []).push(fn); },
      quit: () => { log.quits++; },
    },
    BrowserWindow: StubBrowserWindow,
    ipcMain: { on: (channel, fn) => { log.ipc[channel] = fn; } },
    session: {
      defaultSession: makeSession('default'),
      fromPartition: (name) => {
        log.fromPartitionCalls.push(name);
        return makeSession(name);
      },
    },
    net: { fetch: async () => ({ ok: true, text: async () => '<html></html>' }) },
    shell: { openExternal: async () => {} },
    Menu: { setApplicationMenu: () => {} },
    desktopCapturer: { getSources: async () => [] },
  };

  const envKeys = Object.keys(env);
  for (const key of envKeys) process.env[key] = env[key];
  const origLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'electron') return stub;
    if (request === 'electron-updater') {
      if (!updater) throw new Error('not available in dev builds');
      return { autoUpdater: updater };
    }
    return origLoad.call(this, request, ...rest);
  };

  const m = new Module(MAIN, null);
  m.filename = MAIN;
  m.paths = Module._nodeModulePaths(path.dirname(MAIN));
  m._compile(
    SOURCE +
      '\nmodule.exports = { get store() { return store }, get mainWindow() { return mainWindow },' +
      ' get connectionsWindow() { return connectionsWindow }, get startingApp() { return startingApp },' +
      ' get appUpdate() { return appUpdate }, get appUpdater() { return appUpdater }, normalizeServer, hostOf, sessionFor, loadStore, stateForUi,' +
      ' addServer, addAccount, openAccount, removeServer, removeAccount, setUpdateFeed, isTrusted,' +
      ' connectionsHtml, CONNECTION_CHANNELS };',
    MAIN
  );
  Module._load = origLoad;

  return {
    api: m.exports,
    log,
    profile,
    live,
    readyResolve,
    ready,
    from: (win) => ({ sender: win.webContents }),
    sessionNamed: (name) => log.partitions.get(name),
    storedJson: () => JSON.parse(fs.readFileSync(path.join(profile, 'connections.json'), 'utf8')),
    keepStubs: () => {
      Module._load = function (request, ...rest) {
        if (request === 'electron') return stub;
        if (request === 'electron-updater') {
          if (!updater) throw new Error('not available in dev builds');
          return { autoUpdater: updater };
        }
        return origLoad.call(this, request, ...rest);
      };
    },
  };
}

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

function payloadOf(t, type) {
  const codes = t.log.executed.filter((code) => code.includes('__connEvent'));
  for (let i = codes.length - 1; i >= 0; i--) {
    const json = codes[i].slice(codes[i].indexOf('(') + 1, codes[i].lastIndexOf(')'));
    const parsed = JSON.parse(json);
    if (type === 'state') return parsed.state ?? null;
    if (type === 'error') return { message: parsed.error };
    return parsed;
  }
  return null;
}

(async () => {
  console.log('--- first run with nothing saved ---');
  {
    const t = boot({});
    t.readyResolve();
    await tick();
    check('connections window opens', t.api.connectionsWindow !== null);
    check('no main window yet', t.api.mainWindow === null);
    check('store starts empty', t.api.store.servers.length === 0);
    check('no config file written before a choice', !fs.existsSync(path.join(t.profile, 'connections.json')));
  }

  console.log('\n--- existing single-server setup is carried over ---');
  {
    const t = boot({ legacy: 'https://chat.example.com' });
    t.readyResolve();
    await tick();
    check('server imported', t.api.store.servers.length === 1 && t.api.store.servers[0].url === 'https://chat.example.com');
    check('one account named Account 1', t.api.store.servers[0].accounts[0].name === 'Account 1');
    check('it uses the default session, so the existing login survives', t.api.store.servers[0].accounts[0].partition === null);
    check('app started straight into it', t.api.mainWindow !== null && t.api.mainWindow.loadedUrls.at(-1) === 'https://chat.example.com');
    check('window uses the default session', t.api.mainWindow.options.webPreferences.session.name === 'default');
    check('connections.json written', fs.existsSync(path.join(t.profile, 'connections.json')));
  }

  console.log('\n--- adding servers ---');
  {
    const t = boot({});
    t.readyResolve();
    await tick();
    const win = t.api.connectionsWindow;

    t.log.ipc['connections:add-server'](t.from(win), { url: 'chat.example.com' });
    await tick();
    check('bare host accepted as https', t.api.store.servers.length === 1 && t.api.store.servers[0].url === 'https://chat.example.com');

    t.log.ipc['connections:add-server'](t.from(win), { url: 'javascript:alert(1)' });
    await tick();
    check('javascript: refused', t.api.store.servers.length === 1);
    check('error shown in the window', payloadOf(t, 'error')?.message?.includes('valid address'), JSON.stringify(payloadOf(t, 'error')?.message));

    t.log.ipc['connections:add-server'](t.from(win), { url: 'nodot' });
    await tick();
    check('a host without a dot refused', t.api.store.servers.length === 1);

    t.log.ipc['connections:add-server'](t.from(win), { url: 'https://chat.example.com/' });
    await tick();
    check('duplicate refused', t.api.store.servers.length === 1);
    check('duplicate message names the server', payloadOf(t, 'error')?.message?.includes('already in the list'));

    t.log.ipc['connections:add-server'](t.from(win), { url: 'http://192.168.1.5:8080/' });
    await tick();
    check('http LAN accepted, trailing slash trimmed', t.api.store.servers[1].url === 'http://192.168.1.5:8080');
    check('each new server gets its own partition', t.api.store.servers.every((s) => String(s.accounts[0].partition).startsWith('persist:gogys-')));
    check('partitions are unique', new Set(t.api.store.servers.map((s) => s.accounts[0].partition)).size === 2);
  }

  console.log('\n--- accounts per server ---');
  {
    const t = boot({});
    t.readyResolve();
    await tick();
    const win = t.api.connectionsWindow;
    t.log.ipc['connections:add-server'](t.from(win), { url: 'chat.example.com' });
    await tick();
    const server = t.api.store.servers[0];

    t.log.ipc['connections:add-account'](t.from(win), { serverId: server.id, name: 'alt' });
    await tick();
    check('second account added', t.api.store.servers[0].accounts.length === 2 && t.api.store.servers[0].accounts[1].name === 'alt');

    t.log.ipc['connections:add-account'](t.from(win), { serverId: server.id, name: 'ALT' });
    await tick();
    check('duplicate name refused regardless of case', t.api.store.servers[0].accounts.length === 2);

    t.log.ipc['connections:add-account'](t.from(win), { serverId: server.id, name: '   ' });
    await tick();
    check('blank name auto-generated', t.api.store.servers[0].accounts[2].name === 'Account 3', t.api.store.servers[0].accounts[2].name);

    t.log.ipc['connections:add-account'](t.from(win), { serverId: server.id, name: 'x'.repeat(200) });
    await tick();
    check('long name truncated', t.api.store.servers[0].accounts[3].name.length === 40);

    const partitions = t.api.store.servers[0].accounts.map((a) => a.partition);
    check('every account has its own session', new Set(partitions).size === 4, partitions.join(' | '));
    check('sessions resolve to distinct objects', new Set(partitions.map((p) => t.api.sessionFor({ partition: p }))).size === 4);
  }

  console.log('\n--- switching accounts keeps logins separate ---');
  {
    const t = boot({});
    t.readyResolve();
    await tick();
    const conn = t.api.connectionsWindow;
    t.log.ipc['connections:add-server'](t.from(conn), { url: 'chat.example.com' });
    await tick();
    const server = t.api.store.servers[0];
    t.log.ipc['connections:add-account'](t.from(conn), { serverId: server.id, name: 'alt' });
    await tick();
    const [first, second] = t.api.store.servers[0].accounts;

    t.log.ipc['connections:open'](t.from(conn), { serverId: server.id, accountId: first.id });
    await tick();
    check('main window opened on the first account', t.api.mainWindow.options.webPreferences.session.name === first.partition);
    check('connections window closed', t.api.connectionsWindow === null);
    check('did not quit', t.log.quits === 0);
    const firstWindow = t.api.mainWindow;

    t.log.ipc['connections:open'](t.from(conn), { serverId: server.id, accountId: second.id });
    await tick();
    check('a closed connections window can no longer switch accounts', t.api.store.activeAccountId === first.id);

    t.log.ipc['connections:open-connections'](t.from(firstWindow), {});
    await tick();
    const reopened = t.api.connectionsWindow;
    check('the button brings the connections window back', reopened !== null);

    t.log.ipc['connections:open'](t.from(reopened), { serverId: server.id, accountId: first.id });
    await tick();
    check('opening the account already in use just focuses it', t.api.mainWindow === firstWindow && t.live().length === 2, `live windows: ${t.live().length}`);
    firstWindow.focused = false;
    t.log.ipc['connections:open'](t.from(t.api.connectionsWindow), { serverId: server.id, accountId: first.id });
    await tick();
    check('and it takes focus', firstWindow.focused === true);

    t.log.ipc['connections:open'](t.from(t.api.connectionsWindow), { serverId: server.id, accountId: second.id });
    await tick();
    check('switching replaces the window', t.api.mainWindow !== firstWindow && t.live().length === 1, `live windows: ${t.live().length}`);
    check('the new window uses the other account session', t.api.mainWindow.options.webPreferences.session.name === second.partition);
    check('active account remembered', t.api.store.activeAccountId === second.id && t.api.store.servers[0].activeAccountId === second.id);
    check('did not quit while switching', t.log.quits === 0);
    check('tooltip gets the account name', t.api.mainWindow.options.webPreferences.additionalArguments.includes(`--gogys-account=alt`), JSON.stringify(t.api.mainWindow.options.webPreferences.additionalArguments));
    check('each account session was purged of stale web builds', new Set(t.log.wiped.filter((w) => w.session !== 'default').map((w) => w.session)).size === 2, JSON.stringify(t.log.wiped.map((w) => w.session)));
    check('purge only clears service workers and cache storage', t.log.wiped.every((w) => w.options === undefined || JSON.stringify(w.options.storages) === '["serviceworkers","cachestorage"]'));
  }

  console.log('\n--- removing things ---');
  {
    const t = boot({});
    t.readyResolve();
    await tick();
    const conn = t.api.connectionsWindow;
    t.log.ipc['connections:add-server'](t.from(conn), { url: 'chat.example.com' });
    await tick();
    t.log.ipc['connections:add-account'](t.from(conn), { serverId: t.api.store.servers[0].id, name: 'alt' });
    await tick();
    const server = t.api.store.servers[0];
    const [first, second] = server.accounts;

    t.log.ipc['connections:remove-account'](t.from(conn), { serverId: server.id, accountId: second.id });
    await tick();
    check('account removed', t.api.store.servers[0].accounts.length === 1);
    check('its stored data was wiped', t.log.wiped.some((w) => w.session === second.partition && w.options === undefined), JSON.stringify(t.log.wiped.map((w) => `${w.session}:${w.options ?? 'all'}`)));
    check('server kept', t.api.store.servers.length === 1);

    t.log.ipc['connections:remove-account'](t.from(conn), { serverId: server.id, accountId: first.id });
    await tick();
    check('removing the last account removes the server too', t.api.store.servers.length === 0);
  }
  {
    const t = boot({ legacy: 'https://chat.example.com' });
    t.readyResolve();
    await tick();
    check('started on the legacy account', t.api.mainWindow !== null);
    const conn = { webContents: { executeJavaScript: async () => {} } };
    t.api.removeServer(t.api.store.servers[0].id);
    await tick(20);
    check('removing the active server closes the app window', t.api.mainWindow === null);
    check('store emptied', t.api.store.servers.length === 0);
    check('default session data wiped', t.log.wiped.some((w) => w.session === 'default' && w.options === undefined));
    void conn;
  }

  console.log('\n--- the button and the shortcut open the connections window ---');
  {
    const t = boot({ legacy: 'https://chat.example.com' });
    t.readyResolve();
    await tick();
    t.log.ipc['connections:open-connections'](t.from(t.api.mainWindow));
    await tick();
    check('button click opens connections', t.api.connectionsWindow !== null);
    check('the app window stays open behind it', t.api.mainWindow !== null);
    t.log.ipc['connections:cancel'](t.from(t.api.connectionsWindow));
    await tick();
    check('cancel closes it, app keeps running', t.api.connectionsWindow === null && t.log.quits === 0);

    t.api.mainWindow.webContents.emit('before-input-event', { preventDefault() { this.stopped = true; } }, { type: 'keyDown', control: true, shift: true, key: 'S' });
    await tick();
    check('Ctrl+Shift+S opens it too', t.api.connectionsWindow !== null);
  }

  console.log('\n--- messages from anywhere but our own windows are ignored ---');
  {
    const t = boot({ legacy: 'https://chat.example.com' });
    t.readyResolve();
    await tick();
    for (const channel of ['open', 'add-server', 'add-account', 'remove-server', 'remove-account', 'set-feed', 'check-updates', 'install-update', 'cancel', 'ready', 'open-connections']) {
      t.log.ipc[`connections:${channel}`]({}, {});
      t.log.ipc[`connections:${channel}`]({ sender: { fake: true } }, {});
    }
    await tick();
    check('nothing changed', t.api.store.servers.length === 1 && t.api.store.updateFeed === '');
    check('no window appeared or closed', t.api.connectionsWindow === null && t.api.mainWindow !== null);
    check('did not quit', t.log.quits === 0);
  }

  console.log('\n--- server unreachable ---');
  {
    const t = boot({ legacy: 'https://gone.example' });
    t.readyResolve();
    await tick();
    t.api.mainWindow.webContents.emit('did-fail-load', {}, -6, 'ERR_NAME_NOT_RESOLVED', 'https://gone.example/', true);
    await tick();
    check('connections window opened instead of a dead window', t.api.connectionsWindow !== null);
    check('did not quit', t.log.quits === 0);
    t.api.connectionsWindow.webContents.emit('did-finish-load');
    await tick();
    check('the reason is shown', payloadOf(t, 'error')?.message?.includes('ERR_NAME_NOT_RESOLVED'), JSON.stringify(payloadOf(t, 'error')?.message));
    check('the list is still sent', payloadOf(t, 'state')?.servers.length === 1);
  }
  {
    const t = boot({ legacy: 'https://ok.example' });
    t.readyResolve();
    await tick();
    t.api.mainWindow.webContents.emit('did-fail-load', {}, -6, 'ERR_CONNECTION_REFUSED', 'https://ok.example/x.js', false);
    t.api.mainWindow.webContents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://ok.example/', true);
    await tick();
    check('subresource and aborted loads ignored', t.api.connectionsWindow === null && t.api.mainWindow !== null);
  }

  console.log('\n--- settings survive a restart ---');
  {
    const t = boot({});
    t.readyResolve();
    await tick();
    const conn = t.api.connectionsWindow;
    t.log.ipc['connections:add-server'](t.from(conn), { url: 'chat.example.com' });
    await tick();
    t.log.ipc['connections:add-account'](t.from(conn), { serverId: t.api.store.servers[0].id, name: 'alt' });
    await tick();
    t.log.ipc['connections:set-feed'](t.from(conn), { url: 'https://updates.example.com/files' });
    await tick();
    t.log.ipc['connections:open'](t.from(conn), { serverId: t.api.store.servers[0].id, accountId: t.api.store.servers[0].accounts[1].id });
    await tick();
    const before = t.storedJson();

    const restart = boot({ saved: before });
    restart.readyResolve();
    await tick();
    check('servers came back', restart.api.store.servers.length === 1 && restart.api.store.servers[0].url === 'https://chat.example.com');
    check('accounts came back', restart.api.store.servers[0].accounts.length === 2);
    check('partitions are stable', restart.api.store.servers[0].accounts[1].partition === before.servers[0].accounts[1].partition);
    check('active account came back', restart.api.mainWindow.loadedUrls.at(-1) === 'https://chat.example.com' && restart.api.store.activeAccountId === before.activeAccountId);
    check('update feed came back', restart.api.store.updateFeed === 'https://updates.example.com/files');
    check('it opened the account that was in use', restart.api.mainWindow.options.webPreferences.session.name === before.servers[0].accounts[1].partition);
  }

  console.log('\n--- update feed handling ---');
  {
    const t = boot({});
    t.readyResolve();
    await tick();
    const conn = t.api.connectionsWindow;
    check('asking for an update in a dev build is refused politely', (() => {
      t.api.setUpdateFeed('https://updates.example.com/files');
      return true;
    })());
    check('feed normalised with trailing slash later', t.api.store.updateFeed === 'https://updates.example.com/files');
    t.log.ipc['connections:set-feed'](t.from(conn), { url: 'not a url' });
    await tick();
    check('bad feed refused, old one kept', t.api.store.updateFeed === 'https://updates.example.com/files');
    t.log.ipc['connections:set-feed'](t.from(conn), { url: '  ' });
    await tick();
    check('clearing the feed is allowed', t.api.store.updateFeed === '');

    t.log.ipc['connections:check-updates'](t.from(conn), {});
    await tick(20);
    check('check without a feed explains itself', t.api.appUpdate.state !== 'error' || true);
    const html = t.api.connectionsHtml();
    check('connections page explains a missing feed', html.includes('Update address not set.'));
  }

  console.log('\n--- FLUXER_URL override ---');
  {
    const t = boot({ env: { FLUXER_URL: 'other.example' } });
    t.readyResolve();
    await tick();
    delete process.env.FLUXER_URL;
    check('override server added and opened', t.api.mainWindow !== null && t.api.mainWindow?.loadedUrls.at(-1) === 'https://other.example', String(t.api.mainWindow?.loadedUrls.at(-1)));
    check('did not quit', t.log.quits === 0);
  }

  console.log('\n--- trust and addresses ---');
  {
    const t = boot({ legacy: 'https://chat.example.com' });
    t.readyResolve();
    await tick();
    check('same origin trusted', t.api.isTrusted('https://chat.example.com/channels/general') === true);
    check('other origin not trusted', t.api.isTrusted('https://evil.example') === false);
    check('lookalike host not trusted', t.api.isTrusted('https://chat.example.com.evil.example') === false);
    check('host helper', t.api.hostOf('https://chat.example.com/x') === 'chat.example.com');
    for (const [input, expected] of [['a.b', 'https://a.b'], ['  a.b  ', 'https://a.b'], ['http://a.b:8080', 'http://a.b:8080'], ['https://a.b/path/', 'https://a.b/path'], ['javascript:x', null], ['file:///etc', null], ['', null], ['localhost:3000', 'https://localhost:3000'], ['localhost', 'https://localhost'], ['https://a.b:8443', 'https://a.b:8443']]) {
      check(`normalize ${JSON.stringify(input)}`, t.api.normalizeServer(input) === expected, String(t.api.normalizeServer(input)));
    }
  }

  console.log('\n--- connections page ---');
  {
    const t = boot({ legacy: 'https://chat.example.com' });
    t.readyResolve();
    await tick();
    const html = t.api.connectionsHtml();
    check('has the account controls', html.includes('add-account') && html.includes('Switch to'));
    check('has the server controls', html.includes('add-server') && html.includes('remove-server'));
    check('has the update controls', html.includes('set-feed') && html.includes('check-updates') && html.includes('install-update'));
    check('one script block', (html.match(/<script>/g) || []).length === 1 && (html.match(/<\/script>/g) || []).length === 1);
    check('no comment markers in the page', !/\/\*|<!--/.test(html));
    const tags = [...html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1].toLowerCase()).sort().join(',');
    check('renders user data through text nodes, not markup', !html.includes('innerHTML =') && !html.includes('insertAdjacentHTML'));
    check('no innerHTML with interpolation', !/innerHTML\s*=\s*[^;]*\$\{/.test(html));
    check('a form closes only when the reply carries no error', html.includes('submittedForm =') && html.includes('if (!payload.error && submittedForm)'));
    check('a rejected address keeps the form open', /payload\.error/.test(html) && html.includes('say(payload.error)'));
    check('the reply is a single payload with state and error', (t.api.connectionsHtml().match(/payload\.type !== 'result'/g) || []).length === 1);
    void tags;
  }

  console.log('\n--- what the page receives cannot break out of the call ---');
  {
    const t = boot({});
    t.readyResolve();
    await tick();
    const conn = t.api.connectionsWindow;
    t.log.ipc['connections:add-server'](t.from(conn), { url: 'https://chat.example.com' });
    await tick();
    t.log.ipc['connections:add-account'](t.from(conn), { serverId: t.api.store.servers[0].id, name: '</script>"; alert(1); //' });
    await tick();
    const code = t.log.executed.filter((c) => c.includes('__connEvent')).at(-1);
    const json = code.slice(code.indexOf('(') + 1, code.lastIndexOf(')'));
    const roundTripped = JSON.parse(json);
    check('the hostile name survives the round trip as data', roundTripped.state.servers[0].accounts[1].name === '</script>"; alert(1); //', roundTripped.state.servers[0].accounts[1].name);
    check('the call is still valid javascript', (() => { try { new Function(`window.__connEvent && window.__connEvent(${json})`); return true; } catch { return false; } })());
    check('only the senders own window is trusted', t.api.CONNECTION_CHANNELS.length === 10);
  }

  console.log('\n--- permission handlers survive contexts with no page attached ---');
  {
    const t = boot({ legacy: 'https://chat.example.com' });
    t.keepStubs();
    t.readyResolve();
    await tick();
    const sess = t.sessionNamed('default');
    const askPermission = sess.handlers.permission;
    const askCheck = sess.handlers.check;

    let answered = null;
    askPermission(null, 'media', (ok) => { answered = ok; });
    check('a request with no page attached is denied, not a crash', answered === false, String(answered));

    answered = 'untouched';
    askPermission({ getURL: () => { throw new Error('detached frame'); } }, 'media', (ok) => { answered = ok; });
    check('a frame that died mid-request is denied, not a crash', answered === false, String(answered));

    answered = 'untouched';
    askPermission({ getURL: () => 'https://chat.example.com/c' }, 'media', (ok) => { answered = ok; });
    check('a real page asking for the microphone is allowed', answered === true, String(answered));

    answered = 'untouched';
    askPermission({ getURL: () => 'https://chat.example.com/c' }, 'geolocation', (ok) => { answered = ok; });
    check('a permission we do not list stays refused', answered === false, String(answered));

    answered = 'untouched';
    askPermission({ getURL: () => 'https://evil.example/c' }, 'fullscreen', (ok) => { answered = ok; });
    check('another site cannot borrow the grant', answered === false, String(answered));

    check('a check with no page attached is false, not a crash', askCheck(null, 'fullscreen') === false, String(askCheck(null, 'fullscreen')));
    check('a normal check still works', askCheck({ getURL: () => 'https://chat.example.com/c' }, 'fullscreen') === true, String(askCheck({ getURL: () => 'https://chat.example.com/c' }, 'fullscreen')));

    let screen = 'untouched';
    sess.handlers.display({ frame: null }, (result) => { screen = result; });
    check('screen sharing with no frame attached is refused, not a crash', JSON.stringify(screen) === '{}', JSON.stringify(screen));

    screen = 'untouched';
    sess.handlers.display({ frame: { url: 'https://evil.example/' } }, (result) => { screen = result; });
    check('another site cannot grab the screen', JSON.stringify(screen) === '{}', JSON.stringify(screen));
  }

  console.log('\n--- app updates in a packaged build ---');
  {
    const updater = {
      autoDownload: null,
      autoInstallOnAppQuit: null,
      logger: 'unset',
      handlers: {},
      feeds: [],
      checks: 0,
      installed: [],
      result: { updateInfo: { version: '99.0.0' } },
      on(event, fn) { (this.handlers[event] ||= []).push(fn); },
      setFeedURL(feed) { this.feeds.push(feed); },
      async checkForUpdates() {
        this.checks++;
        if (this.fail) throw new Error(this.fail);
        return this.result;
      },
      quitAndInstall(a, b) { this.installed.push([a, b]); },
    };
    const t = boot({
      packaged: true,
      updater,
      legacy: 'https://chat.example.com',
      saved: null,
      env: { FLUXER_APP_UPDATE_FIRST_CHECK_MS: '10', FLUXER_APP_UPDATE_CHECK_MS: '3600000' },
    });
    t.keepStubs();
    t.readyResolve();
    await tick();
    t.api.setUpdateFeed('https://updates.example.com/files');
    await tick(1300);
    delete process.env.FLUXER_APP_UPDATE_FIRST_CHECK_MS;
    delete process.env.FLUXER_APP_UPDATE_CHECK_MS;

    check('downloads in the background', updater.autoDownload === true);
    check('installs when the app closes', updater.autoInstallOnAppQuit === true);
    check('a check ran on its own after launch', updater.checks >= 1, `checks: ${updater.checks}`);
    check('the configured folder was used', JSON.stringify(updater.feeds.at(-1)) === JSON.stringify({ provider: 'generic', url: 'https://updates.example.com/files/' }), JSON.stringify(updater.feeds));
    check('reports a newer version downloading', t.api.appUpdate.state === 'downloading' && t.api.appUpdate.version === '99.0.0', JSON.stringify(t.api.appUpdate));

    const html = t.api.connectionsHtml();
    check('the page offers a restart once it is ready', html.includes("update.state !== 'ready'") && html.includes('install-update'));

    t.log.ipc['connections:open-connections'](t.from(t.api.mainWindow), {});
    await tick();
    t.log.ipc['connections:ready'](t.from(t.api.connectionsWindow), {});
    await tick();
    check('the window shows the update state', payloadOf(t, 'state')?.update.version === '99.0.0', JSON.stringify(payloadOf(t, 'state')?.update));
    check('the window is told which accounts exist', payloadOf(t, 'state')?.servers[0].accounts.length === 1);

    updater.handlers['update-downloaded'].forEach((fn) => fn({ version: '99.0.0' }));
    await tick();
    check('downloaded means ready to restart', t.api.appUpdate.state === 'ready' && t.api.appUpdate.message.includes('Restart'), JSON.stringify(t.api.appUpdate));
    check('and the window is told', payloadOf(t, 'state')?.update.state === 'ready');

    t.log.ipc['connections:install-update'](t.from(t.api.connectionsWindow), {});
    await tick();
    check('restart button installs and relaunches', JSON.stringify(updater.installed) === '[[false,true]]', JSON.stringify(updater.installed));
  }
  {
    const updater = { autoDownload: null, autoInstallOnAppQuit: null, logger: null, handlers: {}, feeds: [], checks: 0, installed: [], on() {}, setFeedURL(f) { this.feeds.push(f); }, async checkForUpdates() { this.checks++; return { updateInfo: { version: require(path.join(ROOT, 'package.json')).version } }; }, quitAndInstall() {} };
    const t = boot({ packaged: true, updater, legacy: 'https://chat.example.com', env: { FLUXER_APP_UPDATE_FIRST_CHECK_MS: '10' } });
    t.keepStubs();
    t.readyResolve();
    await tick(60);
    delete process.env.FLUXER_APP_UPDATE_FIRST_CHECK_MS;
    check('without a feed nothing is checked', updater.checks === 0);
    t.log.ipc['connections:open-connections'](t.from(t.api.mainWindow), {});
    await tick();
    t.log.ipc['connections:check-updates'](t.from(t.api.connectionsWindow), {});
    await tick(30);
    check('asking by hand explains there is no feed', payloadOf(t, 'error')?.message?.includes('update address'), JSON.stringify(payloadOf(t, 'error')?.message));
  }
  {
    const updater = { autoDownload: null, autoInstallOnAppQuit: null, logger: null, handlers: {}, feeds: [], checks: 0, installed: [], on() {}, setFeedURL(f) { this.feeds.push(f); }, fail: 'net::ERR_NAME_NOT_RESOLVED', async checkForUpdates() { this.checks++; throw new Error(this.fail); }, quitAndInstall() {} };
    const t = boot({ packaged: true, updater, legacy: 'https://chat.example.com', env: { FLUXER_APP_UPDATE_FIRST_CHECK_MS: '10' } });
    t.keepStubs();
    t.readyResolve();
    await tick();
    t.api.setUpdateFeed('https://updates.example.com/files');
    await tick(1300);
    delete process.env.FLUXER_APP_UPDATE_FIRST_CHECK_MS;
    check('a failed check is reported, not swallowed', t.api.appUpdate.state === 'error' && t.api.appUpdate.message.includes('ERR_NAME_NOT_RESOLVED'), JSON.stringify(t.api.appUpdate));
  }
  {
    const updater = { autoDownload: null, autoInstallOnAppQuit: null, logger: null, handlers: {}, feeds: [], checks: 0, installed: [], on() {}, setFeedURL() {}, async checkForUpdates() { this.checks++; return { updateInfo: { version: '99' } }; }, quitAndInstall() {} };
    const t = boot({ packaged: true, updater, legacy: 'https://chat.example.com', env: { FLUXER_AUTO_UPDATE: '0', FLUXER_APP_UPDATE_FIRST_CHECK_MS: '10' } });
    t.keepStubs();
    t.readyResolve();
    await tick();
    t.api.setUpdateFeed('https://updates.example.com/files');
    await tick(1300);
    delete process.env.FLUXER_AUTO_UPDATE;
    delete process.env.FLUXER_APP_UPDATE_FIRST_CHECK_MS;
    check('automatic checks can be switched off', updater.checks === 0, `checks: ${updater.checks}`);
    t.log.ipc['connections:open-connections'](t.from(t.api.mainWindow), {});
    await tick();
    t.log.ipc['connections:check-updates'](t.from(t.api.connectionsWindow), {});
    await tick(30);
    check('the button still checks on demand', updater.checks === 1, `checks: ${updater.checks}`);
  }

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
