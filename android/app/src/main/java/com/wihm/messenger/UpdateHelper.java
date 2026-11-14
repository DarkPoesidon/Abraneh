/*! Copyright (c) 2026 DarkPoesidon. Abraneh: https://github.com/DarkPoesidon/Abraneh. PolyForm Noncommercial 1.0.0; see LICENSE and NOTICE. */
package com.wihm.messenger;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.Log;
import android.view.LayoutInflater;
import android.view.View;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.appcompat.app.AlertDialog;
import androidx.core.content.FileProvider;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class UpdateHelper {
    private static final String TAG = "UpdateHelper";
    public static final String GITHUB_REPO = "DarkPoesidon/Abraneh";
    // By number, not name: GitHub keeps the number through a rename or a transfer. Same number as src/update-bundle.ts.
    public static final String GITHUB_RELEASES_API = "https://api.github.com/repositories/1436869002/releases/latest";
    public static final String GITHUB_RELEASES_PAGE = "https://github.com/" + GITHUB_REPO + "/releases/latest";
    private static final String APK_NAME = "wihm-messenger-android-universal.apk";
    private static final String UPDATE_CHECK_PREF = "last_update_check_time";
    private static final long UPDATE_CHECK_INTERVAL_MS = 24L * 3600L * 1000L;
    private static final int UPDATE_NOTIFICATION_ID = 9002;

    private static final ExecutorService executor = Executors.newSingleThreadExecutor();
    private static final Handler mainHandler = new Handler(Looper.getMainLooper());

    public interface UpdateCheckListener {
        void onCheckComplete(boolean updateAvailable, String latestVersion, String currentVersion, String error);
    }

    public static String getAppVersion(Context context) {
        try {
            PackageInfo pInfo = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            return pInfo.versionName != null ? pInfo.versionName : "1.4.4";
        } catch (PackageManager.NameNotFoundException e) {
            return "1.4.4";
        }
    }

    public static String getPrimaryAbi() {
        if (Build.SUPPORTED_ABIS != null && Build.SUPPORTED_ABIS.length > 0) {
            return Build.SUPPORTED_ABIS[0];
        }
        return "universal";
    }

    /** Returns the latest published release. */
    private static JSONObject fetchLatestRelease() throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(GITHUB_RELEASES_API).openConnection();
        try {
            conn.setRequestMethod("GET");
            conn.setRequestProperty("User-Agent", "WIHM-Android-Messenger");
            conn.setRequestProperty("Accept", "application/vnd.github.v3+json");
            conn.setConnectTimeout(10000);
            conn.setReadTimeout(15000);

            int responseCode = conn.getResponseCode();
            if (responseCode != HttpURLConnection.HTTP_OK) {
                throw new Exception("GitHub API HTTP " + responseCode);
            }

            StringBuilder sb = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    sb.append(line);
                }
            }

            return new JSONObject(sb.toString());
        } finally {
            conn.disconnect();
        }
    }

    public static void checkForUpdate(final Activity activity, final boolean userInitiated, final UpdateCheckListener listener) {
        if (activity == null || activity.isFinishing()) return;

        if (userInitiated) {
            Toast.makeText(activity, R.string.update_checking, Toast.LENGTH_SHORT).show();
        }

        executor.execute(() -> {
            try {
                JSONObject release = fetchLatestRelease();
                String currentVersion = getAppVersion(activity);
                String releaseVersion = UrlRules.androidReleaseVersion(release.optString("tag_name"));
                String latestVersion = releaseVersion == null ? currentVersion : releaseVersion;
                String releaseNotes = release.optString("body", "").trim();
                String htmlUrl = release.optString("html_url", GITHUB_RELEASES_PAGE);
                JSONArray assets = release.optJSONArray("assets");

                String downloadUrl = "";
                long size = 0;
                for (int i = 0; assets != null && i < assets.length(); i++) {
                    JSONObject asset = assets.getJSONObject(i);
                    if (APK_NAME.equals(asset.optString("name"))) {
                        downloadUrl = asset.optString("browser_download_url");
                        size = asset.optLong("size");
                        break;
                    }
                }

                final boolean isNewer = !release.optBoolean("draft") && !release.optBoolean("prerelease")
                        && !downloadUrl.isEmpty() && compareVersions(latestVersion, currentVersion) > 0;
                final String finalDownloadUrl = downloadUrl;
                final long finalSize = size;

                mainHandler.post(() -> {
                    if (activity.isFinishing()) return;

                    if (listener != null) {
                        listener.onCheckComplete(isNewer, latestVersion, currentVersion, null);
                    }

                    if (isNewer) {
                        showUpdateAvailableDialog(activity, latestVersion, currentVersion, releaseNotes,
                                finalDownloadUrl, APK_NAME, finalSize, htmlUrl);
                    } else if (userInitiated) {
                        new AlertDialog.Builder(activity)
                                .setTitle(R.string.update_latest_title)
                                .setMessage(activity.getString(R.string.update_latest_msg, currentVersion))
                                .setPositiveButton(activity.getString(R.string.ok), null)
                                .show();
                    }
                });

            } catch (Exception e) {
                Log.e(TAG, "Failed to check update", e);
                final String errMsg = e.getMessage();
                mainHandler.post(() -> {
                    if (listener != null) {
                        listener.onCheckComplete(false, null, getAppVersion(activity), errMsg);
                    }
                    if (userInitiated && !activity.isFinishing()) {
                        Toast.makeText(activity, "خطا در بررسی نسخه جدید: " + errMsg, Toast.LENGTH_LONG).show();
                    }
                });
            }
        });
    }

    private static void showUpdateAvailableDialog(final Activity activity,
                                                   final String latestVersion,
                                                   final String currentVersion,
                                                   final String releaseNotes,
                                                   final String downloadUrl,
                                                   final String assetName,
                                                   final long assetSize,
                                                   final String htmlUrl) {
        String primaryAbi = getPrimaryAbi();
        String message = activity.getString(R.string.update_available_msg,
                latestVersion, currentVersion, primaryAbi,
                (releaseNotes.isEmpty() ? activity.getString(R.string.improvements) : releaseNotes));

        AlertDialog.Builder builder = new AlertDialog.Builder(activity)
                .setTitle(R.string.update_available_title)
                .setMessage(message)
                .setNegativeButton(R.string.update_later_btn, null)
                .setNeutralButton(R.string.update_view_releases, (d, w) -> {
                    try {
                        Intent browserIntent = new Intent(Intent.ACTION_VIEW, Uri.parse(htmlUrl));
                        activity.startActivity(browserIntent);
                    } catch (Exception ignored) {
                    }
                });

        if (downloadUrl != null && !downloadUrl.isEmpty()) {
            builder.setPositiveButton(R.string.update_download_btn, (d, w) -> {
                downloadAndInstallApk(activity, downloadUrl, assetName, assetSize);
            });
        }

        builder.show();
    }

    public static void downloadAndInstallApk(final Activity activity,
                                            final String downloadUrl,
                                            final String assetName,
                                            final long totalSize) {
        if (activity == null || activity.isFinishing()) return;

        // Custom download progress dialog
        final AlertDialog progressDialog = new AlertDialog.Builder(activity)
                .setTitle(activity.getString(R.string.downloading_title))
                .setMessage(activity.getString(R.string.downloading_wait))
                .setCancelable(false)
                .create();

        final ProgressBar progressBar = new ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal);
        progressBar.setMax(100);
        progressBar.setProgress(0);
        progressBar.setIndeterminate(false);
        progressBar.setPadding(40, 20, 40, 20);

        progressDialog.setView(progressBar);
        progressDialog.setButton(AlertDialog.BUTTON_NEGATIVE, activity.getString(R.string.cancel_short), (d, w) -> progressDialog.dismiss());
        progressDialog.show();

        executor.execute(() -> {
            HttpURLConnection conn = null;
            InputStream in = null;
            FileOutputStream out = null;
            File outputFile = null;

            try {
                // Follow redirects manually if needed (GitHub redirects download URLs to AWS S3)
                String currentUrl = downloadUrl;
                for (int redirectCount = 0; redirectCount < 6; redirectCount++) {
                    URL u = new URL(currentUrl);
                    conn = (HttpURLConnection) u.openConnection(ProxySettings.current(activity));
                    conn.setRequestProperty("User-Agent", "WIHM-Android-Messenger");
                    conn.setConnectTimeout(15000);
                    conn.setReadTimeout(30000);
                    conn.setInstanceFollowRedirects(true);

                    int code = conn.getResponseCode();
                    if (code == HttpURLConnection.HTTP_MOVED_PERM ||
                            code == HttpURLConnection.HTTP_MOVED_TEMP ||
                            code == HttpURLConnection.HTTP_SEE_OTHER ||
                            code == 307 || code == 308) {
                        String location = conn.getHeaderField("Location");
                        conn.disconnect();
                        if (location != null && !location.isEmpty()) {
                            currentUrl = location;
                            continue;
                        }
                    }
                    break;
                }

                if (conn.getResponseCode() != HttpURLConnection.HTTP_OK) {
                    throw new Exception("HTTP response " + conn.getResponseCode());
                }

                long fileLength = conn.getContentLength();
                if (fileLength <= 0) fileLength = totalSize;

                File cacheDir = activity.getExternalCacheDir();
                if (cacheDir == null) cacheDir = activity.getCacheDir();
                outputFile = new File(cacheDir, assetName);
                if (outputFile.exists()) {
                    outputFile.delete();
                }

                in = conn.getInputStream();
                out = new FileOutputStream(outputFile);

                byte[] buffer = new byte[8192];
                long downloaded = 0;
                int read;
                long lastProgressTime = 0;

                while ((read = in.read(buffer)) != -1) {
                    if (!progressDialog.isShowing()) {
                        // User canceled download
                        if (outputFile.exists()) outputFile.delete();
                        return;
                    }

                    out.write(buffer, 0, read);
                    downloaded += read;

                    long now = System.currentTimeMillis();
                    if (fileLength > 0 && (now - lastProgressTime > 150)) {
                        lastProgressTime = now;
                        final int progress = (int) ((downloaded * 100) / fileLength);
                        final long currentBytes = downloaded;
                        final long totalBytes = fileLength;
                        mainHandler.post(() -> {
                            if (progressDialog.isShowing()) {
                                progressBar.setProgress(progress);
                                progressDialog.setMessage(String.format("در حال دریافت: %d%% (%.1f / %.1f مگابایت)",
                                        progress,
                                        currentBytes / (1024.0 * 1024.0),
                                        totalBytes / (1024.0 * 1024.0)));
                            }
                        });
                    }
                }

                out.flush();

                final File finalApkFile = outputFile;
                mainHandler.post(() -> {
                    try {
                        if (progressDialog.isShowing()) {
                            progressDialog.dismiss();
                        }
                    } catch (Exception ignored) {
                    }
                    installApk(activity, finalApkFile);
                });

            } catch (Exception e) {
                Log.e(TAG, "Download failed", e);
                if (outputFile != null && outputFile.exists()) {
                    outputFile.delete();
                }
                final String err = e.getMessage();
                mainHandler.post(() -> {
                    try {
                        if (progressDialog.isShowing()) {
                            progressDialog.dismiss();
                        }
                    } catch (Exception ignored) {
                    }
                    Toast.makeText(activity, "دانلود با خطا مواجه شد: " + err, Toast.LENGTH_LONG).show();
                });
            } finally {
                try {
                    if (in != null) in.close();
                } catch (Exception ignored) {}
                try {
                    if (out != null) out.close();
                } catch (Exception ignored) {}
                if (conn != null) conn.disconnect();
            }
        });
    }

    public static void installApk(Activity activity, File apkFile) {
        if (activity == null || activity.isFinishing() || apkFile == null || !apkFile.exists()) {
            return;
        }

        // Check Unknown Apps permission on Android 8.0+ (API 26)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (!activity.getPackageManager().canRequestPackageInstalls()) {
                Toast.makeText(activity, R.string.update_permission_needed, Toast.LENGTH_LONG).show();
                try {
                    Intent permIntent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                            Uri.parse("package:" + activity.getPackageName()));
                    activity.startActivity(permIntent);
                } catch (Exception e) {
                    Log.e(TAG, "Could not open unknown apps settings", e);
                }
                return;
            }
        }

        try {
            Uri apkUri = FileProvider.getUriForFile(
                    activity,
                    activity.getPackageName() + ".provider",
                    apkFile
            );

            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(apkUri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.startActivity(intent);
        } catch (Exception e) {
            Log.e(TAG, "Failed to launch package installer", e);
            Toast.makeText(activity, "خطا در اجرای برنامه نصب: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    public static int compareVersions(String v1, String v2) {
        if (v1 == null) v1 = "0.0.0";
        if (v2 == null) v2 = "0.0.0";

        v1 = v1.replaceAll("^[vV]", "").trim();
        v2 = v2.replaceAll("^[vV]", "").trim();

        String[] parts1 = v1.split("[.\\-]");
        String[] parts2 = v2.split("[.\\-]");

        int length = Math.max(parts1.length, parts2.length);
        for (int i = 0; i < length; i++) {
            int num1 = 0;
            if (i < parts1.length) {
                try {
                    num1 = Integer.parseInt(parts1[i].replaceAll("\\D+", ""));
                } catch (Exception ignored) {}
            }
            int num2 = 0;
            if (i < parts2.length) {
                try {
                    num2 = Integer.parseInt(parts2[i].replaceAll("\\D+", ""));
                } catch (Exception ignored) {}
            }

            if (num1 > num2) return 1;
            if (num1 < num2) return -1;
        }

        return 0;
    }

    public static void openGitHubReleases(Activity activity) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(GITHUB_RELEASES_PAGE));
            activity.startActivity(intent);
        } catch (Exception ignored) {
        }
    }
}
