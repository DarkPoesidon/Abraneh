package com.wihm.messenger;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (context == null || intent == null) return;

        String action = intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(action) ||
            Intent.ACTION_MY_PACKAGE_REPLACED.equals(action) ||
            "android.intent.action.QUICKBOOT_POWERON".equals(action)) {

            SharedPreferences prefs = context.getSharedPreferences(ServerConfigActivity.PREFS_NAME, Context.MODE_PRIVATE);
            String token = prefs.getString(ServerConfigActivity.KEY_AUTH_TOKEN, "");
            boolean keepAlive = prefs.getBoolean("keep_alive_enabled", true);

            if (!token.isEmpty() && keepAlive) {
                WihmNotificationService.start(context);
            }
        }
    }
}
