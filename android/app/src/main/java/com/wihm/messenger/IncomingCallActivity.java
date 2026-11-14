/*! Copyright (c) 2026 DarkPoesidon. Abraneh: https://github.com/DarkPoesidon/Abraneh. PolyForm Noncommercial 1.0.0; see LICENSE and NOTICE. */
package com.wihm.messenger;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;
import android.widget.TextView;

import androidx.core.content.ContextCompat;

/** The full screen incoming call, which also shows over the lock screen. It reveals only the caller's name. */
public class IncomingCallActivity extends Activity {
    static final String ACTION_CLOSE = "com.wihm.messenger.CLOSE_INCOMING_CALL";

    private final BroadcastReceiver closer = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            finish();
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
        setContentView(R.layout.activity_incoming_call);
        ContextCompat.registerReceiver(this, closer, new IntentFilter(ACTION_CLOSE), ContextCompat.RECEIVER_NOT_EXPORTED);

        ((TextView) findViewById(R.id.call_caller)).setText(getIntent().getStringExtra(IncomingCall.EXTRA_CALLER));
        ((TextView) findViewById(R.id.call_kind)).setText(getIntent().getBooleanExtra(IncomingCall.EXTRA_VIDEO, false)
                ? R.string.call_video_incoming : R.string.call_audio_incoming);
        findViewById(R.id.call_answer).setOnClickListener(v -> {
            startActivity(IncomingCall.answerIntent(this));
            finish();
        });
        findViewById(R.id.call_decline).setOnClickListener(v -> {
            startService(new Intent(this, WihmNotificationService.class).setAction(WihmNotificationService.ACTION_DECLINE));
            finish();
        });
    }

    @Override
    protected void onDestroy() {
        unregisterReceiver(closer);
        super.onDestroy();
    }
}
