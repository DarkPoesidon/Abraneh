(() => {
  const KINDS = {
    voice: { label: 'پیام صوتی', types: ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'], constraints: { audio: true }, options: { audioBitsPerSecond: 32000 }, maxMs: 300_000, maxBytes: 4 * 1048576 },
    video: { label: 'پیام تصویری', types: ['video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'], constraints: { audio: true, video: { facingMode: 'user', width: { ideal: 480 }, height: { ideal: 480 } } }, options: { videoBitsPerSecond: 400000, audioBitsPerSecond: 32000 }, maxMs: 60_000, maxBytes: 16 * 1048576 },
  };
  const CACHED_NOTES = 40, BARS = 36;
  const clock = ms => { const seconds = Math.round(ms / 1000); return Math.floor(seconds / 60).toLocaleString('fa-IR') + ':' + (seconds % 60).toLocaleString('fa-IR', { minimumIntegerDigits: 2 }); };
  const create = (tag, className) => { const node = document.createElement(tag); if (className) node.className = className; return node; };
  function failure(error) {
    if (['NotAllowedError', 'SecurityError'].includes(error?.name)) return 'مجوز میکروفون یا دوربین رد شد؛ از مجوزهای سایت در مرورگر فعالش کنید.';
    if (['NotFoundError', 'OverconstrainedError'].includes(error?.name)) return 'میکروفون یا دوربین پیدا نشد؛ اتصال دستگاه را بررسی کنید.';
    if (error?.name === 'NotReadableError') return 'میکروفون یا دوربین در اختیار برنامهٔ دیگری است.';
    return 'ضبط پیام شروع نشد؛ دوباره تلاش کنید.';
  }
  // Real peaks need the audio itself, so bars stay flat until the first play instead of showing an invented shape.
  async function drawPeaks(blob, bars) {
    const Context = window.AudioContext || window.webkitAudioContext; if (!Context) return;
    const decoder = new Context();
    try {
      const samples = (await decoder.decodeAudioData(await blob.arrayBuffer())).getChannelData(0), step = Math.max(1, Math.floor(samples.length / BARS)), peaks = [];
      for (let bar = 0; bar < BARS; bar++) { let peak = 0; for (let i = bar * step; i < (bar + 1) * step && i < samples.length; i += 16) peak = Math.max(peak, Math.abs(samples[i])); peaks.push(peak); }
      const loudest = Math.max(...peaks) || 1;
      peaks.forEach((peak, index) => { bars.children[index].style.setProperty('--level', String(Math.max(0.12, peak / loudest))); });
    } catch {} finally { decoder.close?.().catch?.(() => {}); }
  }
  window.WihmMedia = {
    create({ footer, sendButton, getChat, canRecord, upload, download, notify }) {
      const notes = new Map(); let recording = null, pending = null;
      const bar = create('div', 'media-recorder'); bar.hidden = true;
      const preview = create('video', 'media-preview'), status = create('span', 'media-status'), send = create('button', 'btn-primary media-send'), cancel = create('button', 'quiet-button media-cancel');
      preview.muted = preview.playsInline = preview.autoplay = true; preview.hidden = true; preview.setAttribute('aria-label', 'پیش‌نمایش دوربین');
      status.setAttribute('role', 'status'); send.type = cancel.type = 'button'; cancel.textContent = 'لغو';
      bar.append(preview, status, send, cancel); footer.append(bar);

      const supported = typeof MediaRecorder !== 'undefined' && navigator.mediaDevices?.getUserMedia;
      if (supported) {
        footer.classList.add('can-record');
        for (const [kind, icon] of [['video', '<rect x="3" y="5" width="12" height="14" rx="3"/><path d="m15 10 6-4v12l-6-4"/>'], ['voice', '<path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>']]) {
          const button = create('button', 'icon-btn media-record'); button.type = 'button'; button.id = 'btn-record-' + kind; button.title = 'ضبط ' + KINDS[kind].label; button.setAttribute('aria-label', button.title);
          button.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg>`;
          button.addEventListener('click', () => start(kind)); footer.insertBefore(button, sendButton);
        }
      }
      function show(on) { bar.hidden = !on; footer.classList.toggle('recording', on); if (!on) delete bar.dataset.state; }
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
        send.textContent = 'ارسال'; send.disabled = false; show(true); bar.dataset.state = 'recording';
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
        delete bar.dataset.state; status.textContent = 'در حال ارسال...'; send.disabled = true; show(true);
        try { await upload(item.blob, item); if (pending === item) { pending = null; show(false); } }
        catch (error) { if (pending === item) { status.textContent = error.message || 'ارسال نشد.'; send.textContent = 'تلاش دوباره'; send.disabled = false; } }
      }
      send.addEventListener('click', () => { if (recording) stop(true); else sendPending(); });
      cancel.addEventListener('click', () => { if (recording) stop(false); else { pending = null; show(false); } });

      // One element per message: rendering rebuilds the list, and reattaching the same node keeps playback running.
      function buildNote(msg, settings) {
        const video = msg.media.kind === 'video', total = msg.media.durationMs / 1000 || 0;
        const root = create('div', video ? 'video-note' : 'voice-note'), toggle = create('button', 'media-play'), time = create('span', 'media-time');
        toggle.type = 'button'; toggle.setAttribute('aria-label', 'پخش ' + settings.label + ' · ' + clock(msg.media.durationMs)); time.textContent = clock(msg.media.durationMs);
        let bars, seek, player = null;
        if (video) root.append(toggle, time);
        else {
          bars = create('div', 'voice-bars'); for (let i = 0; i < BARS; i++) bars.append(create('span'));
          seek = create('input', 'voice-seek'); seek.type = 'range'; seek.min = 0; seek.max = 1000; seek.value = 0; seek.disabled = true; seek.setAttribute('aria-label', 'جابه‌جایی در ' + settings.label);
          const track = create('div', 'voice-track'); track.append(bars, seek);
          root.append(toggle, track, time);
        }
        const show = () => {
          const position = player?.currentTime || 0, length = Number.isFinite(player?.duration) && player.duration > 0 ? player.duration : total;
          time.textContent = clock(position ? position * 1000 : msg.media.durationMs);
          if (!seek) return;
          const fraction = length ? Math.min(1, position / length) : 0;
          seek.value = fraction * 1000; bars.style.setProperty('--progress', String(fraction));
        };
        toggle.addEventListener('click', async () => {
          if (player) { if (player.paused) player.play().catch(() => {}); else player.pause(); return; }
          toggle.disabled = true; root.dataset.state = 'loading';
          try {
            const blob = await download(msg);
            player = create(video ? 'video' : 'audio', 'media-player');
            player.src = URL.createObjectURL(blob); player.setAttribute('aria-label', settings.label);
            if (video) { player.playsInline = true; player.addEventListener('click', () => toggle.click()); root.prepend(player); } else { root.append(player); drawPeaks(blob, bars); seek.disabled = false; }
            for (const event of ['play', 'pause', 'ended']) player.addEventListener(event, () => { root.dataset.state = player.paused ? 'paused' : 'playing'; toggle.setAttribute('aria-label', (player.paused ? 'پخش ' : 'توقف ') + settings.label); if (event === 'ended') { player.currentTime = 0; show(); } });
            player.addEventListener('timeupdate', show);
            root.player = player; player.play().catch(() => { root.dataset.state = 'paused'; });
          } catch (error) { delete root.dataset.state; notify(error.message || 'پخش پیام ممکن نشد.'); }
          toggle.disabled = false;
        });
        seek?.addEventListener('input', () => { if (player && total) try { player.currentTime = (Number(seek.value) / 1000) * (Number.isFinite(player.duration) && player.duration > 0 ? player.duration : total); } catch {} });
        return root;
      }
      function evict() {
        for (const [id, note] of notes) {
          if (notes.size <= CACHED_NOTES) return;
          if (note.player && !note.player.paused) continue;
          if (note.player) URL.revokeObjectURL(note.player.src);
          notes.delete(id);
        }
      }
      function enhance(bubble, msg) {
        if (!msg.media || msg.deletedAt) return;
        const slot = bubble.querySelector('.message-text'), settings = KINDS[msg.media.kind]; if (!slot || !settings) return;
        let note = notes.get(msg.id);
        if (!note) { note = buildNote(msg, settings); notes.set(msg.id, note); evict(); }
        bubble.classList.add('has-media', 'media-' + msg.media.kind); slot.replaceWith(note);
      }
      return {
        enhance,
        reset() { pending = null; if (recording) stop(false); else show(false); },
        purge() { this.reset(); for (const note of notes.values()) if (note.player) { note.player.pause(); URL.revokeObjectURL(note.player.src); } notes.clear(); },
      };
    },
  };
})();
