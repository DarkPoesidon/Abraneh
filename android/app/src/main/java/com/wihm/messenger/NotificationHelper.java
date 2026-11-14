/*! Copyright (c) 2026 DarkPoesidon. Abraneh: https://github.com/DarkPoesidon/Abraneh. PolyForm Noncommercial 1.0.0; see LICENSE and NOTICE. */
package com.wihm.messenger;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.service.notification.StatusBarNotification;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Paint;
import androidx.core.app.NotificationCompat;
import androidx.core.content.LocusIdCompat;
import androidx.core.content.pm.ShortcutInfoCompat;
import androidx.core.content.pm.ShortcutManagerCompat;
import androidx.core.graphics.drawable.IconCompat;
import androidx.core.app.Person;
import androidx.core.app.RemoteInput;
import androidx.core.content.ContextCompat;

public class NotificationHelper {
    public static final String CHANNEL_ID = "wihm_messages_channel_v2";
    static final String GROUP = "wihm_messages";
    static final int SUMMARY_ID = 20000;
    static final String EXTRA_CHAT = "chatId", EXTRA_MESSAGE = "messageId";
    private static final String EXTRA_TITLE = "wihm_title";
    private static int notificationIdCounter = 1000;

    public static void createNotificationChannel(Context context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            CharSequence name = context.getString(R.string.notification_channel_name);
            String description = context.getString(R.string.notification_channel_desc);
            int importance = NotificationManager.IMPORTANCE_HIGH;

            NotificationChannel channel = new NotificationChannel(CHANNEL_ID, name, importance);
            channel.setDescription(description);
            channel.enableLights(true);
            channel.setLightColor(Color.parseColor("#0284c7"));
            channel.enableVibration(true);
            channel.setVibrationPattern(new long[]{0, 250, 100, 250});
            channel.setShowBadge(true);
            channel.setLockscreenVisibility(android.app.Notification.VISIBILITY_PUBLIC);

            Uri defaultSoundUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
            AudioAttributes audioAttributes = new AudioAttributes.Builder()
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION_COMMUNICATION_REQUEST)
                    .build();
            channel.setSound(defaultSoundUri, audioAttributes);

