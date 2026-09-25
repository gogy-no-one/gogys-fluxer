'use strict';
// Runs the real web-ui.js against a fake DOM to check the button, its label,
// position and click. No GUI, no browser engine.
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'web-ui.js');
let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n      ${detail}` : ''}`);
};

function makeDom({ readyState = 'complete', argv = [] } = {}) {
  const sent = [];
  const byId = new Map();
  const docListeners = new Map();

  const makeEl = (tag) => {
    const el = {
      tagName: tag.toUpperCase(),
      children: [],
      attrs: {},
      handlers: {},
      queries: {},
      setAttribute(k, v) { this.attrs[k] = v; },
      getAttribute(k) { return this.attrs[k]; },
      appendChild(child) { this.children.push(child); return child; },
      addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); },
      click() { for (const fn of this.handlers.click || []) fn({ preventDefault() {}, stopPropagation() {} }); },
      querySelector(selector) {
        if (selector === 'span') {
          if (!this.queries.span) {
            this.queries.span = { tagName: 'SPAN', _text: '', get textContent() { return this._text; }, set textContent(v) { this._text = v; } };
            this.children.push(this.queries.span);
          }
          return this.queries.span;
        }
        return null;
      },
      get textContent() { return this._text ?? ''; },
      set textContent(v) { this._text = v; },
    };
    Object.defineProperty(el, 'id', {
      get() { return this.attrs.id ?? ''; },
      set(v) { this.attrs.id = v; byId.set(v, el); },
    });
    return el;
  };

  const head = makeEl('head');
  const body = makeEl('body');
  const document = {
    readyState,
    head,
    body,
    documentElement: makeEl('html'),
    createElement: makeEl,
    getElementById: (id) => byId.get(id) ?? null,
    addEventListener(type, fn) { (docListeners.get(type) ?? docListeners.set(type, []).get(type)).push(fn); },
    __fire: (type) => { for (const fn of docListeners.get(type) || []) fn(); },
  };

  const origArgv = process.argv;
  process.argv = ['electron', '.', ...argv];
  globalThis.document = document;

  const stub = { ipcRenderer: { send: (...args) => sent.push(args) } };
  const origLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'electron') return stub;
    return origLoad.call(this, request, ...rest);
  };
  delete require.cache[require.resolve(SCRIPT)];
  require(SCRIPT);
  Module._load = origLoad;

  return {
    document,
    body,
    head,
    sent,
    byId,
    restore: () => {
      process.argv = origArgv;
      delete globalThis.document;
    },
  };
}

const ID = 'gogys-connections-button';

console.log('--- the button ---');
{
  const dom = makeDom({ argv: ['--gogys-server=https://chat.example.com', '--gogys-account=alt'] });
  const button = dom.byId.get(ID);
  const css = dom.head.children[0].textContent;

  check('button is added to the page', Boolean(button) && dom.body.children.includes(button));
  check('a real button element', button.tagName === 'BUTTON' && button.type === 'button');
  check('labelled for screen readers', button.getAttribute('aria-label') === 'Switch server or account');
  check('tooltip names the server', button.title === 'Switch server or account - chat.example.com', button.title);
  check('label shows which account is in use', button.querySelector('span').textContent === 'alt', button.querySelector('span').textContent);
  check('has an icon', button.innerHTML.includes('<svg'));
  check('on the right now', /right:\s*12px/.test(css) && !/left:\s*12px/.test(css));
  check('near the bottom', /bottom:\s*12px/.test(css));
  check('fully visible, not faded', /opacity:\s*1\s*!important/.test(css) && !/opacity:\s*0\.[0-9]/.test(css));
  check('still fixed above the page', /position:\s*fixed/.test(css) && /z-index:\s*2147483647/.test(css));
  check('long labels are capped', /max-width:\s*240px/.test(css) && /text-overflow:\s*ellipsis/.test(css));
  check('site styles cannot strip it', (css.match(/!important/g) || []).length > 40, `${(css.match(/!important/g) || []).length} !important rules`);
  check('clicks only land on the button', /pointer-events:\s*auto/.test(css));
  check('a stylesheet is injected once', dom.head.children.length === 1);

  button.click();
  check('one click sends one message', dom.sent.length === 1);
  check('on the channel the app listens for', dom.sent[0][0] === 'connections:open-connections', JSON.stringify(dom.sent[0]));
  dom.restore();
}

