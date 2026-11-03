package com.wihm.messenger;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.webkit.WebSettings;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;

/** The whole messenger runs in WebView, and on old phones WebView can be years behind the app. */
final class WebViewCheck {
    private static final String WEBVIEW_PACKAGE = "com.google.android.webview";

    private WebViewCheck() {
    }

    static void warnIfOld(AppCompatActivity activity) {
        // The installed package can't be read before Android 8 until WebView has loaded, but this always works.
        if (!UrlRules.webViewTooOld(WebSettings.getDefaultUserAgent(activity))) return;
        new AlertDialog.Builder(activity)
                .setTitle(R.string.webview_old_title)
                .setMessage(R.string.webview_old_message)
                .setPositiveButton(R.string.webview_update, (dialog, which) -> openStore(activity))
                .setNegativeButton(android.R.string.cancel, null)
                .show();
    }

    private static void openStore(AppCompatActivity activity) {
        try {
            activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=" + WEBVIEW_PACKAGE)));
        } catch (ActivityNotFoundException noStore) {
            activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=" + WEBVIEW_PACKAGE)));
        }
    }
}
