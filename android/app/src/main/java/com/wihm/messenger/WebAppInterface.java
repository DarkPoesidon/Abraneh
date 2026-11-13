package com.wihm.messenger;

import androidx.core.content.pm.ShortcutManagerCompat;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.webkit.JavascriptInterface;
import android.widget.Toast;

public class WebAppInterface {
    private final MainActivity activity;
    private final CallAudio callAudio;

    public WebAppInterface(MainActivity activity) {
        this.activity = activity;
        callAudio = new CallAudio(activity);
    }

    @JavascriptInterface
    public boolean isAndroidApp() {
        return true;
    }

    @JavascriptInterface
    public String getAppVersion() {
        return UpdateHelper.getAppVersion(activity);
    }

    @JavascriptInterface
    public String getDeviceArchitecture() {
        return UpdateHelper.getPrimaryAbi();
    }

    @JavascriptInterface
    public void checkForUpdates() {
        activity.runOnUiThread(() -> UpdateHelper.checkForUpdate(activity, true, (available, latest, current, err) -> {
            activity.notifyWebUpdateStatus(available, latest, current, err);
        }));
    }

    @JavascriptInterface
    public void openGitHubReleases() {
        activity.runOnUiThread(() -> UpdateHelper.openGitHubReleases(activity));
    }

    @JavascriptInterface
    public void showToast(final String message) {
        if (message == null || message.trim().isEmpty()) return;
        activity.runOnUiThread(() -> Toast.makeText(activity, message, Toast.LENGTH_SHORT).show());
    }

    /** The page reports its theme, so the system bars around it match. */
    @JavascriptInterface
    public void setTheme(final boolean light) {
        activity.runOnUiThread(() -> activity.applySystemBars(light, true));
    }

    /** Whether back would close something in the page, so Android knows before a back gesture ends. */
    @JavascriptInterface
    public void setCanGoBack(final boolean canGoBack) {
        activity.runOnUiThread(() -> activity.setPageHasBack(canGoBack));
    }

    @JavascriptInterface
    public boolean isAppLockAvailable() {
        return activity.appLockAvailable();
    }

    @JavascriptInterface
    public boolean isAppLockEnabled() {
        return activity.appLockEnabled();
    }

    /** Returns false when the phone has no screen lock to unlock the app with. */
    @JavascriptInterface
    public boolean setAppLockEnabled(final boolean enabled) {
        if (enabled && !activity.appLockAvailable()) return false;
        activity.runOnUiThread(() -> activity.setAppLock(enabled));
        return true;
    }

    @JavascriptInterface
    public void showNotification(final String title, final String message, final String chatId) {
        activity.runOnUiThread(() -> NotificationHelper.showNotification(activity, title, message, chatId));
    }

    @JavascriptInterface
    public void setCallAudio(final String route) {
        activity.runOnUiThread(() -> {
            if (!callAudio.set(route)) return;
            activity.keepScreenOn(!"off".equals(route));
        });
    }

    /** The token only goes to this app's own server, whatever the page asks for. */
    @JavascriptInterface
    public void downloadFile(final String url, final String name, final String mime, final String token) {
        if (url == null || name == null || token == null || !UrlRules.sameOrigin(url, activity.serverUrl())) return;
        activity.runOnUiThread(() -> FileDownload.start(activity, url, name, mime == null ? "application/octet-stream" : mime, token));
    }

    void stopCallAudio() {
        callAudio.stop();
    }

    @JavascriptInterface
    public void saveAuthToken(final String token, final String userId, final String serverUrl) {
        if (token == null || token.isEmpty()) return;
        activity.runOnUiThread(() -> {
            SharedPreferences prefs = activity.getSharedPreferences(ServerConfigActivity.PREFS_NAME, Context.MODE_PRIVATE);
            prefs.edit()
                    .putString(ServerConfigActivity.KEY_AUTH_TOKEN, token)
                    .putString(ServerConfigActivity.KEY_USER_ID, userId != null ? userId : "")
                    .apply();

            // Start background notification service
            WihmNotificationService.start(activity);
            PowerHelper.askForExemptionOnce(activity);
        });
    }