console.log('\n--- no arguments at all ---');
{
  const dom = makeDom({ argv: [] });
  const button = dom.byId.get(ID);
  check('still created', Boolean(button));
  check('plain label and tooltip', button.querySelector('span').textContent === 'server' && button.title === 'Switch server or account', `${button.querySelector('span').textContent} / ${button.title}`);
  button.click();
  check('click still works', dom.sent[0][0] === 'connections:open-connections');
  dom.restore();
}

console.log('\n--- awkward argument values ---');
{
  const dom = makeDom({ argv: ['--gogys-server=not a url', '--gogys-account='] });
  const button = dom.byId.get(ID);
  check('unparseable server falls back', button.title === 'Switch server or account', button.title);
  check('empty account falls back', button.querySelector('span').textContent === 'server');
  dom.restore();
}
{
  const dom = makeDom({ argv: ['--gogys-account=a-very-long-account-name-indeed'] });
  const label = dom.byId.get(ID).querySelector('span').textContent;
  check('long account name shortened', label.length <= 18 && label.endsWith('…'), label);
  dom.restore();
}
{
  const dom = makeDom({ argv: ['--gogys-account=<img src=x onerror=alert(1)>'] });
  const button = dom.byId.get(ID);
  check('hostile account name becomes text, not markup', button.querySelector('span').textContent.startsWith('<img src=x') && !button.innerHTML.includes('onerror'), button.querySelector('span').textContent);
  dom.restore();
}

console.log('\n--- page still loading ---');
{
  const dom = makeDom({ readyState: 'loading', argv: ['--gogys-account=alt'] });
  check('nothing injected too early', !dom.byId.has(ID));
  dom.document.__fire('DOMContentLoaded');
  check('injected once the page is ready', dom.byId.has(ID));
  dom.document.__fire('DOMContentLoaded');
  check('not duplicated on a second event', dom.body.children.length === 1);
  dom.restore();
}

console.log('\n--- the script stays small and inert ---');
{
  const source = fs.readFileSync(SCRIPT, 'utf8');
  check('no comments in the file', !/^\s*(\/\/|\/\*|\*)/m.test(source));
  check('nothing shared with the page', !/exposeInMainWorld|contextBridge/.test(source));
  check('no node modules besides electron', !/require\((?!'electron')/.test(source));
  check('only ipcRenderer is used', (source.match(/ipcRenderer\./g) || []).length === 1);
  check('no interpolated markup', !/innerHTML\s*=\s*[^;]*\$\{/.test(source));
  check('label set as text, not markup', /textContent = accountLabel\(\)/.test(source));
}

console.log('\n--- the connections window bridge ---');
{
  const source = fs.readFileSync(path.join(ROOT, 'connections-preload.js'), 'utf8');
  const sent = [];
  const origLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'electron') {
      return {
        contextBridge: { exposeInMainWorld: (key, api) => { sent.push(['exposed', key, api]); } },
        ipcRenderer: { send: (...args) => sent.push(args) },
      };
    }
    return origLoad.call(this, request, ...rest);
  };
  const file = path.join(ROOT, 'connections-preload.js');
  delete require.cache[require.resolve(file)];
  require(file);
  Module._load = origLoad;

  const [, key, api] = sent[0];
  check('exposes one namespaced object', key === 'gogysConnections' && typeof api.send === 'function');
  api.send('open', { serverId: 's1', accountId: 'a1' });
  check('messages are namespaced', sent[1][0] === 'connections:open', JSON.stringify(sent[1]));
  api.send('evil-channel', { serverId: 'x' });
  check('unknown channels dropped', sent.length === 2, JSON.stringify(sent));
  check('no comments in the bridge', !/^\s*(\/\/|\/\*|\*)/m.test(source));
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
