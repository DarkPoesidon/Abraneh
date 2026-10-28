// Cloudflare Messenger PWA Client
(() => {
  // State
  let token = localStorage.getItem('cf_msg_token') || '';
  let currentUser = null;
  try { currentUser = JSON.parse(localStorage.getItem('cf_msg_user') || 'null'); } catch { /* Start a new session. */ }
  let chats = [];
  let activeChat = null;
  const messagesByChat = {};
  const historyState = {};
  const historyRequests = new Map();
  let ws = null;
  let wsPingInterval = null;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let chatPollInterval = null;
  let chatsRequest = null;
  let typingTimer = null;
  let deferredInstallPrompt = null;
  let outbox = [];
  const backgroundSockets = new Map();
  const receiptsByChat = {};
  const reportedReceipts = new Map();
  const reportingReceipts = new Set();
  let locatingUnread = null;
  let openingChatId = null;

  // DOM Elements
  const authOverlay = document.getElementById('auth-overlay');
  const authForm = document.getElementById('auth-form');
  const authError = document.getElementById('auth-error');
  const tabLogin = document.getElementById('tab-login');
  const tabRegister = document.getElementById('tab-register');
  const displayNameGroup = document.getElementById('display-name-group');
  const inputDisplayName = document.getElementById('input-display-name');
  const inputUsername = document.getElementById('input-username');
  const inputPassword = document.getElementById('input-password');
  const authSubmitBtn = document.getElementById('auth-submit-btn');

  const sidebar = document.getElementById('sidebar');
  const userAvatar = document.getElementById('user-avatar');
  const userDisplayName = document.getElementById('user-display-name');
  const userUsernameBadge = document.getElementById('user-username-badge');
  const btnLogout = document.getElementById('btn-logout');
  const btnOpenSearch = document.getElementById('btn-open-search');
  const chatFilterInput = document.getElementById('chat-filter-input');
  const chatsList = document.getElementById('chats-list');

  const emptyState = document.getElementById('empty-state');
  const activeChatWrapper = document.getElementById('active-chat-wrapper');
  const btnBackToChats = document.getElementById('btn-back-to-chats');
  const chatHeaderAvatar = document.getElementById('chat-header-avatar');
  const activeChatTitle = document.getElementById('active-chat-title');
  const statusIndicatorDot = document.getElementById('status-indicator-dot');
  const statusText = document.getElementById('status-text');
  const messagesContainer = document.getElementById('messages-container');
  const typingBar = document.getElementById('typing-bar');
  const messageInput = document.getElementById('message-input');
  const btnSendMessage = document.getElementById('btn-send-message');
  const btnLoadOlder = document.getElementById('btn-load-older');
  const chatError = document.getElementById('chat-error');
  const btnAddMembers = document.getElementById('btn-add-members');
  const btnFirstUnread = document.getElementById('btn-first-unread');
  const sessionsModal = document.getElementById('sessions-modal');
  const sessionsList = document.getElementById('sessions-list');
  const sessionsError = document.getElementById('sessions-error');

  const searchModal = document.getElementById('search-modal');
  const btnCloseModal = document.getElementById('btn-close-modal');
  const modalSearchInput = document.getElementById('modal-search-input');
  const searchResultsList = document.getElementById('search-results-list');
  const searchModalTitle = document.getElementById('search-modal-title');
  const btnGroupMode = document.getElementById('btn-group-mode');
  const groupTitleInput = document.getElementById('group-title-input');
  const btnSaveGroup = document.getElementById('btn-save-group');
  const selectedMembersText = document.getElementById('selected-members');
  let searchMode = 'dm';
  let memberTargetChatId = null;
  let searchResults = [];
  const selectedMembers = new Map();
  let existingMembers = new Set();
  let searchVersion = 0;
  let modalVersion = 0;

  const installBanner = document.getElementById('install-banner');
  const btnInstallPwa = document.getElementById('btn-install-pwa');
  const btnDismissInstall = document.getElementById('btn-dismiss-install');

  let isRegisterMode = false;

  // --- API Helper ---
  async function api(path, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    const res = await fetch(path, { ...options, headers });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      if (res.status === 401 && !['/api/auth/login', '/api/auth/register'].includes(path)) endSession();
      throw new Error(data?.error || `خطا در برقراری ارتباط (${res.status})`);
    }
    return data;
  }

  // --- Helper: Format Time ---
  function formatTime(timestamp) {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    return date.toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
  }

  // --- Service Worker Registration ---
  if ('serviceWorker' in navigator) {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) document.getElementById('update-banner').hidden = false; });
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch((err) => {
      console.warn('Service worker registration failed:', err);
    });
  }
  document.getElementById('btn-apply-update').addEventListener('click', () => {
    if (messageInput.value.trim() && !confirm('متن داخل کادر هنوز ارسال نشده است. پیش از نوسازی آن را کپی کنید یا بفرستید؛ اکنون نوسازی شود؟')) return;
    if (outbox.length && !saveOutbox()) return;
    location.reload();
  });

  // --- PWA Installation Handling ---
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    installBanner.style.display = 'flex';
  });

  btnInstallPwa.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    if (outcome === 'accepted') {
      installBanner.style.display = 'none';
    }
    deferredInstallPrompt = null;
  });

  btnDismissInstall.addEventListener('click', () => {
    installBanner.style.display = 'none';
  });

  // --- Auth Tabs & Submission ---
  tabLogin.addEventListener('click', () => {
    isRegisterMode = false;
    tabLogin.classList.add('active');
    tabRegister.classList.remove('active');
    displayNameGroup.style.display = 'none';
    authSubmitBtn.textContent = 'ورود به حساب';
    authError.style.display = 'none';
  });

  tabRegister.addEventListener('click', () => {
    isRegisterMode = true;
    tabRegister.classList.add('active');
    tabLogin.classList.remove('active');
    displayNameGroup.style.display = 'block';
    authSubmitBtn.textContent = 'ایجاد حساب کاربری';
    authError.style.display = 'none';
  });

  authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    authError.style.display = 'none';
    const username = inputUsername.value.trim();
    const password = inputPassword.value;
    const displayName = inputDisplayName.value.trim();

    try {
      authSubmitBtn.disabled = true;
      authSubmitBtn.textContent = 'در حال پردازش...';

      const endpoint = isRegisterMode ? '/api/auth/register' : '/api/auth/login';
      const body = { username, password, displayName };
      const res = await api(endpoint, { method: 'POST', body: JSON.stringify(body) });

      token = res.token;
      currentUser = res.user;
      localStorage.setItem('cf_msg_token', token);
      localStorage.setItem('cf_msg_user', JSON.stringify(currentUser));

      setupUserSession();
    } catch (err) {
      authError.textContent = err.message;
      authError.style.display = 'block';
    } finally {
      authSubmitBtn.disabled = false;
      authSubmitBtn.textContent = isRegisterMode ? 'ایجاد حساب کاربری' : 'ورود به حساب';
    }
  });

  btnLogout.addEventListener('click', async () => {
    if (!confirm('از حساب خارج می‌شوید؟ پیام‌های ارسال‌نشدهٔ این حساب از این دستگاه پاک می‌شوند.')) return;
    const accountId = currentUser?.id;
    try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); }
    catch (error) { if (token) { alert('خروج از سرور تأیید نشد. برای لغو نشست، اینترنت را وصل کنید و دوباره تلاش کنید.'); return; } }
    if (accountId) localStorage.removeItem('cf_msg_outbox_' + accountId);
    endSession(); location.reload();
  });

  function endSession() {
    token = '';
    currentUser = null;
    activeChat = null;
    disconnectWebSocket();
    for (const socket of backgroundSockets.values()) { socket.onmessage = socket.onclose = null; socket.close(); }
    backgroundSockets.clear(); outbox = [];
    reportedReceipts.clear(); reportingReceipts.clear();
    for (const key of Object.keys(receiptsByChat)) delete receiptsByChat[key];
    sessionsModal.style.display = 'none';
    clearInterval(chatPollInterval);
    chatPollInterval = null;
    chats = [];
    for (const id of Object.keys(messagesByChat)) delete messagesByChat[id];
    for (const id of Object.keys(historyState)) delete historyState[id];
    localStorage.removeItem('cf_msg_token');
    localStorage.removeItem('cf_msg_user');
    messagesContainer.innerHTML = '';
    chatsList.innerHTML = '';
    activeChatWrapper.style.display = 'none';
    emptyState.style.display = 'flex';
    authOverlay.style.display = 'flex';
  }

  function setupUserSession() {
    if (!currentUser || !token) {
      authOverlay.style.display = 'flex';
      return;
    }
    authOverlay.style.display = 'none';
    userDisplayName.textContent = currentUser.displayName || currentUser.username;
    userUsernameBadge.textContent = `@${currentUser.username}`;
    userAvatar.textContent = (currentUser.displayName || currentUser.username)[0].toUpperCase();
    try {
      const saved = JSON.parse(localStorage.getItem('cf_msg_outbox_' + currentUser.id) || '[]');
      outbox = Array.isArray(saved) ? saved.filter(item => item && typeof item.clientMsgId === 'string' && typeof item.chatId === 'string' && typeof item.text === 'string' && item.text.length <= 10000).slice(0, 100) : [];
      for (const item of outbox) { item.attemptedAt = 0; item.attempts = 0; }
    } catch { outbox = []; chatError.textContent = 'خواندن صف پیام‌های این دستگاه انجام نشد.'; }
    for (const item of outbox) addPending(item);
    loadChats();
    if (!chatPollInterval) chatPollInterval = setInterval(() => {
      if (document.visibilityState !== 'hidden') loadChats();
      flushOutbox();
    }, 5000);
    flushOutbox();
  }

  // --- Load Chats ---
  async function loadChats(force = false) {
    if (!token) return;
    if (chatsRequest) {
      await chatsRequest;
      if (!force || !token) return;
    }
    const sessionToken = token;
    chatsRequest = refreshChats(sessionToken);
    try { await chatsRequest; } finally { chatsRequest = null; }
  }

  async function refreshChats(sessionToken) {
    try {
      const snapshot = await api('/api/chats');
      if (token !== sessionToken) return;
      // Do not let a list request started before a live message roll its preview back.
      chats = snapshot.map(chat => {
        const live = chats.find(c => c.id === chat.id);
        return live && live.updatedAt > chat.updatedAt ? { ...chat, lastMessage: live.lastMessage, updatedAt: live.updatedAt } : chat;
      }).sort((a, b) => b.updatedAt - a.updatedAt);
      renderFilteredChats();
      if (activeChat) {
        const updated = chats.find(c => c.id === activeChat.id);
        if (updated) {
          activeChat = updated;
          if (updated.lastMessage && !(messagesByChat[updated.id] || []).some(m => m.id === updated.lastMessage.id)) {
            await loadMessages(updated.id, { catchUp: true });
          }
          refreshReceipts(updated.id);
          reportReceipt(updated.id);
        }
      }
    } catch (err) {
      if (token === sessionToken) console.error('Failed to load chats:', err);
    }
  }

  function renderFilteredChats() {
    const q = chatFilterInput.value.trim().toLowerCase();
    renderChats(chats.filter(chat => (chat.title || '').toLowerCase().includes(q)));
  }

  function renderChats(list) {
    chatsList.innerHTML = '';
    if (!list.length) {
      chatsList.innerHTML = `<div style="padding: 24px 16px; text-align: center; color: var(--text-muted); font-size: 0.85rem;">گفتگویی وجود ندارد.<br>با کلیک روی دکمه + گفتگوی جدیدی آغاز کنید.</div>`;
      return;
    }

    list.forEach((chat) => {
      const item = document.createElement('div');
      item.className = `chat-item ${activeChat?.id === chat.id ? 'active' : ''}`;
      const initials = (chat.title || '؟')[0].toUpperCase();
      const timeStr = chat.lastMessage ? formatTime(chat.lastMessage.createdAt) : '';
      const lastText = chat.lastMessage ? chat.lastMessage.text : 'هنوز پیامی ارسال نشده است';

      item.innerHTML = `
        <div class="avatar">${escapeHtml(initials)}</div>
        <div class="chat-meta">
          <div class="chat-top-row">
            <span class="chat-title">${escapeHtml(chat.title)}</span>
            <span class="chat-time">${timeStr}</span>
          </div>
          <div class="chat-last-msg">${escapeHtml(lastText)}${chat.unreadCount ? `<span class="unread-badge" aria-label="${Number(chat.unreadCount)} پیام نخوانده">${Number(chat.unreadCount).toLocaleString('fa-IR')}</span>` : ''}</div>
        </div>
      `;

      item.addEventListener('click', () => openChat(chat));
      chatsList.appendChild(item);
    });
  }

  chatFilterInput.addEventListener('input', (e) => {
    renderFilteredChats();
  });

  // --- Open Chat & Connect WebSocket ---
  async function openChat(chat) {
    activeChat = chat;
    openingChatId = chat.id;
    renderFilteredChats();
    typingBar.textContent = '';
    chatError.textContent = '';
    messageInput.value = '';
    btnFirstUnread.hidden = !chat.firstUnreadId;
    btnAddMembers.style.display = chat.type === 'group' ? 'inline-flex' : 'none';

    // Mobile layout adjustment
    if (window.innerWidth <= 768) {
      sidebar.classList.add('hidden');
    }

    emptyState.style.display = 'none';
    activeChatWrapper.style.display = 'flex';
    activeChatTitle.textContent = chat.title;
    chatHeaderAvatar.textContent = (chat.title || '؟')[0].toUpperCase();
    statusIndicatorDot.className = 'status-dot';
    statusText.textContent = 'در حال اتصال...';

    // Disconnect old socket
    disconnectWebSocket();
    reconnectAttempt = 0;

    // Connect WebSocket
    connectWebSocket(chat.id);

    // Load History
    renderMessages(messagesByChat[chat.id] || []);
    await loadMessages(chat.id, { catchUp: true });
    refreshReceipts(chat.id);
    flushOutbox();
    if (activeChat?.id === chat.id && chat.firstUnreadId) await locateFirstUnread(chat);
    if (openingChatId === chat.id) openingChatId = null;
    if (activeChat?.id === chat.id) reportReceipt(chat.id);
  }

  btnBackToChats.addEventListener('click', () => {
    sidebar.classList.remove('hidden');
  });

  // --- Load Messages History ---
  async function loadMessages(chatId, { older = false, catchUp = false } = {}) {
    const key = `${chatId}:${older}`;
    if (historyRequests.has(key)) return historyRequests.get(key);
    const request = fetchMessages(chatId, { older, catchUp });
    historyRequests.set(key, request);
    try { await request; } finally { historyRequests.delete(key); }
  }

  async function fetchMessages(chatId, { older, catchUp }) {
    const sessionToken = token;
    const state = historyState[chatId] ||= { initialized: false, hasOlder: false, loading: false };
    const known = (messagesByChat[chatId] || []).filter(message => !message.pending);
    const knownIds = new Set(known.map(message => message.id));
    let before = older && known.length ? cursorFor(known[0]) : '';
    if (older && (!state.hasOlder || state.loading)) return;
    if (older) state.loading = true;
    updateHistoryButton();
    try {
      let page;
      do {
        page = await api(`/api/chats/${chatId}/messages?limit=50${before ? '&before=' + encodeURIComponent(before) : ''}`);
        if (token !== sessionToken) return;
        for (const message of page) acknowledgeOutbox(message);
        messagesByChat[chatId] = mergeMessages(messagesByChat[chatId] || [], page);
        if (!state.initialized || older) {
          state.hasOlder = page.length === 50;
          state.initialized = true;
        }
        const reachedKnown = page.some(message => knownIds.has(message.id));
        const next = page.length ? cursorFor(page[0]) : '';
        if (older || !catchUp || !knownIds.size || reachedKnown || page.length < 50 || next === before) break;
        before = next;
      } while (true);
      if (activeChat?.id === chatId) {
        const previousHeight = messagesContainer.scrollHeight;
        const previousTop = messagesContainer.scrollTop;
        renderMessages(messagesByChat[chatId], { keepPosition: true });
        if (older) messagesContainer.scrollTop = previousTop + messagesContainer.scrollHeight - previousHeight;
        chatError.textContent = '';
        reportReceipt(chatId);
      }
    } catch (err) {
      if (activeChat?.id === chatId) chatError.textContent = `خطا در دریافت پیام‌ها: ${err.message}`;
    } finally {
      state.loading = false;
      updateHistoryButton();
    }
  }

  function mergeMessages(existing, incoming) {
    const unique = new Map(existing.map(message => [message.id, message]));
    for (const message of incoming) {
      if (!message.pending && message.clientMsgId) for (const [id, old] of unique) {
        if (old.pending && old.clientMsgId === message.clientMsgId && old.senderId === message.senderId) unique.delete(id);
      }
      unique.set(message.id, message);
    }
    return [...unique.values()].sort((a, b) => Number(!!a.pending) - Number(!!b.pending) || a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  function cursorFor(message) { return `${message.createdAt}:${message.id}`; }

  function updateHistoryButton() {
    const state = activeChat && historyState[activeChat.id];
    btnLoadOlder.hidden = !state?.hasOlder;
    btnLoadOlder.disabled = !!state?.loading;
    btnLoadOlder.textContent = state?.loading ? 'در حال دریافت...' : 'پیام‌های قبلی';
  }

  btnLoadOlder.addEventListener('click', () => {
    if (activeChat) loadMessages(activeChat.id, { older: true });
  });

  function renderMessages(msgList, { keepPosition = false } = {}) {
    const top = messagesContainer.scrollTop;
    const atBottom = nearBottom();
    const previousIds = new Set([...messagesContainer.children].map(child => child.id));
    messagesContainer.innerHTML = '';
    if (!msgList || !msgList.length) {
      messagesContainer.innerHTML = `<div style="text-align: center; color: var(--text-muted); margin: auto; font-size: 0.85rem;">هنوز هیچ پیامی در این گفتگو ارسال نشده است.<br>اولین پیام را شما بفرستید!</div>`;
      return;
    }

    msgList.forEach((msg) => {
      if (activeChat?.firstUnreadId === msg.id) { const divider = document.createElement('div'); divider.className = 'unread-divider'; divider.textContent = 'پیام‌های نخوانده'; messagesContainer.appendChild(divider); }
      appendMessageToUI(msg, !previousIds.has('message-' + msg.id));
    });
    if (!keepPosition || atBottom) scrollToBottom(); else messagesContainer.scrollTop = top;
  }

  function appendMessageToUI(msg, animate = true) {
    const isSent = msg.senderId === currentUser.id;
    const bubble = document.createElement('div');
    bubble.className = `message-bubble ${isSent ? 'sent' : 'received'}${msg.pending ? ' pending' : ''}${msg.failed ? ' failed' : ''}`;
    bubble.id = 'message-' + msg.id;
    if (!animate) bubble.style.animation = 'none';

    let senderHtml = '';
    if (!isSent && activeChat?.type === 'group') {
      senderHtml = `<div class="message-sender">${escapeHtml(msg.senderName || 'کاربر')}</div>`;
    }

    bubble.innerHTML = `
      ${senderHtml}
      <div class="message-text">${escapeHtml(msg.text)}</div>
      <div class="message-time">${formatTime(msg.createdAt)}${isSent ? `<span class="message-status">${messageStatus(msg)}</span>` : ''}</div>
    `;
    if (msg.pending) {
      if (msg.failed) {
        const retry = document.createElement('button'); retry.className = 'message-retry'; retry.textContent = 'تلاش دوباره'; retry.type = 'button';
        retry.addEventListener('click', () => { const item = outbox.find(item => item.clientMsgId === msg.clientMsgId); if (item) { item.failed = false; item.attempts = 0; item.attemptedAt = 0; saveOutbox(); addPending(item); flushOutbox(); renderMessages(messagesByChat[activeChat.id], { keepPosition: true }); } });
        bubble.appendChild(retry);
      }
      const remove = document.createElement('button'); remove.className = 'message-retry'; remove.textContent = 'حذف از صف'; remove.type = 'button';
      remove.addEventListener('click', () => {
        if (!confirm('پیام از صف این دستگاه حذف شود؟ اگر قبلاً به سرور رسیده باشد، از گفتگو حذف نمی‌شود.')) return;
        outbox = outbox.filter(item => item.clientMsgId !== msg.clientMsgId); saveOutbox();
        messagesByChat[msg.chatId] = (messagesByChat[msg.chatId] || []).filter(item => item.id !== msg.id);
        if (activeChat?.id === msg.chatId) renderMessages(messagesByChat[msg.chatId], { keepPosition: true });
      }); bubble.appendChild(remove);
    }

    messagesContainer.appendChild(bubble);
  }

  function scrollToBottom() {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  // --- WebSocket Connection Management ---
  function disconnectWebSocket() {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    clearInterval(wsPingInterval);
    wsPingInterval = null;
    const old = ws;
    ws = null;
    if (old) {
      old.onopen = old.onmessage = old.onclose = old.onerror = null;
      old.close();
    }
  }

  function connectWebSocket(chatId) {
    if (!token || activeChat?.id !== chatId) return;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}/ws?chatId=${encodeURIComponent(chatId)}&token=${encodeURIComponent(token)}`;

    const socket = new WebSocket(wsUrl);
    ws = socket;

    socket.onopen = () => {
      if (ws !== socket || activeChat?.id !== chatId) return;
      reconnectAttempt = 0;
      statusIndicatorDot.className = 'status-dot';
      statusText.textContent = 'متصل به سرور';
      clearInterval(wsPingInterval);
      loadMessages(chatId, { catchUp: true });
      flushOutbox();

      // Keepalive ping every 25 seconds
      wsPingInterval = setInterval(() => {
        if (ws === socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ action: 'ping' }));
        }
      }, 25000);
    };

    socket.onmessage = (event) => {
      if (ws !== socket || activeChat?.id !== chatId) return;
      try {
        const data = JSON.parse(event.data);
        handleServerWsEvent(data);
      } catch (err) {
        console.error('WebSocket parse error:', err);
      }
    };

    socket.onclose = (event) => {
      if (ws !== socket) return;
      ws = null;
      statusIndicatorDot.className = 'status-dot offline';
      statusText.textContent = 'در حال اتصال مجدد...';
      if (wsPingInterval) clearInterval(wsPingInterval);
      wsPingInterval = null;
      if (event?.code === 4001) { endSession(); authError.textContent = 'نشست این دستگاه پایان یافته است. دوباره وارد شوید.'; authError.style.display = 'block'; return; }
      if (token && activeChat?.id === chatId) {
        const delay = Math.min(1000 * 2 ** reconnectAttempt++, 30000);
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connectWebSocket(chatId);
        }, delay);
      }
    };

    socket.onerror = (err) => {
      console.warn('WebSocket error:', err);
    };
  }

  window.addEventListener('online', () => {
    loadChats();
    flushOutbox();
    if (activeChat && (!ws || ws.readyState === WebSocket.CLOSED)) {
      disconnectWebSocket();
      connectWebSocket(activeChat.id);
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && token) {
      loadChats();
      if (activeChat) loadMessages(activeChat.id, { catchUp: true });
      if (activeChat) { refreshReceipts(activeChat.id); reportReceipt(activeChat.id); }
    }
  });

  function handleServerWsEvent(data) {
    if (data.event === 'session_revoked') { endSession(); authError.textContent = 'دسترسی این دستگاه لغو شده است. دوباره وارد شوید.'; authError.style.display = 'block'; return; }
    if (data.event === 'new_message') {
      const msg = data.message;
      acknowledgeOutbox(msg);
      messagesByChat[msg.chatId] = mergeMessages(messagesByChat[msg.chatId] || [], [msg]);
      if (activeChat && msg.chatId === activeChat.id) {
        renderMessages(messagesByChat[msg.chatId], { keepPosition: true });
        reportReceipt(msg.chatId);
      }

      // Update sidebar preview
      const targetChat = chats.find((c) => c.id === msg.chatId);
      if (targetChat) {
        if (!targetChat.lastMessage || msg.createdAt >= targetChat.lastMessage.createdAt) targetChat.lastMessage = {
          id: msg.id,
          text: msg.text,
          senderName: msg.senderName,
          createdAt: msg.createdAt,
        };
        targetChat.updatedAt = Math.max(targetChat.updatedAt || 0, msg.createdAt);
        chats.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        renderFilteredChats();
      }
    } else if (data.event === 'receipt') {
      if (!data.chatId || !data.userId) return;
      const values = receiptsByChat[data.chatId] ||= [];
      const index = values.findIndex(receipt => receipt.userId === data.userId);
      if (index === -1) values.push(data); else values[index] = data;
      if (activeChat?.id === data.chatId) renderMessages(messagesByChat[data.chatId] || [], { keepPosition: true });
    } else if (data.event === 'error') {
      chatError.textContent = data.message;
      if (data.clientMsgId) {
        const item = outbox.find(item => item.clientMsgId === data.clientMsgId);
        if (item) { item.failed = true; item.attemptedAt = 0; saveOutbox(); addPending(item); if (activeChat?.id === item.chatId) renderMessages(messagesByChat[item.chatId], { keepPosition: true }); }
      }
    } else if (data.event === 'typing') {
      if (activeChat && data.chatId === activeChat.id && data.userId !== currentUser.id) {
        if (data.isTyping) {
          typingBar.textContent = `${data.username} در حال نوشتن...`;
        } else {
          typingBar.textContent = '';
        }
      }
    } else if (data.event === 'presence') {
      if (activeChat && activeChat.type === 'dm' && data.userId === activeChat.partnerId) {
        if (data.status === 'online') {
          statusIndicatorDot.className = 'status-dot';
          statusText.textContent = 'آنلاین';
        } else {
          statusIndicatorDot.className = 'status-dot offline';
          statusText.textContent = 'آفلاین';
        }
      }
    }
  }

  // --- Send Message ---
  function sendMessage() {
    const text = messageInput.value.trim();
    if (!text || !activeChat) return;
    if (text.length > 10000) { chatError.textContent = 'هر پیام باید حداکثر ۱۰٬۰۰۰ کاراکتر باشد.'; return; }

    if (outbox.length >= 100) { chatError.textContent = 'صف این دستگاه پر است. ابتدا پیام‌های در انتظار را ارسال یا حذف کنید.'; return; }
    const item = { chatId: activeChat.id, text, clientMsgId: 'cli_' + (globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + '_' + Math.random().toString(36).slice(2)), createdAt: Date.now(), attemptedAt: 0, attempts: 0, failed: false };
    if (!saveOutbox([...outbox, item])) return;
    outbox.push(item); addPending(item);
    renderMessages(messagesByChat[activeChat.id]);
    chatError.textContent = '';
    messageInput.value = '';
    messageInput.style.height = 'auto';

    // Broadcast typing stop
    sendTypingStatus(false);
    flushOutbox();
  }

  btnSendMessage.addEventListener('click', sendMessage);

  messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Typing broadcast
  messageInput.addEventListener('input', () => {
    sendTypingStatus(true);
    if (typingTimer) clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
      sendTypingStatus(false);
    }, 2000);
  });

  function sendTypingStatus(isTyping) {
    if (ws && ws.readyState === WebSocket.OPEN && activeChat) {
      ws.send(JSON.stringify({ action: 'typing', chatId: activeChat.id, isTyping }));
    }
  }

  // A local, per-account outbox survives refresh. Stable IDs make retries idempotent.
  function saveOutbox(value = outbox) {
    if (!currentUser) return false;
    try { localStorage.setItem('cf_msg_outbox_' + currentUser.id, JSON.stringify(value)); return true; }
    catch { chatError.textContent = 'فضای ذخیرهٔ مرورگر کافی نیست؛ متن را نگه دارید و فضای دستگاه را بررسی کنید.'; return false; }
  }
  function addPending(item) {
    if (!currentUser) return;
    const pending = { ...item, id: 'pending-' + item.clientMsgId, senderId: currentUser.id, senderName: currentUser.displayName, pending: true };
    messagesByChat[item.chatId] = mergeMessages(messagesByChat[item.chatId] || [], [pending]);
  }
  function acknowledgeOutbox(message) {
    if (!currentUser || message.senderId !== currentUser.id || !message.clientMsgId) return;
    if (outbox.some(item => item.clientMsgId === message.clientMsgId && item.chatId === message.chatId)) {
      outbox = outbox.filter(item => item.clientMsgId !== message.clientMsgId || item.chatId !== message.chatId);
      saveOutbox();
    }
  }
  function sendQueued(socket, chatId) {
    for (const item of outbox.filter(item => item.chatId === chatId && !item.failed)) {
      if (Date.now() - (item.attemptedAt || 0) < 12_000) continue;
      if ((item.attempts || 0) >= 5) { item.failed = true; addPending(item); continue; }
      item.attemptedAt = Date.now(); item.attempts = (item.attempts || 0) + 1;
      try { socket.send(JSON.stringify({ action: 'send_message', chatId, text: item.text, clientMsgId: item.clientMsgId })); }
      catch { item.attemptedAt = 0; }
      addPending(item);
    }
    saveOutbox();
    if (activeChat?.id === chatId) renderMessages(messagesByChat[chatId] || [], { keepPosition: true });
  }
  function flushOutbox() {
    if (!token || !currentUser || navigator.onLine === false || !outbox.length) return;
    for (const [chatId, socket] of backgroundSockets) {
      if (!outbox.some(item => item.chatId === chatId && !item.failed)) { socket.onclose = null; socket.close(); backgroundSockets.delete(chatId); }
    }
    for (const chatId of new Set(outbox.filter(item => !item.failed).map(item => item.chatId))) {
      if (activeChat?.id === chatId && ws?.readyState === WebSocket.OPEN) { sendQueued(ws, chatId); continue; }
      if (activeChat?.id === chatId && ws && ws.readyState !== WebSocket.CLOSED) continue;
      const previous = backgroundSockets.get(chatId);
      if (previous) { if (previous.readyState === WebSocket.OPEN) sendQueued(previous, chatId); continue; }
      const sessionToken = token;
      const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws?chatId=${encodeURIComponent(chatId)}&token=${encodeURIComponent(token)}`);
      backgroundSockets.set(chatId, socket);
      socket.onopen = () => { if (token === sessionToken) sendQueued(socket, chatId); else socket.close(); };
      socket.onmessage = event => {
        if (token !== sessionToken) return;
        try { handleServerWsEvent(JSON.parse(event.data)); } catch { return; }
        if (!outbox.some(item => item.chatId === chatId && !item.failed)) { socket.close(); backgroundSockets.delete(chatId); }
      };
      socket.onclose = event => {
        if (backgroundSockets.get(chatId) === socket) backgroundSockets.delete(chatId);
        if (event?.code === 4001 && token === sessionToken) endSession();
      };
      socket.onerror = () => {};
    }
  }
  function nearBottom() { return messagesContainer.scrollHeight - messagesContainer.scrollTop - (messagesContainer.clientHeight || 0) <= 80; }
  function canReadChat(chatId) {
    return activeChat?.id === chatId && openingChatId !== chatId && document.visibilityState !== 'hidden'
      && !(window.innerWidth <= 768 && !sidebar.classList.contains?.('hidden')) && nearBottom();
  }
  function covers(receipt, message, kind) {
    return Number(receipt[kind + 'At']) > message.createdAt || (Number(receipt[kind + 'At']) === message.createdAt && String(receipt[kind + 'Id']) >= message.id);
  }
  function messageStatus(message) {
    if (message.pending) return message.failed ? 'ارسال تأیید نشد؛ تلاش دوباره' : message.attemptedAt ? 'در حال ارسال…' : 'در انتظار اتصال';
    const others = (receiptsByChat[message.chatId] || []).filter(receipt => receipt.userId !== currentUser.id);
    const read = others.filter(receipt => covers(receipt, message, 'read')).length;
    const delivered = others.filter(receipt => covers(receipt, message, 'delivered')).length;
    if (read) return activeChat?.type === 'group' ? `خوانده شد (${read.toLocaleString('fa-IR')})` : 'خوانده شد';
    if (delivered) return activeChat?.type === 'group' ? `تحویل شد (${delivered.toLocaleString('fa-IR')})` : 'تحویل شد';
    return 'ارسال شد';
  }
  async function refreshReceipts(chatId) {
    const sessionToken = token;
    try {
      const rows = await api(`/api/chats/${chatId}/receipts`);
      if (token !== sessionToken || !Array.isArray(rows)) return;
      const incoming = rows.filter(row => row && typeof row.userId === 'string');
      if (JSON.stringify(incoming) === JSON.stringify(receiptsByChat[chatId] || [])) return;
      receiptsByChat[chatId] = incoming;
      if (activeChat?.id === chatId) renderMessages(messagesByChat[chatId] || [], { keepPosition: true });
    } catch { /* Poll again; a receipt failure does not discard a message. */ }
  }
  async function reportReceipt(chatId) {
    if (!token || reportingReceipts.has(chatId)) return;
    const messages = (messagesByChat[chatId] || []).filter(message => !message.pending);
    const last = messages.at(-1);
    if (!last) return;
    const read = canReadChat(chatId), key = last.id + ':' + read;
    if (reportedReceipts.get(chatId) === key) return;
    const sessionToken = token;
    reportingReceipts.add(chatId);
    try {
      const receipt = await api(`/api/chats/${chatId}/receipts`, { method: 'POST', body: JSON.stringify({ messageId: last.id, read }) });
      if (sessionToken !== token) return;
      reportedReceipts.set(chatId, key);
      if (read && receipt?.userId === currentUser?.id) {
        const chat = chats.find(chat => chat.id === chatId);
        if (chat && chat.lastMessage?.id === last.id) { chat.unreadCount = 0; chat.firstUnreadId = null; renderFilteredChats(); }
        if (activeChat?.id === chatId) btnFirstUnread.hidden = true;
      }
    } catch { /* A later scroll/poll retries the cumulative receipt. */ }
    finally { reportingReceipts.delete(chatId); }
  }
  messagesContainer.addEventListener('scroll', () => { if (activeChat) reportReceipt(activeChat.id); });
  function scrollToUnread(id) { document.getElementById('message-' + id)?.scrollIntoView?.({ block: 'start' }); }
  async function locateFirstUnread(chat) {
    if (!chat.firstUnreadId || locatingUnread === chat.id) return;
    locatingUnread = chat.id; btnFirstUnread.disabled = true; btnFirstUnread.textContent = 'در حال یافتن پیام نخوانده…';
    try {
      while (activeChat?.id === chat.id && !(messagesByChat[chat.id] || []).some(message => message.id === chat.firstUnreadId) && historyState[chat.id]?.hasOlder) {
        const length = messagesByChat[chat.id].length;
        await loadMessages(chat.id, { older: true });
        if (messagesByChat[chat.id].length === length) break;
      }
      if (activeChat?.id === chat.id) scrollToUnread(chat.firstUnreadId);
    } finally {
      if (locatingUnread === chat.id) locatingUnread = null;
      btnFirstUnread.disabled = false; btnFirstUnread.textContent = 'اولین پیام نخوانده';
    }
  }
  btnFirstUnread.addEventListener('click', () => { if (activeChat) locateFirstUnread(activeChat); });

  async function loadSessions() {
    sessionsError.textContent = ''; sessionsList.textContent = 'در حال دریافت…';
    const sessionToken = token;
    try {
      const rows = await api('/api/auth/sessions');
      if (token !== sessionToken) return;
      sessionsList.innerHTML = '';
      for (const session of rows) {
        const row = document.createElement('div'); row.className = 'session-row';
        row.innerHTML = `<strong>${session.current ? 'این دستگاه' : 'دستگاه دیگر'}</strong><p dir="ltr">${escapeHtml(session.label)}</p><p>ثبت نشست: ${new Date(session.createdAt).toLocaleString('fa-IR')}</p>`;
        if (!session.current) {
          const revoke = document.createElement('button'); revoke.type = 'button'; revoke.className = 'message-retry'; revoke.textContent = 'خروج از این دستگاه';
          revoke.addEventListener('click', async () => {
            if (!confirm('دسترسی این دستگاه قطع شود؟')) return;
            revoke.disabled = true;
            try { await api('/api/auth/sessions/revoke', { method: 'POST', body: JSON.stringify({ id: session.id }) }); await loadSessions(); }
            catch (error) { sessionsError.textContent = error.message; revoke.disabled = false; }
          }); row.appendChild(revoke);
        }
        sessionsList.appendChild(row);
      }
    } catch (error) { sessionsError.textContent = error.message; sessionsList.textContent = ''; }
  }
  document.getElementById('btn-sessions').addEventListener('click', () => { sessionsModal.style.display = 'flex'; document.getElementById('btn-close-sessions').focus(); loadSessions(); });
  document.getElementById('btn-close-sessions').addEventListener('click', () => { sessionsModal.style.display = 'none'; document.getElementById('btn-sessions').focus(); });
  document.getElementById('btn-revoke-others').addEventListener('click', async () => {
    if (!confirm('همهٔ دستگاه‌های دیگر از حساب خارج شوند؟')) return;
    const button = document.getElementById('btn-revoke-others'); button.disabled = true;
    try { await api('/api/auth/sessions/revoke', { method: 'POST', body: JSON.stringify({ others: true }) }); await loadSessions(); }
    catch (error) { sessionsError.textContent = error.message; } finally { button.disabled = false; }
  });

  // --- Search Users Modal ---
  function openSearch(mode = 'dm', chatId = null) {
    searchMode = mode;
    memberTargetChatId = chatId;
    searchVersion++;
    modalVersion++;
    selectedMembers.clear();
    existingMembers = new Set();
    searchResults = [];
    searchModal.style.display = 'flex';
    modalSearchInput.value = '';
    groupTitleInput.value = '';
    groupTitleInput.hidden = mode !== 'group';
    btnGroupMode.hidden = mode === 'members';
    btnGroupMode.textContent = mode === 'group' ? 'گفتگوی خصوصی' : 'ساخت گروه';
    searchModalTitle.textContent = mode === 'members' ? 'افزودن عضو به گروه' : mode === 'group' ? 'ساخت گروه جدید' : 'شروع گفتگوی جدید';
    updateMemberSelection();
    searchResultsList.innerHTML = '<div style="text-align: center; color: var(--text-muted); font-size: 0.85rem; padding: 12px;">نام کاربری مخاطب مورد نظر را جستجو کنید...</div>';
    modalSearchInput.focus();
  }

  btnOpenSearch.addEventListener('click', () => openSearch());
  btnGroupMode.addEventListener('click', () => openSearch(searchMode === 'group' ? 'dm' : 'group'));
  btnAddMembers.addEventListener('click', async () => {
    if (activeChat?.type !== 'group') return;
    const chatId = activeChat.id;
    openSearch('members', chatId);
    const version = modalVersion;
    try {
      const members = await api(`/api/chats/${chatId}/members`);
      if (version !== modalVersion || memberTargetChatId !== chatId) return;
      existingMembers = new Set(members.map(member => member.id));
      for (const id of existingMembers) selectedMembers.delete(id);
      renderSearchResults(searchResults);
      updateMemberSelection();
    } catch (err) { if (version === modalVersion) searchResultsList.textContent = err.message; }
  });

  btnCloseModal.addEventListener('click', () => {
    searchModal.style.display = 'none';
    searchVersion++;
    modalVersion++;
  });

  let searchDebounce = null;
  modalSearchInput.addEventListener('input', (e) => {
    const q = e.target.value.trim();
    const version = ++searchVersion;
    if (searchDebounce) clearTimeout(searchDebounce);
    if (!q) {
      searchResultsList.innerHTML = '';
      return;
    }

    searchDebounce = setTimeout(async () => {
      try {
        const users = await api(`/api/users/search?q=${encodeURIComponent(q)}`);
        if (version !== searchVersion) return;
        renderSearchResults(users);
      } catch (err) {
        if (version === searchVersion) searchResultsList.textContent = `خطا: ${err.message}`;
      }
    }, 300);
  });

  function renderSearchResults(users) {
    searchResults = users;
    searchResultsList.innerHTML = '';
    if (!users.length) {
      searchResultsList.innerHTML = '<div style="text-align: center; color: var(--text-muted); font-size: 0.85rem; padding: 12px;">کاربری با این مشخصات یافت نشد.</div>';
      return;
    }

    users.forEach((user) => {
      const row = document.createElement('div');
      row.className = 'user-search-result';
      row.innerHTML = `
        <div style="display: flex; align-items: center; gap: 10px;">
          <div class="avatar" style="width: 34px; height: 34px; font-size: 0.85rem;">${escapeHtml((user.displayName || user.username)[0].toUpperCase())}</div>
          <div>
            <div style="font-size: 0.9rem; font-weight: 600;">${escapeHtml(user.displayName)}</div>
            <div style="font-size: 0.75rem; color: var(--text-secondary);">@${escapeHtml(user.username)}</div>
          </div>
        </div>
        <button type="button" class="install-btn" style="font-size: 0.8rem; padding: 4px 10px;">${searchMode === 'dm' ? 'گفتگو' : existingMembers.has(user.id) ? 'عضو گروه' : selectedMembers.has(user.id) ? 'انتخاب شد ✓' : 'انتخاب'}</button>
      `;

      row.addEventListener('click', async () => {
        if (searchMode !== 'dm') {
          if (existingMembers.has(user.id)) return;
          if (selectedMembers.has(user.id)) selectedMembers.delete(user.id);
          else if (selectedMembers.size < 99) selectedMembers.set(user.id, user);
          updateMemberSelection();
          renderSearchResults(searchResults);
          return;
        }
        try {
          const res = await api('/api/chats', {
            method: 'POST',
            body: JSON.stringify({ type: 'dm', targetUserId: user.id }),
          });
          searchModal.style.display = 'none';
          await loadChats(true);
          const target = chats.find((c) => c.id === res.id);
          if (target) {
            openChat(target);
          }
        } catch (err) {
          alert('خطا در ایجاد چت: ' + err.message);
        }
      });

      searchResultsList.appendChild(row);
    });
  }

  function updateMemberSelection() {
    btnSaveGroup.hidden = searchMode === 'dm';
    btnSaveGroup.disabled = selectedMembers.size === 0;
    btnSaveGroup.textContent = `${searchMode === 'members' ? 'افزودن اعضا' : 'ساخت گروه'} (${selectedMembers.size})`;
    selectedMembersText.textContent = [...selectedMembers.values()].map(user => user.displayName || user.username).join('، ');
  }

  btnSaveGroup.addEventListener('click', async () => {
    const ids = [...selectedMembers.keys()];
    if (!ids.length) return;
    const adding = searchMode === 'members';
    const version = modalVersion;
    try {
      btnSaveGroup.disabled = true;
      const path = adding ? `/api/chats/${memberTargetChatId}/members` : '/api/chats';
      const body = adding ? { userIds: ids } : { type: 'group', title: groupTitleInput.value.trim(), memberIds: ids };
      const result = await api(path, { method: 'POST', body: JSON.stringify(body) });
      if (version === modalVersion) searchModal.style.display = 'none';
      await loadChats(true);
      if (!adding) {
        const chat = chats.find(chat => chat.id === result.id);
        if (chat) openChat(chat);
      }
    } catch (err) {
      if (version === modalVersion) searchResultsList.textContent = `خطا: ${err.message}`;
    } finally { if (version === modalVersion) updateMemberSelection(); }
  });

  // Helper: Escape HTML
  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // Start app
  setupUserSession();
})();
