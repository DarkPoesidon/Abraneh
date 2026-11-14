/*! Copyright (c) 2026 DarkPoesidon. Abraneh: https://github.com/DarkPoesidon/Abraneh. PolyForm Noncommercial 1.0.0; see LICENSE and NOTICE. */
package com.wihm.messenger;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Log;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.IOException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/**
 * Keeps one socket open to the user's inbox on the server, as Telegram's NotificationsService does,
 * so messages and calls arrive with the app closed. It needs no browser or Google service.
 * All state is touched on the main thread.
 */
public class WihmNotificationService extends Service {
    private static final String TAG = "WihmNotificationService";
    public static final String BACKGROUND_CHANNEL_ID = "wihm_background_channel";
    static final String ACTION_TICK = "com.wihm.messenger.TICK";
    static final String ACTION_DECLINE = "com.wihm.messenger.DECLINE";
    static final String ACTION_STOP_RING = "com.wihm.messenger.STOP_RING";
    static final String ACTION_PROXY_CHANGED = "com.wihm.messenger.PROXY_CHANGED";
    private static final int FOREGROUND_SERVICE_ID = 9001;
    // Short enough to keep mobile NAT mappings open, and to find a dead socket within minutes.
    private static final long TICK_MS = 2 * 60_000;
    private static final long PONG_TIMEOUT_MS = 10_000;
    // While the socket is down, or the server is too old for it. Every poll is a billable query.
    private static final long POLL_MS = 60_000;
    private static final long MAX_RECONNECT_MS = 60_000;

    private static volatile boolean running;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private OkHttpClient client;
    private WebSocket socket;
    private String socketToken = "";
    private boolean connected;
    private boolean stopped;
    private int failures;
    private long lastPong;
    private IncomingCall call;
    private PowerManager.WakeLock wakeLock;
    private ConnectivityManager.NetworkCallback networkCallback;

    private final Runnable reconnect = this::connect;
    private final Runnable poll = new Runnable() {
        @Override
        public void run() {
            if (stopped || connected) return;
            catchUp();
            handler.postDelayed(this, POLL_MS);
        }
    };
    private final Runnable ringTimeout = () -> endCall(true);

    public static void start(Context context) {
        if (context == null) return;
        try {
            ContextCompat.startForegroundService(context, new Intent(context, WihmNotificationService.class));
        } catch (RuntimeException e) {
            Log.e(TAG, "Failed to start WihmNotificationService: " + e.getMessage());
        }
    }

    public static void stop(Context context) {
        if (context == null) return;
        try {
            context.stopService(new Intent(context, WihmNotificationService.class));
        } catch (RuntimeException ignored) {
        }
    }

    /** Reconnects through the proxy the user just saved. */
    static void proxyChanged(Context context) {
        if (!running) return;
        try {
            context.startService(new Intent(context, WihmNotificationService.class).setAction(ACTION_PROXY_CHANGED));
        } catch (RuntimeException ignored) {
        }
    }

