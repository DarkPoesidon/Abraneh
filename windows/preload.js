// Runs in the setup page and the server's page. The web client already talks to native apps through window.Android.
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('wihmSetup', {
    load: () => ipcRenderer.invoke('setup-load'),
    connect: input => ipcRenderer.invoke('setup-connect', input),
    back: () => ipcRenderer.send('setup-back'),
  });
} else if (ipcRenderer.sendSync('is-server-origin', location.origin)) {
  const PING_MS = 2 * 60_000;
  let token = '', socket = null, failures = 0, retry = 0, waitingForPong = false;

  function notify(title, body, chatId) {
    const notification = new Notification(String(title), { body: String(body || ''), icon: '/icon.svg', tag: String(chatId || ''), dir: 'auto' });
    notification.onclick = () => {
      ipcRenderer.send('show-window');
      if (/^[a-zA-Z0-9_-]{1,100}$/.test(String(chatId || ''))) location.assign('/?chat=' + encodeURIComponent(chatId));
    };
  }

  function handleEvent(text) {
    let event;
    try { event = JSON.parse(text); } catch { return; }
    if (event.kind === 'call') {
      ipcRenderer.send('show-window');
      window.dispatchEvent(new Event('wihm-check-calls'));
    } else if (event.kind !== 'call-end' && event.title && !document.hasFocus()) {
      notify(event.title, event.body, event.chatId);
    }
  }

  function connect() {
    clearTimeout(retry);
    if (!token) return;
    const current = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/ws/inbox`, ['wihm.v1', 'wihm.token.' + token]);
    socket = current;
    waitingForPong = false;
    current.onopen = () => { failures = 0; };
    current.onmessage = message => {
      if (message.data === 'pong') waitingForPong = false;
      else handleEvent(message.data);
    };
    current.onclose = () => {
      if (socket !== current || !token) return;
      retry = setTimeout(connect, Math.min(60_000, 2000 * 2 ** failures++));
    };
  }

  // Finds a socket that died without closing, as after sleep.
  setInterval(() => {
    if (socket?.readyState !== WebSocket.OPEN) return;
    if (waitingForPong) { socket.close(); return; }
    waitingForPong = true;
    socket.send('ping');
  }, PING_MS);

  contextBridge.exposeInMainWorld('Android', {
    isDesktop: true,
    saveAuthToken(value) {
      if (typeof value !== 'string' || !value || value === token) return;
      token = value;
      socket?.close();
      connect();
    },
    clearAuthToken() {
      token = '';
      clearTimeout(retry);
      socket?.close();
      socket = null;
    },
    // The inbox socket notifies whenever this window has no focus.
    showNotification(title, body, chatId) {
      if (document.hasFocus()) notify(title, body, chatId);
    },
    openServerSettings() {
      ipcRenderer.send('open-setup');
    },
  });
}
