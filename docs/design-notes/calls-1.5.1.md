# Call corrections in 1.5.1

## Reproduced failures

- The CSS reset removed the browser dialog's automatic margins. At 1280×850, the released call dialog was at x=840, y=0, with black text. It reused a card designed for a centered overlay, without that overlay. The native dialog now has explicit centered margins, viewport bounds, app text color and its own backdrop.
- Audio calls initially rendered two empty native video players. The call screen now separates voice playback from remote video and the local camera preview, with labeled microphone, camera, speaker and playback controls.
- Invitations were delivered only to sockets in the active conversation. A recipient elsewhere in the app received nothing. A bounded, authenticated per-user Durable Object inbox now carries only short-lived invitation metadata. Acceptance opens the conversation and waits for its authenticated connection. Decline works without opening it. Cancellation, first-device acceptance, session ownership, membership and blocks remain enforced. A poll started before a new invitation cannot dismiss that invitation.
- Only a STUN server was provided, so direct connections could fail behind restrictive NAT. The administrator can now configure Cloudflare TURN through the existing service panel. The backend validates credentials before replacing working settings, encrypts the master token with a purpose-derived AES-GCM key, and returns 20-minute client credentials only for a current call participant. Redirects are not followed. Restoration removes this integration until the administrator enables it again.
- A combined remote audio/video element sometimes received decoded frames without becoming ready to render. Remote audio now has its own audio sink and remote video has a separate muted video sink, as in Telegram Web. Neither track event resets the other sink. Blocked audio autoplay has an explicit retry button.

## Reference and runtime evidence

Telegram Web's [PhoneCall.tsx](https://github.com/Ajaxy/telegram-tt/blob/6002824b6532f3d913997ce496d9ab5f9b86bc22/src/components/calls/phone/PhoneCall.tsx) and [layout](https://github.com/Ajaxy/telegram-tt/blob/6002824b6532f3d913997ce496d9ab5f9b86bc22/src/components/calls/phone/PhoneCall.module.scss) were read for the separate main/local video, avatar, call state and labeled controls pattern. No Telegram protocol or implementation was transplanted. Telegram also supplies TURN/STUN connection information in its [call API](https://core.telegram.org/api/calls).

REA opened Telegram Web in an isolated browser; only its login screen was available, not an authenticated call. Evidence: `ev_b5fb4ca3a4fefd4490d6b339f1172ceefb2ffdaa63ac843e4c7fc94d1f4da09b`.

REA then exercised the actual `public/calls.js` and stylesheet in a local invitation fixture at 375×812, clicked the voice preview and observed the accessible incoming-call dialog, acceptance and rejection controls. Its owned browser was terminated. Evidence: `ev_6f3b19c92c72af23b05dd7a9f23ff50d96c040dc479ca4b185c7c2f59798d553`. This controlled UI fixture establishes layout/control behavior, not media transport.

A second REA scenario at 320×568 opened voice ringing, declined it, then opened video ringing; all actions completed and the video dialog exposed the correct acceptance/rejection controls. Evidence: `ev_e48de1270d06d3617ddcd06521470811d7b95e66c4a957d8597f077e9b96fa3f`.

`tests/browser/calls-app.mjs` separately runs two signed-in app browsers against real local Worker/D1/Durable Object signaling. It checks incoming delivery without opening the conversation, privacy before acceptance, inbound audio bytes, decoded video frames, actual media playback, microphone/camera/speaker controls, hangup stopping tracks, encrypted TURN storage and the real administrator form. Chrome uses synthetic microphones/cameras and local ICE; the TURN provider response is mocked and its contract follows the [official Cloudflare API](https://developers.cloudflare.com/realtime/turn/generate-credentials/).

`tests/browser/calls.mjs` checks centering, contrast, closed-dialog visibility, no empty video players during voice calls and short viewport bounds. Unit/runtime tests cover inbox ownership, blocks, cancellation, participant-bound credentials, encrypted push payloads, expired notification suppression, notification clicks and autoplay recovery. The existing full regression and installer suites remain release gates.

## Limits

Calls remain one-to-one and on the same server, with a 15-minute limit. WebRTC transport encryption is not a separately verified contact fingerprint. Notifications depend on browser/OS permissions and the push provider. Actual Android/iOS hardware, acoustic quality, camera quality and paid TURN relay traffic over carrier networks were not tested here. No production account or deployment was modified during local verification.
