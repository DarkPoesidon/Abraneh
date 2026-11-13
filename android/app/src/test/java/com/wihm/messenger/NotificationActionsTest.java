package com.wihm.messenger;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.robolectric.Shadows.shadowOf;

import android.app.Application;
import android.app.Notification;
import android.app.NotificationManager;
import android.content.Context;

import androidx.core.app.NotificationCompat;
import androidx.test.core.app.ApplicationProvider;

import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okhttp3.mockwebserver.Dispatcher;
import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import okhttp3.mockwebserver.RecordedRequest;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class NotificationActionsTest {
    private final BlockingQueue<RecordedRequest> requests = new LinkedBlockingQueue<>();
    private MockWebServer server;
    private volatile boolean storeReplies = true;
    private Application app;
    private NotificationManager notifications;

    @Before
    public void start() throws Exception {
        app = ApplicationProvider.getApplicationContext();
        notifications = app.getSystemService(NotificationManager.class);
        shadowOf(app).grantPermissions(android.Manifest.permission.POST_NOTIFICATIONS);
        server = new MockWebServer();
        server.setDispatcher(new Dispatcher() {
            @Override
            public MockResponse dispatch(RecordedRequest request) {
                requests.add(request);
                if (!request.getPath().startsWith("/ws?chatId=")) return new MockResponse().setBody("{}");
                return new MockResponse().withWebSocketUpgrade(new WebSocketListener() {
                    @Override
                    public void onMessage(WebSocket webSocket, String text) {
                        try {
                            JSONObject sent = new JSONObject(text);
                            webSocket.send(storeReplies
                                    ? new JSONObject().put("event", "new_message").put("message", new JSONObject().put("text", sent.getString("text")).put("clientMsgId", sent.getString("clientMsgId"))).toString()
                                    : new JSONObject().put("event", "error").put("clientMsgId", sent.getString("clientMsgId")).toString());
                        } catch (Exception e) {
                            throw new AssertionError(e);
                        }
                    }

                    @Override
                    public void onClosing(WebSocket webSocket, int code, String reason) {
                        webSocket.close(1000, null);
                    }
                });
            }
        });
        server.start();
        app.getSharedPreferences(ServerConfigActivity.PREFS_NAME, Context.MODE_PRIVATE).edit()
                .putString(ServerConfigActivity.KEY_SERVER_URL, server.url("/").toString().replaceAll("/$", ""))
                .putString(ServerConfigActivity.KEY_AUTH_TOKEN, "test-token")
                .apply();
    }

    @After
    public void stop() throws Exception {
        server.shutdown();
    }

    private Notification chat(String chatId) {
        return shadowOf(notifications).getNotification(NotificationHelper.idFor(chatId));
    }

    @Test
    public void aChatCollectsItsMessagesInOneNotificationWithReplyAndRead() {
        NotificationHelper.showMessage(app, "سارا", "سلام", "room-1", "m1");
        NotificationHelper.showMessage(app, "سارا", "هستی؟", "room-1", "m2");
        NotificationCompat.MessagingStyle style = NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(chat("room-1"));
        assertNotNull(style);
        assertEquals(2, style.getMessages().size());
        assertEquals("هستی؟", style.getMessages().get(1).getText().toString());
        assertEquals("سارا", style.getMessages().get(1).getPerson().getName().toString());
        assertEquals(2, chat("room-1").actions.length);
        assertNotNull(chat("room-1").actions[0].getRemoteInputs());
        assertEquals(NotificationHelper.GROUP, chat("room-1").getGroup());
        assertNotNull("chats fold under one header", shadowOf(notifications).getNotification(NotificationHelper.SUMMARY_ID));
    }

    @Test
    public void aChatNotificationIsAConversationWithItsOwnShortcut() {
        NotificationHelper.showMessage(app, "سارا", "سلام", "room-1", "m1");
        assertEquals("room-1", chat("room-1").getShortcutId());
        java.util.List<androidx.core.content.pm.ShortcutInfoCompat> shortcuts =
                androidx.core.content.pm.ShortcutManagerCompat.getDynamicShortcuts(app);
        assertEquals(1, shortcuts.size());
        assertEquals("room-1", shortcuts.get(0).getId());
        assertEquals("سارا", shortcuts.get(0).getShortLabel().toString());
        assertEquals("room-1", shortcuts.get(0).getIntent().getStringExtra("target_chat_id"));
        NotificationCompat.MessagingStyle style = NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(chat("room-1"));
        assertNotNull("the sender has a picture", style.getMessages().get(0).getPerson().getIcon());
    }

    @Test
    public void letterAvatarsUseTheFirstLetterAndSurviveEmptyTitles() {
        assertEquals(128, NotificationHelper.letterAvatar("سارا", "room-1").getWidth());
        assertNotNull(NotificationHelper.letterAvatar("", "room-1"));
        assertNotNull(NotificationHelper.letterAvatar("😀 گروه", "room-2"));
    }

    @Test
    public void aMessageWithoutAnIdGetsNoButtons() {
        NotificationHelper.showNotification(app, "سارا", "سلام", "room-1");
        assertNotNull(NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(chat("room-1")));
        assertNull(chat("room-1").actions);
    }

    @Test
    public void aMissedCallStaysOutOfTheConversation() {
        NotificationHelper.showPlain(app, "تماس از دست رفته", "سارا", "room-1");
        assertNull(NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(chat("room-1")));
        assertNull(shadowOf(notifications).getNotification(NotificationHelper.SUMMARY_ID));
    }

    @Test
    public void aReplyIsSentOnlyWhenTheServerStoredIt() throws Exception {
        assertTrue(NotificationActions.sendReply(app, "room-1", "می‌آیم"));
        RecordedRequest upgrade = requests.poll(5, TimeUnit.SECONDS);
        assertEquals("/ws?chatId=room-1", upgrade.getPath());
        assertEquals("Bearer test-token", upgrade.getHeader("Authorization"));
        storeReplies = false;
        assertFalse(NotificationActions.sendReply(app, "room-1", "می‌آیم"));
    }

    @Test
    public void aFailedReplyIsReportedInTheNotification() {
        NotificationHelper.showMessage(app, "سارا", "سلام", "room-1", "m1");
        NotificationHelper.showReplyFailed(app, "room-1");
        NotificationCompat.MessagingStyle style = NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(chat("room-1"));
        assertEquals(2, style.getMessages().size());
        assertEquals(app.getString(R.string.reply_failed), style.getMessages().get(1).getText().toString());
        assertNull("the note is the user's own line", style.getMessages().get(1).getPerson());
        assertEquals("the buttons stay, so the reply can be tried again", 2, chat("room-1").actions.length);
    }

    @Test
    public void readingMarksTheMessageAndRemovesTheNotification() throws Exception {
        NotificationHelper.showMessage(app, "سارا", "سلام", "room-1", "m1");
        NotificationHelper.showMessage(app, "کیان", "سلام", "room-2", "m9");
        NotificationActions.markRead(app, "room-1", "m1");
        RecordedRequest receipt = requests.poll(5, TimeUnit.SECONDS);
        assertEquals("/api/chats/room-1/receipts", receipt.getPath());
        JSONObject body = new JSONObject(receipt.getBody().readUtf8());
        assertEquals("m1", body.getString("messageId"));
        assertTrue(body.getBoolean("read"));
        NotificationHelper.dismiss(app, "room-1");
        assertNull(chat("room-1"));
        assertNotNull("another chat keeps the header", shadowOf(notifications).getNotification(NotificationHelper.SUMMARY_ID));
        NotificationHelper.dismiss(app, "room-2");
        assertNull(shadowOf(notifications).getNotification(NotificationHelper.SUMMARY_ID));
    }

    @Test
    public void openingTheAppClearsMessageNotifications() {
        NotificationHelper.showMessage(app, "سارا", "سلام", "room-1", "m1");
        NotificationHelper.clearMessages(app);
        assertNull(chat("room-1"));
        assertNull(shadowOf(notifications).getNotification(NotificationHelper.SUMMARY_ID));
    }
}
