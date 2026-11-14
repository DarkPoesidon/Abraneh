/*! Copyright (c) 2026 DarkPoesidon. Abraneh: https://github.com/DarkPoesidon/Abraneh. PolyForm Noncommercial 1.0.0; see LICENSE and NOTICE. */
// The service admin's panel. Direct messages never appear here unless someone reports one.
(() => {
  const byId = id => document.getElementById(id);
  window.WihmAdmin = { create({ api, post, show, error, escape: esc, generation, users, overview, serviceSettings, audit, onChange }) {
    const patch = (path, body) => api(path, { method: 'PATCH', body: JSON.stringify(body) });
    const bind = (id, callback, event = 'click') => byId(id)?.addEventListener(event, e => { if (event === 'submit') e.preventDefault(); Promise.resolve().then(callback).catch(error); });
    const date = value => new Date(value).toLocaleString('fa-IR');
    const count = value => Number(value || 0).toLocaleString('fa-IR');
    const status = text => { if (byId('feature-status')) byId('feature-status').textContent = text; };

    async function home() {
      const view = show('پنل مدیریت', '<p class="session-help">در حال دریافت…</p>'), data = await api('/api/service/overview'); if (generation() !== view) return;
      const c = data.counts;
      show('پنل مدیریت', `<dl class="service-metrics"><div><dt>کاربران</dt><dd>${count(c.users)}</dd></div><div><dt>گروه‌ها</dt><dd>${count(c.groups)}</dd></div><div><dt>کانال‌ها</dt><dd>${count(c.channels)}</dd></div><div><dt>گزارش‌های باز</dt><dd>${count(c.openReports)}</dd></div></dl>
        <div class="admin-menu"><button id="admin-reports" class="quiet-button" type="button">گزارش‌های تخلف${c.openReports ? ` <span class="unread-badge">${count(c.openReports)}</span>` : ''}</button><button id="admin-users" class="quiet-button" type="button">کاربران</button><button id="admin-groups" class="quiet-button" type="button">گروه‌ها</button><button id="admin-channels" class="quiet-button" type="button">کانال‌ها</button><button id="admin-audit" class="quiet-button" type="button">رویدادهای مدیریت</button><button id="admin-status" class="quiet-button" type="button">وضعیت سرویس</button><button id="admin-settings" class="quiet-button" type="button">ثبت‌نام، تماس و تنظیمات</button></div>`);
      bind('admin-reports', reports); bind('admin-users', () => users()); bind('admin-groups', () => chats('group')); bind('admin-channels', () => chats('channel'));
      bind('admin-audit', audit); bind('admin-status', overview); bind('admin-settings', serviceSettings);
    }

    async function reports() {
      const view = show('گزارش‌های تخلف', '<p class="session-help">در حال دریافت…</p>'), rows = await api('/api/service/reports'); if (generation() !== view) return;
      const place = row => row.chatTitle ? `${row.isChannel ? 'کانال' : 'گروه'} «${esc(row.chatTitle)}»` : row.chatType === 'dm' ? 'گفتگوی خصوصی' : row.chat_id ? 'گفتگوی خصوصی' : 'حساب کاربری';
      show('گزارش‌های تخلف', `<div class="button-row"><button id="admin-home" class="quiet-button" type="button">پنل مدیریت</button></div><p class="session-help">مدیر فقط پیام گزارش‌شده را می‌بیند، نه بقیهٔ گفتگو را. هر اقدام در رویدادهای مدیریت ثبت می‌شود.</p>${rows.map((row, i) => `<section class="feature-section admin-card ${row.status === 'resolved' ? 'is-done' : ''}">
          <p class="admin-card-title"><bdi>@${esc(row.reporter)}</bdi> ← <bdi>@${esc(row.target)}</bdi>${row.targetDisabledAt ? ' · حساب غیرفعال است' : ''}</p>
          <p class="session-help">${place(row)} · ${date(row.created_at)} · ${row.status === 'resolved' ? 'بررسی‌شده' : 'باز'}</p>
          <p>${esc(row.reason)}</p>${row.snapshot ? `<blockquote class="action-preview">${esc(row.snapshot)}</blockquote>` : ''}
          <div class="button-row">
            <button id="report-state-${i}" class="quiet-button" type="button">${row.status === 'resolved' ? 'باز کردن دوباره' : 'علامت بررسی‌شده'}</button>
            ${row.message_id ? `<button id="report-delete-${i}" class="quiet-button danger-text" type="button">حذف پیام برای همه</button>` : ''}
            <button id="report-user-${i}" class="quiet-button danger-text" type="button">${row.targetDisabledAt ? 'فعال‌کردن حساب' : 'غیرفعال‌کردن حساب'}</button>
            ${row.chatType === 'group' ? `<button id="report-chat-${i}" class="quiet-button danger-text" type="button">تعلیق ${row.isChannel ? 'کانال' : 'گروه'}</button>` : ''}
          </div></section>`).join('') || '<p class="session-help">گزارشی ثبت نشده است.</p>'}`);
      bind('admin-home', home);
      rows.forEach((row, i) => {
        bind('report-state-' + i, async () => { await patch('/api/service/reports', { id: row.id, status: row.status === 'resolved' ? 'open' : 'resolved' }); onChange(); await reports(); });
        bind('report-delete-' + i, async () => { if (!confirm('این پیام برای همهٔ اعضا حذف شود؟ برگشت‌پذیر نیست.')) return; await post('/api/service/messages', { chatId: row.chat_id, messageId: row.message_id }); status('پیام حذف شد.'); });
        bind('report-user-' + i, async () => { const enable = !!row.targetDisabledAt; if (!enable && !confirm(`حساب @${row.target} غیرفعال شود؟ همهٔ نشست‌های آن بسته می‌شود.`)) return; await patch('/api/service/users', { userId: row.target_user_id, action: enable ? 'enable' : 'disable', reason: enable ? '' : row.reason.slice(0, 200) }); await reports(); });
        bind('report-chat-' + i, async () => { if (!confirm('این گفتگو برای همهٔ اعضا تعلیق شود؟ بعداً می‌توانید آن را برگردانید.')) return; await patch('/api/service/chats', { chatId: row.chat_id, action: 'suspend', reason: row.reason.slice(0, 200) }); status('تعلیق شد.'); });
      });
    }

    async function chats(kind, query = '', after = '') {
      const title = kind === 'channel' ? 'کانال‌ها' : 'گروه‌ها', noun = kind === 'channel' ? 'کانال' : 'گروه';
      const view = show(title, '<p class="session-help">در حال دریافت…</p>'), data = await api(`/api/service/chats?kind=${kind}&q=${encodeURIComponent(query)}&after=${encodeURIComponent(after)}`); if (generation() !== view) return;
      show(title, `<div class="button-row"><button id="admin-home" class="quiet-button" type="button">پنل مدیریت</button></div><form id="admin-chat-search" class="feature-form"><label>جستجوی ${noun}<input id="admin-chat-query" class="form-input" maxlength="100" value="${esc(query)}"></label><button class="quiet-button" type="submit">جستجو</button></form><p class="session-help">تعلیق، دسترسی همهٔ اعضا را می‌بندد و پیام‌ها را نگه می‌دارد. حذف، گفتگو و همهٔ پیام‌ها و فایل‌هایش را برای همیشه پاک می‌کند.</p>
        ${data.chats.map((row, i) => `<section class="feature-section admin-card"><p class="admin-card-title">${esc(row.title)}${row.handle ? ` <bdi dir="ltr">@${esc(row.handle)}</bdi>` : ''}</p>
          <p class="session-help">${row.visibility === 'public' ? 'عمومی · ' : row.visibility ? 'خصوصی · ' : ''}مالک: <bdi>@${esc(row.owner || '—')}</bdi> · ${count(row.members)} عضو · ${count(row.messages)} پیام${row.openReports ? ` · ${count(row.openReports)} گزارش باز` : ''}</p>
          ${row.suspendedAt ? `<p class="error-text">تعلیق‌شده در ${date(row.suspendedAt)}${row.reason ? ' · ' + esc(row.reason) : ''}</p>` : ''}
          <div class="button-row"><button id="chat-toggle-${i}" class="quiet-button ${row.suspendedAt ? '' : 'danger-text'}" type="button">${row.suspendedAt ? 'رفع تعلیق' : 'تعلیق'}</button><button id="chat-delete-${i}" class="quiet-button danger-text" type="button">حذف همیشگی</button></div></section>`).join('') || `<p class="session-help">${noun}ی پیدا نشد.</p>`}
        ${data.next ? '<button id="admin-chat-next" class="quiet-button" type="button">صفحهٔ بعد</button>' : ''}`);
      bind('admin-home', home); bind('admin-chat-next', () => chats(kind, query, data.next));
      bind('admin-chat-search', () => chats(kind, byId('admin-chat-query').value), 'submit');
      data.chats.forEach((row, i) => {
        bind('chat-toggle-' + i, async () => { let reason = ''; if (!row.suspendedAt) { reason = prompt('دلیل تعلیق (اختیاری):', '') ?? null; if (reason === null) return; } await patch('/api/service/chats', { chatId: row.id, action: row.suspendedAt ? 'restore' : 'suspend', reason: reason.slice(0, 200) }); await chats(kind, query, after); });
        bind('chat-delete-' + i, async () => { if (!confirm(`«${row.title}» و همهٔ پیام‌ها و فایل‌هایش برای همیشه حذف شود؟`)) return; await patch('/api/service/chats', { chatId: row.id, action: 'delete', reason: '' }); await chats(kind, query, after); });
      });
    }
    return { home, reports, chats };
  } };
})();
