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
      if (res.status === 401 && !path.startsWith('/api/auth/')) endSession();
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
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('Service worker registration failed:', err);
    });
  }

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

  btnLogout.addEventListener('click', () => {
    if (confirm('آیا می‌خواهید از حساب خود خارج شوید؟')) {
      endSession();
      location.reload();
    }
  });

  function endSession() {
    token = '';
    currentUser = null;
    activeChat = null;
    disconnectWebSocket();
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
    loadChats();
    if (!chatPollInterval) chatPollInterval = setInterval(() => {
      if (document.visibilityState !== 'hidden') loadChats();
    }, 5000);
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
        return live && live.updatedAt > chat.updatedAt ? live : chat;
      }).sort((a, b) => b.updatedAt - a.updatedAt);
      renderFilteredChats();
      if (activeChat) {
        const updated = chats.find(c => c.id === activeChat.id);
        if (updated) {
          activeChat = updated;
          if (updated.lastMessage && !(messagesByChat[updated.id] || []).some(m => m.id === updated.lastMessage.id)) {
            await loadMessages(updated.id, { catchUp: true });
          }
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
          <div class="chat-last-msg">${escapeHtml(lastText)}</div>
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
    renderFilteredChats();
    typingBar.textContent = '';
    chatError.textContent = '';
    messageInput.value = '';
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
    const known = messagesByChat[chatId] || [];
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
        renderMessages(messagesByChat[chatId]);
        if (older) messagesContainer.scrollTop = previousTop + messagesContainer.scrollHeight - previousHeight;
        chatError.textContent = '';
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
    for (const message of incoming) unique.set(message.id, message);
    return [...unique.values()].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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

  function renderMessages(msgList) {
    messagesContainer.innerHTML = '';
    if (!msgList || !msgList.length) {
      messagesContainer.innerHTML = `<div style="text-align: center; color: var(--text-muted); margin: auto; font-size: 0.85rem;">هنوز هیچ پیامی در این گفتگو ارسال نشده است.<br>اولین پیام را شما بفرستید!</div>`;
      return;
    }

    msgList.forEach((msg) => {
      appendMessageToUI(msg);
    });
    scrollToBottom();
  }

  function appendMessageToUI(msg) {
    const isSent = msg.senderId === currentUser.id;
    const bubble = document.createElement('div');
    bubble.className = `message-bubble ${isSent ? 'sent' : 'received'}`;

    let senderHtml = '';
    if (!isSent && activeChat?.type === 'group') {
      senderHtml = `<div class="message-sender">${escapeHtml(msg.senderName || 'کاربر')}</div>`;
    }

    bubble.innerHTML = `
      ${senderHtml}
      <div class="message-text">${escapeHtml(msg.text)}</div>
      <div class="message-time">${formatTime(msg.createdAt)}</div>
    `;

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

    socket.onclose = () => {
      if (ws !== socket) return;
      ws = null;
      statusIndicatorDot.className = 'status-dot offline';
      statusText.textContent = 'در حال اتصال مجدد...';
      if (wsPingInterval) clearInterval(wsPingInterval);
      wsPingInterval = null;
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
    if (activeChat && (!ws || ws.readyState === WebSocket.CLOSED)) {
      disconnectWebSocket();
      connectWebSocket(activeChat.id);
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && token) {
      loadChats();
      if (activeChat) loadMessages(activeChat.id, { catchUp: true });
    }
  });

  function handleServerWsEvent(data) {
    if (data.event === 'new_message') {
      const msg = data.message;
      messagesByChat[msg.chatId] = mergeMessages(messagesByChat[msg.chatId] || [], [msg]);
      if (activeChat && msg.chatId === activeChat.id) {
        renderMessages(messagesByChat[msg.chatId]);
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
    } else if (data.event === 'error') {
      chatError.textContent = data.message;
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

    if (!ws || ws.readyState !== WebSocket.OPEN) {
      chatError.textContent = 'اتصال برقرار نیست؛ برنامه دوباره تلاش می‌کند. متن پیام شما حفظ شده است.';
      return;
    }

    const clientMsgId = 'cli_' + Math.random().toString(36).substring(2, 9);
    const action = {
      action: 'send_message',
      chatId: activeChat.id,
      text,
      clientMsgId,
    };

    ws.send(JSON.stringify(action));
    chatError.textContent = '';
    messageInput.value = '';
    messageInput.style.height = 'auto';

    // Broadcast typing stop
    sendTypingStatus(false);
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
