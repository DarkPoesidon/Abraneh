What this repo does: WIHM is a self-hosted Cloudflare messenger with browser notifications. This focused ponytail audit covers notification delivery and the mobile chat layout, assuming personal and small-group use. It is not a whole-repository audit.

## Must fix

1. **Short notifications use the entire provider size budget** (`src/push.ts`, shared `deliver` caller).
   - **What this is:** Messages, update notices and test notifications share one encrypted sender.
   - **Problem:** The shipped 1.4.1 Worker pads even a short notice to 4096 bytes. The user supplied a real provider HTTP 413 response. Existing tests checked encryption but did not reject this unnecessary padding.
   - **Fix:** Use the installed package's `encryptNotification` with `pad:false` and its existing `vapidHeaders`. Keep size validation, endpoint validation, retry and expiration handling. No dependency or cryptographic implementation is added.
   - **If we skip it:** Affected push services keep rejecting notifications on both desktop and mobile.

2. **The keyboard hides the composer and latest messages** (`public/index.html`, `public/app.js`, `public/style.css`).
   - **What this is:** Mobile browsers can shrink the visible viewport while the layout viewport stays tall.
   - **Problem:** `100dvh` alone leaves the app behind an overlay keyboard; focusing the composer can also pan the page and hide the header.
   - **Fix:** Request content resizing and fit the mobile app to `visualViewport.height` and `offsetTop`, with window-height fallback. Keep the latest message visible only when already at the end; preserve history position, drafts and zoom.
   - **If we skip it:** The composer or message list remains underneath the keyboard.

## Reference and checks

REA opened the actual [Telegram Web A](https://web.telegram.org/a/) in a temporary Chrome profile at 390x844. Evidence: `ev_02445506495aa669d37b7531e5fd6fb61a45fd80b926b076d6be629efa0582a3`; navigation completed, HTTP 200 and live script URLs were observed. No Telegram account was signed in and no logged-in chat or Telegram notification delivery was observed. The owned browser was closed.

The official [Telegram window-size utility](https://github.com/Ajaxy/telegram-tt/blob/master/src/util/windowSize.ts) updates a CSS height variable from resize events and uses VisualViewport for iOS. That source is a design reference, not proof that every captured live bundle executes the same source revision. WIHM uses its own smaller implementation and keeps browser zoom available.

The new size assertion fails against the previous committed sender. The integration test measures actual encrypted bytes sent by the room alarm, and the existing tests independently decrypt the payload and verify VAPID. Chrome keyboard-overlay tests cover 360, 390 and 768 pixels, viewport shrink/pan, draft retention and history position.

Verdict: fix the shared notification padding and mobile viewport, with no unrelated feature work.

Android follow-up: Chrome on an isolated Android 16 emulator was tested with its actual soft keyboard. The visual viewport shrank from 628.19 to 344 CSS pixels; the composer ended at 344 and the chat header remained at 0. The composer and newest message were inspected in an Android screenshot. This is an emulator check, not the user's physical phone.

Not checked: production Cloudflare credentials, the user's phone settings or actual delivery to that phone. A temporary private Chrome Push subscription was denied; a regular temporary profile's subscription then timed out. Neither attempt established real Push delivery in this environment or a problem with the user's subscription.