    @JavascriptInterface
    public void clearAuthToken() {
        activity.runOnUiThread(() -> {
            SharedPreferences prefs = activity.getSharedPreferences(ServerConfigActivity.PREFS_NAME, Context.MODE_PRIVATE);
            prefs.edit()
                    .remove(ServerConfigActivity.KEY_AUTH_TOKEN)
                    .remove(ServerConfigActivity.KEY_USER_ID)
                    .apply();

            // Stop background notification service
            WihmNotificationService.stop(activity);
            // The chats' shortcuts name the people in them, so they leave with the account.
            ShortcutManagerCompat.removeAllDynamicShortcuts(activity);
        });
    }

    @JavascriptInterface
    public boolean isKeepAliveEnabled() {
        SharedPreferences prefs = activity.getSharedPreferences(ServerConfigActivity.PREFS_NAME, Context.MODE_PRIVATE);
        return prefs.getBoolean("keep_alive_enabled", true);
    }

    @JavascriptInterface
    public void setKeepAliveEnabled(final boolean enabled) {
        activity.runOnUiThread(() -> {
            SharedPreferences prefs = activity.getSharedPreferences(ServerConfigActivity.PREFS_NAME, Context.MODE_PRIVATE);
            prefs.edit().putBoolean("keep_alive_enabled", enabled).apply();
            if (enabled) {
                WihmNotificationService.start(activity);
                Toast.makeText(activity, activity.getString(R.string.service_turned_on), Toast.LENGTH_SHORT).show();
            } else {
                WihmNotificationService.stop(activity);
                Toast.makeText(activity, activity.getString(R.string.service_turned_off), Toast.LENGTH_SHORT).show();
            }
        });
    }

    @JavascriptInterface
    public boolean isBatteryOptimizationIgnored() {
        return PowerHelper.isIgnoringBatteryOptimizations(activity);
    }

    @JavascriptInterface
    public void requestIgnoreBatteryOptimization() {
        activity.runOnUiThread(() -> PowerHelper.requestIgnoreBatteryOptimizations(activity));
    }

    @JavascriptInterface
    public void openAutostartSettings() {
        activity.runOnUiThread(() -> PowerHelper.openAutostartSettings(activity));
    }

    @JavascriptInterface
    public void vibrate(final long milliseconds) {
        activity.runOnUiThread(() -> {
            try {
                Vibrator v = (Vibrator) activity.getSystemService(Context.VIBRATOR_SERVICE);
                if (v != null && v.hasVibrator()) {
                    long duration = milliseconds > 0 && milliseconds < 2000 ? milliseconds : 50;
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        v.vibrate(VibrationEffect.createOneShot(duration, VibrationEffect.DEFAULT_AMPLITUDE));
                    } else {
                        v.vibrate(duration);
                    }
                }
            } catch (Exception ignored) {
            }
        });
    }

    @JavascriptInterface
    public void copyToClipboard(final String text) {
        if (text == null) return;
        activity.runOnUiThread(() -> {
            try {
                ClipboardManager clipboard = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
                ClipData clip = ClipData.newPlainText("WIHM Text", text);
                if (clipboard != null) {
                    clipboard.setPrimaryClip(clip);
                    Toast.makeText(activity, activity.getString(R.string.copied), Toast.LENGTH_SHORT).show();
                }
            } catch (Exception ignored) {
            }
        });
    }

    @JavascriptInterface
    public void shareText(final String title, final String text) {
        activity.runOnUiThread(() -> {
            try {
                Intent sendIntent = new Intent();
                sendIntent.setAction(Intent.ACTION_SEND);
                sendIntent.putExtra(Intent.EXTRA_TEXT, text != null ? text : "");
                if (title != null && !title.isEmpty()) {
                    sendIntent.putExtra(Intent.EXTRA_SUBJECT, title);
                }
                sendIntent.setType("text/plain");
                Intent shareIntent = Intent.createChooser(sendIntent, title != null ? title : activity.getString(R.string.share));
                activity.startActivity(shareIntent);
            } catch (Exception ignored) {
            }
        });
    }

    @JavascriptInterface
    public void openInTelegram(final String url) {
        activity.runOnUiThread(() -> TelegramHelper.openTelegramLink(activity, url));
    }

    @JavascriptInterface
    public String getServerUrl() {
        return activity.getServerUrl();
    }

    @JavascriptInterface
    public void setServerUrl(final String url) {
        activity.runOnUiThread(() -> activity.saveAndReloadServer(url));
    }

    @JavascriptInterface
    public void openNotificationSettings() {
        activity.runOnUiThread(activity::showNotificationSettingsDialog);
    }

    @JavascriptInterface
    public void openServerSettings() {
        activity.runOnUiThread(activity::openServerConfig);
    }
}