    /** The app is on screen, and its own page takes over the ringing. */
    static void stopRinging(Context context) {
        if (!running) return;
        try {
            context.startService(new Intent(context, WihmNotificationService.class).setAction(ACTION_STOP_RING));
        } catch (RuntimeException ignored) {
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        client = ProxySettings.client(this);
        running = true;
        createBackgroundNotificationChannel();
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(@NonNull Network network) {
                handler.post(() -> {
                    if (stopped) return;
                    // A socket from the previous network can look open and never deliver again.
                    if (connected) {
                        Log.d(TAG, "Network changed, checking the socket");
                        verifySocket();
                        return;
                    }
                    failures = 0;
                    connect();
                });
            }
        };
        ConnectivityManager connectivity = ContextCompat.getSystemService(this, ConnectivityManager.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) connectivity.registerDefaultNetworkCallback(networkCallback);
        else connectivity.registerNetworkCallback(new NetworkRequest.Builder().addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).build(), networkCallback);
    }

    private void createBackgroundNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(BACKGROUND_CHANNEL_ID, this.getString(R.string.service_channel), NotificationManager.IMPORTANCE_LOW);
            channel.setDescription(this.getString(R.string.service_channel_desc));
            channel.enableLights(false);
            channel.enableVibration(false);
            channel.setShowBadge(false);
            channel.setSound(null, null);
            ContextCompat.getSystemService(this, NotificationManager.class).createNotificationChannel(channel);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // Android stops the app if this is late after startForegroundService, whatever happens next.
        startForeground(FOREGROUND_SERVICE_ID, statusNotification(connected));

        SharedPreferences prefs = prefs();
        if (!prefs.getBoolean("keep_alive_enabled", true) || prefs.getString(ServerConfigActivity.KEY_AUTH_TOKEN, "").isEmpty()) {
            stopSelf();
            return START_NOT_STICKY;
        }

        String action = intent != null ? intent.getAction() : null;
        if (ACTION_DECLINE.equals(action)) {
            declineCall();
        } else if (ACTION_STOP_RING.equals(action)) {
            endCall(false);
        } else if (ACTION_PROXY_CHANGED.equals(action)) {
            client = ProxySettings.client(this);
            if (socket != null) socket.cancel();
        } else if (ACTION_TICK.equals(action)) {
            tick();
        }
        if (socket == null) connect();
        scheduleTick();
        return START_STICKY;
    }

    private Notification statusNotification(boolean online) {
        PendingIntent open = PendingIntent.getActivity(this, 0,
                new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, BACKGROUND_CHANNEL_ID)
                .setContentTitle(getString(R.string.app_name))
                .setContentText(getString(online ? R.string.service_online : R.string.service_connecting))
                .setSmallIcon(R.drawable.ic_stat_notify)
                .setPriority(NotificationCompat.PRIORITY_MIN)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .setColor(ContextCompat.getColor(this, R.color.primary))
                .setContentIntent(open)
                .build();
    }

    private void showStatus(boolean online) {
        ContextCompat.getSystemService(this, NotificationManager.class).notify(FOREGROUND_SERVICE_ID, statusNotification(online));
    }

    private SharedPreferences prefs() {
        return getSharedPreferences(ServerConfigActivity.PREFS_NAME, Context.MODE_PRIVATE);
    }

    private String serverUrl() {
        return prefs().getString(ServerConfigActivity.KEY_SERVER_URL, "");
    }

    private Request.Builder authorized(String path) {
        return new Request.Builder()
                .url(serverUrl() + path)
                .header("Authorization", "Bearer " + prefs().getString(ServerConfigActivity.KEY_AUTH_TOKEN, ""));
    }

    private void connect() {
        handler.removeCallbacks(reconnect);
        socketToken = prefs().getString(ServerConfigActivity.KEY_AUTH_TOKEN, "");
        if (stopped || socket != null || serverUrl().isEmpty() || socketToken.isEmpty()) return;
        try {
            socket = client.newWebSocket(authorized("/api/ws/inbox").build(), new InboxListener());
        } catch (IllegalArgumentException e) {
            Log.w(TAG, "The saved server address is not usable", e);
        }
    }

    private final class InboxListener extends WebSocketListener {
        @Override
        public void onOpen(@NonNull WebSocket webSocket, @NonNull Response response) {
            handler.post(() -> {
                if (webSocket != socket) return;
                connected = true;
                failures = 0;
                lastPong = SystemClock.elapsedRealtime();
                handler.removeCallbacks(poll);
                showStatus(true);
                catchUp();
            });
        }

        @Override
        public void onMessage(@NonNull WebSocket webSocket, @NonNull String text) {
            handler.post(() -> {
                if (webSocket != socket) return;
                if ("pong".equals(text)) lastPong = SystemClock.elapsedRealtime();
                else handleEvent(InboxEvent.parse(text));
            });
        }

        @Override
        public void onClosing(@NonNull WebSocket webSocket, int code, @NonNull String reason) {
            webSocket.close(1000, null);
        }

        @Override
        public void onClosed(@NonNull WebSocket webSocket, int code, @NonNull String reason) {
            handler.post(() -> dropped(webSocket, code));
        }

        @Override
        public void onFailure(@NonNull WebSocket webSocket, @NonNull Throwable error, Response response) {
            int code = response != null ? response.code() : 0;
            Log.w(TAG, "Inbox socket failed (" + code + "): " + error.getMessage());
            handler.post(() -> dropped(webSocket, code));
        }
    }

    private void dropped(WebSocket webSocket, int code) {
        if (webSocket != socket) return;
        socket = null;
        connected = false;
        if (code == 401 || code == 403 || code == 4001) {
            // That login ended, and the page starts this service again after the next one.
            // The page may have saved a newer login in the meantime, which must stay.
            if (socketToken.equals(prefs().getString(ServerConfigActivity.KEY_AUTH_TOKEN, ""))) {
                prefs().edit().remove(ServerConfigActivity.KEY_AUTH_TOKEN).apply();
                stopSelf();
            } else {
                connect();
            }
            return;
        }
        if (stopped) return;
        showStatus(false);
        handler.postDelayed(reconnect, Math.min(MAX_RECONNECT_MS, 1000L << Math.min(failures++, 6)));
        handler.removeCallbacks(poll);
        handler.postDelayed(poll, POLL_MS);
    }

    private void handleEvent(InboxEvent event) {
        if (event == null) return;
        if (event.kind == InboxEvent.Kind.CALL) {
            startCall(event);
        } else if (event.kind == InboxEvent.Kind.CALL_END) {
            if (call != null && call.callId.equals(event.callId)) endCall(true);
        } else if (!MainActivity.visible) {
            if (!event.messageId.isEmpty()) prefs().edit().putString("last_notified_" + event.chatId, event.messageId).apply();
            boolean hidden = "پیام تازه در ابرانه".equals(event.title);
            NotificationHelper.showMessage(getApplicationContext(), hidden ? getString(R.string.message_new) : event.title, hidden ? getString(R.string.message_open) : event.body, event.chatId, UrlRules.isChatId(event.chatId) ? event.messageId : "");
        }
    }

    private void startCall(InboxEvent event) {
        // On screen, the page already rings and shows the call itself.
        if (MainActivity.visible || call != null) return;
        call = new IncomingCall(event, getString(R.string.call_unknown_caller));
        call.start(this);
        handler.postDelayed(ringTimeout, IncomingCall.RING_MS);
    }

    /** Stops the ring and, if the user never saw the call, leaves a missed call notification. */
    private void endCall(boolean missed) {
        if (call == null) return;
        IncomingCall ended = call;
        call = null;
        handler.removeCallbacks(ringTimeout);
        ended.stop(this);
        if (missed) NotificationHelper.showPlain(getApplicationContext(), getString(R.string.call_missed), ended.caller, ended.chatId);
    }

    private void declineCall() {
        if (call == null) return;
        String chatId = call.chatId;
        String callId = call.callId;
        endCall(false);
        executor.execute(() -> {
            try {
                String body = new JSONObject().put("chatId", chatId).put("callId", callId).toString();
                Request request = authorized("/api/calls/decline")
                        .post(RequestBody.create(body, MediaType.get("application/json")))
                        .build();
                try (Response ignored = client.newCall(request).execute()) {
                    Log.d(TAG, "Call declined");
                }
            } catch (Exception e) {
                Log.w(TAG, "Could not decline the call: " + e.getMessage());
            }
        });
    }

    /** Wakes the phone long enough to prove the socket is alive, and replaces it if it isn't. */
    private void tick() {
        acquireWakeLock();
        verifySocket();
    }

    private void verifySocket() {
        if (socket == null || !connected) return;
        long sentAt = SystemClock.elapsedRealtime();
        WebSocket pinged = socket;
        pinged.send("ping");
        handler.postDelayed(() -> {
            if (pinged == socket && lastPong < sentAt) pinged.cancel();
        }, PONG_TIMEOUT_MS);
    }

    private PendingIntent tickIntent() {
        Intent intent = new Intent(this, WihmNotificationService.class).setAction(ACTION_TICK);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? PendingIntent.getForegroundService(this, 7, intent, flags)
                : PendingIntent.getService(this, 7, intent, flags);
    }

    private void scheduleTick() {
        // Not exact, because exact alarms need a permission and the socket tolerates a late ping.
        AlarmManager alarms = ContextCompat.getSystemService(this, AlarmManager.class);
        long at = SystemClock.elapsedRealtime() + TICK_MS;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) alarms.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, tickIntent());
        else alarms.set(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, tickIntent());
    }

    private void acquireWakeLock() {
        if (wakeLock == null) {
            wakeLock = ContextCompat.getSystemService(this, PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "WIHM:Inbox");
        }
        wakeLock.acquire(PONG_TIMEOUT_MS + 2000);
    }

    /** Fetches what the socket can't have delivered while it was down. */
    private void catchUp() {
        executor.execute(() -> {
            try {
                checkIncomingCalls();
                checkNewMessages();
            } catch (IOException | org.json.JSONException e) {
                Log.w(TAG, "Catch-up failed: " + e.getMessage());
            }
        });
    }

    private String get(String path) throws IOException {
        try (Response response = client.newCall(authorized(path).build()).execute()) {
            if (response.code() == 401 || response.code() == 403) {
                handler.post(() -> dropped(socket, response.code()));
                return null;
            }
            return response.isSuccessful() && response.body() != null ? response.body().string() : null;
        }
    }

    private void checkIncomingCalls() throws IOException, org.json.JSONException {
        String text = get("/api/calls/incoming");
        if (text == null) return;
        JSONArray events = new JSONArray(text);
        if (events.length() == 0) return;
        JSONObject first = events.getJSONObject(0);
        InboxEvent event = InboxEvent.parse(new JSONObject()
                .put("kind", "call").put("chatId", first.optString("chatId")).put("callId", first.optString("callId"))
                .put("video", first.optBoolean("video")).toString());
        handler.post(() -> handleEvent(event));
    }

    private void checkNewMessages() throws IOException, org.json.JSONException {
        String text = get("/api/chats");
        if (text == null) return;
        SharedPreferences prefs = prefs();
        String self = prefs.getString(ServerConfigActivity.KEY_USER_ID, "");
        JSONArray chats = new JSONArray(text);
        for (int i = 0; i < chats.length(); i++) {
            JSONObject chat = chats.getJSONObject(i);
            JSONObject last = chat.optJSONObject("lastMessage");
            if (chat.optInt("unreadCount", 0) <= 0 || last == null || self.equals(last.optString("senderId"))) continue;
            String chatId = chat.optString("id");
            String messageId = last.optString("id");
            String key = "last_notified_" + chatId;
            if (messageId.isEmpty() || messageId.equals(prefs.getString(key, ""))) continue;
            prefs.edit().putString(key, messageId).apply();
            // Text stays out, because this path can't see the user's message preview setting.
            if (!MainActivity.visible) {
                if (UrlRules.isChatId(chatId)) NotificationHelper.showMessage(getApplicationContext(), getString(R.string.message_new), getString(R.string.message_open), chatId, messageId);
            }
        }
    }

    @Override
    public void onDestroy() {
        Log.d(TAG, "Service stopped");
        running = false;
        stopped = true;
        handler.removeCallbacksAndMessages(null);
        endCall(false);
        ContextCompat.getSystemService(this, ConnectivityManager.class).unregisterNetworkCallback(networkCallback);
        ContextCompat.getSystemService(this, AlarmManager.class).cancel(tickIntent());
        if (socket != null) socket.cancel();
        socket = null;
        executor.shutdown();
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
