// Cloudflare Messenger PWA Client
(() => {
  // State
  let token = localStorage.getItem('cf_msg_token') || '';
  let currentUser = null;
  let secureItems=[],securePoll=null,secureRequest=null;
  async function refreshSecure(){
    if(!token||!currentUser||!window.WihmSecure||secureRequest)return;
    const owner=currentUser,session=token;
    const task=(async()=>{try{
      const {client}=await window.WihmSecure.connect(api,owner);if(token!==session)return;
      await client.sync();const view=await client.view();if(token!==session)return;
      secureItems=view.threads.map(t=>({id:t.id,threadId:t.id,secure:true,title:t.peer,lastMessage:t.messages.at(-1),updatedAt:t.messages.at(-1)?.createdAt||0}));
      for(const e of view.pending.filter(e=>e.kind==='welcome'))if(!secureItems.some(t=>t.id===e.thread))secureItems.push({id:e.thread,threadId:e.thread,secure:true,title:e.from,lastMessage:{text:'دعوت گفتگو · منتظر تأیید دستگاه',createdAt:Date.now()},updatedAt:Date.now(),unreadCount:1});
      renderFilteredChats();await window.WihmSecure.refresh?.();
    }catch(e){console.warn('Secure sync:',e.message);}})();secureRequest=task;try{await task;}finally{if(secureRequest===task)secureRequest=null;}
  }
  async function openSecure(initialAddress='',threadId=''){
    if(!currentUser)return;
    const session=token;
    try{await window.WihmSecure.open({api,post,show:(title,html)=>{if(token===session)return showFeature(title,html);},error:featureError,escape:escapeHtml,user:currentUser,initialAddress,threadId});}catch(e){if(token===session)featureError(e);}
  }
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
  let profile = {}, archivedView = false, composerContext = null;
  let extras=null,calls=null,media=null;
  let sidebarCompact=false,lastMobileLayout=window.innerWidth<=768;
  try {sidebarCompact=localStorage.getItem('cf_msg_sidebar_compact')==='1';}catch{/* Preferences are optional when device storage is unavailable. */}
  const hiddenMessages = new Map(), deniedChats = new Set(), chatDetails = new Map();
  let invitation = new URLSearchParams(location.hash?.slice(1) || '');

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
  let viewportFrame=0;
  function fitMobileViewport(){
    cancelAnimationFrame(viewportFrame);viewportFrame=requestAnimationFrame(()=>{
      const root=document.documentElement,viewport=window.visualViewport;
      if(window.innerWidth>768||viewport&&viewport.scale!==1){root.style.removeProperty('--app-height');root.style.removeProperty('--app-top');return;}
      const atEnd=nearBottom();
      root.style.setProperty('--app-height',(viewport?.height||window.innerHeight)+'px');
      root.style.setProperty('--app-top',(viewport?.offsetTop||0)+'px');
      if(atEnd)requestAnimationFrame(scrollToBottom);
    });
  }
  window.visualViewport?.addEventListener('resize',fitMobileViewport);
  window.visualViewport?.addEventListener('scroll',fitMobileViewport);
  window.addEventListener('resize',fitMobileViewport);
  fitMobileViewport();
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
  window.WihmUpdates?.init({
    canReload:()=>!calls?.active()&&(document.getElementById('feature-modal')?.style.display!=='flex'||document.getElementById('feature-title')?.textContent==='به‌روزرسانی')&&document.visibilityState==='visible'&&!messageInput.value.trim()&&!outbox.length,
    prepareReload:()=>!calls?.active()&&(document.getElementById('feature-modal')?.style.display!=='flex'||document.getElementById('feature-title')?.textContent==='به‌روزرسانی')&&!messageInput.value.trim()&&(!outbox.length||saveOutbox()),
  });

  // --- PWA Installation Handling ---
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    installBanner.hidden=false;
  });

  btnInstallPwa.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    if (outcome === 'accepted') {
      installBanner.hidden=true;
    }
    deferredInstallPrompt = null;
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
      const body = { username, password, displayName, otp:document.getElementById('input-otp')?.value||'', inviteToken: invitation.get('register') || '' };
      const res = await api(endpoint, { method: 'POST', body: JSON.stringify(body) });

      token = res.token;
      currentUser = res.user;
      localStorage.setItem('cf_msg_token', token);
      localStorage.setItem('cf_msg_user', JSON.stringify(currentUser));

      if(invitation.has('register')) {invitation.delete('register');history.replaceState(null,'',location.pathname);}
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
    media?.purge();
    calls?.reset();
    window.WihmSecure?.reset();secureItems=[];clearInterval(securePoll);securePoll=null;secureRequest=null;
    if (window.Android && window.Android.clearAuthToken) {
      window.Android.clearAuthToken();
    }
    token = '';
    currentUser = null;
    activeChat = null;
    disconnectWebSocket();
    for (const socket of backgroundSockets.values()) { socket.onmessage = socket.onclose = null; socket.close(); }
    backgroundSockets.clear(); outbox = [];
    reportedReceipts.clear(); reportingReceipts.clear();
    hiddenMessages.clear();chatDetails.clear();deniedChats.clear();profile={};cancelComposer();
    extras?.clearNotice();featureGeneration++;
    for (const key of Object.keys(receiptsByChat)) delete receiptsByChat[key];
    sessionsModal.style.display = 'none';
    closeMainMenu();
    document.getElementById('feature-modal').style.display='none';
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
    if (window.Android && window.Android.saveAuthToken) {
      window.Android.saveAuthToken(token, currentUser.id, location.origin);
    }
    userDisplayName.textContent = currentUser.displayName || currentUser.username;
    userUsernameBadge.textContent = `@${currentUser.username}`;
    userAvatar.textContent = (currentUser.displayName || currentUser.username)[0].toUpperCase();
    try {
      const saved = JSON.parse(localStorage.getItem('cf_msg_outbox_' + currentUser.id) || '[]');
      outbox = Array.isArray(saved) ? saved.filter(item => item && typeof item.clientMsgId === 'string' && typeof item.chatId === 'string' && typeof item.text === 'string' && item.text.length <= 10000).slice(0, 100) : [];
      for (const item of outbox) { item.attemptedAt = 0; item.attempts = 0; }
    } catch { outbox = []; chatError.textContent = 'خواندن صف پیام‌های این دستگاه انجام نشد.'; }
    for (const item of outbox) addPending(item);
    loadProfile().catch(() => {});
    const secureLaunch=new URLSearchParams(location.search||'').get('secure');if(secureLaunch&&/^[a-f0-9-]{36}$/.test(secureLaunch)){openSecure('',secureLaunch);history.replaceState(null,'',location.pathname);}
    refreshSecure();
    if(!securePoll)securePoll=setInterval(()=>{if(document.visibilityState!=='hidden')refreshSecure();},15000);
    redeemInvitation().catch(error => { chatError.textContent=error.message; });
    loadChats().then(()=>{checkIncomingCalls();const launchChat=new URLSearchParams(location.search||'').get('chat');const target=chats.find(chat=>chat.id===launchChat);if(target){openChat(target);history.replaceState(null,'',location.pathname);}});
    if (!chatPollInterval) chatPollInterval = setInterval(() => {
      if (document.visibilityState !== 'hidden') loadChats();
      flushOutbox();
      checkIncomingCalls();
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
        const newerPreview=live?.lastMessage?.id===chat.lastMessage?.id&&Number(live?.lastMessage?.revision||0)>Number(chat.lastMessage?.revision||0);
        return live && (live.updatedAt > chat.updatedAt || newerPreview) ? { ...chat, lastMessage: live.lastMessage, updatedAt: live.updatedAt } : chat;
      }).sort((a, b) => Number(!!b.pinned)-Number(!!a.pinned) || b.updatedAt - a.updatedAt);
      renderFilteredChats();
      for(const chat of chats) if(chat.blocked&&!deniedChats.has(chat.id)) denyChat(chat.id,false);
      for(const item of outbox) if(!chats.some(chat=>chat.id===item.chatId)&&!deniedChats.has(item.chatId)) denyChat(item.chatId,false);
      if (activeChat) {
        const updated = chats.find(c => c.id === activeChat.id);
        if (updated) {
          activeChat = updated;
          activeChatTitle.textContent=updated.title;chatHeaderAvatar.innerHTML=avatarHtml(updated.avatar,updated.title);
          await loadChatDetails(updated.id).catch(()=>{});
          if (updated.lastMessage && !(messagesByChat[updated.id] || []).some(m => m.id === updated.lastMessage.id)) {
            await loadMessages(updated.id, { catchUp: true });
          }
          refreshReceipts(updated.id);
          reportReceipt(updated.id);
        } else if(!deniedChats.has(activeChat.id)) denyChat(activeChat.id,false);
      }
    } catch (err) {
      if (token === sessionToken) console.error('Failed to load chats:', err);
    }
  }

  function renderFilteredChats() {
    const q = chatFilterInput.value.trim().toLowerCase();
    renderChats([...chats,...(archivedView?[]:secureItems)].filter(chat => (!!chat.archived === archivedView) && (chat.title || '').toLowerCase().includes(q)));
  }

  function renderChats(list) {
    chatsList.innerHTML = '';
    if (!list.length) {
      chatsList.innerHTML = `<div class="chat-list-empty" role="status" aria-label="گفتگویی وجود ندارد">${uiIcon('compose')}<span>گفتگویی وجود ندارد.<br>با دکمهٔ گفتگوی جدید شروع کنید.</span></div>`;
      return;
    }

    list.forEach((chat) => {
      const item = document.createElement('button');item.type='button';
      item.dataset.chatId=chat.id;item.title=chat.title||'گفتگو';
      item.setAttribute('aria-label',(chat.title||'گفتگو')+(chat.unreadCount?'، '+Number(chat.unreadCount).toLocaleString('fa-IR')+' پیام نخوانده':''));
      item.setAttribute('aria-current',activeChat?.id===chat.id?'true':'false');
      item.className = `chat-item ${activeChat?.id === chat.id ? 'active' : ''}`;

      const timeStr = chat.lastMessage ? formatTime(chat.lastMessage.createdAt) : '';
      const lastText = (chat.pinned?'⌖ ':'')+(chat.muted?'بی‌صدا · ':'')+(chat.lastMessage ? chat.lastMessage.text : 'هنوز پیامی ارسال نشده است');

      item.innerHTML = `
        <span class="chat-avatar-wrap"><span class="avatar" style="--avatar-hue:${avatarHue(chat.id)}">${avatarHtml(chat.avatar,chat.title)}</span>${chat.unreadCount?`<span class="rail-unread" aria-hidden="true">${Number(chat.unreadCount)>99?'۹۹+':Number(chat.unreadCount).toLocaleString('fa-IR')}</span>`:''}</span>
        <div class="chat-meta">
          <div class="chat-top-row">
            <span class="chat-title">${escapeHtml(chat.title)}</span>
            <span class="chat-time">${timeStr}</span>
          </div>
          <div class="chat-last-msg">${escapeHtml(lastText)}${chat.unreadCount ? `<span class="unread-badge" aria-label="${Number(chat.unreadCount)} پیام نخوانده">${Number(chat.unreadCount).toLocaleString('fa-IR')}</span>` : ''}</div>
        </div>
      `;

      item.addEventListener('click', () => {if(chat.secure)return openSecure('',chat.threadId);if(activeChat?.id===chat.id){if(window.innerWidth<=768)sidebar.classList.add('hidden');reportReceipt(chat.id);return;}return openChat(chat);});
      chatsList.appendChild(item);
    });
  }

  chatFilterInput.addEventListener('input', (e) => {
    renderFilteredChats();
  });

  // --- Open Chat & Connect WebSocket ---
  async function openChat(chat, preserveCall = false) {
    activeChat = chat;
    openingChatId = chat.id;
    cancelComposer();
    loadChatDetails(chat.id).catch(() => {});
    renderFilteredChats();
    typingBar.textContent = '';
    chatError.textContent = '';
    messageInput.value = '';
    syncComposer();
    btnFirstUnread.hidden = !chat.firstUnreadId;
    btnAddMembers.style.display = chat.type === 'group' && ['owner','admin'].includes(chat.role) ? 'inline-flex' : 'none';

    // Mobile layout adjustment
    if (window.innerWidth <= 768) {
      sidebar.classList.add('hidden');
    }

    emptyState.style.display = 'none';
    activeChatWrapper.style.display = 'flex';
    activeChatTitle.textContent = chat.title;
    chatHeaderAvatar.innerHTML = avatarHtml(chat.avatar,chat.title);
    chatHeaderAvatar.style.setProperty?.('--avatar-hue',avatarHue(chat.id));
    statusIndicatorDot.className = 'status-dot';
    statusText.textContent = 'در حال اتصال...';

    // Disconnect old socket
    disconnectWebSocket(preserveCall);
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
      const prior = unique.get(message.id);
      if (!prior || Number(message.revision || 0) >= Number(prior.revision || 0)) unique.set(message.id, message);
    }
    const values=[...unique.values()].filter(message => !hiddenMessages.get(message.chatId)?.has(message.id));
    for(const message of values) if(message.replyToId) {
      const parent=unique.get(message.replyToId);
      if(parent) message.replyTo={id:parent.id,senderName:parent.senderName,text:parent.deletedAt?'':parent.text,deleted:!!parent.deletedAt};
      if(hiddenMessages.get(message.chatId)?.has(message.replyToId)&&message.replyTo) message.replyTo={...message.replyTo,text:'',deleted:true};
    }
    return values.sort((a, b) => Number(!!a.pending) - Number(!!b.pending) || a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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

    const visible = msgList.filter(msg => !hiddenMessages.get(msg.chatId)?.has(msg.id));
    // Consecutive messages from one person read as a group, broken by a new day or a long pause.
    const sameGroup = (a, b) => !!a && !!b && a.senderId === b.senderId && dayKey(a.createdAt) === dayKey(b.createdAt) && Math.abs(b.createdAt - a.createdAt) < 300_000;
    visible.forEach((msg, index) => {
      const previous = visible[index - 1];
      if (dayKey(previous?.createdAt) !== dayKey(msg.createdAt)) { const pill = document.createElement('div'); pill.className = 'date-pill'; pill.textContent = dayLabel(msg.createdAt); messagesContainer.appendChild(pill); }
      if (activeChat?.firstUnreadId === msg.id) { const divider = document.createElement('div'); divider.className = 'unread-divider'; divider.textContent = 'پیام‌های نخوانده'; messagesContainer.appendChild(divider); }
      appendMessageToUI(msg, !previousIds.has('message-' + msg.id), { first: !sameGroup(previous, msg), last: !sameGroup(msg, visible[index + 1]) });
    });
    if (!keepPosition || atBottom) scrollToBottom(); else messagesContainer.scrollTop = top;
  }

  function dayKey(timestamp) { if (!timestamp) return ''; const date = new Date(timestamp); return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`; }
  function dayLabel(timestamp) {
    const key = dayKey(timestamp);
    if (key === dayKey(Date.now())) return 'امروز';
    if (key === dayKey(Date.now() - 86400_000)) return 'دیروز';
    return new Date(timestamp).toLocaleDateString('fa-IR', { day: 'numeric', month: 'long', year: new Date(timestamp).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  }
  function clockTime(timestamp) { return new Date(timestamp).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' }); }
  function statusMarkup(msg) {
    const text = messageStatus(msg), state = msg.failed ? 'failed' : msg.pending ? 'pending' : text.startsWith('خوانده') ? 'read' : text.startsWith('تحویل') ? 'delivered' : 'sent';
    const check = 'M3 12.5 8 17.5 18 6.5', second = 'M9.5 15.5 11 17.5 21 6.5';
    const mark = state === 'failed' ? '' : state === 'pending' ? '<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/>' : `<path d="${check}"/>${state === 'sent' ? '' : `<path d="${second}"/>`}`;
    return `<span class="message-status" data-state="${state}" title="${escapeHtml(text)}">${mark ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${mark}</svg><span class="visually-hidden">${escapeHtml(text)}</span>` : escapeHtml(text)}</span>`;
  }

  function appendMessageToUI(msg, animate = true, { first = true, last = true } = {}) {
    const isSent = msg.senderId === currentUser.id;
    const bubble = document.createElement('div');
    bubble.className = `message-bubble ${isSent ? 'sent' : 'received'}${first ? ' group-first' : ''}${last ? ' group-last' : ''}${msg.pending ? ' pending' : ''}${msg.failed ? ' failed' : ''}`;
    bubble.id = 'message-' + msg.id;
    if (!animate) bubble.style.animation = 'none';

    let senderHtml = '';
    if (!isSent && first && activeChat?.type === 'group') {
      senderHtml = `<div class="message-sender" style="--avatar-hue:${avatarHue(msg.senderId)}">${escapeHtml(msg.senderName || 'کاربر')}</div>`;
    }

    bubble.innerHTML = `
      ${senderHtml}
      ${msg.replyTo && !msg.deletedAt ? `<button class="reply-quote" type="button" data-reply="${escapeHtml(msg.replyTo.id)}"><strong>${escapeHtml(msg.replyTo.senderName)}</strong><span>${escapeHtml(msg.replyTo.deleted ? 'پیام حذف شده' : msg.replyTo.text.slice(0,180))}</span></button>` : ''}
      <div class="message-text${msg.deletedAt ? ' deleted-message' : ''}">${msg.deletedAt ? 'این پیام حذف شده است' : escapeHtml(msg.text)}</div>
      ${!msg.deletedAt && msg.reactions?.length ? `<div class="reactions">${msg.reactions.map(r=>`<button type="button" class="reaction-chip ${r.users.includes(currentUser.id)?'selected':''}" data-emoji="${escapeHtml(r.emoji)}" aria-label="واکنش ${escapeHtml(r.emoji)}">${escapeHtml(r.emoji)} ${r.users.length.toLocaleString('fa-IR')}</button>`).join('')}</div>` : ''}
      <div class="message-footer"><div class="message-time">${msg.editedAt && !msg.deletedAt ? 'ویرایش‌شده · ' : ''}${clockTime(msg.createdAt)}${isSent ? statusMarkup(msg) : ''}</div></div>
    `;
    media?.enhance(bubble,msg);
    if (!msg.pending) addMessageControls(bubble,msg);
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
  function disconnectWebSocket(preserveCall = false) {
    if (!preserveCall) calls?.reset();
    media?.reset();
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
    if (!token || activeChat?.id !== chatId || deniedChats.has(chatId)) return;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}/ws?chatId=${encodeURIComponent(chatId)}`;

    const socket = new WebSocket(wsUrl, ['wihm.v1', 'wihm.token.' + token]);
    ws = socket;

    socket.onopen = () => {
      if (ws !== socket || activeChat?.id !== chatId) return;
      reconnectAttempt = 0;
      statusIndicatorDot.className = 'status-dot';
      statusText.textContent = 'متصل به سرور';
      clearInterval(wsPingInterval);
      loadMessages(chatId, { catchUp: true });
      refreshLoadedMessages(chatId).catch(error=>{if(activeChat?.id===chatId)chatError.textContent=error.message;});
      flushOutbox();
      calls?.connectionRestored();

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
      // 4xxx closes mean access ended; anything else may be a brief drop that an accepted call survives.
      if (event?.code >= 4000) calls?.reset(false); else calls?.connectionLost();
      ws = null;
      statusIndicatorDot.className = 'status-dot offline';
      statusText.textContent = 'در حال اتصال مجدد...';
      if (wsPingInterval) clearInterval(wsPingInterval);
      wsPingInterval = null;
      if (event?.code === 4003) { denyChat(chatId); return; }
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
    refreshSecure();
    loadChats();
    flushOutbox();
    if (activeChat && (!ws || ws.readyState === WebSocket.CLOSED)) {
      disconnectWebSocket();
      connectWebSocket(activeChat.id);
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && token) {
      refreshSecure();
      loadChats();
      if (activeChat) {loadMessages(activeChat.id, { catchUp: true });refreshLoadedMessages(activeChat.id).catch(()=>{});}
      if (activeChat) { refreshReceipts(activeChat.id); reportReceipt(activeChat.id); }
    }
  });

  function handleServerWsEvent(data) {
    if(data.event==='call_signal'||data.event==='call_error'){void calls?.receive(data);return;}
    if (data.event === 'session_revoked') { endSession(); authError.textContent = 'دسترسی این دستگاه لغو شده است. دوباره وارد شوید.'; authError.style.display = 'block'; return; }
    if (data.event === 'chat_access_revoked') { denyChat(data.chatId); return; }
    if (data.event === 'message_changed') { acceptMutation(data.message); return; }
    if (data.event === 'new_message') {
      const msg = data.message;
      acknowledgeOutbox(msg);
      messagesByChat[msg.chatId] = mergeMessages(messagesByChat[msg.chatId] || [], [msg]);

      // Notification trigger for incoming messages
      if (currentUser && msg.senderId !== currentUser.id) {
        const isReadingChat = activeChat && activeChat.id === msg.chatId && document.visibilityState !== 'hidden';
        if (!isReadingChat) {
          const targetChat = chats.find(c => c.id === msg.chatId);
          const chatTitle = (targetChat && targetChat.type === 'group' ? targetChat.title : msg.senderName) || 'پیام تازه در ابرانه';
          const preview = msg.text || 'یک پیام جدید دریافت شد';
          if (window.Android && window.Android.showNotification) {
            window.Android.showNotification(chatTitle, preview, msg.chatId);
          } else if ('Notification' in window && Notification.permission === 'granted') {
            try {
              new Notification(chatTitle, { body: preview, icon: '/icon.svg', tag: msg.chatId, dir: 'rtl' });
            } catch (e) {}
          }
        }
      }

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
    if (deniedChats.has(activeChat.id)) { chatError.textContent='دسترسی ارسال در این گفتگو بسته است.'; return; }
    if (composerContext?.mode === 'edit') { commitEdit(text); return; }
    if (text.length > 10000) { chatError.textContent = 'هر پیام باید حداکثر ۱۰٬۰۰۰ کاراکتر باشد.'; return; }

    if (outbox.length >= 100) { chatError.textContent = 'صف این دستگاه پر است. ابتدا پیام‌های در انتظار را ارسال یا حذف کنید.'; return; }
    const item = { chatId: activeChat.id, text, ...(composerContext?.mode === 'reply' ? {replyToId:composerContext.message.id,replyTo:{id:composerContext.message.id,text:composerContext.message.text,senderName:composerContext.message.senderName}} : {}), clientMsgId: 'cli_' + (globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + '_' + Math.random().toString(36).slice(2)), createdAt: Date.now(), attemptedAt: 0, attempts: 0, failed: false };
    if (!saveOutbox([...outbox, item])) return;
    outbox.push(item); addPending(item);
    cancelComposer();
    renderMessages(messagesByChat[activeChat.id]);
    chatError.textContent = '';
    messageInput.value = '';
    messageInput.style.height = 'auto';
    syncComposer();

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
      try { socket.send(JSON.stringify({ action: 'send_message', chatId, text: item.text, clientMsgId: item.clientMsgId, ...(item.replyToId ? {replyToId:item.replyToId} : {}) })); }
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
      if(deniedChats.has(chatId)) {for(const item of outbox.filter(row=>row.chatId===chatId)){item.failed=true;addPending(item);}saveOutbox();continue;}
      if (activeChat?.id === chatId && ws?.readyState === WebSocket.OPEN) { sendQueued(ws, chatId); continue; }
      if (activeChat?.id === chatId && ws && ws.readyState !== WebSocket.CLOSED) continue;
      const previous = backgroundSockets.get(chatId);
      if (previous) { if (previous.readyState === WebSocket.OPEN) sendQueued(previous, chatId); continue; }
      const sessionToken = token;
      const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws?chatId=${encodeURIComponent(chatId)}`, ['wihm.v1', 'wihm.token.' + token]);
      backgroundSockets.set(chatId, socket);
      socket.onopen = () => { if (token === sessionToken) sendQueued(socket, chatId); else socket.close(); };
      socket.onmessage = event => {
        if (token !== sessionToken) return;
        try { handleServerWsEvent(JSON.parse(event.data)); } catch { return; }
        if (!outbox.some(item => item.chatId === chatId && !item.failed)) { socket.close(); backgroundSockets.delete(chatId); }
      };
      socket.onclose = event => {
        if (backgroundSockets.get(chatId) === socket) backgroundSockets.delete(chatId);
        if (event?.code === 4003) denyChat(chatId);
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
  document.getElementById('btn-sessions').addEventListener('click', () => {closeFeature();sessionsModal.style.display='flex';document.getElementById('btn-close-sessions').focus();loadSessions();});
  document.getElementById('btn-close-sessions').addEventListener('click',()=>{sessionsModal.style.display='none';document.getElementById('btn-settings').focus();settings().then(()=>document.getElementById('btn-sessions').focus()).catch(featureError);});
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
        if(searchMode==='dm'&&q.includes('@')&&q.replace(/^@/,'').includes('@')){
          const remote=await post('/api/network/lookup',{address:q});
          if(version!==searchVersion)return;
          searchResultsList.innerHTML=`<button type="button" id="remote-start-chat" class="settings-row"><span>${escapeHtml(remote.displayName)}<small dir="ltr">${escapeHtml(remote.address)}</small></span><span>گفتگو</span></button>`;
          byId('remote-start-chat').addEventListener('click',()=>{searchModal.style.display='none';openSecure(remote.address);});return;
        }
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
    // innerHTML leaves quotes as they are, and these values also go inside HTML attributes.
    return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Daily-use tools share the authenticated session, outbox and message store.
  const byId = id => document.getElementById(id);
  const featureModal = byId('feature-modal'), featureContent = byId('feature-content');
  const mainMenu=byId('main-menu'),mainMenuButton=byId('btn-main-menu');
  let featureGeneration = 0, lastFeatureFocus = null, avatarDraft = '';
  const roleName = role => ({owner:'مالک',admin:'مدیر',member:'عضو'})[role] || 'عضو';
  const isManager = chat => ['owner','admin'].includes(chat?.role);
  const post = (path,body={}) => api(path,{method:'POST',body:JSON.stringify(body)});
  const patch = (path,body) => api(path,{method:'PATCH',body:JSON.stringify(body)});
  function uiIcon(name) {return `<svg class="ui-icon" aria-hidden="true" focusable="false"><use href="#i-${name}"/></svg>`;}
  function avatarHue(id) {let hash=0;for(const ch of id||'')hash=(hash*31+ch.charCodeAt(0))>>>0;hash^=hash>>>16;hash=Math.imul(hash,0x45d9f3b)>>>0;hash^=hash>>>16;return (hash>>>0)%360;}
  function closeMainMenu(restoreFocus=false) {mainMenu.hidden=true;mainMenuButton.setAttribute('aria-expanded','false');if(restoreFocus)mainMenuButton.focus();}
  function applySidebarLayout() {
    const mobile=window.innerWidth<=768,compact=!mobile&&sidebarCompact;
    if(compact)sidebar.classList.add('collapsed');else sidebar.classList.remove('collapsed');
    if(mobile&&!lastMobileLayout&&activeChat)sidebar.classList.add('hidden');
    lastMobileLayout=mobile;
    const label=compact?'بازکردن فهرست گفتگوها':'جمع‌کردن فهرست گفتگوها',button=byId('btn-toggle-sidebar');
    button.title=label;button.setAttribute('aria-label',label);button.setAttribute('aria-expanded',String(!compact));
    if(mobile&&document.activeElement===button)mainMenuButton.focus();
    closeMainMenu();
  }
  byId('btn-toggle-sidebar').addEventListener('click',()=>{sidebarCompact=!sidebarCompact;try{localStorage.setItem('cf_msg_sidebar_compact',sidebarCompact?'1':'0');}catch{/* The panel still works when storage is disabled. */}applySidebarLayout();});
  window.addEventListener('resize',applySidebarLayout);
  mainMenuButton.addEventListener('click',()=>{const open=mainMenu.hidden;mainMenu.hidden=!open;mainMenuButton.setAttribute('aria-expanded',String(open));if(open)mainMenu.querySelector('button')?.focus();});
  mainMenu.addEventListener('click',event=>{if(event.target.closest('button'))closeMainMenu();});
  document.addEventListener('pointerdown',event=>{if(!mainMenu.hidden&&!mainMenu.contains(event.target)&&!mainMenuButton.contains(event.target))closeMainMenu();});
  byId('btn-menu-settings').addEventListener('click',()=>settings().catch(featureError));
  byId('btn-menu-group').addEventListener('click',()=>openSearch('group'));
  byId('btn-menu-archive').addEventListener('click',()=>setArchivedView(true));
  function setArchivedView(archived) {
    archivedView=archived;byId('archive-label').textContent=archived?'همهٔ گفتگوها':'آرشیو';
    const button=byId('btn-archive');button.setAttribute('aria-pressed',String(archived));button.title=archived?'بازگشت به همهٔ گفتگوها':'گفتگوهای آرشیوشده';button.setAttribute('aria-label',button.title);renderFilteredChats();
  }
  applySidebarLayout();
  function closeFeature() { featureGeneration++; featureModal.style.display='none'; lastFeatureFocus?.focus?.(); }
  function showFeature(title,html) {
    if(featureModal.style.display!=='flex')lastFeatureFocus=mainMenu.contains(document.activeElement)?mainMenuButton:document.activeElement;
    byId('feature-title').textContent=title; featureContent.innerHTML=html;featureContent.dataset.settingsPage='';byId('settings-navigation').hidden=true;byId('btn-settings-back').hidden=true;
    byId('feature-status').textContent=''; featureModal.style.display='flex'; featureGeneration++;
    byId('btn-close-feature').focus?.(); return featureGeneration;
  }
  function featureError(error) { byId('feature-status').textContent=error.message || String(error); }
  function bind(id,callback,event='click') { byId(id)?.addEventListener(event,async e=> { if(event==='submit') e.preventDefault(); try { await callback(e); } catch(error) { featureError(error); } }); }
  function avatarHtml(value,name) { return /^data:image\/(png|webp);base64,[A-Za-z0-9+/]+=*$/.test(value||'') ? `<img src="${escapeHtml(value)}" alt="">` : escapeHtml((name||'؟')[0]); }
  byId('btn-close-feature').addEventListener('click',closeFeature);
  featureModal.addEventListener('click',e=> { if(e.target===featureModal) closeFeature(); });
  document.addEventListener('keydown',e=> {
    if(!mainMenu.hidden) {
      const items=[...mainMenu.querySelectorAll('button')].filter(el=>!el.hidden&&el.offsetParent!==null),index=items.indexOf(document.activeElement);
      if(e.key==='Escape'){e.preventDefault();closeMainMenu(true);return;}
      if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)) {e.preventDefault();const next=e.key==='Home'?0:e.key==='End'?items.length-1:(index+(e.key==='ArrowDown'?1:-1)+items.length)%items.length;items[next]?.focus();return;}
      if(e.key==='Tab')closeMainMenu(true);
    }
    const dialog=sessionsModal.style.display==='flex'?sessionsModal:searchModal.style.display==='flex'?searchModal:featureModal.style.display==='flex'?featureModal:null;
    if(dialog&&dialog!==featureModal) {
      if(e.key==='Escape'){e.preventDefault();byId(dialog===sessionsModal?'btn-close-sessions':'btn-close-modal').click();return;}
      if(e.key==='Tab')trapDialogFocus(dialog,e);return;
    }
    if(featureModal.style.display!=='flex') return;
    if(e.key==='Escape') { closeFeature(); return; }
    if(e.key==='Tab')trapDialogFocus(featureModal,e);
  });
  function trapDialogFocus(dialog,e) {
      const nodes=[...dialog.querySelectorAll('button:not([disabled]),input:not([disabled]),textarea,select,a[href]')].filter(el=>!el.hidden&&el.offsetParent!==null);
      if(!nodes.length) return; const first=nodes[0],last=nodes[nodes.length-1];
      if(e.shiftKey&&document.activeElement===first) { e.preventDefault();last.focus(); }
      else if(!e.shiftKey&&document.activeElement===last) { e.preventDefault();first.focus(); }
  }
  async function settings() {
    if(!currentUser||!token)return;
    showFeature('تنظیمات','<p class="session-help">در حال دریافت…</p>');const generation=featureGeneration;
    await loadProfile();if(generation!==featureGeneration||!currentUser)return;
    showFeature('تنظیمات',`<div class="settings-account"><div class="avatar">${avatarHtml(profile.avatar,currentUser.displayName)}</div><div><h4>${escapeHtml(currentUser.displayName)}</h4><p dir="ltr">@${escapeHtml(currentUser.username)}</p>${profile.about?`<p class="settings-about">${escapeHtml(profile.about)}</p>`:''}</div></div>`);
    byId('settings-navigation').hidden=false;
  }
  for(const section of ['profile','appearance','notifications','password'])byId('settings-'+section).addEventListener('click',()=>editSettings(section).catch(featureError));
  byId('settings-blocks').addEventListener('click',()=>showBlocks().catch(featureError));
  byId('settings-admin').addEventListener('click',()=>serviceSettings().catch(featureError));
  extras=window.WihmExtras?.create({api,post,show:showFeature,error:featureError,escape:escapeHtml,profile:()=>profile,generation:()=>featureGeneration,startChat:openSecure});
  byId('settings-discovery')?.addEventListener('click',()=>extras?.discovery().catch(featureError));
  byId('settings-security')?.addEventListener('click',()=>window.WihmSecurity.create({api,post,show:showFeature,error:featureError,escape:escapeHtml,profile:()=>profile,generation:()=>featureGeneration}).open().catch(featureError));
  byId('settings-secure')?.addEventListener('click',()=>openSecure());
  byId('settings-channels')?.addEventListener('click',()=>window.WihmChannels.open({api,post,show:showFeature,error:featureError,escape:escapeHtml,user:()=>currentUser}).catch(featureError));
  byId('settings-federation')?.addEventListener('click',async()=>{try{
    const data=await api('/api/service/federation');
    showFeature('اتصال سرورهای امن',`<p class="session-help">سرورها از طریق HTTPS به‌صورت خودکار متصل و کلید نخستین اتصال ثبت می‌شود. فهرست زیر فقط برای ثبت دستی کلیدهای مورد اعتماد مدیر است و برای گفتگو لازم نیست. تأیید اثرانگشت دستگاه مخاطب همچنان لازم است.</p><label>کلید عمومی این سرور<input id="federation-own-key" class="form-input" dir="ltr" readonly value="${escapeHtml(data.publicKey)}"></label><form id="federation-form" class="feature-form"><label><input id="federation-enabled" type="checkbox" ${data.enabled?'checked':''}> اجازهٔ پیام رمز‌شده بین سرورها</label><div id="federation-peers">${[...Object.entries(data.peers),['','']].map(([host,key])=>`<div class="field-pair"><label>نام دامنهٔ سرور<input class="form-input peer-host" dir="ltr" value="${escapeHtml(host)}" placeholder="chat.account.workers.dev"></label><label>کلید عمومی همان سرور<input class="form-input peer-key" dir="ltr" value="${escapeHtml(key)}"></label></div>`).join('')}</div><button class="btn-primary">ذخیرهٔ سرورهای مجاز</button></form>`);
    bind('federation-form',async()=>{const hosts=[...byId('federation-peers').querySelectorAll('.peer-host')],keys=[...byId('federation-peers').querySelectorAll('.peer-key')],peers={};hosts.forEach((host,i)=>{if(host.value.trim())peers[host.value.trim().toLowerCase()]=keys[i].value.trim();});await api('/api/service/federation',{method:'PATCH',body:JSON.stringify({enabled:byId('federation-enabled').checked,origin:data.origin,peers})});byId('feature-status').textContent='تنظیمات ذخیره شد؛ برای افزودن سرور دیگر دوباره این صفحه را باز کنید.';},'submit');
  }catch(error){featureError(error);}});
  byId('settings-backup')?.addEventListener('click',()=>window.WihmBackup.open({api,post,show:showFeature,error:featureError,escape:escapeHtml,generation:()=>featureGeneration}).catch(featureError));
  byId('btn-passkey-login')?.addEventListener('click',async()=>{try{const result=await window.WihmSecurity.login(post,inputUsername.value);token=result.token;currentUser=result.user;localStorage.setItem('cf_msg_token',token);localStorage.setItem('cf_msg_user',JSON.stringify(currentUser));setupUserSession();}catch(error){authError.textContent=error.message;authError.style.display='block';}});
  let incomingRequest = false;
  async function checkIncomingCalls() {
    if (!token || !calls || incomingRequest) return;
    incomingRequest = true; const session = token, ringingId = calls.ringingId();
    try {
      const events = await api('/api/calls/incoming'); if (token !== session) return;
      const incoming = events.find(event => chats.some(chat => chat.id === event.chatId));
      if (incoming && !calls.active()) await calls.receive(incoming);
      else if (ringingId && calls.ringingId() === ringingId && !events.some(event => event.callId === ringingId)) calls.reset(false);
    } catch (error) { console.warn('Incoming calls:', error.message); }
    finally { incomingRequest = false; }
  }
  async function activateCall(chatId) {
    const chat = chats.find(chat => chat.id === chatId); if (!chat || chat.blocked) throw Error('گفتگو در دسترس نیست.');
    if (activeChat?.id !== chatId) await openChat(chat, true);
    const socket = ws; if (!socket) throw Error('اتصال گفتگو برقرار نیست.');
    if (socket.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      const finish = error => { clearTimeout(timer); socket.removeEventListener('open', ready); socket.removeEventListener('close', failed); error ? reject(error) : resolve(); };
      const ready = () => finish(), failed = () => finish(Error('اتصال گفتگو برقرار نشد.'));
      const timer = setTimeout(failed, 10000); socket.addEventListener('open', ready, { once: true }); socket.addEventListener('close', failed, { once: true });
    });
  }
  const callMount=document.querySelector('.chat-header');if(callMount&&window.WihmCalls)calls=window.WihmCalls.create({getChat:id=>id?chats.find(chat=>chat.id===id):activeChat,getUser:()=>currentUser,activate:activateCall,getIceServers:async(chatId,callId)=>(await post('/api/calls/ice',{chatId,callId})).iceServers,send:data=>{
    if((data.kind==='decline'||data.kind==='end')&&(activeChat?.id!==data.chatId||ws?.readyState!==WebSocket.OPEN)){post('/api/calls/'+data.kind,{chatId:data.chatId,callId:data.callId}).catch(error=>{chatError.textContent=error.message;});return;}
    if(!ws||ws.readyState!==WebSocket.OPEN||activeChat?.id!==data.chatId)throw Error('اتصال گفتگو برقرار نیست.');ws.send(JSON.stringify(data));
  },mount:callMount,notify:message=>chatError.textContent=message});
  media=window.WihmMedia?.create({footer:document.querySelector('.chat-input-area'),sendButton:btnSendMessage,getChat:()=>activeChat,notify:message=>chatError.textContent=message,
    canRecord:()=>{if(!activeChat)return false;if(deniedChats.has(activeChat.id)){chatError.textContent='دسترسی ارسال در این گفتگو بسته است.';return false;}if(composerContext?.mode==='edit'){chatError.textContent='ابتدا ویرایش پیام را تمام یا لغو کنید.';return false;}chatError.textContent='';return true;},
    upload:async(blob,item)=>{
      const query=new URLSearchParams({kind:item.kind,mime:item.mime,durationMs:String(item.durationMs),clientMsgId:item.clientMsgId});
      if(composerContext?.mode==='reply'&&activeChat?.id===item.chatId)query.set('replyToId',composerContext.message.id);
      const response=await fetch(`/api/chats/${item.chatId}/media?${query}`,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':item.mime},body:blob});
      const data=await response.json().catch(()=>null);
      if(!response.ok)throw Error(data?.error||'ارسال پیام انجام نشد؛ دوباره تلاش کنید.');
      if(composerContext?.mode==='reply'&&activeChat?.id===item.chatId)cancelComposer();
      acceptMutation(data.message);
    },
    download:async msg=>{
      const response=await fetch(`/api/chats/${msg.chatId}/media/${msg.id}`,{headers:{Authorization:'Bearer '+token}});
      if(!response.ok)throw Error((await response.json().catch(()=>null))?.error||'دریافت پیام ممکن نشد.');
      return response.blob();
    }});
  byId('settings-updates')?.addEventListener('click',()=>extras?.updates().catch(featureError));
  byId('settings-telegram')?.addEventListener('click',()=>extras?.botSettings().catch(featureError));
  byId('settings-server')?.addEventListener('click',()=>{closeFeature();if(window.Android&&window.Android.openServerSettings){window.Android.openServerSettings();}else{alert('نشانی سرور متصل فعلی: '+location.origin);}});
  byId('btn-menu-server')?.addEventListener('click',()=>{closeMainMenu();if(window.Android&&window.Android.openServerSettings){window.Android.openServerSettings();}else{alert('نشانی سرور متصل فعلی: '+location.origin);}});
  byId('btn-auth-change-server')?.addEventListener('click',()=>{if(window.Android&&window.Android.openServerSettings){window.Android.openServerSettings();}else{alert('نشانی سرور متصل فعلی: '+location.origin);}});
  byId('btn-channels')?.addEventListener('click',()=>{closeMainMenu();extras?.channels().catch(featureError);});
  async function loadProfile() {
    const sessionToken=token, row=await api('/api/profile'); if(!row||sessionToken!==token) return;
    profile=row; currentUser.displayName=row.displayName || currentUser.displayName;
    extras?.notice(row).catch(()=>{});
    userDisplayName.textContent=currentUser.displayName; userAvatar.innerHTML=avatarHtml(row.avatar,currentUser.displayName);
    localStorage.setItem('cf_msg_user',JSON.stringify(currentUser)); applyAppearance(row.theme||'dark',row.font_size||'normal');
  }
  function applyAppearance(theme,size) {
    const light=theme==='light'||(theme==='system'&&window.matchMedia?.('(prefers-color-scheme: light)').matches);
    if(document.documentElement?.dataset) { document.documentElement.dataset.theme=light?'light':'dark'; document.documentElement.dataset.fontSize=size; }
  }
  window.matchMedia?.('(prefers-color-scheme: light)').addEventListener?.('change',()=>applyAppearance(profile.theme,profile.font_size));
  byId('btn-settings').addEventListener('click',()=>{closeMainMenu();settings().catch(featureError);});
  byId('btn-settings-back').addEventListener('click',()=>settings().catch(featureError));
  async function editSettings(section='profile') {
    showFeature('تنظیمات','<p class="session-help">در حال دریافت…</p>'); const generation=featureGeneration;
    await loadProfile(); if(generation!==featureGeneration) return;
    avatarDraft=profile.avatar||'';
    const isAndroid = !!window.Android;
    const notificationSectionHtml = isAndroid ? `
      <section class="feature-section notification-controls">
        <h4>تنظیمات اعلان و فعالیت در پس‌زمینه</h4>
        <p class="session-help">برای دریافت آنی پیام‌ها حتی زمانی که اپلیکیشن کاملاً بسته است یا گوشی به خواب می‌رود (Doze Mode)، موارد زیر را فعال کنید.</p>
        <div style="margin-top: 10px; margin-bottom: 12px;">
          <label class="check-label" style="cursor: pointer; display: flex; align-items: center; gap: 8px;">
            <input id="android-keep-alive" type="checkbox" ${window.Android.isKeepAliveEnabled?.() ? 'checked' : ''}>
            <span><strong>سرویس زنده در پس‌زمینه (Keep-Alive Service)</strong></span>
          </label>
          <p class="session-help" style="margin-top: 4px; margin-right: 24px;">سرویس بومی اندروید در پس‌زمینه فعال مانده و به محض ارسال پیام توسط دیگران، اعلان می‌دهد.</p>
        </div>
        <div class="button-row" style="margin-top: 10px;">
          <button id="android-battery-opt" class="quiet-button" type="button">${window.Android.isBatteryOptimizationIgnored?.() ? '✓ باتری: بدون محدودیت' : '⚡ غیرفعال‌سازی محدودیت باتری'}</button>
          <button id="android-autostart" class="quiet-button" type="button">🚀 تنظیمات شروع خودکار (Autostart)</button>
          <button id="android-test-notif" class="quiet-button" type="button">🔔 آزمایش اعلان دستگاه</button>
        </div>
        <p id="android-power-status" class="session-help" style="margin-top: 8px;">
          ${window.Android.isBatteryOptimizationIgnored?.() ? 'محدودیت باتری اندروید برای ابرانه برداشته شده است.' : 'توجه: برای دریافت پیام در حالت خاموش بودن صفحه، دکمه «غیرفعال‌سازی محدودیت باتری» را بزنید و مجاز کنید.'}
        </p>
      </section>
    ` : `
      <section class="feature-section notification-controls"><h4>اعلان این دستگاه</h4><p class="session-help">اعلان به اجازهٔ مرورگر و اتصال به سرویس اعلان آن وابسته است. در آیفون و آیپد، iOS 16.4 یا جدیدتر و افزودن برنامه به صفحهٔ اصلی لازم است. ذخیرهٔ پیام به اعلان وابسته نیست.</p><div class="button-row"><button id="enable-notifications" class="quiet-button" type="button">فعال‌کردن اعلان</button><button id="test-notifications" class="quiet-button" type="button">آزمایش ارسال سرور</button><button id="test-local-notification" class="quiet-button" type="button">آزمایش نمایش دستگاه</button><button id="disable-notifications" class="quiet-button" type="button">قطع اعلان این دستگاه</button></div><p id="notification-state" class="session-help"></p></section>
    `;

    showFeature(({profile:'ویرایش پروفایل',appearance:'ظاهر و نوشته‌ها',notifications:'اعلان‌ها',password:'رمز عبور و امنیت'})[section],`
      <form id="profile-form" class="feature-form">
        <div class="settings-profile-fields"><div class="profile-picture"><div class="avatar" id="profile-avatar">${avatarHtml(avatarDraft,currentUser.displayName)}</div><label class="quiet-button">انتخاب عکس<input id="profile-file" type="file" accept="image/png,image/jpeg,image/webp" class="visually-hidden"></label><button id="remove-avatar" class="quiet-button" type="button">حذف عکس</button></div>
        <label>نام نمایشی<input id="profile-name" class="form-input" required maxlength="100" value="${escapeHtml(currentUser.displayName)}"></label>
        <label>دربارهٔ من<textarea id="profile-about" class="form-input" maxlength="300" rows="2">${escapeHtml(profile.about||'')}</textarea></label></div>
        <div class="field-pair settings-appearance-fields"><label>ظاهر<select id="profile-theme" class="form-input"><option value="dark">تیره</option><option value="light">روشن</option><option value="system">هماهنگ با دستگاه</option></select></label><label>اندازهٔ نوشته<select id="profile-font" class="form-input"><option value="small">کوچک</option><option value="normal">معمولی</option><option value="large">بزرگ</option></select></label></div>
        <div class="settings-notification-fields"><label class="check-label"><input id="profile-preview" type="checkbox" ${profile.notification_preview?'checked':''}>نمایش متن پیام در اعلان</label>
        <p class="session-help">با خاموش بودن این گزینه، اعلان فقط دریافت پیام تازه را نشان می‌دهد.</p></div>
        <button class="btn-primary" type="submit">ذخیرهٔ تنظیمات</button>
      </form>
      ${notificationSectionHtml}
      <section class="feature-section password-controls"><h4>تغییر رمز عبور</h4><form id="password-form" class="feature-form"><label>رمز فعلی<input id="password-current" class="form-input" type="password" autocomplete="current-password" required></label><label>کد دومرحله‌ای؛ اگر فعال است<input id="password-otp" class="form-input" autocomplete="one-time-code"></label><label>رمز تازه<input id="password-new" class="form-input" type="password" autocomplete="new-password" minlength="8" maxlength="1024" required></label><label>تکرار رمز تازه<input id="password-confirm" class="form-input" type="password" autocomplete="new-password" minlength="8" required></label><p class="session-help">پس از تغییر رمز، سایر دستگاه‌ها از حساب خارج می‌شوند.</p><button class="quiet-button" type="submit">تغییر رمز</button></form></section>
      `);
    featureContent.dataset.settingsPage=section;byId('btn-settings-back').hidden=false;
    byId('profile-theme').value=profile.theme||'dark'; byId('profile-font').value=profile.font_size||'normal';
    if(byId('notification-state'))byId('notification-state').textContent=!('Notification' in window&&'PushManager' in window&&'serviceWorker' in navigator)?'این مرورگر اعلان پس‌زمینه را پشتیبانی نمی‌کند.':!profile.pushConfigured?'کلید اعلان سرور تنظیم نیست؛ نصب‌کنندهٔ جدید را با همان نام اجرا کنید.':`اجازهٔ مرورگر: ${{granted:'فعال',denied:'مسدود؛ از تنظیمات مرورگر باز کنید',default:'هنوز درخواست نشده'}[Notification.permission]}`;
    bind('profile-file',async e=> {
      const file=e.target.files[0]; if(!file) return; if(file.size>8*1024*1024) throw new Error('عکس حداکثر ۸ مگابایت انتخاب کنید.');
      const bitmap=await createImageBitmap(file); const canvas=document.createElement('canvas'); canvas.width=canvas.height=96;
      const context=canvas.getContext('2d'), edge=Math.min(bitmap.width,bitmap.height); context.drawImage(bitmap,(bitmap.width-edge)/2,(bitmap.height-edge)/2,edge,edge,0,0,96,96); bitmap.close();
      avatarDraft=canvas.toDataURL('image/webp',.8); if(avatarDraft.length>48000) throw new Error('عکس کوچکتری انتخاب کنید.'); byId('profile-avatar').innerHTML=avatarHtml(avatarDraft,currentUser.displayName);
    },'change');
    bind('remove-avatar',()=>{avatarDraft='';byId('profile-avatar').innerHTML=avatarHtml('',currentUser.displayName);});
    bind('profile-form',async()=>{await saveProfile();byId('feature-status').textContent='تنظیمات ذخیره شد.';},'submit');
    bind('password-form',async()=>{if(byId('password-new').value!==byId('password-confirm').value) throw new Error('تکرار رمز تازه مطابقت ندارد.'); await post('/api/profile/password',{currentPassword:byId('password-current').value,newPassword:byId('password-new').value,otp:byId('password-otp')?.value||''}); byId('password-form').reset();byId('feature-status').textContent='رمز تغییر کرد؛ سایر دستگاه‌ها خارج شدند.';},'submit');
    if (isAndroid) {
      bind('android-keep-alive', e => {
        window.Android.setKeepAliveEnabled?.(e.target.checked);
      }, 'change');
      bind('android-battery-opt', () => {
        window.Android.requestIgnoreBatteryOptimization?.();
        setTimeout(() => {
          const ignored = window.Android.isBatteryOptimizationIgnored?.();
          const btn = byId('android-battery-opt');
          if (btn) btn.textContent = ignored ? '✓ باتری: بدون محدودیت' : '⚡ غیرفعال‌سازی محدودیت باتری';
          const status = byId('android-power-status');
          if (status) status.textContent = ignored ? 'محدودیت باتری اندروید برای ابرانه برداشته شده است.' : 'توجه: برای دریافت پیام در حالت خاموش بودن صفحه، دکمه «غیرفعال‌سازی محدودیت باتری» را بزنید و مجاز کنید.';
        }, 1000);
      });
      bind('android-autostart', () => {
        window.Android.openAutostartSettings?.();
      });
      bind('android-test-notif', () => {
        if (window.Android.showNotification) {
          window.Android.showNotification('آزمایش اعلان ابرانه', 'سرویس اعلان بومی فعال است و با موفقیت کار می‌کند.', '');
        }
      });
    } else {
      bind('test-notifications',async()=>{const result=await post('/api/push/test',{});byId('notification-state').textContent=result.message;});
      bind('test-local-notification',async()=>{if(Notification.permission!=='granted')throw new Error('ابتدا اعلان را فعال کنید.');const registration=await navigator.serviceWorker.ready;await registration.showNotification('آزمایش نمایش ابرانه',{body:'اگر این اعلان را می‌بینید، نمایش اعلان روی دستگاه فعال است.',tag:'wihm-local-test',icon:'/icon.svg',dir:'rtl'});byId('notification-state').textContent='این آزمایش فقط نمایش دستگاه را بررسی می‌کند؛ برای مسیر شبکه، آزمایش ارسال سرور را بزنید.';});
      bind('enable-notifications',enableNotifications); bind('disable-notifications',async()=>{ await api('/api/push',{method:'DELETE'}); const registration=await navigator.serviceWorker?.getRegistration(); const subscription=await registration?.pushManager?.getSubscription(); await subscription?.unsubscribe();byId('notification-state').textContent='اعلان این دستگاه قطع شد.'; });
    }

  }
  async function saveProfile(extra={}) {
    await patch('/api/profile',{displayName:byId('profile-name').value.trim(),about:byId('profile-about').value,avatar:avatarDraft,theme:byId('profile-theme').value,fontSize:byId('profile-font').value,notifications:!!profile.notifications,notificationPreview:byId('profile-preview').checked,...extra}); await loadProfile();
  }
  async function enableNotifications() {
    if(!('Notification' in window&&'PushManager' in window&&'serviceWorker' in navigator)) throw new Error('این مرورگر از اعلان پس‌زمینه پشتیبانی نمی‌کند.');
    if(!profile.pushConfigured) throw new Error('سرور را با نصب‌کنندهٔ جدید به‌روز کنید.');
    const permission=await Notification.requestPermission(); if(permission!=='granted') throw new Error('اجازهٔ اعلان داده نشد. می‌توانید آن را در تنظیمات مرورگر تغییر دهید.');
    const registration=await navigator.serviceWorker.ready;
    const bytes=Uint8Array.from(atob(profile.vapidPublicKey.replace(/-/g,'+').replace(/_/g,'/')),ch=>ch.charCodeAt(0));
    let subscription=await registration.pushManager.getSubscription();
    if(subscription?.options.applicationServerKey && Array.from(new Uint8Array(subscription.options.applicationServerKey)).join()!==Array.from(bytes).join()) {await subscription.unsubscribe();subscription=null;}
    subscription ||= await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:bytes});
    await saveProfile({notifications:true}); await post('/api/push',subscription.toJSON());
    byId('notification-state').textContent='اعلان این دستگاه فعال شد. یک پیام از حساب دیگر برای آزمایش بفرستید.';
  }
  function syncComposer() { messageInput.closest?.('.chat-input-area')?.classList.toggle('has-text',!!messageInput.value.trim()); }
  function cancelComposer() { composerContext=null; byId('composer-context').hidden=true; btnSendMessage.disabled=false; btnSendMessage.title='ارسال'; }
  byId('btn-cancel-context').addEventListener('click',()=>{if(composerContext?.mode==='edit') messageInput.value='';cancelComposer();syncComposer();messageInput.focus?.();});
  messageInput.addEventListener('input',syncComposer);
  // The round button jumps back to the newest message once the reader has scrolled away from it.
  const scrollDown=document.createElement('button');scrollDown.id='btn-scroll-bottom';scrollDown.type='button';scrollDown.className='scroll-bottom';scrollDown.hidden=true;scrollDown.title='رفتن به آخرین پیام';scrollDown.setAttribute('aria-label',scrollDown.title);scrollDown.innerHTML='<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
  scrollDown.addEventListener('click',()=>{messagesContainer.scrollTop=messagesContainer.scrollHeight;});messagesContainer.after?.(scrollDown);
  messagesContainer.addEventListener('scroll',()=>{scrollDown.hidden=nearBottom();},{passive:true});
  function setComposer(mode,msg) { if(messageInput.value.trim()&&!confirm('متن فعلی کادر کنار گذاشته شود؟')) return; composerContext={mode,message:msg}; byId('composer-label').textContent=`${mode==='edit'?'ویرایش پیام':'پاسخ به '+msg.senderName}: ${msg.text.slice(0,120)}`;byId('composer-context').hidden=false;messageInput.value=mode==='edit'?msg.text:'';syncComposer();btnSendMessage.title=mode==='edit'?'ذخیرهٔ ویرایش':'ارسال';closeFeature();messageInput.focus?.(); }
  async function commitEdit(text) {
    const context=composerContext,chatId=activeChat.id; btnSendMessage.disabled=true;
    try { const result=await post(`/api/chats/${chatId}/messages/${context.message.id}/edit`,{text});acceptMutation(result.message); if(composerContext===context) {cancelComposer();messageInput.value='';syncComposer();} }
    catch(error) {chatError.textContent=error.message;}
    finally {btnSendMessage.disabled=false;}
  }
  function acceptMutation(message) {
    if(!message?.chatId) return; const id=message.chatId;
    messagesByChat[id]=mergeMessages(messagesByChat[id]||[],[message]);
    const latest=messagesByChat[id].find(row=>row.id===message.id);if(!latest)return;
    for(const row of messagesByChat[id]) if(row.replyToId===latest.id) row.replyTo={id:latest.id,senderName:latest.senderName,text:latest.deletedAt?'':latest.text,deleted:!!latest.deletedAt};
    const chat=chats.find(chat=>chat.id===id); if(chat?.lastMessage?.id===latest.id) chat.lastMessage={...latest,text:latest.deletedAt?'پیام حذف شده':latest.text};
    if(activeChat?.id===id) {renderMessages(messagesByChat[id],{keepPosition:true});renderPin(id);}
    renderFilteredChats();
  }
  function addMessageControls(bubble,msg) {
    const button=document.createElement('button');button.type='button';button.className='message-more';button.innerHTML=uiIcon('more');button.title='گزینه‌های پیام';button.setAttribute?.('aria-label','گزینه‌های پیام');button.addEventListener('click',()=>messageActions(msg));bubble.appendChild(button);
    bubble.addEventListener?.('contextmenu',event=>{if(window.getSelection?.()?.toString()||event.target.closest?.('a,input,audio,video'))return;event.preventDefault();messageActions(msg);});
    bubble.querySelector?.('.reply-quote')?.addEventListener('click',()=>jumpToMessage(msg.chatId,msg.replyTo.id).catch(error=>{chatError.textContent=error.message;}));
    bubble.querySelectorAll?.('[data-emoji]').forEach(button=>button.addEventListener('click',()=>react(msg,button.dataset.emoji).catch(error=>{chatError.textContent=error.message;})));
  }
  async function mutate(msg,action,body={}) { const result=await post(`/api/chats/${msg.chatId}/messages/${msg.id}/${action}`,body);if(result.message) acceptMutation(result.message);return result; }
  async function react(msg,emoji) { const previous=msg.reactions?.find(row=>row.users.includes(currentUser.id));await mutate(msg,'reaction',{emoji:previous?.emoji===emoji?'':emoji}); }
  function messageActions(msg) {
    const chat=chats.find(chat=>chat.id===msg.chatId)||activeChat, own=msg.senderId===currentUser.id;
    showFeature('گزینه‌های پیام',`<p class="action-preview">${escapeHtml(msg.deletedAt?'پیام حذف شده':msg.text.slice(0,240))}</p><div class="action-grid">
      ${!msg.deletedAt?`<button id="action-reply" class="quiet-button">پاسخ</button>${own&&!msg.media?'<button id="action-edit" class="quiet-button">ویرایش</button>':''}<button id="action-save" class="quiet-button">ذخیرهٔ پیام</button><button id="action-copy" class="quiet-button">کپی متن</button>${chat?.type==='dm'||isManager(chat)?'<button id="action-pin" class="quiet-button">سنجاق / برداشتن سنجاق</button>':''}`:''}
      <button id="action-hide" class="quiet-button">حذف فقط برای من</button>${own||chat?.type==='group'&&isManager(chat)?'<button id="action-delete" class="quiet-button danger-text">حذف برای همه</button>':''}${!own?'<button id="action-report" class="quiet-button danger-text">گزارش پیام</button>':''}</div>
      ${!msg.deletedAt?`<p class="session-help">واکنش شما؛ انتخاب دوباره برای برداشتن</p><div class="emoji-picker">${['👍','❤️','😂','😮','😢','🙏'].map((emoji,i)=>`<button id="react-${i}" class="quiet-button" aria-label="واکنش ${emoji}">${emoji}</button>`).join('')}</div>`:''}`);
    bind('action-reply',()=>setComposer('reply',msg));bind('action-edit',()=>setComposer('edit',msg));
    bind('action-copy',async()=>{await navigator.clipboard.writeText(msg.text);byId('feature-status').textContent='متن کپی شد.';});
    bind('action-save',async()=>{await mutate(msg,'save');byId('feature-status').textContent='در پیام‌های ذخیره‌شده قرار گرفت.';});
    bind('action-hide',async()=>{if(!confirm('این پیام فقط برای حساب شما پنهان شود؟ مخاطب همچنان آن را می‌بیند.'))return;await mutate(msg,'hide');const hidden=hiddenMessages.get(msg.chatId)||new Set();hidden.add(msg.id);hiddenMessages.set(msg.chatId,hidden);messagesByChat[msg.chatId]=(messagesByChat[msg.chatId]||[]).filter(row=>row.id!==msg.id);renderMessages(messagesByChat[msg.chatId],{keepPosition:true});closeFeature();await loadChats(true);});
    bind('action-delete',async()=>{if(!confirm('متن این پیام برای همه حذف شود؟ این کار برگشت‌پذیر نیست.'))return;await mutate(msg,'delete');closeFeature();});
    bind('action-pin',async()=>{const details=await api(`/api/chats/${msg.chatId}/details`);await mutate(msg,'pin',{pinned:details.pinnedMessageId!==msg.id});await loadChatDetails(msg.chatId);closeFeature();});
    bind('action-report',()=>reportForm(msg.senderId,msg));
    ['👍','❤️','😂','😮','😢','🙏'].forEach((emoji,i)=>bind('react-'+i,async()=>{await react(msg,emoji);closeFeature();}));
  }
  function denyChat(chatId,reload=true) {
    if(!chatId)return;deniedChats.add(chatId);
    for(const item of outbox.filter(row=>row.chatId===chatId)) {item.failed=true;addPending(item);}saveOutbox();
    const background=backgroundSockets.get(chatId);if(background){background.onclose=null;background.close();backgroundSockets.delete(chatId);}
    if(activeChat?.id===chatId) {disconnectWebSocket();statusText.textContent='دسترسی گفتگو بسته است';chatError.textContent='عضویت شما یا امکان ارتباط با این مخاطب تغییر کرده است. از اطلاعات گفتگو وضعیت را بررسی کنید.';}
    if(reload) loadChats();
  }
  async function loadChatDetails(chatId) {
    const sessionToken=token,details=await api(`/api/chats/${chatId}/details`);if(!details?.type||token!==sessionToken)return;
    chatDetails.set(chatId,details);hiddenMessages.set(chatId,new Set(details.hidden||[]));
    if(messagesByChat[chatId]) messagesByChat[chatId]=mergeMessages(messagesByChat[chatId],[]);
    if(details.blocked) deniedChats.add(chatId);else deniedChats.delete(chatId);
    if(activeChat?.id===chatId) {activeChat.role=details.role;btnAddMembers.style.display=details.type==='group'&&isManager(details)?'inline-flex':'none';renderPin(chatId);renderMessages(messagesByChat[chatId]||[],{keepPosition:true});}
    return details;
  }
  async function refreshLoadedMessages(chatId) {
    const sessionToken=token,ids=(messagesByChat[chatId]||[]).filter(row=>!row.pending).map(row=>row.id);
    await loadChatDetails(chatId);
    for(let offset=0;offset<ids.length;offset+=100) {
      const rows=await post(`/api/chats/${chatId}/changes`,{ids:ids.slice(offset,offset+100)});
      if(token!==sessionToken)return;for(const row of rows)acceptMutation(row);
    }
  }
  function renderPin(chatId) {
    if(activeChat?.id!==chatId)return;const pin=chatDetails.get(chatId)?.pinnedMessageId, msg=messagesByChat[chatId]?.find(m=>m.id===pin),button=byId('btn-pinned-message');
    button.hidden=!pin||!!hiddenMessages.get(chatId)?.has(pin);button.textContent=pin?`⌖ پیام سنجاق‌شده · ${msg?(msg.deletedAt?'پیام حذف شده':msg.text.slice(0,90)):'نمایش پیام'}`:'';
  }
  byId('btn-pinned-message').addEventListener('click',()=>{if(activeChat)jumpToMessage(activeChat.id,chatDetails.get(activeChat.id)?.pinnedMessageId).catch(error=>{chatError.textContent=error.message;});});
  byId('btn-chat-details').addEventListener('click',()=>{if(activeChat)detailsView(activeChat.id).catch(featureError);});
  byId('btn-archive').addEventListener('click',()=>setArchivedView(!archivedView));
  byId('btn-saved').addEventListener('click',()=>savedView().catch(featureError));
  async function detailsView(chatId) {
    showFeature('اطلاعات گفتگو','<p>در حال دریافت…</p>');const generation=featureGeneration,details=await loadChatDetails(chatId);if(generation!==featureGeneration)return;
    const chat=chats.find(row=>row.id===chatId)||activeChat; if(!chat||!details)return;
    const group=details.type==='group',manage=isManager(details),owner=details.role==='owner';
    const blocks=group?[]:await api('/api/blocks'),ownBlock=blocks.some(row=>row.id===chat.partnerId);
    showFeature(chat.title,`<div class="button-row"><button id="pref-archive" class="quiet-button">${chat.archived?'خارج‌کردن از آرشیو':'آرشیو گفتگو'}</button><button id="pref-mute" class="quiet-button">${chat.muted?'روشن‌کردن اعلان':'بی‌صدا کردن'}</button><button id="pref-pin" class="quiet-button">${chat.pinned?'برداشتن سنجاق گفتگو':'سنجاق گفتگو'}</button></div>
      ${group?`<p class="session-help">نقش شما: ${roleName(details.role)} · ${details.members.length.toLocaleString('fa-IR')} عضو</p>${manage?'<button id="group-add-members" class="quiet-button" type="button">افزودن عضو</button><form id="rename-form" class="feature-form"><label>نام گروه<input id="rename-title" class="form-input" required maxlength="100"></label><button class="quiet-button" type="submit">ذخیرهٔ نام گروه</button></form><button id="group-invites" class="quiet-button">دعوت‌نامه‌های گروه</button>':''}<section class="feature-section"><h4>اعضا</h4><div id="group-member-list">${details.members.map((member,i)=>`<div class="member-row"><div class="avatar">${avatarHtml(member.avatar,member.displayName)}</div><div class="member-name"><strong>${escapeHtml(member.displayName)}</strong><small dir="ltr">@${escapeHtml(member.username)}</small><small>${roleName(member.role)}</small></div><div class="member-actions">${member.id!==currentUser.id&&member.role!=='owner'&&manage?`${owner?`<button id="member-role-${i}" class="quiet-button">${member.role==='admin'?'عضو عادی':'مدیر شود'}</button><button id="member-transfer-${i}" class="quiet-button">انتقال مالکیت</button>`:''}${owner||member.role==='member'?`<button id="member-remove-${i}" class="quiet-button danger-text">حذف عضو</button>`:''}`:''}</div></div>`).join('')}</div></section><button id="leave-group" class="quiet-button danger-text">خروج از گروه</button><p class="session-help">مالک باید پیش از خروج مالکیت را به یکی از اعضا منتقل کند. حذف عضو، دسترسی او به تاریخچهٔ سرور و اتصال زنده را قطع می‌کند؛ نسخهٔ کپی‌شده روی دستگاه او قابل پس‌گرفتن نیست.</p>`:`<div class="feature-section">${details.members.filter(m=>m.id!==currentUser.id).map(m=>`<p><strong>${escapeHtml(m.displayName)}</strong> <bdi>@${escapeHtml(m.username)}</bdi></p><p class="session-help">${escapeHtml(m.about||'')}</p>`).join('')}<p class="session-help">مسدودکردن، پیام خصوصی را از هر دو سمت می‌بندد و روی گروه مشترک اثر ندارد.</p><div class="button-row"><button id="block-user" class="quiet-button danger-text">${ownBlock?'رفع مسدودیت':'مسدودکردن مخاطب'}</button><button id="report-user" class="quiet-button danger-text">گزارش مزاحمت</button></div></div>`}`);
    for(const [id,key] of [['pref-archive','archived'],['pref-mute','muted'],['pref-pin','pinned']]) bind(id,async()=>{await patch(`/api/chats/${chatId}/preferences`,{[key]:!chat[key]});await loadChats(true);await detailsView(chatId);});
    if(group) {
      if(manage) {bind('group-add-members',()=>{closeFeature();btnAddMembers.click();});byId('rename-title').value=chat.title;bind('rename-form',async()=>{await patch(`/api/chats/${chatId}/group`,{action:'rename',title:byId('rename-title').value});await loadChats(true);activeChatTitle.textContent=chats.find(c=>c.id===chatId)?.title||chat.title;byId('feature-status').textContent='نام گروه ذخیره شد.';},'submit');bind('group-invites',()=>invitesView(chatId));}
      details.members.forEach((member,i)=>{
        bind('member-role-'+i,async()=>{await patch(`/api/chats/${chatId}/group`,{action:'role',userId:member.id,role:member.role==='admin'?'member':'admin'});await detailsView(chatId);});
        bind('member-transfer-'+i,async()=>{if(!confirm(`مالکیت به «${member.displayName}» منتقل شود؟ شما مدیر می‌مانید و دیگر نمی‌توانید مالک را حذف کنید.`))return;await patch(`/api/chats/${chatId}/group`,{action:'transfer',userId:member.id});await loadChats(true);await detailsView(chatId);});
        bind('member-remove-'+i,async()=>{if(!confirm(`«${member.displayName}» از گروه حذف شود؟`))return;await patch(`/api/chats/${chatId}/group`,{action:'remove',userId:member.id});await detailsView(chatId);});
      });
      bind('leave-group',async()=>{if(!confirm('از گروه خارج می‌شوید؟ دسترسی شما به تاریخچهٔ گروه هم قطع می‌شود.'))return;await post(`/api/chats/${chatId}/leave`);denyChat(chatId);activeChat=null;activeChatWrapper.style.display='none';emptyState.style.display='flex';sidebar.classList.remove('hidden');closeFeature();await loadChats(true);});
    } else {
      bind('block-user',async()=>{if(!ownBlock&&!confirm('پیام خصوصی با این مخاطب مسدود شود؟'))return;await api('/api/blocks',{method:ownBlock?'DELETE':'POST',body:JSON.stringify({userId:chat.partnerId})});if(ownBlock){deniedChats.delete(chatId);connectWebSocket(chatId);}else denyChat(chatId);await loadChats(true);await detailsView(chatId);});
      bind('report-user',()=>reportForm(chat.partnerId));
    }
  }
  async function showBlocks() {
    const rows=await api('/api/blocks');showFeature('افراد مسدودشده',rows.length?rows.map((row,i)=>`<div class="member-row"><span class="member-name">${escapeHtml(row.displayName)} <bdi>@${escapeHtml(row.username)}</bdi></span><button id="unblock-${i}" class="quiet-button">رفع مسدودیت</button></div>`).join(''):'<p class="session-help">کسی را مسدود نکرده‌اید.</p>');
    rows.forEach((row,i)=>bind('unblock-'+i,async()=>{await api('/api/blocks',{method:'DELETE',body:JSON.stringify({userId:row.id})});await loadChats(true);await showBlocks();}));
  }
  function reportForm(userId,msg) {showFeature('گزارش مزاحمت',`<form id="report-form" class="feature-form"><p class="session-help">گزارش برای مدیر این سرویس ارسال می‌شود.${msg?' متن همین پیام هم همراه گزارش است.':''}</p><label>توضیح<textarea id="report-reason" class="form-input" rows="4" minlength="3" maxlength="1000" required></textarea></label><button class="btn-primary" type="submit">فرستادن گزارش</button></form>`);bind('report-form',async()=>{await post('/api/reports',{userId,reason:byId('report-reason').value,...(msg?{chatId:msg.chatId,messageId:msg.id}:{})});byId('feature-status').textContent='گزارش ثبت شد.';byId('report-form').hidden=true;},'submit');}
  const dateLabel = value => new Date(value).toLocaleString('fa-IR');
  async function invitesView(chatId=null) {
    const path=chatId?`/api/chats/${chatId}/invites`:'/api/service/invites',rows=await api(path);
    showFeature(chatId?'دعوت‌نامه‌های گروه':'دعوت‌نامه‌های ثبت‌نام',`<form id="invite-form" class="feature-form"><p class="session-help">لینک فقط یک بار نمایش داده می‌شود؛ آن را کپی کنید. دعوت گروه به حساب موجود نیاز دارد و جای دعوت ثبت‌نام را نمی‌گیرد.</p><div class="field-pair"><label>اعتبار<select id="invite-hours" class="form-input"><option value="24">یک روز</option><option value="1">یک ساعت</option><option value="168">یک هفته</option></select></label><label>تعداد استفاده<input id="invite-uses" class="form-input" type="number" min="1" max="1000" value="10" required></label></div><button class="btn-primary" type="submit">ساخت لینک دعوت</button></form><div id="created-invite" class="feature-section" hidden><label>لینک دعوت<input id="invite-link" class="form-input" readonly dir="ltr"></label><button id="copy-invite" class="quiet-button">کپی لینک</button></div><section class="feature-section"><h4>دعوت‌های قبلی</h4>${rows.length?rows.map((row,i)=>`<div class="invite-row"><p>${row.revokedAt?'لغوشده':row.expiresAt<=Date.now()?'منقضی':row.uses>=row.useLimit?'مصرف‌شده':'فعال'} · ${row.uses}/${row.useLimit}<small>انقضا: ${dateLabel(row.expiresAt)}</small></p>${!row.revokedAt?`<button id="revoke-invite-${i}" class="quiet-button danger-text">لغو</button>`:''}</div>`).join(''):'<p class="session-help">هنوز دعوتی نساخته‌اید.</p>'}</section>`);
    bind('invite-form',async()=>{const result=await post(path,{hours:Number(byId('invite-hours').value),uses:Number(byId('invite-uses').value)});byId('created-invite').hidden=false;byId('invite-link').value=location.origin+'/#'+(chatId?'join=':'register=')+result.token;byId('invite-link').select();byId('feature-status').textContent='لینک ساخته شد؛ پیش از بستن پنجره کپی کنید.';},'submit');
    bind('copy-invite',async()=>{await navigator.clipboard.writeText(byId('invite-link').value);byId('feature-status').textContent='لینک دعوت کپی شد.';});
    rows.forEach((row,i)=>bind('revoke-invite-'+i,async()=>{if(!confirm('این دعوت‌نامه لغو شود؟'))return;await api(path,{method:'DELETE',body:JSON.stringify({id:row.id})});await invitesView(chatId);}));
  }
  async function serviceSettings() {
    await loadProfile();
    if(!profile.isServiceAdmin) {
      showFeature('مدیریت سرویس',profile.adminConfigured?'<p class="session-help">مدیر این سرویس قبلاً تعیین شده است. با حساب مدیر وارد شوید.</p>':'<form id="claim-form" class="feature-form"><p class="session-help">صاحب سرویس می‌تواند با کد نمایش‌داده‌شده در پایان نصب، حساب خودش را مدیر کند. اگر کد را ندارید نصب‌کنندهٔ جدید را با همان حساب کلادفلر و همان نام اجرا کنید.</p><label>کد مدیریت<input id="claim-code" class="form-input" dir="ltr" autocomplete="off" required></label><button class="btn-primary" type="submit">فعال‌سازی مدیریت این حساب</button></form>');
      bind('claim-form',async()=>{await post('/api/service/claim',{code:byId('claim-code').value.trim()});await serviceSettings();},'submit');return;
    }
    const settings=await api('/api/service/settings');
    showFeature('مدیریت سرویس',`<form id="service-form" class="feature-form"><label>ثبت‌نام<select id="registration-mode" class="form-input"><option value="open">آزاد؛ همه می‌توانند حساب بسازند</option><option value="invite">فقط با دعوت‌نامهٔ ثبت‌نام</option><option value="closed">بسته؛ فقط ورود حساب‌های موجود</option></select></label><button class="btn-primary" type="submit">ذخیرهٔ وضعیت ثبت‌نام</button></form><div class="button-row feature-section"><button id="service-overview" class="quiet-button">وضعیت و مدیریت کاربران</button><button id="registration-invites" class="quiet-button">دعوت‌نامه‌های ثبت‌نام</button><button id="service-reports" class="quiet-button">گزارش‌های مزاحمت</button></div><p class="session-help">مدیر سرویس به پایگاه داده دسترسی دارد؛ این نسخه رمزگذاری سرتاسری ندارد.</p>`);
    byId('registration-mode').value=settings.registration;
    const callSettings = document.createElement('button'); callSettings.id = 'service-call-settings'; callSettings.type = 'button'; callSettings.className = 'quiet-button'; callSettings.textContent = 'تنظیم اتصال تماس (TURN)';
    byId('service-form').after(callSettings); callSettings.addEventListener('click', () => turnSettings().catch(featureError));
    bind('service-overview',()=>extras?.management());
    bind('service-form',async()=>{await patch('/api/service/settings',{registration:byId('registration-mode').value});byId('feature-status').textContent='وضعیت ثبت‌نام ذخیره شد.';},'submit');bind('registration-invites',()=>invitesView());
    bind('service-reports',async()=>{const rows=await api('/api/service/reports');showFeature('گزارش‌های مزاحمت',rows.length?rows.map((row,i)=>`<section class="feature-section"><p><bdi>@${escapeHtml(row.reporter)}</bdi> ← <bdi>@${escapeHtml(row.target)}</bdi></p><p>${escapeHtml(row.reason)}</p>${row.snapshot?`<blockquote class="action-preview">${escapeHtml(row.snapshot)}</blockquote>`:''}<p class="session-help">${dateLabel(row.created_at)} · ${row.status==='resolved'?'بررسی‌شده':'باز'}</p><button id="resolve-report-${i}" class="quiet-button">${row.status==='resolved'?'باز کردن دوباره':'علامت بررسی‌شده'}</button></section>`).join(''):'<p class="session-help">گزارشی ثبت نشده است.</p>');rows.forEach((row,i)=>bind('resolve-report-'+i,async()=>{await patch('/api/service/reports',{id:row.id,status:row.status==='resolved'?'open':'resolved'});byId('resolve-report-'+i).disabled=true;byId('feature-status').textContent='وضعیت گزارش تغییر کرد.';}));});
  }
  async function turnSettings() {
    const config = await api('/api/service/calls');
    showFeature('اتصال تماس در شبکه‌های محدود', `<p class="session-help">${config.configured?'واسط TURN فعال است. برای تعویض، کلید جدید وارد کنید.':'فعلاً تماس مستقیم فعال است؛ اینترنت موبایل و بعضی شبکه‌ها به TURN نیاز دارند.'} کلید را از بخش Realtime ← TURN در حساب Cloudflare خود بسازید. مصرف این سرویس تابع تعرفهٔ کلادفلر است.</p><a href="https://dash.cloudflare.com/?to=/:account/realtime/turn" target="_blank" rel="noopener noreferrer">باز کردن بخش TURN در کلادفلر</a><form id="turn-form" class="feature-form"><label>TURN Key ID<input id="turn-key-id" class="form-input" dir="ltr" maxlength="128" value="${escapeHtml(config.keyId)}" required></label><label>API Token همان کلید<input id="turn-key-token" type="password" class="form-input" dir="ltr" autocomplete="off" maxlength="1024" required></label><button class="btn-primary" type="submit">بررسی کلید و فعال‌سازی واسط تماس</button></form><button id="turn-disable" class="quiet-button danger-text" ${config.configured?'':'hidden'}>قطع واسط و استفاده از تماس مستقیم</button><p class="session-help">توکن اصلی فقط به سرور خودتان ارسال و رمزگذاری می‌شود. دستگاه‌های کاربران مجوز موقت ۲۰ دقیقه‌ای دریافت می‌کنند.</p>`);
    bind('turn-form', async () => { await post('/api/service/calls', { keyId: byId('turn-key-id').value.trim(), token: byId('turn-key-token').value.trim() }); byId('turn-key-token').value = ''; byId('turn-disable').hidden = false; byId('feature-status').textContent = 'کلید تأیید شد؛ تماس‌های بعدی از مسیر مستقیم یا واسط برقرار می‌شوند.'; }, 'submit');
    bind('turn-disable', async () => { if (!confirm('واسط تماس غیرفعال شود؟ بعضی شبکه‌ها بدون آن وصل نمی‌شوند.')) return; await api('/api/service/calls', { method: 'DELETE' }); await turnSettings(); });
  }
  byId('btn-message-search').addEventListener('click',()=>{
    if(!activeChat)return;const chatId=activeChat.id;
    showFeature('جستجو در گفتگو','<form id="message-search-form" class="feature-form"><label>متن پیام<input id="message-search-query" class="form-input" maxlength="100" required placeholder="عبارت فارسی یا انگلیسی…"></label><button type="submit" class="btn-primary">جستجو</button></form><div id="message-search-results" class="feature-section"></div><button id="more-search-results" class="quiet-button" hidden>نتایج بیشتر</button>');
    let cursor='',query='',results=[],requestGeneration=0;
    async function search(older=false) {
      const generation=++requestGeneration;byId('feature-status').textContent='در حال جستجو…';
      const page=await api(`/api/chats/${chatId}/search?q=${encodeURIComponent(query)}${older&&cursor?'&before='+encodeURIComponent(cursor):''}`);if(generation!==requestGeneration)return;
      results=older?[...results,...page]:page;cursor=page.length?cursorFor(page[page.length-1]):'';byId('more-search-results').hidden=page.length<50;
      byId('message-search-results').innerHTML=results.length?results.map((msg,i)=>`<button id="search-hit-${i}" class="result-card"><strong>${escapeHtml(msg.senderName)}</strong><span>${escapeHtml(msg.text)}</span><small>${dateLabel(msg.createdAt)}</small></button>`).join(''):'<p class="session-help">پیامی پیدا نشد.</p>';
      results.forEach((msg,i)=>bind('search-hit-'+i,()=>jumpToMessage(chatId,msg.id)));byId('feature-status').textContent='';
    }
    bind('message-search-form',async()=>{query=byId('message-search-query').value.trim();await search();},'submit');bind('more-search-results',()=>search(true));byId('message-search-query').focus();
  });
  async function jumpToMessage(chatId,messageId) {
    if(!messageId)return;let chat=chats.find(row=>row.id===chatId);if(!chat){await loadChats(true);chat=chats.find(row=>row.id===chatId);}if(!chat)throw new Error('دیگر به این گفتگو دسترسی ندارید.');
    if(activeChat?.id!==chatId)await openChat(chat);
    let rounds=0;while(!(messagesByChat[chatId]||[]).some(row=>row.id===messageId)&&historyState[chatId]?.hasOlder&&rounds++<100)await loadMessages(chatId,{older:true});
    if(!(messagesByChat[chatId]||[]).some(row=>row.id===messageId))throw new Error('پیام پیدا نشد یا فقط برای حساب شما حذف شده است.');
    closeFeature();const node=byId('message-'+messageId);node?.scrollIntoView?.({block:'center'});node?.classList.add('highlight-message');setTimeout(()=>node?.classList.remove('highlight-message'),2000);
  }
  async function savedView(previous=[],cursor='') {
    const page=await api('/api/saved'+(cursor?'?before='+encodeURIComponent(cursor):'')),rows=[...previous,...page];showFeature('پیام‌های ذخیره‌شده',`<p class="session-help">این فهرست نشانه‌گذاری پیام اصلی است. ویرایش، حذف یا خروج از گفتگوی اصلی روی دسترسی به آن اثر می‌گذارد. نتایج صفحه‌بندی شده‌اند؛ برای ادامه «ذخیره‌های قبلی» را بزنید.</p>${rows.length?rows.map((msg,i)=>`<div class="saved-row"><button id="saved-open-${i}" class="result-card"><strong>${escapeHtml(msg.senderName)}</strong><span>${escapeHtml(msg.deletedAt?'پیام حذف شده':msg.text)}</span><small>${dateLabel(msg.createdAt)}</small></button><button id="saved-remove-${i}" class="quiet-button danger-text">برداشتن از ذخیره‌ها</button></div>`).join(''):'<p class="session-help">هنوز پیامی ذخیره نکرده‌اید. از دکمهٔ ⋯ کنار هر پیام استفاده کنید.</p>'}<button id="saved-more" class="quiet-button" ${page.length<8?'hidden':''}>ذخیره‌های قبلی</button>`);
    bind('saved-more',()=>savedView(rows,page.length?page.at(-1).savedAt+':'+page.at(-1).id:''));
    rows.forEach((msg,i)=>{bind('saved-open-'+i,()=>jumpToMessage(msg.chatId,msg.id));bind('saved-remove-'+i,async()=>{await mutate(msg,'save',{saved:false});await savedView();});});
  }
  async function redeemInvitation() {
    const join=invitation.get('join');if(!join||!token)return;if(!/^[a-f0-9]{64}$/.test(join))throw new Error('دعوت‌نامه معتبر نیست.');
    const result=await post('/api/invites/'+join+'/join');invitation.delete('join');history.replaceState(null,'',location.pathname);await loadChats(true);const chat=chats.find(row=>row.id===result.chatId);if(chat)await openChat(chat);
  }
  window.addEventListener('hashchange',()=>{invitation=new URLSearchParams(location.hash.slice(1));redeemInvitation().catch(error=>{chatError.textContent=error.message;});});
  api('/api/bootstrap').then(data=>{if(!data)return;byId('registration-help').textContent=data.registration==='invite'?'ثبت‌نام در این سرویس فقط با لینک دعوت مدیر ممکن است.':data.registration==='closed'?'ثبت‌نام فعلاً بسته است؛ با حساب موجود وارد شوید.':'';if(invitation.get('register')){byId('registration-help').textContent='دعوت‌نامهٔ ثبت‌نام دریافت شد. اطلاعات حساب تازه را وارد کنید.';tabRegister.click?.();}}).catch(()=>{});
  navigator.serviceWorker?.addEventListener?.('message',event=>{if(event.data?.type==='incoming-call'&&token){loadChats(true).then(checkIncomingCalls).catch(()=>{});return;}if(event.data?.type==='open-secure'&&token){openSecure('',event.data.threadId);return;}if(event.data?.type==='open-chat'&&token){loadChats(true).then(()=>{const chat=chats.find(row=>row.id===event.data.chatId);if(chat)openChat(chat);}).catch(()=>{});}});

  // Start app
  setupUserSession();
})();
