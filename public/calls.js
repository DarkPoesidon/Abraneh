(() => {
  const directIce = [{ urls: 'stun:stun.l.google.com:19302' }];
  window.WihmCalls = {
    create({ getChat, getUser, send, mount, activate = async () => {}, getIceServers = async () => directIce, notify = () => {} }) {
      let current = null;
      const dialog = document.createElement('dialog');
      dialog.className = 'modal-card call-dialog'; dialog.setAttribute('aria-label', 'تماس خصوصی');
      const title = document.createElement('h3'), status = document.createElement('p'), privacy = document.createElement('p');
      status.setAttribute('role', 'status'); privacy.className = 'feature-hint';
      privacy.textContent = 'پس از پذیرش تماس، نشانی اینترنتی شما ممکن است برای مخاطب و سرویس اتصال STUN/TURN آشکار شود. صدا و تصویر از مسیر WebRTC رمزگذاری می‌شود؛ اثرانگشت مستقل هویت تماس در این نسخه وجود ندارد. دسترسی میکروفون و دوربین فقط با شروع یا پذیرش شما درخواست می‌شود. برای شبکه‌های محدود، مدیر باید واسط TURN را فعال کند.';
      const local = document.createElement('video'), remote = document.createElement('video'), audio = document.createElement('audio');
      local.className = 'call-self'; remote.className = 'call-remote';
      const stage = document.createElement('div'), avatar = document.createElement('div'); stage.className = 'call-stage'; avatar.className = 'call-avatar'; avatar.setAttribute('aria-hidden', 'true');
      stage.append(avatar, remote, local);
      for (const media of [local, remote, audio]) { media.autoplay = true; media.playsInline = true; media.hidden = true; }
      audio.setAttribute('aria-label', 'صدای مخاطب');
      local.muted = remote.muted = true; local.setAttribute('aria-label', 'تصویر خودتان'); remote.setAttribute('aria-label', 'تصویر مخاطب');
      const accept = document.createElement('button'), decline = document.createElement('button'), end = document.createElement('button');
      for (const button of [accept, decline, end]) { button.type = 'button'; button.className = 'btn-primary'; }
      accept.textContent = 'پذیرش تماس'; accept.title = 'پذیرش تماس و اجازهٔ میکروفون یا دوربین'; decline.textContent = 'رد تماس'; end.textContent = 'پایان تماس';
      const microphone = document.createElement('button'), camera = document.createElement('button'), speaker = document.createElement('button'), play = document.createElement('button');
      for (const button of [microphone, camera, speaker, play]) { button.type = 'button'; button.className = 'quiet-button'; button.hidden = true; }
      microphone.textContent = 'قطع میکروفون'; camera.textContent = 'خاموش کردن دوربین'; play.textContent = 'پخش صدای مخاطب';
      speaker.textContent = 'قطع صدای مخاطب'; speaker.className += ' call-speaker';
      const actions = document.createElement('div'); actions.className = 'call-actions'; actions.append(microphone, camera, speaker, play);
      microphone.className += ' call-microphone'; camera.className += ' call-camera';
      end.className = decline.className = 'btn-primary call-end'; accept.className += ' call-accept';
      const information = document.createElement('details'), summary = document.createElement('summary'); information.className = 'call-information'; summary.textContent = 'حریم خصوصی و محدودیت اتصال'; information.append(summary, privacy);
      const decisions = document.createElement('div'); decisions.className = 'call-decisions'; decisions.append(accept, decline, end);
      dialog.append(title, status, stage, audio, actions, decisions, information); document.body.appendChild(dialog);
      let ringStop = null;
      // Browsers may keep this silent until the page has had a user gesture; the dialog and vibration still show.
      function startRing() {
        if (ringStop) return;
        const Context = window.AudioContext || window.webkitAudioContext, sound = Context ? new Context() : null;
        const ring = () => {
          navigator.vibrate?.([400, 200, 400]);
          if (!sound) return;
          sound.resume?.()?.catch?.(() => {});
          const oscillator = sound.createOscillator(), gain = sound.createGain();
          oscillator.frequency.value = 480; gain.gain.value = 0.08;
          oscillator.connect(gain); gain.connect(sound.destination);
          oscillator.start(); oscillator.stop(sound.currentTime + 1);
        };
        ring(); const timer = setInterval(ring, 3000);
        ringStop = () => { clearInterval(timer); navigator.vibrate?.(0); sound?.close?.()?.catch?.(() => {}); ringStop = null; };
      }
      function emit(kind, payload) {
        if (!current) return;
        send({ action: 'call_signal', chatId: current.chatId, callId: current.id, kind,
          ...(kind === 'invite' ? { video: current.video } : {}), ...(payload ? { payload } : {}) });
      }
      function reset(signal = true, message = '') {
        const previous = current;
        if (signal && previous) try { emit(previous.incoming && !previous.accepted ? 'decline' : 'end'); } catch {}
        current = null; ringStop?.();
        if (previous) {
          clearTimeout(previous.timer); clearTimeout(previous.connectTimer); clearTimeout(previous.restartTimer); clearTimeout(previous.failTimer); clearInterval(previous.durationTimer);
          if (previous.peer) { previous.peer.onicecandidate = previous.peer.ontrack = previous.peer.onconnectionstatechange = null; previous.peer.close(); }
          previous.stream?.getTracks().forEach(track => track.stop());
        }
        local.srcObject = remote.srcObject = audio.srcObject = null;
        for (const node of [local, remote, audio, microphone, camera, speaker, play]) node.hidden = true;
        if (dialog.open) dialog.close();
        if (message) notify(message);
      }
      function failure(error) {
        if (['NotAllowedError', 'SecurityError'].includes(error?.name)) return 'مجوز میکروفون یا دوربین رد شد؛ از مجوزهای سایت در مرورگر فعالش کنید.';
        if (error?.name === 'NotFoundError') return 'میکروفون یا دوربین پیدا نشد؛ اتصال دستگاه را بررسی کنید.';
        if (error?.name === 'NotReadableError') return 'میکروفون یا دوربین در اختیار برنامهٔ دیگری است یا قابل استفاده نیست.';
        return error?.name === 'Error' ? error.message : 'برقراری تماس کامل نشد؛ مجوز میکروفون و دوربین و اتصال شبکه را بررسی کنید.';
      }
      function deadline(expiresAt) {
        clearTimeout(current.timer);
        current.timer = setTimeout(() => reset(true, 'زمان تماس پایان یافت.'), Math.max(0, Math.min(expiresAt - Date.now(), 15 * 60_000)));
      }
      function show(incoming) {
        title.textContent = `${current.video ? 'تماس تصویری' : 'تماس صوتی'} · ${getChat(current.chatId)?.title || getChat(current.chatId)?.partnerName || 'گفتگوی خصوصی'}`;
        avatar.textContent = [...(getChat(current.chatId)?.title || getChat(current.chatId)?.partnerName || '؟')][0]; avatar.hidden = false;
        status.textContent = incoming ? 'تماس ورودی؛ تا پذیرش شما صدا و تصویر ارسال نمی‌شود.' : 'در انتظار پذیرش مخاطب…';
        accept.hidden = decline.hidden = !incoming; end.hidden = incoming; accept.disabled = false;
        for (const node of [local, remote, audio, microphone, camera, speaker, play]) node.hidden = true;
        audio.muted = false; speaker.textContent = 'قطع صدای مخاطب'; speaker.setAttribute('aria-pressed', 'false');
        microphone.textContent = 'قطع میکروفون'; camera.textContent = 'خاموش کردن دوربین';
        microphone.setAttribute('aria-pressed', 'false'); camera.setAttribute('aria-pressed', 'false');
        if (!dialog.open) dialog.showModal();
        if (incoming) startRing();
      }
      // Only the caller restarts ICE, so both sides can't send colliding offers.
      async function restartIce(call) {
        if (current !== call || call.incoming || !call.peer || call.restarts >= 3 || call.peer.signalingState !== 'stable') return;
        call.restarts++; call.peer.restartIce();
        try { await description('offer'); } catch {} // connectionRestored resends the offer once the socket is back.
      }
      async function capture(video) {
        try { return { stream: await navigator.mediaDevices.getUserMedia({ audio: true, video }), hasVideo: video }; }
        catch (error) {
          if (!video) throw error;
          return { stream: await navigator.mediaDevices.getUserMedia({ audio: true, video: false }), hasVideo: false };
        }
      }
      // Candidates that can't be sent wait for the socket to reconnect; losing one must not end the call.
      function flushIce(call) {
        while (call.sentSdp && call.localIce.length) {
          try { emit('ice', call.localIce[0]); call.localIce.shift(); } catch { return; }
        }
      }
      async function prepare() {
        const call = current;
        // Without TURN credentials a direct connection may still work.
        const iceServers = await getIceServers(call.chatId, call.id).catch(() => directIce);
        if (current !== call) return null;
        const { stream, hasVideo } = await capture(call.video);
        if (current !== call) { stream.getTracks().forEach(track => track.stop()); return null; }
        call.stream = stream; local.srcObject = stream; local.hidden = !hasVideo;
        microphone.hidden = false; camera.hidden = !hasVideo;
        if (call.video && !hasVideo) notify('دوربین در دسترس نیست؛ تماس بدون تصویر شما ادامه می‌یابد.');
        const peer = call.peer = new RTCPeerConnection({ iceServers });
        stream.getTracks().forEach(track => peer.addTrack(track, stream));
        // An offer without a video section would stop the other side from sending theirs.
        if (call.video && !hasVideo && !call.incoming) peer.addTransceiver('video', { direction: 'recvonly' });
        peer.onicecandidate = event => {
          if (current !== call || !event.candidate) return;
          if (call.localIce.length < 100) call.localIce.push(event.candidate.toJSON());
          flushIce(call);
        };
        peer.ontrack = event => {
          if (current !== call) return;
          const video = event.track.kind === 'video', media = video ? remote : audio;
          if (video && !call.video) return;
          media.hidden = !video;
          // Separate sinks let muted video render without waiting for audio playback permission.
          media.srcObject = new MediaStream([event.track]);
          if (video) avatar.hidden = true; else speaker.hidden = false;
          media.play().then(() => { if (current === call && !video) play.hidden = true; }).catch(error => { if (current === call && !video && error.name !== 'AbortError') { play.hidden = false; status.textContent = 'برای شنیدن صدا، «پخش صدای مخاطب» را بزنید.'; } });
        };
        peer.onconnectionstatechange = () => {
          if (current !== call) return;
          if (peer.connectionState === 'connected') {
            clearTimeout(call.connectTimer); clearTimeout(call.restartTimer); clearTimeout(call.failTimer); call.restartTimer = call.failTimer = null; call.restarts = 0;
            if (!call.connectedAt) {
              call.connectedAt = Date.now();
              const duration = () => { const seconds = Math.floor((Date.now() - call.connectedAt) / 1000); status.textContent = 'تماس برقرار است. · ' + Math.floor(seconds / 60).toLocaleString('fa-IR', { minimumIntegerDigits: 2 }) + ':' + (seconds % 60).toLocaleString('fa-IR', { minimumIntegerDigits: 2 }); };
              duration(); call.durationTimer = setInterval(duration, 1000);
            }
          }
          // A network change shows up as disconnected, then failed. Try a new path before giving up.
          if (peer.connectionState === 'disconnected' && !call.restartTimer) call.restartTimer = setTimeout(() => { call.restartTimer = null; restartIce(call); }, 3000);
          if (peer.connectionState === 'failed') {
            restartIce(call);
            if (!call.failTimer) call.failTimer = setTimeout(() => { if (current === call) reset(true, 'ارتباط مستقیم برقرار نشد؛ شبکهٔ محدود ممکن است به سرور TURN نیاز داشته باشد.'); }, 30_000);
          }
        };
        call.connectTimer = setTimeout(() => { if (current === call && peer.connectionState !== 'connected') reset(true, 'تماس برقرار نشد؛ دسترسی شبکه و نیاز به TURN را بررسی کنید.'); }, 45_000);
        return peer;
      }
      async function description(kind) {
        const call = current, peer = call.peer;
        await peer.setLocalDescription(kind === 'offer' ? await peer.createOffer() : await peer.createAnswer());
        if (current !== call) return;
        emit(kind, { type: peer.localDescription.type, sdp: peer.localDescription.sdp }); call.sentSdp = true;
        flushIce(call);
      }
      async function remoteDescription(payload) {
        const call = current;
        await call.peer.setRemoteDescription(payload);
        if (current !== call) return;
        for (const ice of call.remoteIce.splice(0)) await call.peer.addIceCandidate(ice);
      }
      function base(id, chatId, video, incoming) {
        return { id, chatId, video, incoming, accepted: false, localIce: [], remoteIce: [], sentSdp: false, restarts: 0 };
      }
      async function start(video = false) {
        const chat = getChat();
        if (current) { notify('ابتدا تماس قبلی را پایان دهید.'); return; }
        if (chat?.type !== 'dm' || !getUser() || !navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === 'undefined') { notify('تماس به مرورگر پشتیبانی‌شده، HTTPS و گفتگوی خصوصی نیاز دارد.'); return; }
        current = base(crypto.randomUUID(), chat.id, !!video, false); show(false); deadline(Date.now() + 45_000);
        // The caller explicitly confirms before any network address or media is shared.
        if (!confirm(`تماس ${video ? 'تصویری با دوربین و میکروفون' : 'صوتی با میکروفون'} شروع شود؟ تماس ممکن است نشانی اینترنتی شما را برای مخاطب و سرویس STUN/TURN آشکار کند.`)) { reset(false); return; }
        try { emit('invite'); } catch { reset(false, 'ابتدا اتصال گفتگو به سرور را برقرار کنید.'); }
      }
      async function receive(data) {
        if (data.event === 'call_error') { if (current?.id === data.callId) reset(false, data.message); return; }
        if (data.event !== 'call_signal' || !getUser() || !getChat(data.chatId)) return;
        if (data.kind === 'claimed') { if (current?.id === data.callId && current.incoming && !current.accepted) reset(false, 'تماس در دستگاه دیگری پذیرفته شد.'); return; }
        if (data.from === getUser().id) return;
        if (data.kind === 'invite') {
          if (current || data.expiresAt <= Date.now()) return;
          current = base(data.callId, data.chatId, data.video === true, true); show(true); deadline(data.expiresAt); return;
        }
        if (!current || current.id !== data.callId) return;
        const call = current;
        try {
          if (data.kind === 'end' || data.kind === 'decline') { reset(false, data.kind === 'decline' ? 'تماس رد شد.' : 'تماس پایان یافت.'); return; }
          if (data.kind === 'accept' && !call.incoming && !call.accepted) {
            call.accepted = true; deadline(data.expiresAt); status.textContent = 'در حال اتصال…';
            if (await prepare() && current === call) await description('offer');
          } else if (data.kind === 'offer' && call.incoming && call.accepted && call.peer) {
            await remoteDescription(data.payload);
            if (current === call) await description('answer');
          } else if (data.kind === 'answer' && !call.incoming && call.peer && call.peer.signalingState !== 'stable') await remoteDescription(data.payload);
          else if (data.kind === 'ice' && call.accepted) {
            if (call.peer?.remoteDescription) await call.peer.addIceCandidate(data.payload);
            else if (call.remoteIce.length < 100) call.remoteIce.push(data.payload);
          }
        } catch (error) { if (current === call) reset(true, failure(error)); }
      }
      accept.onclick = async () => {
        if (!current || current.accepted) return;
        const call = current; call.accepted = true; accept.disabled = true; ringStop?.();
        try {
          await activate(call.chatId);
          if (current !== call) return;
          if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === 'undefined') throw new Error('unsupported');
          if (!await prepare() || current !== call) return;
          accept.hidden = decline.hidden = true; end.hidden = false; status.textContent = 'در حال اتصال…';
          emit('accept'); deadline(Date.now() + 15 * 60_000);
        } catch (error) { if (current === call) reset(true, failure(error)); }
      };
      decline.onclick = end.onclick = () => reset();
      microphone.onclick = () => {
        const tracks = current?.stream?.getAudioTracks() || []; if (!tracks.length) return;
        const muted = tracks[0].enabled; tracks.forEach(track => { track.enabled = !muted; });
        microphone.textContent = muted ? 'وصل میکروفون' : 'قطع میکروفون'; microphone.setAttribute('aria-pressed', String(muted));
      };
      camera.onclick = () => {
        const tracks = current?.stream?.getVideoTracks() || []; if (!tracks.length) return;
        const disabled = tracks[0].enabled; tracks.forEach(track => { track.enabled = !disabled; });
        camera.textContent = disabled ? 'روشن کردن دوربین' : 'خاموش کردن دوربین'; camera.setAttribute('aria-pressed', String(disabled));
      };
      speaker.onclick = () => { audio.muted = !audio.muted; speaker.textContent = audio.muted ? 'وصل صدای مخاطب' : 'قطع صدای مخاطب'; speaker.setAttribute('aria-pressed', String(audio.muted)); };
      play.onclick = () => { audio.play().then(() => { play.hidden = true; }).catch(() => { status.textContent = 'مرورگر پخش را مجاز نکرد؛ مجوز صدای سایت را بررسی کنید.'; }); };
      dialog.addEventListener('cancel', event => { event.preventDefault(); reset(); });
      window.addEventListener('pagehide', () => reset());
      if (mount) for (const [label, video] of [['تماس صوتی', false], ['تماس تصویری', true]]) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'icon-btn call-launch'; button.title = label; button.setAttribute('aria-label', label);
        button.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${video ? '<rect x="3" y="5" width="12" height="14" rx="3"/><path d="m15 10 6-4v12l-6-4"/>' : '<path d="M22 16.9v3a2 2 0 0 1-2.2 2A20 20 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7l.5 3a2 2 0 0 1-.6 1.7L7.7 9.7a16 16 0 0 0 6.6 6.6l1.3-1.3a2 2 0 0 1 1.7-.6l3 .5a2 2 0 0 1 1.7 2z"/>'}</svg>`;
        button.addEventListener('click', () => start(video)); mount.appendChild(button);
      }
      return { start, receive, reset, active: () => !!current,
        connectionLost: () => { if (current && !current.accepted) reset(false); },
        connectionRestored: () => {
          if (!current) return;
          const offer = current.peer?.signalingState === 'have-local-offer' && !current.incoming && current.peer.localDescription;
          if (offer) try { emit('offer', { type: offer.type, sdp: offer.sdp }); } catch {}
          flushIce(current);
        }, ringingId: () => current?.incoming && !current.accepted ? current.id : null };
    },
  };
})();
