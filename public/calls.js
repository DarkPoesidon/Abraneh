(() => {
  window.WihmCalls = {
    create({ getChat, getUser, send, mount, notify = () => {} }) {
      let current = null;
      const dialog = document.createElement('dialog');
      dialog.className = 'modal-card'; dialog.setAttribute('aria-label', 'تماس خصوصی');
      const title = document.createElement('h3'), status = document.createElement('p'), privacy = document.createElement('p');
      status.setAttribute('role', 'status'); privacy.className = 'feature-hint';
      privacy.textContent = 'تماس مستقیم است و نشانی اینترنتی شما ممکن است برای مخاطب و سرویس STUN گوگل آشکار شود. فقط با زدن پذیرش یا شروع تماس، میکروفون و برای تماس تصویری دوربین درخواست می‌شود. هر دو نفر باید همین گفتگوی خصوصی را باز نگه دارند. در بعضی شبکه‌ها تماس بدون TURN برقرار نمی‌شود.';
      const local = document.createElement('video'), remote = document.createElement('video');
      for (const video of [local, remote]) { video.autoplay = true; video.playsInline = true; video.controls = true; video.style.maxWidth = '100%'; }
      local.muted = true; local.setAttribute('aria-label', 'تصویر خودتان'); remote.setAttribute('aria-label', 'صدا و تصویر مخاطب');
      const accept = document.createElement('button'), decline = document.createElement('button'), end = document.createElement('button');
      for (const button of [accept, decline, end]) { button.type = 'button'; button.className = 'btn-primary'; }
      accept.textContent = 'پذیرش و اجازهٔ میکروفون / دوربین'; decline.textContent = 'رد تماس'; end.textContent = 'پایان تماس';
      dialog.append(title, status, privacy, remote, local, accept, decline, end); document.body.appendChild(dialog);
      function emit(kind, payload) {
        if (!current) return;
        send({ action: 'call_signal', chatId: current.chatId, callId: current.id, kind,
          ...(kind === 'invite' ? { video: current.video } : {}), ...(payload ? { payload } : {}) });
      }
      function reset(signal = true, message = '') {
        const previous = current;
        if (signal && previous) try { emit(previous.incoming && !previous.accepted ? 'decline' : 'end'); } catch {}
        current = null;
        if (previous) {
          clearTimeout(previous.timer); clearTimeout(previous.connectTimer);
          if (previous.peer) { previous.peer.onicecandidate = previous.peer.ontrack = previous.peer.onconnectionstatechange = null; previous.peer.close(); }
          previous.stream?.getTracks().forEach(track => track.stop());
        }
        local.srcObject = remote.srcObject = null;
        if (dialog.open) dialog.close();
        if (message) notify(message);
      }
      function deadline(expiresAt) {
        clearTimeout(current.timer);
        current.timer = setTimeout(() => reset(true, 'زمان تماس پایان یافت.'), Math.max(0, Math.min(expiresAt - Date.now(), 15 * 60_000)));
      }
      function show(incoming) {
        title.textContent = `${current.video ? 'تماس تصویری' : 'تماس صوتی'} · ${getChat()?.title || getChat()?.partnerName || 'گفتگوی خصوصی'}`;
        status.textContent = incoming ? 'تماس ورودی؛ تا پذیرش شما صدا و تصویر ارسال نمی‌شود.' : 'در انتظار پذیرش مخاطب…';
        accept.hidden = decline.hidden = !incoming; end.hidden = incoming; accept.disabled = false;
        if (!dialog.open) dialog.showModal();
      }
      async function prepare() {
        const call = current;
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: call.video });
        if (current !== call) { stream.getTracks().forEach(track => track.stop()); return null; }
        call.stream = stream; local.srcObject = stream; local.hidden = !call.video;
        const peer = call.peer = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
        stream.getTracks().forEach(track => peer.addTrack(track, stream));
        peer.onicecandidate = event => {
          if (current !== call || !event.candidate) return;
          const candidate = event.candidate.toJSON();
          if (call.sentSdp) { try { emit('ice', candidate); } catch { reset(false, 'ارتباط با سرور تماس قطع شد.'); } }
          else if (call.localIce.length < 100) call.localIce.push(candidate);
        };
        peer.ontrack = event => {
          if (current !== call) return;
          remote.srcObject = event.streams[0] || new MediaStream([event.track]);
          remote.play().catch(() => { status.textContent = 'برای شنیدن صدا، پخش ویدئو را بزنید.'; });
        };
        peer.onconnectionstatechange = () => {
          if (current !== call) return;
          if (peer.connectionState === 'connected') { clearTimeout(call.connectTimer); status.textContent = 'تماس برقرار است.'; }
          if (peer.connectionState === 'failed') reset(true, 'ارتباط مستقیم برقرار نشد؛ شبکهٔ محدود ممکن است به سرور TURN نیاز داشته باشد.');
        };
        call.connectTimer = setTimeout(() => { if (current === call && peer.connectionState !== 'connected') reset(true, 'تماس برقرار نشد؛ دسترسی شبکه و نیاز به TURN را بررسی کنید.'); }, 45_000);
        return peer;
      }
      async function description(kind) {
        const call = current, peer = call.peer;
        await peer.setLocalDescription(kind === 'offer' ? await peer.createOffer() : await peer.createAnswer());
        if (current !== call) return;
        emit(kind, { type: peer.localDescription.type, sdp: peer.localDescription.sdp }); call.sentSdp = true;
        for (const ice of call.localIce.splice(0)) emit('ice', ice);
      }
      async function remoteDescription(payload) {
        const call = current;
        await call.peer.setRemoteDescription(payload);
        if (current !== call) return;
        for (const ice of call.remoteIce.splice(0)) await call.peer.addIceCandidate(ice);
      }
      function base(id, chatId, video, incoming) {
        return { id, chatId, video, incoming, accepted: false, localIce: [], remoteIce: [], sentSdp: false };
      }
      async function start(video = false) {
        const chat = getChat();
        if (current) { notify('ابتدا تماس قبلی را پایان دهید.'); return; }
        if (chat?.type !== 'dm' || !getUser() || !navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === 'undefined') { notify('تماس به مرورگر پشتیبانی‌شده، HTTPS و گفتگوی خصوصی نیاز دارد.'); return; }
        current = base(crypto.randomUUID(), chat.id, !!video, false); show(false); deadline(Date.now() + 45_000);
        // The caller explicitly confirms before any network address or media is shared.
        if (!confirm(`تماس ${video ? 'تصویری با دوربین و میکروفون' : 'صوتی با میکروفون'} شروع شود؟ تماس مستقیم ممکن است نشانی اینترنتی شما را برای مخاطب و STUN گوگل آشکار کند.`)) { reset(false); return; }
        try { emit('invite'); } catch { reset(false, 'ابتدا اتصال گفتگو به سرور را برقرار کنید.'); }
      }
      async function receive(data) {
        if (data.event === 'call_error') { if (current?.id === data.callId) reset(false, data.message); return; }
        if (data.event !== 'call_signal' || data.chatId !== getChat()?.id || !getUser()) return;
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
          } else if (data.kind === 'answer' && !call.incoming && call.peer) await remoteDescription(data.payload);
          else if (data.kind === 'ice' && call.accepted) {
            if (call.peer?.remoteDescription) await call.peer.addIceCandidate(data.payload);
            else if (call.remoteIce.length < 100) call.remoteIce.push(data.payload);
          }
        } catch { if (current === call) reset(true, 'برقراری تماس کامل نشد؛ مجوز میکروفون و دوربین و اتصال شبکه را بررسی کنید.'); }
      }
      accept.onclick = async () => {
        if (!current || current.accepted) return;
        const call = current; call.accepted = true; accept.disabled = true;
        try {
          if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === 'undefined') throw new Error('unsupported');
          if (!await prepare() || current !== call) return;
          accept.hidden = decline.hidden = true; end.hidden = false; status.textContent = 'در حال اتصال…';
          emit('accept'); deadline(Date.now() + 15 * 60_000);
        } catch { if (current === call) reset(true, 'مجوز میکروفون یا دوربین داده نشد؛ تماس پایان یافت.'); }
      };
      decline.onclick = end.onclick = () => reset();
      dialog.addEventListener('cancel', event => { event.preventDefault(); reset(); });
      window.addEventListener('pagehide', () => reset());
      if (mount) for (const [label, video] of [['تماس صوتی', false], ['تماس تصویری', true]]) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'icon-btn'; button.textContent = label; button.title = label;
        button.addEventListener('click', () => start(video)); mount.appendChild(button);
      }
      return { start, receive, reset, active: () => !!current };
    },
  };
})();
