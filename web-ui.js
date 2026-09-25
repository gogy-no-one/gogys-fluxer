const { ipcRenderer } = require('electron');

const BUTTON_ID = 'gogys-connections-button';
const LABEL_MAX = 18;

function argument(prefix) {
  const match = (process.argv || []).find((value) => typeof value === 'string' && value.startsWith(prefix));
  return match ? match.slice(prefix.length) : '';
}

function accountLabel() {
  const name = argument('--gogys-account=').trim();
  if (name.length === 0) return 'server';
  return name.length > LABEL_MAX ? `${name.slice(0, LABEL_MAX - 1)}…` : name;
}

function tooltip() {
  const url = argument('--gogys-server=').trim();
  const host = (() => {
    try {
      return url.length > 0 ? new URL(url).host : '';
    } catch {
      return '';
    }
  })();
  return host.length > 0 ? `Switch server or account - ${host}` : 'Switch server or account';
}

const STYLE = `
#${BUTTON_ID} {
  position: fixed !important;
  right: 12px !important;
  bottom: 12px !important;
  z-index: 2147483647 !important;
  display: flex !important;
  align-items: center !important;
  gap: 8px !important;
  max-width: 240px !important;
  height: 36px !important;
  padding: 0 12px !important;
  margin: 0 !important;
  border: 1px solid rgba(255, 255, 255, 0.22) !important;
  border-radius: 18px !important;
  background: #2a1a6e !important;
  color: #ffffff !important;
  font: 600 13px/1 system-ui, -apple-system, 'Segoe UI', sans-serif !important;
  letter-spacing: 0.1px !important;
  white-space: nowrap !important;
  overflow: hidden !important;
  cursor: pointer !important;
  opacity: 1 !important;
  transform: none !important;
  text-align: left !important;
  text-decoration: none !important;
  text-transform: none !important;
  box-shadow: 0 3px 14px rgba(0, 0, 0, 0.45) !important;
  box-sizing: border-box !important;
  pointer-events: auto !important;
  user-select: none !important;
  transition: background-color 0.15s ease, transform 0.15s ease !important;
}
#${BUTTON_ID}:hover {
  background: #3f2ab5 !important;
  transform: translateY(-1px) !important;
}
#${BUTTON_ID}:active {
  transform: translateY(0) !important;
}
#${BUTTON_ID}:focus-visible {
  outline: 2px solid #8ea2ff !important;
  outline-offset: 2px !important;
}
#${BUTTON_ID} > svg {
  flex: 0 0 auto !important;
  width: 17px !important;
  height: 17px !important;
  margin: 0 !important;
  padding: 0 !important;
  border: 0 !important;
  background: none !important;
  stroke: currentColor !important;
}
#${BUTTON_ID} > span {
  flex: 0 1 auto !important;
  margin: 0 !important;
  padding: 0 !important;
  border: 0 !important;
  background: none !important;
  color: inherit !important;
  font: inherit !important;
  overflow: hidden !important;
  text-overflow: ellipsis !important;
}
`;

const ICON =
  '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke-width="2.2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M4 8h13l-3.2-3.2"/><path d="M20 16H7l3.2 3.2"/></svg>';

function addButton() {
  if (document.getElementById(BUTTON_ID)) return;

  const style = document.createElement('style');
  style.textContent = STYLE;
  (document.head || document.documentElement).appendChild(style);

  const button = document.createElement('button');
  button.id = BUTTON_ID;
  button.type = 'button';
  button.setAttribute('aria-label', 'Switch server or account');
  button.title = tooltip();
  button.innerHTML = ICON + '<span></span>';
  button.querySelector('span').textContent = accountLabel();
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    ipcRenderer.send('connections:open-connections', {});
  });

  (document.body || document.documentElement).appendChild(button);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', addButton, { once: true });
} else {
  addButton();
}
