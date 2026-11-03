package com.wihm.messenger;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.util.Log;

public class TelegramHelper {
    private static final String TAG = "TelegramHelper";

    // Known Telegram Android package names
    private static final String[] TELEGRAM_PACKAGES = {
        "org.telegram.messenger",
        "org.telegram.messenger.web",
        "org.thunderdog.challegram", // Telegram X
        "org.telegram.plus"          // Plus Messenger
    };

    /**
     * Checks if any Telegram app is installed on the device.
     */
    public static boolean isTelegramInstalled(Context context) {
        PackageManager pm = context.getPackageManager();
        for (String pkg : TELEGRAM_PACKAGES) {
            try {
                pm.getPackageInfo(pkg, PackageManager.GET_ACTIVITIES);
                return true;
            } catch (PackageManager.NameNotFoundException ignored) {
            }
        }
        return false;
    }

    /**
     * Opens a Telegram link (t.me/... or tg://...) in the installed Telegram app,
     * or falls back to standard browser view.
     */
    public static boolean openTelegramLink(Context context, String url) {
        if (url == null || url.trim().isEmpty()) {
            return false;
        }

        try {
            Uri uri = Uri.parse(url);
            String scheme = uri.getScheme();
            String host = uri.getHost();

            // Direct tg:// URI
            if ("tg".equalsIgnoreCase(scheme)) {
                Intent tgIntent = new Intent(Intent.ACTION_VIEW, uri);
                tgIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(tgIntent);
                return true;
            }

            // t.me or telegram.me web URLs
            if (("t.me".equalsIgnoreCase(host) || "telegram.me".equalsIgnoreCase(host))) {
                // Try opening with Telegram-specific package first
                for (String pkg : TELEGRAM_PACKAGES) {
                    try {
                        Intent intent = new Intent(Intent.ACTION_VIEW, uri);
                        intent.setPackage(pkg);
                        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        context.startActivity(intent);
                        return true;
                    } catch (Exception ignored) {
                    }
                }

                // If package targeting failed, try converting to tg://resolve?domain=
                String path = uri.getPath();
                if (path != null && path.length() > 1) {
                    String domainOrPost = path.substring(1); // remove leading /
                    String tgResolveUrl;
                    if (domainOrPost.contains("/")) {
                        String[] parts = domainOrPost.split("/");
                        tgResolveUrl = "tg://resolve?domain=" + parts[0] + "&post=" + parts[1];
                    } else {
                        tgResolveUrl = "tg://resolve?domain=" + domainOrPost;
                    }
                    try {
                        Intent resolveIntent = new Intent(Intent.ACTION_VIEW, Uri.parse(tgResolveUrl));
                        resolveIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        context.startActivity(resolveIntent);
                        return true;
                    } catch (Exception ignored) {
                    }
                }
            }

            // Fallback: standard browser intent
            Intent browserIntent = new Intent(Intent.ACTION_VIEW, uri);
            browserIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(browserIntent);
            return true;

        } catch (Exception e) {
            Log.e(TAG, "Error opening Telegram link: " + url, e);
            return false;
        }
    }
}