            NotificationManager notificationManager = ContextCompat.getSystemService(context, NotificationManager.class);
            if (notificationManager != null) {
                notificationManager.createNotificationChannel(channel);
            }
        }
    }

    /** A message notification from the page, or a plain one when it belongs to no chat. */
    public static void showNotification(Context context, String title, String message, String chatId) {
        if (UrlRules.isChatId(chatId)) showMessage(context, title, message, chatId, "");
        else post(context, title, message, null, "", false, false);
    }

    /** Keeps its own look, because a missed call is not a line of the conversation. */
    static void showPlain(Context context, String title, String message, String chatId) {
        post(context, title, message, chatId, "", false, false);
    }

    /** One notification per chat, which collects that chat's messages. A message id adds the reply and read buttons. */
    static void showMessage(Context context, String title, String message, String chatId, String messageId) {
        post(context, title, message, chatId, messageId, true, false);
    }

    /** Ends the reply spinner by telling the user the reply was not sent. */
    static void showReplyFailed(Context context, String chatId) {
        post(context, null, context.getString(R.string.reply_failed), chatId, "", true, true);
    }

    /** A coloured circle with the chat's first letter, as the chat list draws it. */
    static Bitmap letterAvatar(String title, String key) {
        int size = 128;
        Bitmap bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bitmap);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        paint.setColor(Color.HSVToColor(new float[]{Math.abs(key.hashCode() % 360), 0.55f, 0.72f}));
        canvas.drawCircle(size / 2f, size / 2f, size / 2f, paint);
        String letter = title == null || title.trim().isEmpty() ? "?" : new String(Character.toChars(title.trim().codePointAt(0)));
        paint.setColor(Color.WHITE);
        paint.setTextSize(size * 0.45f);
        paint.setTextAlign(Paint.Align.CENTER);
        paint.setFakeBoldText(true);
        canvas.drawText(letter, size / 2f, size / 2f - (paint.descent() + paint.ascent()) / 2, paint);
        return bitmap;
    }

    static int idFor(String chatId) {
        return Math.abs(chatId.hashCode() % 10000);
    }

    /** Removes one chat's notification, and the group header once it is the last. */
    static void dismiss(Context context, String chatId) {
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        manager.cancel(idFor(chatId));
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return;
        for (StatusBarNotification active : manager.getActiveNotifications()) {
            if (active.getId() != SUMMARY_ID && active.getId() != idFor(chatId) && GROUP.equals(active.getNotification().getGroup())) return;
        }
        manager.cancel(SUMMARY_ID);
    }

    /** The user is looking at the app, so what the notifications said is already on screen. */
    static void clearMessages(Context context) {
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return;
        for (StatusBarNotification active : manager.getActiveNotifications()) {
            if (GROUP.equals(active.getNotification().getGroup())) manager.cancel(active.getId());
        }
    }

    private static PendingIntent action(Context context, String action, String chatId, String messageId, boolean filledBySystem) {
        Intent intent = new Intent(context, NotificationActions.class).setAction(action)
                .putExtra(EXTRA_CHAT, chatId).putExtra(EXTRA_MESSAGE, messageId);
        // Android writes the typed reply into the intent, which it may only do to a mutable one.
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && filledBySystem ? PendingIntent.FLAG_MUTABLE
                : Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0);
        return PendingIntent.getBroadcast(context, idFor(chatId) * 2 + (filledBySystem ? 1 : 0), intent, flags);
    }

    private static void post(Context context, String title, String message, String chatId, String messageId, boolean conversation, boolean own) {
        if (context == null || message == null || message.trim().isEmpty()) {
            return;
        }

        // Check POST_NOTIFICATIONS permission on Android 13+
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(context, android.Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED) {
                return;
            }
        }
        NotificationManager notificationManager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (notificationManager == null) return;

        createNotificationChannel(context);
        boolean chat = chatId != null && !chatId.trim().isEmpty();
        int id = chat ? idFor(chatId) : ++notificationIdCounter;

        // The chat's earlier messages are read back from its notification, so nothing else has to store them.
        NotificationCompat.MessagingStyle style = null;
        if (conversation && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            for (StatusBarNotification active : notificationManager.getActiveNotifications()) {
                if (active.getId() != id) continue;
                style = NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(active.getNotification());
                if (own) {
                    title = active.getNotification().extras.getString(EXTRA_TITLE);
                    messageId = active.getNotification().extras.getString(EXTRA_MESSAGE, "");
                }
            }
        }
        if (own && style == null) return;

        Intent intent = new Intent(context, MainActivity.class);
        intent.setAction(Intent.ACTION_VIEW);
        if (chat) {
            intent.putExtra("target_chat_id", chatId);
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);

        PendingIntent pendingIntent = PendingIntent.getActivity(
                context,
                chat ? Math.abs(chatId.hashCode()) : (int) System.currentTimeMillis(),
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0)
        );

        Uri defaultSound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);

        String displayTitle = (title != null && !title.trim().isEmpty()) ? title : context.getString(R.string.app_name);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_notify)
                .setContentTitle(displayTitle)
                .setContentText(message)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setAutoCancel(true)
                .setSound(defaultSound)
                .setVibrate(new long[]{0, 250, 100, 250})
                .setLights(Color.parseColor("#0284c7"), 1000, 1000)
                .setColor(ContextCompat.getColor(context, R.color.primary))
                .setContentIntent(pendingIntent);

        if (!conversation) {
            builder.setStyle(new NotificationCompat.BigTextStyle().bigText(message));
            notificationManager.notify(id, builder.build());
            return;
        }

        if (style == null) style = new NotificationCompat.MessagingStyle(new Person.Builder().setName(context.getString(R.string.you)).build());
        IconCompat avatar = IconCompat.createWithBitmap(letterAvatar(displayTitle, chatId));
        Person sender = new Person.Builder().setName(displayTitle).setKey(chatId).setIcon(avatar).build();
        // A message with no person is shown as the user's own.
        style.addMessage(message, System.currentTimeMillis(), own ? null : sender);
        // A long-lived shortcut puts the chat in Android 11's Conversations section, with its own priority and bubble settings.
        ShortcutManagerCompat.pushDynamicShortcut(context, new ShortcutInfoCompat.Builder(context, chatId)
                .setShortLabel(displayTitle).setLongLived(true).setPerson(sender).setIcon(avatar)
                .setIntent(intent).build());
        builder.setShortcutId(chatId).setLocusId(new LocusIdCompat(chatId)).setLargeIcon(avatar.getBitmap());
        Bundle extras = new Bundle();
        extras.putString(EXTRA_TITLE, displayTitle);
        extras.putString(EXTRA_MESSAGE, messageId);
        builder.setStyle(style).setGroup(GROUP).addExtras(extras).setSilent(own);
        if (messageId != null && !messageId.isEmpty()) {
            // Typing a reply in the notification needs Android 7.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                builder.addAction(new NotificationCompat.Action.Builder(0, context.getString(R.string.reply), action(context, NotificationActions.REPLY, chatId, messageId, true))
                        .addRemoteInput(new RemoteInput.Builder(NotificationActions.KEY_TEXT).setLabel(context.getString(R.string.reply)).build())
                        .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY).setShowsUserInterface(false).build());
            }
            builder.addAction(new NotificationCompat.Action.Builder(0, context.getString(R.string.mark_read), action(context, NotificationActions.READ, chatId, messageId, false))
                    .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_MARK_AS_READ).setShowsUserInterface(false).build());
        }
        notificationManager.notify(id, builder.build());
        // Android 7 and later fold the chats under this header; before that it would show as one more notification.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            notificationManager.notify(SUMMARY_ID, new NotificationCompat.Builder(context, CHANNEL_ID)
                    .setSmallIcon(R.drawable.ic_stat_notify)
                    .setColor(ContextCompat.getColor(context, R.color.primary))
                    .setGroup(GROUP).setGroupSummary(true)
                    .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
                    .setAutoCancel(true).build());
        }
    }
}
