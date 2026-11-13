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
import android.content.Intent;
import android.os.Looper;

import androidx.test.core.app.ApplicationProvider;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.android.controller.ServiceController;
import org.robolectric.annotation.Config;

import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;

import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okhttp3.mockwebserver.Dispatcher;
import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import okhttp3.mockwebserver.RecordedRequest;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class InboxServiceTest {
    private static final String CALL = "{\"kind\":\"call\",\"chatId\":\"room-1\",\"callId\":\"call-1\",\"caller\":\"نیلوفر\",\"video\":false,\"title\":\"t\",\"body\":\"b\"}";

    private final BlockingQueue<WebSocket> sockets = new LinkedBlockingQueue<>();
    private final BlockingQueue<String> received = new LinkedBlockingQueue<>();
    private final BlockingQueue<RecordedRequest> posts = new LinkedBlockingQueue<>();
    private MockWebServer server;
    private volatile int inboxStatus = 101;
    private Application app;
    private NotificationManager notifications;
    private ServiceController<WihmNotificationService> service;

    @Before
    public void start() throws Exception {
        app = ApplicationProvider.getApplicationContext();
        notifications = app.getSystemService(NotificationManager.class);
        shadowOf(app).grantPermissions(android.Manifest.permission.POST_NOTIFICATIONS);
        MainActivity.visible = false;
        server = new MockWebServer();
        server.setDispatcher(new Dispatcher() {
            @Override
            public MockResponse dispatch(RecordedRequest request) {
                String path = request.getPath();
                if ("/api/ws/inbox".equals(path)) {
                    if (inboxStatus != 101) return new MockResponse().setResponseCode(inboxStatus);
                    return new MockResponse().withWebSocketUpgrade(new WebSocketListener() {
                        @Override
                        public void onOpen(WebSocket webSocket, Response response) {
                            sockets.add(webSocket);
                        }

                        @Override
                        public void onMessage(WebSocket webSocket, String text) {
                            received.add(text);
                            if ("ping".equals(text)) webSocket.send("pong");
                        }

                        @Override
                        public void onClosing(WebSocket webSocket, int code, String reason) {
                            webSocket.close(1000, null);
                        }
                    });
                }
                if ("POST".equals(request.getMethod())) posts.add(request);
                return new MockResponse().setBody("/api/chats".equals(path) || "/api/calls/incoming".equals(path) ? "[]" : "{}");
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
        if (service != null) service.destroy();
        server.shutdown();
    }

    private WebSocket startService() throws Exception {
        service = Robolectric.buildService(WihmNotificationService.class).create().startCommand(0, 1);
        WebSocket socket = sockets.poll(5, TimeUnit.SECONDS);
        assertNotNull("the service must open its socket", socket);
        settle();
        return socket;
    }

    @Test
    public void theAppLockNeedsAScreenLockAndAsksForItWhenTheAppOpens() {
        android.app.KeyguardManager keyguard = app.getSystemService(android.app.KeyguardManager.class);
        shadowOf(keyguard).setIsDeviceSecure(false);
        MainActivity activity = Robolectric.buildActivity(MainActivity.class).create().get();
        assertFalse("no screen lock, nothing could unlock the app", activity.setAppLock(true));
        assertFalse(activity.appLockEnabled());

        shadowOf(keyguard).setIsDeviceSecure(true);
        assertTrue(activity.setAppLock(true));
        org.robolectric.android.controller.ActivityController<MainActivity> controller = Robolectric.buildActivity(MainActivity.class).create().start().resume();
        Intent unlock = null;
        for (Intent started; (started = shadowOf(controller.get()).getNextStartedActivity()) != null; ) {
            if ("android.app.action.CONFIRM_DEVICE_CREDENTIAL".equals(started.getAction())) unlock = started;
        }
        assertNotNull("a fresh start asks for the phone's unlock", unlock);
        assertEquals(android.view.View.INVISIBLE, controller.get().findViewById(R.id.web_view).getVisibility());
        assertTrue(activity.setAppLock(false));
    }

    private void waitFor(BooleanSupplier condition) throws Exception {
        for (int i = 0; i < 100 && !condition.getAsBoolean(); i++) {
            shadowOf(Looper.getMainLooper()).idle();
            Thread.sleep(50);
        }
        assertTrue(condition.getAsBoolean());
    }

    private void settle() throws Exception {
        for (int i = 0; i < 6; i++) {
            shadowOf(Looper.getMainLooper()).idle();
            Thread.sleep(50);
        }
    }

    private Notification ring() {
        return shadowOf(notifications).getNotification(IncomingCall.NOTIFICATION_ID);
    }

    private boolean notified(String title) {
        return shadowOf(notifications).getAllNotifications().stream()
                .anyMatch(n -> title.equals(n.extras.getString(Notification.EXTRA_TITLE)));
    }

    @Test
    public void itSendsTheLoginTokenToTheInbox() throws Exception {
        startService();
        assertEquals("Bearer test-token", server.takeRequest().getHeader("Authorization"));
    }

    @Test
    public void anIncomingCallRingsWithTheCallersNameAndAFullScreenIntent() throws Exception {
        startService().send(CALL);
        waitFor(() -> ring() != null);
        assertEquals(Notification.CATEGORY_CALL, ring().category);
        assertNotNull(ring().fullScreenIntent);
        assertEquals("نیلوفر", ring().extras.getString(Notification.EXTRA_TITLE));
    }

    @Test
    public void aCallEndedByTheCallerStopsRingingAndLeavesAMissedCall() throws Exception {
        WebSocket socket = startService();
        socket.send(CALL);
        waitFor(() -> ring() != null);
        socket.send("{\"kind\":\"call-end\",\"callId\":\"call-1\"}");
        waitFor(() -> ring() == null);
        assertTrue(notified(app.getString(R.string.call_missed)));
    }

    @Test
    public void anEndEventForAnotherCallKeepsRinging() throws Exception {
        WebSocket socket = startService();
        socket.send(CALL);
        waitFor(() -> ring() != null);
        socket.send("{\"kind\":\"call-end\",\"callId\":\"other\"}");
        settle();
        assertNotNull(ring());
    }

    @Test
    public void decliningStopsRingingAndTellsTheServer() throws Exception {
        startService().send(CALL);
        waitFor(() -> ring() != null);
        service.withIntent(new Intent(app, WihmNotificationService.class).setAction(WihmNotificationService.ACTION_DECLINE)).startCommand(0, 2);
        assertNull(ring());
        RecordedRequest decline = posts.poll(5, TimeUnit.SECONDS);
        assertNotNull(decline);
        assertEquals("/api/calls/decline", decline.getPath());
        assertTrue(decline.getBody().readUtf8().contains("call-1"));
        assertFalse(notified(app.getString(R.string.call_missed)));
    }

    @Test
    public void whileTheAppIsOnScreenThePageHandlesTheCall() throws Exception {
        WebSocket socket = startService();
        MainActivity.visible = true;
        socket.send(CALL);
        settle();
        assertNull(ring());
    }

    @Test
    public void aMessageShowsANotification() throws Exception {
        startService().send("{\"chatId\":\"room-1\",\"messageId\":\"m1\",\"title\":\"سارا\",\"body\":\"سلام\"}");
        waitFor(() -> notified("سارا"));
    }

    @Test
    public void aBadEventDoesNotStopTheSocket() throws Exception {
        WebSocket socket = startService();
        socket.send("not json");
        socket.send(CALL);
        waitFor(() -> ring() != null);
    }

    @Test
    public void aTickPingsTheServerAndADeadSocketIsReplaced() throws Exception {
        WebSocket socket = startService();
        service.withIntent(new Intent(app, WihmNotificationService.class).setAction(WihmNotificationService.ACTION_TICK)).startCommand(0, 2);
        assertEquals("ping", received.poll(5, TimeUnit.SECONDS));
        socket.close(1011, "gone");
        // The reconnect delay runs on the paused looper, so this advances it.
        for (int i = 0; i < 40 && sockets.isEmpty(); i++) {
            shadowOf(Looper.getMainLooper()).idleFor(1, TimeUnit.SECONDS);
            Thread.sleep(50);
        }
        assertNotNull(sockets.poll(5, TimeUnit.SECONDS));
    }

    @Test
    public void anEndedLoginStopsTheServiceAndForgetsTheToken() throws Exception {
        inboxStatus = 401;
        service = Robolectric.buildService(WihmNotificationService.class).create().startCommand(0, 1);
        waitFor(() -> shadowOf(service.get()).isStoppedBySelf());
        assertEquals("", app.getSharedPreferences(ServerConfigActivity.PREFS_NAME, Context.MODE_PRIVATE).getString(ServerConfigActivity.KEY_AUTH_TOKEN, ""));
    }

    @Test
    public void withoutALoginItDoesNotStay() {
        app.getSharedPreferences(ServerConfigActivity.PREFS_NAME, Context.MODE_PRIVATE).edit().remove(ServerConfigActivity.KEY_AUTH_TOKEN).apply();
        service = Robolectric.buildService(WihmNotificationService.class).create().startCommand(0, 1);
        assertTrue(shadowOf(service.get()).isStoppedBySelf());
    }

    @Test
    public void theMainScreenStarts() {
        Robolectric.buildActivity(MainActivity.class).create().start().resume().stop().get();
    }

    @Test
    public void theCallScreenStartsAndCloses() {
        Intent intent = new Intent(app, IncomingCallActivity.class).putExtra(IncomingCall.EXTRA_CALLER, "نیلوفر");
        IncomingCallActivity activity = Robolectric.buildActivity(IncomingCallActivity.class, intent).create().get();
        app.sendBroadcast(new Intent(IncomingCallActivity.ACTION_CLOSE).setPackage(app.getPackageName()));
        shadowOf(Looper.getMainLooper()).idle();
        assertTrue(activity.isFinishing());
    }
}
