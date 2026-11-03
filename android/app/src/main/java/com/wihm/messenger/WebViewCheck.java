package com.wihm.messenger;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.webkit.WebViewCompat;

/** The whole messenger runs in WebView, and on old phones WebView can be years behind the app. */
final class WebViewCheck {
    private WebViewCheck() {
    }

    static void warnIfOld(AppCompatActivity activity) {
        PackageInfo webView = WebViewCompat.getCurrentWebViewPackage(activity);
        if (webView == null || !UrlRules.webViewTooOld(webView.versionName)) return;
        new AlertDialog.Builder(activity)
                .setTitle(R.string.webview_old_title)
                .setMessage(R.string.webview_old_message)
                .setPositiveButton(R.string.webview_update, (dialog, which) -> openStore(activity, webView.packageName))
                .setNegativeButton(android.R.string.cancel, null)
                .show();
    }

    private static void openStore(AppCompatActivity activity, String packageName) {
        try {
            activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=" + packageName)));
        } catch (ActivityNotFoundException noStore) {
            activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=" + packageName)));
        }
    }
}
