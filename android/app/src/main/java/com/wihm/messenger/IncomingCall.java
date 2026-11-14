/*! Copyright (c) 2026 DarkPoesidon. Abraneh: https://github.com/DarkPoesidon/Abraneh. PolyForm Noncommercial 1.0.0; see LICENSE and NOTICE. */
package com.wihm.messenger;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.os.Build;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.Person;
import androidx.core.content.ContextCompat;

/** The ringing side of a call: the ringtone, the vibration and the notification that opens the call screen. */
final class IncomingCall {
    static final String CHANNEL_ID = "wihm_calls_channel";
    static final int NOTIFICATION_ID = 9100;
    static final long RING_MS = 45_000;
    static final String EXTRA_ANSWER = "call_answer";
    static final String EXTRA_CALLER = "call_caller";
    static final String EXTRA_VIDEO = "call_video";
    static final String EXTRA_CHAT_ID = "call_chat_id";
    static final String EXTRA_CALL_ID = "call_id";
    private static final String TAG = "IncomingCall";
    private static final long[] VIBRATION = {0, 800, 800};

    final String chatId;
    final String callId;
    final String caller;
    final boolean video;
    private Ringtone ringtone;
    private Vibrator vibrator;

    IncomingCall(InboxEvent event, String unknownCaller) {
        chatId = event.chatId;
        callId = event.callId;
        caller = event.caller.isEmpty() ? unknownCaller : event.caller;
        video = event.video;
    }

    /** Starts MainActivity, which answers the call as soon as the page shows it. */
    static Intent answerIntent(Context context) {
        return new Intent(context, MainActivity.class)
                .setAction(EXTRA_ANSWER)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra(EXTRA_ANSWER, true);
    }

    void start(Context context) {
        createChannel(context);
        int immutable = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        PendingIntent answer = PendingIntent.getActivity(context, 1, answerIntent(context), immutable);
        PendingIntent decline = PendingIntent.getService(context, 2,
                new Intent(context, WihmNotificationService.class).setAction(WihmNotificationService.ACTION_DECLINE), immutable);
        PendingIntent screen = PendingIntent.getActivity(context, 3,
                new Intent(context, IncomingCallActivity.class)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        .putExtra(EXTRA_CALLER, caller)
                        .putExtra(EXTRA_VIDEO, video), immutable);

        Notification notification = new NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_notify)
                .setContentTitle(caller)
                .setContentText(context.getString(video ? R.string.call_video_incoming : R.string.call_audio_incoming))
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setOngoing(true)
                .setAutoCancel(false)
                .setTimeoutAfter(RING_MS)
                .setContentIntent(screen)
                .setFullScreenIntent(screen, true)
                .setStyle(NotificationCompat.CallStyle.forIncomingCall(
                        new Person.Builder().setName(caller).setImportant(true).build(), decline, answer))
                .build();
        ContextCompat.getSystemService(context, NotificationManager.class).notify(NOTIFICATION_ID, notification);
        startSound(context);
    }

    void stop(Context context) {
        try {
            if (ringtone != null) ringtone.stop();
            if (vibrator != null) vibrator.cancel();
        } catch (RuntimeException e) {
            Log.w(TAG, "Could not stop the ring", e);
        }
        ContextCompat.getSystemService(context, NotificationManager.class).cancel(NOTIFICATION_ID);
        context.sendBroadcast(new Intent(IncomingCallActivity.ACTION_CLOSE).setPackage(context.getPackageName()));
    }

    private void startSound(Context context) {
        // A phone that can't play this ringtone must still show the call.
        try {
            int mode = ContextCompat.getSystemService(context, AudioManager.class).getRingerMode();
            if (mode == AudioManager.RINGER_MODE_SILENT) return;
            vibrator = (Vibrator) context.getSystemService(Context.VIBRATOR_SERVICE);
            if (vibrator != null && vibrator.hasVibrator()) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    vibrator.vibrate(VibrationEffect.createWaveform(VIBRATION, 0));
                } else {
                    vibrator.vibrate(VIBRATION, 0);
                }
            }
            if (mode != AudioManager.RINGER_MODE_NORMAL) return;
            ringtone = RingtoneManager.getRingtone(context, RingtoneManager.getActualDefaultRingtoneUri(context, RingtoneManager.TYPE_RINGTONE));
            if (ringtone == null) return;
            ringtone.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build());
            // shortcut: Android 8 and older play the ringtone once, the vibration still repeats there.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) ringtone.setLooping(true);
            ringtone.play();
        } catch (RuntimeException e) {
            Log.w(TAG, "Could not play the ring", e);
        }
    }

    private static void createChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, context.getString(R.string.call_channel_name), NotificationManager.IMPORTANCE_HIGH);
        // This class plays the ringtone itself, so the sound stops as soon as the call does.
        channel.setSound(null, null);
        channel.enableVibration(false);
        channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        ContextCompat.getSystemService(context, NotificationManager.class).createNotificationChannel(channel);
    }
}
