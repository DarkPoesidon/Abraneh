(() => {
  const KINDS = {
    voice: { label: 'پیام صوتی', types: ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'], constraints: { audio: true }, options: { audioBitsPerSecond: 32000 }, maxMs: 300_000, maxBytes: 4 * 1048576, tag: 'audio' },
    video: { label: 'پیام تصویری', types: ['video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'], constraints: { audio: true, video: { facingMode: 'user', width: { ideal: 480 }, height: { ideal: 480 } } }, options: { videoBitsPerSecond: 400000, audioBitsPerSecond: 32000 }, maxMs: 60_000, maxBytes: 16 * 1048576, tag: 'video' },
  };
  const CACHED_PLAYERS = 20;
  const clock = ms => { const seconds = Math.round(ms / 1000); return Math.floor(seconds / 60).toLocaleString('fa-IR') + ':' + (seconds % 60).toLocaleString('fa-IR', { minimumIntegerDigits: 2 }); };
  function failure(error) {
    if (['NotAllowedError', 'SecurityError'].includes(error?.name)) return 'مجوز میکروفون یا دوربین رد شد؛ از مجوزهای سایت در مرورگر فعالش کنید.';
    if (['NotFoundError', 'OverconstrainedError'].includes(error?.name)) return 'میکروفون یا دوربین پیدا نشد؛ اتصال دستگاه را بررسی کنید.';
    if (error?.name === 'NotReadableError') return 'میکروفون یا دوربین در اختیار برنامهٔ دیگری است.';
    return 'ضبط پیام شروع نشد؛ دوباره تلاش کنید.';
  }
  window.WihmMedia = {
    create({ footer, sendButton, getChat, canRecord, upload, download, notify }) {
      const players = new Map(); let recording = null, pending = null;
      const bar = document.createElement('div'); bar.className = 'media-recorder'; bar.hidden = true;
      const preview = document.createElement('video'), status = document.createElement('span'), send = document.createElement('button'), cancel = document.createElement('button');
      preview.className = 'media-preview'; preview.muted = preview.playsInline = preview.autoplay = true; preview.hidden = true; preview.setAttribute('aria-label', 'پیش‌نمایش دوربین');
      status.className = 'media-status'; status.setAttribute('role', 'status');
      send.type = cancel.type = 'button'; send.className = 'btn-primary media-send'; cancel.className = 'quiet-button media-cancel'; cancel.textContent = 'لغو';
      bar.append(preview, status, send, cancel); footer.append(bar);

      const supported = typeof MediaRecorder !== 'undefined' && navigator.mediaDevices?.getUserMedia;
      if (supported) for (const [kind, icon] of [['voice', '<path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>'], ['video', '<rect x="3" y="5" width="12" height="14" rx="3"/><path d="m15 10 6-4v12l-6-4"/>']]) {
        const button = document.createElement('button'); button.type = 'button'; button.id = 'btn-record-' + kind; button.className = 'icon-btn media-record'; button.title = 'ضبط ' + KINDS[kind].label; button.setAttribute('aria-label', button.title);
        button.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg>`;
        button.addEventListener('click', () => start(kind)); footer.insertBefore(button, sendButton);
      }
      function show(on) { bar.hidden = !on; footer.classList.toggle('recording', on); }
      function stopTracks(stream) { stream?.getTracks().forEach(track => track.stop()); preview.srcObject = null; preview.hidden = true; }

      async function start(kind) {
        if (recording || pending || !canRecord()) return;
        const settings = KINDS[kind], chat = getChat(); if (!chat) return;
        let stream;
        try { stream = await navigator.mediaDevices.getUserMedia(settings.constraints); }
        catch (error) { notify(failure(error)); return; }
        const mimeType = settings.types.find(type => MediaRecorder.isTypeSupported(type));
        let recorder;
        try { recorder = new MediaRecorder(stream, { ...settings.options, ...(mimeType ? { mimeType } : {}) }); }
        catch (error) { stopTracks(stream); notify(failure(error)); return; }
        const chunks = [], startedAt = Date.now(), state = recording = { kind, chatId: chat.id, stream, recorder, sendOnStop: false };
        recorder.ondataavailable = event => { if (event.data?.size) chunks.push(event.data); };
        recorder.onstop = () => { stopTracks(stream); if (recording === state) recording = null; if (state.sendOnStop) finish(state, chunks, Date.now() - startedAt, recorder.mimeType || mimeType); else show(false); };
        if (kind === 'video') { preview.srcObject = stream; preview.hidden = false; }
        send.textContent = 'ارسال'; send.disabled = false; show(true);
        const tick = () => { status.textContent = 'در حال ضبط ' + settings.label + ' · ' + clock(Date.now() - startedAt); };
        tick(); state.timer = setInterval(tick, 500);
        state.limit = setTimeout(() => stop(true), settings.maxMs);
        recorder.start(1000);
      }
      function stop(sendOnStop) {
        const state = recording; if (!state) return;
        clearInterval(state.timer); clearTimeout(state.limit); state.sendOnStop = sendOnStop;
        if (state.recorder.state !== 'inactive') state.recorder.stop();
      }
      function finish(state, chunks, durationMs, mime) {
        const settings = KINDS[state.kind];
        if (durationMs < 1000 || !chunks.length) { show(false); notify('پیام خیلی کوتاه بود و ارسال نشد.'); return; }
        const blob = new Blob(chunks, { type: mime || chunks[0].type });
        if (blob.size > settings.maxBytes) { show(false); notify('حجم پیام بیش از حد مجاز است؛ پیام کوتاه‌تری ضبط کنید.'); return; }
        // A stable id lets a retry after a lost response reuse the stored message instead of duplicating it.
        pending = { blob, chatId: state.chatId, kind: state.kind, mime: blob.type, durationMs: Math.min(durationMs, settings.maxMs), clientMsgId: 'cli_' + crypto.randomUUID() };
        sendPending();
      }
      async function sendPending() {
        const item = pending; if (!item) return;
        status.textContent = 'در حال ارسال...'; send.disabled = true; show(true);
        try { await upload(item.blob, item); if (pending === item) { pending = null; show(false); } }
        catch (error) { if (pending === item) { status.textContent = error.message || 'ارسال نشد.'; send.textContent = 'تلاش دوباره'; send.disabled = false; } }
      }
      send.addEventListener('click', () => { if (recording) stop(true); else sendPending(); });
      cancel.addEventListener('click', () => { if (recording) stop(false); else { pending = null; show(false); } });

      function remember(id, player) {
        players.set(id, player);
        for (const [oldest, element] of players) {
          if (players.size <= CACHED_PLAYERS) break;
          if (oldest === id || !element.paused) continue;
          URL.revokeObjectURL(element.src); players.delete(oldest);
        }
      }
      // Rendering rebuilds the message list. Reattaching the same element keeps playback running through it.
      function enhance(bubble, msg) {
        if (!msg.media || msg.deletedAt) return;
        const slot = bubble.querySelector('.message-text'); if (!slot) return;
        const existing = players.get(msg.id); if (existing) { slot.replaceWith(existing); return; }
        const settings = KINDS[msg.media.kind]; if (!settings) return;
        const button = document.createElement('button'); button.type = 'button'; button.className = 'media-play'; button.textContent = 'پخش ' + settings.label + ' · ' + clock(msg.media.durationMs);
        button.addEventListener('click', async () => {
          button.disabled = true;
          try {
            const player = document.createElement(settings.tag);
            player.controls = true; player.className = 'media-player'; player.setAttribute('aria-label', settings.label); if (msg.media.kind === 'video') player.playsInline = true;
            player.src = URL.createObjectURL(await download(msg));
            remember(msg.id, player);
            document.getElementById('message-' + msg.id)?.querySelector('.media-play')?.replaceWith(player);
            player.play().catch(() => {});
          } catch (error) { button.disabled = false; notify(error.message || 'پخش پیام ممکن نشد.'); }
        });
        slot.replaceWith(button);
      }
      return {
        enhance,
        reset() { pending = null; if (recording) stop(false); else show(false); },
        purge() { this.reset(); for (const element of players.values()) { element.pause(); URL.revokeObjectURL(element.src); } players.clear(); },
      };
    },
  };
})();
