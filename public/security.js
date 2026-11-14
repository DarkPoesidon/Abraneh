/*! Copyright (c) 2026 DarkPoesidon. Abraneh: https://github.com/DarkPoesidon/Abraneh. PolyForm Noncommercial 1.0.0; see LICENSE and NOTICE. */
(function () {
  'use strict';
  const decode = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  const encode = value => btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  function options(value, registration) {
    const result = { ...value, challenge: decode(value.challenge) };
    if (registration) result.user = { ...value.user, id: decode(value.user.id) };
    const field = registration ? 'excludeCredentials' : 'allowCredentials';
    if (value[field]) result[field] = value[field].map(item => ({ ...item, id: decode(item.id) }));
    return result;
  }
  function credentialJSON(credential) {
    if (!credential) throw new Error('تأیید کلید عبور لغو شد.');
    if (typeof credential.toJSON === 'function') return credential.toJSON();
    const response = credential.response;
    return { id: credential.id, rawId: encode(credential.rawId), type: credential.type,
      authenticatorAttachment: credential.authenticatorAttachment || undefined,
      clientExtensionResults: credential.getClientExtensionResults(),
      response: { clientDataJSON: encode(response.clientDataJSON),
        ...(response.attestationObject ? { attestationObject: encode(response.attestationObject), transports: response.getTransports?.() || [] } :
          { authenticatorData: encode(response.authenticatorData), signature: encode(response.signature), userHandle: response.userHandle ? encode(response.userHandle) : undefined }) } };
  }
  async function ceremony(value, registration) {
    if (!window.isSecureContext || !navigator.credentials) throw new Error('کلید عبور در این مرورگر یا اتصال پشتیبانی نمی‌شود؛ از HTTPS و مرورگر به‌روز استفاده کنید.');
    try {
      return credentialJSON(await navigator.credentials[registration ? 'create' : 'get']({ publicKey: options(value, registration) }));
    } catch (error) {
      if (error.name === 'NotAllowedError' || error.name === 'AbortError') throw new Error('درخواست کلید عبور لغو شد یا زمان آن پایان یافت.');
      throw error;
    }
  }
  async function login(post, username) {
    const saved = await post('/api/auth/passkey/options', { username });
    return post('/api/auth/passkey/verify', { challengeId: saved.challengeId, credential: await ceremony(saved.options, false) });
  }
  function create({ api, post, show, error, escape: esc, generation }) {
    const byId = id => document.getElementById(id);
    const bind = (id, action, event = 'click') => byId(id)?.addEventListener(event, async e => {
      e.preventDefault(); const button = e.currentTarget, buttons = button.matches('form') ? [...button.querySelectorAll('button')] : [button];
      buttons.forEach(item => { item.disabled = true; });
      try { await action(); } catch (failure) { error(failure); } finally { buttons.forEach(item => { item.disabled = false; }); }
    });
    const proofFields = enabled => `<label>رمز عبور فعلی<input id="security-password" class="form-input" type="password" autocomplete="current-password" maxlength="1024" required></label>${enabled ? '<label>کد رمزساز یا بازیابی<input id="security-otp" class="form-input" dir="ltr" autocomplete="one-time-code" required></label><p class="session-help">هر کد یک بار پذیرفته می‌شود. برای عملیات بعدی از کد تازه استفاده کنید.</p>' : ''}`;
    const proof = () => ({ password: byId('security-password').value, otp: byId('security-otp')?.value.trim() || '' });
    function codesView(codes) {
      show('کدهای بازیابی', `<p class="session-help">این ۸ کد فقط همین بار نمایش داده می‌شوند. هر کد یک بار و همراه رمز عبور قابل استفاده است. در جای امن خارج از این دستگاه نگه دارید؛ با ساخت دوباره، کدهای قبلی باطل می‌شوند.</p><textarea id="security-codes" class="form-input" rows="8" dir="ltr" readonly aria-label="کدهای بازیابی">${codes.map(esc).join('\n')}</textarea><button id="security-copy" class="quiet-button">کپی کدها</button><button id="security-back" class="quiet-button">بازگشت</button>`);
      bind('security-copy', async () => { await navigator.clipboard.writeText(codes.join('\n')); byId('feature-status').textContent = 'کدها کپی شدند؛ در جای امن ذخیره کنید.'; });
      bind('security-back', open);
    }
    async function open() {
      show('کلید عبور و ورود دومرحله‌ای', '<p>در حال دریافت…</p>'); const view = generation(), status = await api('/api/security/status');
      if (generation() !== view) return;
      show('کلید عبور و ورود دومرحله‌ای', `<p class="session-help">کلید عبور با اثر انگشت، چهره یا PIN دستگاه وارد می‌شود و خودش تأیید دومرحله‌ای محسوب می‌شود. ورود با رمز عبور، در صورت فعال‌بودن رمزساز، کد هم می‌خواهد. کلید عبور به همین دامنه وابسته است.</p><section class="feature-section"><h4>کلیدهای عبور</h4>${status.passkeys.length ? status.passkeys.map((key, i) => `<div class="member-row"><span class="member-name">${esc(key.name)}</span><button id="security-delete-${i}" class="quiet-button danger-text">حذف</button></div>`).join('') : '<p>هنوز کلیدی ثبت نکرده‌اید.</p>'}<button id="security-add" class="quiet-button">افزودن کلید عبور</button></section><section class="feature-section"><h4>برنامهٔ رمزساز (TOTP)</h4><p>${status.totp ? 'فعال' : 'غیرفعال'}${status.totp ? ` · ${status.recoveryRemaining} کد بازیابی باقی مانده` : ''}</p><button id="security-totp" class="quiet-button">${status.totp ? 'غیرفعال‌کردن' : 'فعال‌کردن'}</button>${status.totp ? '<button id="security-recovery" class="quiet-button">ساخت دوبارهٔ کدهای بازیابی</button>' : ''}</section>`);
      bind('security-add', () => {
        show('افزودن کلید عبور', `<form id="security-form" class="feature-form">${proofFields(status.totp)}<label>نام دستگاه<input id="security-name" class="form-input" maxlength="80" value="کلید عبور" required></label><button type="submit" class="btn-primary">ثبت کلید روی دستگاه</button></form>`);
        bind('security-form', async () => {
          const view = generation(), saved = await post('/api/security/passkeys/options', proof());
          if (generation() !== view) return;
          const credential = await ceremony(saved.options, true);
          if (generation() !== view) return;
          await post('/api/security/passkeys/verify', { challengeId: saved.challengeId, credential, name: byId('security-name').value });
          if (generation() === view) await open();
        }, 'submit');
      });
      status.passkeys.forEach((key, i) => bind('security-delete-' + i, () => {
        show('حذف کلید عبور', `<form id="security-form" class="feature-form"><p>کلید «${esc(key.name)}» حذف شود؟ ورود با رمز عبور همچنان ممکن است.</p>${proofFields(status.totp)}<button type="submit" class="btn-primary">حذف کلید</button></form>`);
        bind('security-form', async () => { const view = generation(); await post('/api/security/passkeys/delete', { ...proof(), id: key.id }); if (generation() === view) await open(); }, 'submit');
      }));
      bind('security-totp', () => {
        show(status.totp ? 'غیرفعال‌کردن رمزساز' : 'راه‌اندازی رمزساز', `<form id="security-form" class="feature-form"><p class="session-help">${status.totp ? 'پس از غیرفعال‌کردن، کدهای بازیابی هم باطل می‌شوند.' : 'یک برنامهٔ رمزساز مانند Google Authenticator یا Aegis لازم است. فعال‌سازی، نشست‌های دیگر شما را خارج می‌کند.'}</p>${proofFields(status.totp)}<button type="submit" class="btn-primary">ادامه</button></form>`);
        bind('security-form', async () => {
          const view = generation();
          if (status.totp) { await post('/api/security/totp/disable', proof()); if (generation() === view) await open(); return; }
          const saved = await post('/api/security/totp/setup', proof()); if (generation() !== view) return;
          const secret = new URL(saved.uri).searchParams.get('secret');
          show('تأیید برنامهٔ رمزساز', `<p class="session-help">در برنامهٔ رمزساز، کلید زیر را دستی اضافه کنید: نوع زمان‌محور (TOTP)، ۶ رقم، SHA1 و ۳۰ ثانیه. این کلید را محرمانه نگه دارید. راه‌اندازی ۵ دقیقه اعتبار دارد.</p><label>کلید راه‌اندازی<input class="form-input" dir="ltr" readonly value="${esc(secret)}"></label><details><summary>نشانی واردکردن در رمزساز</summary><textarea class="form-input" dir="ltr" readonly aria-label="نشانی رمزساز">${esc(saved.uri)}</textarea></details><form id="security-confirm" class="feature-form"><label>کد ۶ رقمی برنامه<input id="security-confirm-code" class="form-input" dir="ltr" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></label><button type="submit" class="btn-primary">فعال‌کردن و دریافت کدهای بازیابی</button></form>`);
          bind('security-confirm', async () => { const view = generation(), result = await post('/api/security/totp/enable', { challengeId: saved.challengeId, otp: byId('security-confirm-code').value }); if (generation() === view) codesView(result.recoveryCodes); }, 'submit');
        }, 'submit');
      });
      bind('security-recovery', () => {
        show('جایگزینی کدهای بازیابی', `<form id="security-form" class="feature-form"><p>همهٔ کدهای قبلی باطل می‌شوند. کدهای جدید را ذخیره کنید.</p>${proofFields(true)}<button type="submit" class="btn-primary">ساخت کدهای جدید</button></form>`);
        bind('security-form', async () => { const view = generation(), result = await post('/api/security/recovery', proof()); if (generation() === view) codesView(result.recoveryCodes); }, 'submit');
      });
    }
    return { open };
  }
  window.WihmSecurity = { create, login, credentialJSON, options };
})();
