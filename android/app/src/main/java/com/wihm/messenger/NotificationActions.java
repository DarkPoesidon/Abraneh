/*! Copyright (c) 2026 DarkPoesidon. Abraneh: https://github.com/DarkPoesidon/Abraneh. PolyForm Noncommercial 1.0.0; see LICENSE and NOTICE. */
package com.wihm.messenger;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;

import androidx.annotation.NonNull;
import androidx.core.app.RemoteInput;

import org.json.JSONObject;

import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/** The reply and "mark as read" buttons of a message notification. Both work without opening the app. */
public class NotificationActions extends BroadcastReceiver {
    static final String REPLY = "com.wihm.messenger.REPLY";
    static final String READ = "com.wihm.messenger.READ";
    static final String KEY_TEXT = "text";
    // Android gives a receiver about ten seconds.
    private static final int REPLY_TIMEOUT_SECONDS = 7;
    private static final ExecutorService executor = Executors.newSingleThreadExecutor();

    @Override
    public void onReceive(Context context, Intent intent) {
        String chatId = intent.getStringExtra(NotificationHelper.EXTRA_CHAT);
        String messageId = intent.getStringExtra(NotificationHelper.EXTRA_MESSAGE);
        if (!UrlRules.isChatId(chatId) || !UrlRules.isChatId(messageId)) return;
        Bundle input = RemoteInput.getResultsFromIntent(intent);
        CharSequence typed = input == null ? null : input.getCharSequence(KEY_TEXT);
        boolean reply = REPLY.equals(intent.getAction());
        Context app = context.getApplicationContext();
        PendingResult pending = goAsync();
        executor.execute(() -> {
            try {
                String text = typed == null ? "" : typed.toString().trim();
                if (reply && (text.isEmpty() || !sendReply(app, chatId, text))) {
                    NotificationHelper.showReplyFailed(app, chatId);
                    return;
                }
                markRead(app, chatId, messageId);
                NotificationHelper.dismiss(app, chatId);
            } finally {
                pending.finish();
            }
        });
    }

    private static Request.Builder authorized(Context context, String path) {
        SharedPreferences prefs = context.getSharedPreferences(ServerConfigActivity.PREFS_NAME, Context.MODE_PRIVATE);
        String server = prefs.getString(ServerConfigActivity.KEY_SERVER_URL, ""), token = prefs.getString(ServerConfigActivity.KEY_AUTH_TOKEN, "");
        if (server.isEmpty() || token.isEmpty()) return null;
        return new Request.Builder().url(server + path).header("Authorization", "Bearer " + token);
    }

    /** Messages only go through the chat's socket, so this opens it for the one message. */
    static boolean sendReply(Context context, String chatId, String text) {
        Request.Builder request = authorized(context, "/ws?chatId=" + chatId);
        if (request == null) return false;
        String clientMsgId = UUID.randomUUID().toString();
        CountDownLatch done = new CountDownLatch(1);
        AtomicBoolean stored = new AtomicBoolean();
        OkHttpClient client = ProxySettings.client(context);
        WebSocket socket = client.newWebSocket(request.build(), new WebSocketListener() {
            @Override
            public void onOpen(@NonNull WebSocket webSocket, @NonNull Response response) {
                try {
                    webSocket.send(new JSONObject().put("action", "send_message").put("chatId", chatId).put("text", text).put("clientMsgId", clientMsgId).toString());
                } catch (Exception e) {
                    done.countDown();
                }
            }

            @Override
            public void onMessage(@NonNull WebSocket webSocket, @NonNull String message) {
                try {
                    JSONObject event = new JSONObject(message);
                    JSONObject saved = event.optJSONObject("message");
                    // The server repeats the id only after it has stored the message.
                    if ("new_message".equals(event.optString("event")) && saved != null && clientMsgId.equals(saved.optString("clientMsgId"))) stored.set(true);
                    else if (!"error".equals(event.optString("event"))) return;
                    done.countDown();
                } catch (Exception ignored) {
                    // Other events of the chat are not about this message.
                }
            }

            @Override
            public void onFailure(@NonNull WebSocket webSocket, @NonNull Throwable error, Response response) {
                done.countDown();
            }

            @Override
            public void onClosed(@NonNull WebSocket webSocket, int code, @NonNull String reason) {
                done.countDown();
            }
        });
        try {
            done.await(REPLY_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        socket.close(1000, null);
        return stored.get();
    }

    /** A failure only leaves the chat unread, which the app corrects when it opens. */
    static void markRead(Context context, String chatId, String messageId) {
        Request.Builder request = authorized(context, "/api/chats/" + chatId + "/receipts");
        if (request == null) return;
        try {
            String body = new JSONObject().put("messageId", messageId).put("read", true).toString();
            ProxySettings.client(context).newCall(request.post(RequestBody.create(body, MediaType.parse("application/json"))).build()).execute().close();
        } catch (Exception ignored) {
        }
    }
}
