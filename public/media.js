(() => {
  const KINDS = {
    voice: { label: 'پیام صوتی', types: ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'], constraints: { audio: true }, options: { audioBitsPerSecond: 32000 }, maxMs: 300_000, maxBytes: 4 * 1048576 },
    video: { label: 'پیام تصویری', types: ['video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'], constraints: { audio: true, video: { facingMode: 'user', width: { ideal: 480 }, height: { ideal: 480 } } }, options: { videoBitsPerSecond: 400000, audioBitsPerSecond: 32000 }, maxMs: 60_000, maxBytes: 16 * 1048576 },
  };
  const CACHED_NOTES = 40, BARS = 36, MiB = 1048576;
  const LIMITS = { image: 16 * MiB, file: 32 * MiB };
  const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
  const fileLabel = msg => msg.text.replace(/^(📎|🖼) /, '');
  const fileSize = bytes => bytes < MiB ? Math.max(1, Math.round(bytes / 1024)).toLocaleString('fa-IR') + ' کیلوبایت' : (bytes / MiB).toLocaleString('fa-IR', { maximumFractionDigits: 1 }) + ' مگابایت';
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
    create({ footer, sendButton, getChat, canRecord, upload, download, nativeSave, notify }) {
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
      const picker = create('input', 'media-picker'); picker.type = 'file'; picker.hidden = true;
      const attach = create('button', 'icon-btn media-attach'); attach.type = 'button'; attach.id = 'btn-attach-file'; attach.title = 'ارسال فایل یا تصویر'; attach.setAttribute('aria-label', attach.title);
      attach.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21 11-9.2 9.2a5.5 5.5 0 0 1-7.8-7.8l9.2-9.2a3.7 3.7 0 0 1 5.2 5.2l-9.2 9.2a1.8 1.8 0 0 1-2.6-2.6l8.5-8.5"/></svg>';
      attach.addEventListener('click', () => { if (!recording && !pending && canRecord()) picker.click(); });
      footer.prepend(attach, picker);
      picker.addEventListener('change', () => { const file = picker.files[0]; picker.value = ''; sendFile(file); });
      // A pasted or dropped file asks first, since it may not have been meant for this chat.
      const askToSend = file => { if (file && !recording && !pending && canRecord() && confirm('این فایل ارسال شود؟' + '\n' + file.name)) sendFile(file); };
      footer.querySelector('.message-input')?.addEventListener('paste', event => { const file = event.clipboardData?.files?.[0]; if (file) { event.preventDefault(); askToSend(file); } });
      const dropZone = footer.parentElement;
      dropZone?.addEventListener('dragover', event => { if (event.dataTransfer?.types?.includes('Files')) event.preventDefault(); });
      dropZone?.addEventListener('drop', event => { const file = event.dataTransfer?.files?.[0]; if (file) { event.preventDefault(); askToSend(file); } });
      function sendFile(file) {
        const chat = getChat(); if (!file || !chat) return;
        const kind = IMAGE_TYPES.includes(file.type) && file.size <= LIMITS.image ? 'image' : 'file';
        if (!file.size) { notify('این فایل خالی است.'); return; }
        if (file.size > LIMITS[kind]) { notify('حجم فایل بیشتر از ۳۲ مگابایت است.'); return; }
        pending = { blob: file, chatId: chat.id, kind, mime: file.type || 'application/octet-stream', durationMs: 0, name: file.name, clientMsgId: 'cli_' + crypto.randomUUID() };
        sendPending();
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
      async function saveFile(msg, name) {
        if (nativeSave?.(msg, name, msg.media.mime)) { notify('دریافت فایل شروع شد.'); return; }
        const url = URL.createObjectURL(await download(msg)), link = create('a'); link.href = url; link.download = name; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
      function buildFile(msg) {
        const name = fileLabel(msg), root = create('button', 'file-note'); root.type = 'button'; root.setAttribute('aria-label', 'دریافت فایل ' + name);
        const icon = create('span', 'file-icon'), title = create('bdi', 'file-name'), size = create('span', 'file-size');
        icon.setAttribute('aria-hidden', 'true'); title.textContent = name; size.textContent = fileSize(msg.media.size);
        const text = create('span', 'file-text'); text.append(title, size); root.append(icon, text);
        root.addEventListener('click', async () => { root.dataset.state = 'loading'; try { await saveFile(msg, name); } catch (error) { notify(error.message || 'دریافت فایل ممکن نشد.'); } delete root.dataset.state; });
        return root;
      }
      const lightbox = create('dialog', 'image-viewer'); lightbox.setAttribute('aria-label', 'نمایش تصویر');
      const large = create('img'), closeLarge = create('button', 'quiet-button'), saveLarge = create('button', 'quiet-button');
      closeLarge.type = saveLarge.type = 'button'; closeLarge.textContent = 'بستن'; saveLarge.textContent = 'ذخیرهٔ تصویر';
      const lightboxActions = create('div', 'button-row'); lightboxActions.append(saveLarge, closeLarge); lightbox.append(large, lightboxActions); document.body.append(lightbox);
      closeLarge.addEventListener('click', () => lightbox.close()); lightbox.addEventListener('click', event => { if (event.target === lightbox) lightbox.close(); });
      function buildImage(msg) {
        const name = fileLabel(msg), root = create('button', 'image-note'), image = create('img'); root.type = 'button'; root.dataset.state = 'loading'; root.setAttribute('aria-label', 'نمایش تصویر ' + name); root.append(image);
        const load = async () => { try { root.url = URL.createObjectURL(await download(msg)); image.alt = name; image.src = root.url; delete root.dataset.state; } catch { root.dataset.state = 'failed'; } };
        // Only images that scroll into view are fetched, so opening a long chat stays cheap.
        if (typeof IntersectionObserver === 'function') { const seen = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { seen.disconnect(); load(); } }); seen.observe(root); } else load();
        root.addEventListener('click', () => { if (!root.url) return; large.src = root.url; large.alt = name; saveLarge.onclick = () => saveFile(msg, name).catch(error => notify(error.message)); lightbox.showModal(); });
        return root;
      }
      function evict() {
        for (const [id, note] of notes) {
          if (notes.size <= CACHED_NOTES) return;
          if (note.isConnected || (note.player && !note.player.paused)) continue;
          if (note.player) URL.revokeObjectURL(note.player.src);
          if (note.url) URL.revokeObjectURL(note.url);
          notes.delete(id);
        }
      }
      function enhance(bubble, msg) {
        if (!msg.media || msg.deletedAt) return;
        const slot = bubble.querySelector('.message-text'), settings = KINDS[msg.media.kind], plain = msg.media.kind === 'image' ? buildImage : msg.media.kind === 'file' ? buildFile : null; if (!slot || (!settings && !plain)) return;
        let note = notes.get(msg.id);
        if (!note) { note = plain ? plain(msg) : buildNote(msg, settings); notes.set(msg.id, note); evict(); }
        bubble.classList.add('has-media', 'media-' + msg.media.kind); slot.replaceWith(note);
      }
      return {
        enhance,
        reset() { pending = null; if (recording) stop(false); else show(false); },
        purge() { this.reset(); for (const note of notes.values()) { if (note.player) { note.player.pause(); URL.revokeObjectURL(note.player.src); } if (note.url) URL.revokeObjectURL(note.url); } notes.clear(); },
      };
    },
  };
})();
