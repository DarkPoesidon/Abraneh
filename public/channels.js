(() => {
  window.WihmChannels = {
    async open({ api, post, show, error, escape: esc, user }) {
      let generation = 0;
      const bind = (id, fn, event = 'click') => document.getElementById(id)?.addEventListener(event, e => { e.preventDefault(); Promise.resolve().then(fn).catch(error); });
      const value = id => document.getElementById(id).value;
      const del = path => api(path, { method: 'DELETE' });
      const patch = (path, data) => api(path, { method: 'PATCH', body: JSON.stringify(data) });
      const root = '/api/channels';
      function once(title, label, secret, back) {
        show(title, `<p class="session-help">${esc(label)} این مقدار فقط یک بار نمایش داده می‌شود؛ در جای امن ذخیره کن. آن را در پیام یا تصویر عمومی نفرست.</p><textarea id="channel-secret" rows="4" readonly dir="ltr">${esc(secret)}</textarea><button id="channel-copy" class="btn-primary" type="button">کپی مقدار</button><button id="channel-back" class="quiet-button" type="button">بازگشت</button>`);
        bind('channel-copy', async () => { await navigator.clipboard.writeText(secret); }); bind('channel-back', back);
      }
      async function list(discover = false, after = '', previous = []) {
        const ticket = ++generation, result = await api(root + `?discover=${discover ? '1' : '0'}&after=${encodeURIComponent(after)}`);
        if (ticket !== generation) return;
        const rows = [...previous, ...result.channels];
        show('کانال‌ها', `<p class="session-help">کانال از گفتگو جداست؛ مشترکان فقط پست‌ها را می‌خوانند. هر مالک پنج کانال و هر کانال حداکثر ۱۰۰۰ پست دارد؛ پست قدیمی خودکار حذف نمی‌شود.</p><div class="feature-actions"><button id="channel-mine" class="quiet-button" type="button">کانال‌های من</button><button id="channel-discover" class="quiet-button" type="button">کانال‌های عمومی</button><button id="channel-create" class="quiet-button" type="button">ساخت کانال</button><button id="channel-join" class="quiet-button" type="button">عضویت با دعوت</button></div>${rows.map((row, i) => `<button id="channel-open-${i}" class="result-card" type="button"><strong>${esc(row.title)}</strong><small>${row.visibility === 'public' ? 'عمومی' : 'خصوصی'} · ${esc(row.role || 'بدون عضویت')}</small></button>`).join('') || '<p>کانالی پیدا نشد.</p>'}${result.next ? '<button id="channel-more" class="quiet-button" type="button">کانال‌های بعدی</button>' : ''}`);
        rows.forEach((row, i) => bind('channel-open-' + i, () => detail(row.id)));
        bind('channel-mine', () => list()); bind('channel-discover', () => list(true)); bind('channel-more', () => list(discover, result.next, rows));
        bind('channel-create', create); bind('channel-join', join);
      }
      function create() {
        generation++;
        show('ساخت کانال', '<form id="channel-create-form"><label>نام کانال<input id="channel-title" maxlength="100" required></label><label>نوع<select id="channel-visibility"><option value="private">خصوصی؛ فقط با کد دعوت</option><option value="public">عمومی؛ قابل پیدا شدن برای کاربران این سرویس</option></select></label><button class="btn-primary" type="submit">ساخت کانال</button></form>');
        bind('channel-create-form', async () => { const row = await post(root, { title: value('channel-title'), visibility: value('channel-visibility') }); once('دعوت کانال', 'شناسه و کد دعوت کانال:', row.id + '\n' + row.invite, () => detail(row.id)); }, 'submit');
      }
      function join() {
        generation++;
        show('عضویت با دعوت', '<form id="channel-join-form"><label>شناسهٔ کانال<input id="channel-id" dir="ltr" maxlength="100" required></label><label>کد دعوت خصوصی<input id="channel-invite" dir="ltr" maxlength="64" autocomplete="off"></label><button class="btn-primary" type="submit">عضویت</button></form>');
        bind('channel-join-form', async () => { const id = value('channel-id').trim(); await post(root + '/' + encodeURIComponent(id) + '/subscribe', { invite: value('channel-invite').trim() }); await detail(id); }, 'submit');
      }
      async function detail(id, before = '', previous = []) {
        const ticket = ++generation, base = root + '/' + encodeURIComponent(id);
        const [row, page] = await Promise.all([api(base), api(base + '/posts?before=' + encodeURIComponent(before))]);
        if (ticket !== generation) return;
        const rows = [...previous, ...page.posts], owner = row.ownerId === user()?.id, writer = owner || row.role === 'admin';
        show(row.title, `<button id="channel-list" class="quiet-button" type="button">بازگشت به کانال‌ها</button><p class="session-help">${esc(id)} · ${row.visibility === 'public' ? 'عمومی' : 'خصوصی'} · ${esc(row.role || 'بدون عضویت')} — برای دریافت پست تازه، نوسازی را بزن.</p><div class="feature-actions"><button id="channel-refresh" class="quiet-button" type="button">نوسازی پست‌ها</button>${!owner ? `<button id="channel-subscribe" class="quiet-button" type="button">${row.role ? 'لغو عضویت' : 'عضویت'}</button>` : '<button id="channel-manage" class="quiet-button" type="button">مدیران، ربات و وب‌هوک</button>'}</div>${writer ? '<form id="channel-post-form"><label>پست تازه<textarea id="channel-post-text" maxlength="8192" rows="4" required></textarea></label><button type="submit" class="btn-primary">انتشار پست</button></form>' : ''}<div>${rows.map((item, i) => `<article class="saved-row"><div><small>${esc(new Date(item.createdAt).toLocaleString('fa-IR'))}${item.updatedAt > item.createdAt ? ' · ویرایش‌شده' : ''}</small><p class="message-text">${esc(item.deletedAt ? 'این پست حذف شده است.' : item.text)}</p>${writer && !item.deletedAt ? `<button id="channel-edit-${i}" class="quiet-button" type="button">ویرایش</button><button id="channel-delete-${i}" class="quiet-button danger-text" type="button">حذف پست</button>` : ''}</div></article>`).join('') || '<p>هنوز پستی منتشر نشده است.</p>'}</div>${page.next ? '<button id="channel-older" class="quiet-button" type="button">پست‌های قبلی</button>' : ''}`);
        bind('channel-list', () => list()); bind('channel-refresh', () => detail(id)); bind('channel-manage', () => manage(id)); bind('channel-older', () => detail(id, page.next, rows));
        bind('channel-subscribe', async () => { if (row.role) await del(base + '/subscribe'); else await post(base + '/subscribe', {}); await list(); });
        bind('channel-post-form', async () => { await post(base + '/posts', { text: value('channel-post-text') }); await detail(id); }, 'submit');
        rows.forEach((item, i) => {
          bind('channel-delete-' + i, async () => { if (confirm('متن این پست برای همه حذف شود؟ رد حذف در فهرست می‌ماند.')) { await del(base + '/posts/' + item.id); await detail(id); } });
          bind('channel-edit-' + i, () => { show('ویرایش پست', `<form id="channel-edit-form"><textarea id="channel-edit-text" rows="6" maxlength="8192" required>${esc(item.text)}</textarea><button class="btn-primary" type="submit">ذخیره</button></form>`); bind('channel-edit-form', async () => { await patch(base + '/posts/' + item.id, { text: value('channel-edit-text') }); await detail(id); }, 'submit'); });
        });
      }
      async function manage(id) {
        const ticket = ++generation, base = root + '/' + id;
        const [tokens, hook, admins] = await Promise.all([api(base + '/tokens'), api(base + '/webhook'), api(base + '/members')]);
        if (ticket !== generation) return;
        show('مدیریت کانال', `<button id="channel-back" class="quiet-button" type="button">بازگشت به پست‌ها</button><p class="session-help">توکن ربات فقط به پست‌های همین کانال دسترسی دارد. حداکثر ده توکن، انقضا تا ۹۰ روز. هیچ سرویس پولی فعال نمی‌شود.</p><h4>مدیران انتشار</h4>${admins.map(a => `<p>${esc(a.username)} · ${esc(a.userId)}</p>`).join('')}<form id="channel-role-form"><label>شناسهٔ کاربر<input id="channel-member-id" dir="ltr" maxlength="100" required></label><label>نقش<select id="channel-member-role"><option value="admin">مدیر انتشار</option><option value="subscriber">مشترک؛ برداشتن مدیریت</option></select></label><button class="btn-primary" type="submit">ذخیرهٔ نقش</button></form><button id="channel-rotate" class="quiet-button" type="button">ساخت کد دعوت جدید</button><h4>توکن‌های ربات</h4>${tokens.map((token, i) => `<p>${esc(token.label)} · ${esc(token.scope)} · ${esc(new Date(token.expiresAt).toLocaleDateString('fa-IR'))} <button id="channel-token-revoke-${i}" class="quiet-button danger-text" type="button">لغو</button></p>`).join('')}<form id="channel-token-form"><label>نام ربات<input id="channel-token-label" maxlength="60" required></label><label>مجوز<select id="channel-token-scope"><option value="read">خواندن</option><option value="write">نوشتن</option><option value="read-write">خواندن و نوشتن</option></select></label><label>انقضا؛ روز<input id="channel-token-days" type="number" min="1" max="90" value="30" required></label><button class="btn-primary" type="submit">ساخت توکن</button></form><h4>وب‌هوک خروجی</h4><p class="session-help">فقط HTTPS روی workers.dev یا دامنهٔ مجاز مدیر سرویس. متن پست‌ها برای مقصد ارسال می‌شود. هر رویداد شناسهٔ ثابت دارد؛ گیرنده باید امضای HMAC و زمان را بررسی و تکراری‌ها را حذف کند. تا پنج تلاش؛ ارسال زمان‌بندی‌شده است. هر کانال حداکثر ۱۰۰ رویداد در صف دارد؛ پرشدن صف، انتشار تازه را متوقف می‌کند. تعویض یا حذف وب‌هوک، صف قبلی را حذف می‌کند.</p><p>${esc(hook.hook?.url || 'وب‌هوکی متصل نیست.')} · ${hook.outbox.length} رویداد در صف</p>${hook.outbox.some(job => job.attempts >= 5) ? '<p class="error-text">رویداد ناموفق پس از پنج تلاش متوقف شده است؛ برای پاک‌کردن صف، وب‌هوک را حذف یا دوباره تنظیم کن.</p>' : ''}<form id="channel-hook-form"><label>نشانی مقصد<input id="channel-hook-url" type="url" dir="ltr" maxlength="512" placeholder="https://receiver.account.workers.dev/events" required></label><button class="btn-primary" type="submit">تنظیم یا تعویض وب‌هوک</button></form><button id="channel-hook-delete" class="quiet-button danger-text" type="button">حذف وب‌هوک و صف</button><button id="channel-remove" class="quiet-button danger-text" type="button">حذف کامل کانال</button>`);
        bind('channel-back', () => detail(id));
        bind('channel-role-form', async () => { await post(base + '/members', { userId: value('channel-member-id').trim(), role: value('channel-member-role') }); await manage(id); }, 'submit');
        bind('channel-rotate', async () => { const result = await post(base + '/invite', {}); once('دعوت جدید کانال', 'کد قبلی دیگر معتبر نیست. شناسه و کد جدید:', id + '\n' + result.invite, () => manage(id)); });
        bind('channel-token-form', async () => { const result = await post(base + '/tokens', { label: value('channel-token-label'), scope: value('channel-token-scope'), days: Number(value('channel-token-days')) }); once('توکن ربات', 'توکن را فقط در Authorization: Bearer بفرست. مسیر API: /api/channel-api/' + id + '/posts', result.token, () => manage(id)); }, 'submit');
        tokens.forEach((token, i) => bind('channel-token-revoke-' + i, async () => { await del(base + '/tokens/' + token.id); await manage(id); }));
        bind('channel-hook-form', async () => { if (hook.hook && !confirm('وب‌هوک و صف قبلی حذف و کلید جدید ساخته شود؟')) return; const result = await post(base + '/webhook', { url: value('channel-hook-url').trim() }); once('کلید وب‌هوک', 'کلید HMAC-SHA256 برای X-WIHM-Signature؛ دادهٔ امضا: X-WIHM-Timestamp + نقطه + بدنهٔ خام درخواست. JWT_SECRET عوض شود، وب‌هوک را دوباره تنظیم کن.', result.secret, () => manage(id)); }, 'submit');
        bind('channel-hook-delete', async () => { if (confirm('وب‌هوک و همهٔ رویدادهای صف آن حذف شوند؟')) { await del(base + '/webhook'); await manage(id); } });
        bind('channel-remove', async () => { if (confirm('کانال، پست‌ها، اعضا، توکن‌ها و صف آن برای همیشه حذف شوند؟')) { await del(base); await list(); } });
      }
      await list();
    },
  };
})();
