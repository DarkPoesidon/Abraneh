package com.wihm.messenger;

import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.net.Uri;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.app.KeyguardManager;
import android.view.ViewTreeObserver;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import android.view.WindowManager;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.annotation.NonNull;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.appcompat.widget.SwitchCompat;
import androidx.core.content.ContextCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.List;

public class MainActivity extends AppCompatActivity {
    private static final int REQUEST_CODE_SERVER_CONFIG = 1001;

    /** While on screen the page handles new messages and calls itself. */
    static volatile boolean visible;
    private static final String KEY_LIGHT_THEME = "light_theme";

    private boolean pageLoaded;
    private OnBackPressedCallback backCallback;
    private static final long START_SCREEN_MAX_MS = 3000;
    static final String KEY_APP_LOCK = "app_lock";
    private static final int REQUEST_CODE_UNLOCK = 1002;
    // As in Signal, a short trip to another app does not ask again.
    private static final long LOCK_AFTER_MS = 60_000;
    private boolean unlocked, unlocking, answeringCall;
    private long stoppedAt;
    private final List<String> pendingScripts = new ArrayList<>();
    private WebView webView;
    private ProgressBar progressBar;
    private LinearLayout errorLayout;
    private Button btnRetry;
    private Button btnChangeServer;

    private String currentServerUrl = "";
    private WebAppInterface pageInterface;

    String serverUrl() {
        return currentServerUrl;
    }

    void keepScreenOn(boolean on) {
        if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }
    private ValueCallback<Uri[]> fileUploadCallback;
    private PermissionRequest pendingMediaRequest;

    // Activity result launcher for file chooser
    private final ActivityResultLauncher<Intent> fileChooserLauncher = registerForActivityResult(
            new ActivityResultContracts.StartActivityForResult(),
            result -> {
                if (fileUploadCallback == null) return;
                Uri[] results = null;
                if (result.getResultCode() == RESULT_OK && result.getData() != null) {
                    Intent data = result.getData();
                    if (data.getDataString() != null) {
                        results = new Uri[]{Uri.parse(data.getDataString())};
                    } else if (data.getClipData() != null) {
                        int count = data.getClipData().getItemCount();
                        results = new Uri[count];
                        for (int i = 0; i < count; i++) {
                            results[i] = data.getClipData().getItemAt(i).getUri();
                        }
                    }
                }
                fileUploadCallback.onReceiveValue(results);
                fileUploadCallback = null;
            }
    );

    // Permission launcher for the microphone and camera (messages and calls)
    private final ActivityResultLauncher<String[]> mediaPermissionLauncher = registerForActivityResult(
            new ActivityResultContracts.RequestMultiplePermissions(),
            results -> {
                if (pendingMediaRequest == null) return;
                PermissionRequest request = pendingMediaRequest;
                pendingMediaRequest = null;
                String[] granted = grantableResources(request.getResources());
                if (granted.length == 0 || granted.length < mediaResources(request.getResources()).size()) {
                    Toast.makeText(this, R.string.permission_media_rationale, Toast.LENGTH_LONG).show();
                }
                if (granted.length == 0) request.deny(); else request.grant(granted);
            }
    );

    private static List<String> mediaResources(String[] requested) {
        List<String> media = new ArrayList<>();
        for (String resource : requested) {
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource) || PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) {
                media.add(resource);
            }
        }
        return media;
    }

    private static String androidPermissionFor(String resource) {
        return PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource) ? Manifest.permission.CAMERA : Manifest.permission.RECORD_AUDIO;
    }

    private String[] grantableResources(String[] requested) {
        List<String> granted = new ArrayList<>();
        for (String resource : mediaResources(requested)) {
            if (ContextCompat.checkSelfPermission(this, androidPermissionFor(resource)) == PackageManager.PERMISSION_GRANTED) {
                granted.add(resource);
            }
        }
        return granted.toArray(new String[0]);
    }

    private void handleMediaRequest(PermissionRequest request) {
        // Only the configured server gets media, and nothing beyond the microphone and camera.
        List<String> media = mediaResources(request.getResources());
        if (media.isEmpty() || !UrlRules.sameOrigin(request.getOrigin().toString(), currentServerUrl)) {
            request.deny();
            return;
        }
        List<String> missing = new ArrayList<>();
        for (String resource : media) {
            String permission = androidPermissionFor(resource);
            if (ContextCompat.checkSelfPermission(this, permission) != PackageManager.PERMISSION_GRANTED) missing.add(permission);
        }
        if (missing.isEmpty()) {
            request.grant(media.toArray(new String[0]));
        } else {
            pendingMediaRequest = request;
            mediaPermissionLauncher.launch(missing.toArray(new String[0]));
        }
    }

    // Permission launcher for notifications (Android 13+)
    private final ActivityResultLauncher<String> notificationPermissionLauncher = registerForActivityResult(
            new ActivityResultContracts.RequestPermission(),
            isGranted -> {
                // Notification permission handled
            }
    );

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (WebViewCheck.stopIfMissing(this)) return;
        setContentView(R.layout.activity_main);
        holdStartScreen();
        applySystemBars(getSharedPreferences(ServerConfigActivity.PREFS_NAME, Context.MODE_PRIVATE).getBoolean(KEY_LIGHT_THEME, false), false);

        NotificationHelper.createNotificationChannel(this);
        checkAndRequestNotificationPermission();

        webView = findViewById(R.id.web_view);
        progressBar = findViewById(R.id.progress_bar);
        errorLayout = findViewById(R.id.error_layout);
        btnRetry = findViewById(R.id.btn_retry);
        btnChangeServer = findViewById(R.id.btn_change_server);

        setupWebView();
        setupErrorView();
        setupBackNavigation();
        hideFromRecents(appLockEnabled());

        // Check if server URL is configured
        SharedPreferences prefs = getSharedPreferences(ServerConfigActivity.PREFS_NAME, Context.MODE_PRIVATE);
        currentServerUrl = prefs.getString(ServerConfigActivity.KEY_SERVER_URL, "");

        if (currentServerUrl == null || currentServerUrl.trim().isEmpty()) {
            openServerConfig();
        } else {
            WebViewCheck.warnIfOld(this);
            loadServer(currentServerUrl);
        }

        handleIncomingIntent(getIntent());
    }

    /** Keeps the start screen up until the page has drawn, instead of showing an empty page. Never longer than a few seconds. */
    private void holdStartScreen() {
        final long until = SystemClock.uptimeMillis() + START_SCREEN_MAX_MS;
        final View content = findViewById(android.R.id.content);
        content.getViewTreeObserver().addOnPreDrawListener(new ViewTreeObserver.OnPreDrawListener() {
            @Override
            public boolean onPreDraw() {
                boolean ready = pageLoaded || errorLayout == null || errorLayout.getVisibility() == View.VISIBLE
                        || currentServerUrl == null || currentServerUrl.isEmpty() || SystemClock.uptimeMillis() > until;
                if (ready) content.getViewTreeObserver().removeOnPreDrawListener(this);
                return ready;
            }
        });
    }

    /** The status and navigation bars follow the page's theme. It is saved so the next start opens in it. */
    void applySystemBars(boolean light, boolean save) {
        if (save) getSharedPreferences(ServerConfigActivity.PREFS_NAME, Context.MODE_PRIVATE).edit().putBoolean(KEY_LIGHT_THEME, light).apply();
        // Dark icons need Android 6 on the status bar and Android 8 on the navigation bar. Older versions keep dark bars.
        boolean lightStatus = light && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M;
        boolean lightNavigation = light && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O;
        getWindow().setStatusBarColor(lightStatus ? Color.WHITE : ContextCompat.getColor(this, R.color.status_bar_color));
        getWindow().setNavigationBarColor(lightNavigation ? Color.WHITE : ContextCompat.getColor(this, R.color.nav_bar_color));
        WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        bars.setAppearanceLightStatusBars(lightStatus);
        bars.setAppearanceLightNavigationBars(lightNavigation);
    }

    @Override
    protected void onStart() {
        super.onStart();
        visible = true;
        NotificationHelper.clearMessages(this);
        WihmNotificationService.stopRinging(this);
        tellPageVisibility();
    }

    @Override
    protected void onStop() {
        visible = false;
        stoppedAt = SystemClock.elapsedRealtime();
        tellPageVisibility();
        // Answering a call is the only reason to show over the lock screen, so it ends with the screen.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) setShowWhenLocked(false);
        super.onStop();
    }

    /** Stops the page's own ring while the service rings. Pausing the WebView instead would mute a running call. */
    private void tellPageVisibility() {
        if (pageLoaded) webView.evaluateJavascript(visibilityScript(), null);
    }

    private static String visibilityScript() {
        return "window.wihmAppHidden=" + !visible + ";window.dispatchEvent(new Event('wihm-app-visibility'));";
    }

    boolean appLockEnabled() {
        return getSharedPreferences(ServerConfigActivity.PREFS_NAME, Context.MODE_PRIVATE).getBoolean(KEY_APP_LOCK, false);
    }

    /** Only possible with a screen lock, since that is what unlocks the app. */
    boolean appLockAvailable() {
        KeyguardManager keyguard = ContextCompat.getSystemService(this, KeyguardManager.class);
        return keyguard != null && (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? keyguard.isDeviceSecure() : keyguard.isKeyguardSecure());
    }

    boolean setAppLock(boolean enabled) {
        if (enabled && !appLockAvailable()) return false;
        getSharedPreferences(ServerConfigActivity.PREFS_NAME, Context.MODE_PRIVATE).edit().putBoolean(KEY_APP_LOCK, enabled).commit(); // written at once: a lock lost to a quick kill would leave the app open
        unlocked = true;
        hideFromRecents(enabled);
        return true;
    }

    /** The preview in the recent apps list would show the chats the lock hides. Android 13 can hide it without blocking screenshots. */
    private void hideFromRecents(boolean hide) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) setRecentsScreenshotEnabled(!hide);
    }

    /** Asks for the phone's own unlock when the app opens, or returns after a minute away. An answered call never waits for it. */
    private void lockIfNeeded() {
        if (!appLockEnabled() || unlocking) return;
        if (answeringCall) { answeringCall = false; unlocked = true; return; }
        if (unlocked && SystemClock.elapsedRealtime() - stoppedAt < LOCK_AFTER_MS) return;
        KeyguardManager keyguard = ContextCompat.getSystemService(this, KeyguardManager.class);
        Intent unlock = keyguard == null ? null : keyguard.createConfirmDeviceCredentialIntent(getString(R.string.app_lock_title), getString(R.string.app_lock_desc));
        // The screen lock was removed after the lock was set, so nothing could unlock the app.
        if (unlock == null) { unlocked = true; return; }
        unlocked = false;
        unlocking = true;
        webView.setVisibility(View.INVISIBLE);
        startActivityForResult(unlock, REQUEST_CODE_UNLOCK);
    }

    @Override
    protected void onResume() {
        super.onResume();
        lockIfNeeded();
        SharedPreferences prefs = getSharedPreferences(ServerConfigActivity.PREFS_NAME, Context.MODE_PRIVATE);
        String token = prefs.getString(ServerConfigActivity.KEY_AUTH_TOKEN, "");
        boolean keepAlive = prefs.getBoolean("keep_alive_enabled", true);
        if (!token.isEmpty() && keepAlive) {
            WihmNotificationService.start(this);
            PowerHelper.askForExemptionOnce(this);
        }

        // Periodic background update check (once every 24 hours)
        long lastCheck = prefs.getLong("last_update_check_time", 0);
        long now = System.currentTimeMillis();
        if (now - lastCheck > 24L * 3600L * 1000L) {
            prefs.edit().putLong("last_update_check_time", now).apply();
            UpdateHelper.checkForUpdate(this, false, null);
        }
    }

    private void checkAndRequestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED) {
                notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS);
            }
        }
    }

    @Override
    protected void onDestroy() {
        if (pageInterface != null) pageInterface.stopCallAudio();
        super.onDestroy();
    }

    private void setupWebView() {
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        webView.setVerticalScrollBarEnabled(false);
        webView.setHorizontalScrollBarEnabled(false);
        webView.setLayerType(View.LAYER_TYPE_HARDWARE, null);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setMediaPlaybackRequiresUserGesture(false);

        // Offline caching support
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);

        // Custom User Agent
        String defaultUa = settings.getUserAgentString();
        settings.setUserAgentString(defaultUa + " WIHM-Android/1.4.4");

        // Add native JavaScript Interface
        pageInterface = new WebAppInterface(this);
        webView.addJavascriptInterface(pageInterface, "Android");

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                if (newProgress < 100) {
                    progressBar.setVisibility(View.VISIBLE);
                    progressBar.setProgress(newProgress);
                } else {
                    progressBar.setVisibility(View.GONE);
                }
            }

            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                handleMediaRequest(request);
            }

            @Override
            public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> filePathCallback,
                                              FileChooserParams fileChooserParams) {
                if (fileUploadCallback != null) {
                    fileUploadCallback.onReceiveValue(null);
                }
                fileUploadCallback = filePathCallback;

                Intent intent = fileChooserParams.createIntent();
                try {
                    fileChooserLauncher.launch(intent);
                } catch (ActivityNotFoundException e) {
                    fileUploadCallback = null;
                    Toast.makeText(MainActivity.this, MainActivity.this.getString(R.string.no_file_picker), Toast.LENGTH_SHORT).show();
                    return false;
                }
                return true;
            }
        });

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                return handleUrlNavigation(url);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return handleUrlNavigation(url);
            }

            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                super.onPageStarted(view, url, favicon);
                pageLoaded = false;
                errorLayout.setVisibility(View.GONE);
                webView.setVisibility(View.VISIBLE);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                progressBar.setVisibility(View.GONE);

                // Inject bridge script to catch notifications, telegram links and clipboard
                injectNativeBridge(view);
                pageLoaded = true;
                // A new page has not reported yet, and may never if it is an older version.
                backCallback.setEnabled(true);
                view.evaluateJavascript(visibilityScript(), null);
                for (String script : pendingScripts) view.evaluateJavascript(script, null);
                pendingScripts.clear();
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                super.onReceivedError(view, request, error);
                if (request.isForMainFrame()) {
                    showErrorLayout();
                }
            }
        });
    }

    private boolean handleUrlNavigation(String url) {
        if (url == null) return false;

        // Handle Telegram links (t.me or tg://)
        if (UrlRules.isTelegramLink(url)) {
            TelegramHelper.openTelegramLink(this, url);
            return true;
        }

        // Only the current server stays in the WebView, because pages here can reach the native bridge.
        if (currentServerUrl != null && UrlRules.sameOrigin(url, currentServerUrl)) {
            return false;
        }

        // External links (HTTP/HTTPS external, mailto, tel)
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            startActivity(intent);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private void injectNativeBridge(WebView view) {
        // Injects listener for Notification API, clipboard API, token sync and dynamic settings DOM upgrades
        String js = "(function() {\n" +
                "  if (window.__wihm_native_injected) return;\n" +
                "  window.__wihm_native_injected = true;\n" +
                "  window.isAndroidApp = true;\n" +
                "\n" +
                "  // Inject CSS for smooth momentum scrolling and prevent pull-down reload\n" +
                "  try {\n" +
                "    if (!document.getElementById('__wihm_smooth_scroll')) {\n" +
                "      const s = document.createElement('style');\n" +
                "      s.id = '__wihm_smooth_scroll';\n" +
                "      s.textContent = `\n" +
                "        html, body {\n" +
                "          overscroll-behavior-y: none !important;\n" +
                "          -webkit-overflow-scrolling: touch !important;\n" +
                "          scroll-behavior: smooth !important;\n" +
                "        }\n" +
                "        .modal-body, .settings-list, .main-menu, #feature-content, #messages-container, .chats-list, #active-chat-wrapper, .modal-card {\n" +
                "          -webkit-overflow-scrolling: touch !important;\n" +
                "          overscroll-behavior-y: contain !important;\n" +
                "        }\n" +
                "        * {\n" +
                "          -webkit-tap-highlight-color: transparent !important;\n" +
                "        }\n" +
                "        .tg-card {\n" +
                "          background: #1e293b !important;\n" +
                "          border: 1px solid rgba(255, 255, 255, 0.08) !important;\n" +
                "          border-radius: 14px !important;\n" +
                "          padding: 16px !important;\n" +
                "          margin-bottom: 14px !important;\n" +
                "          box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25) !important;\n" +
                "          box-sizing: border-box !important;\n" +
                "          width: 100% !important;\n" +
                "        }\n" +
                "        .tg-card-header {\n" +
                "          display: flex !important;\n" +
                "          justify-content: space-between !important;\n" +
                "          align-items: center !important;\n" +
                "          margin-bottom: 12px !important;\n" +
                "          padding-bottom: 8px !important;\n" +
                "          border-bottom: 1px solid rgba(255, 255, 255, 0.06) !important;\n" +
                "        }\n" +
                "        .tg-card-title {\n" +
                "          font-size: 14px !important;\n" +
                "          font-weight: 700 !important;\n" +
                "          color: #54a9eb !important;\n" +
                "          margin: 0 !important;\n" +
                "          display: flex !important;\n" +
                "          align-items: center !important;\n" +
                "          gap: 8px !important;\n" +
                "        }\n" +
                "        .tg-card-badge {\n" +
                "          background: rgba(84, 169, 235, 0.15) !important;\n" +
                "          color: #54a9eb !important;\n" +
                "          border: 1px solid rgba(84, 169, 235, 0.25) !important;\n" +
                "          font-size: 11px !important;\n" +
                "          font-weight: 700 !important;\n" +
                "          padding: 2px 8px !important;\n" +
                "          border-radius: 6px !important;\n" +
                "          letter-spacing: 0.5px !important;\n" +
                "        }\n" +
                "        .tg-card-desc {\n" +
                "          font-size: 13px !important;\n" +
                "          line-height: 1.7 !important;\n" +
                "          color: #94a3b8 !important;\n" +
                "          margin: 0 0 14px 0 !important;\n" +
                "        }\n" +
                "        .tg-btn-grid {\n" +
                "          display: grid !important;\n" +
                "          grid-template-columns: 1fr 1fr !important;\n" +
                "          gap: 10px !important;\n" +
                "          align-items: stretch !important;\n" +
                "          margin: 0 !important;\n" +
                "          width: 100% !important;\n" +
                "          box-sizing: border-box !important;\n" +
                "        }\n" +
                "        .tg-btn-primary, .tg-btn-secondary {\n" +
                "          height: 42px !important;\n" +
                "          min-height: 42px !important;\n" +
                "          max-height: 42px !important;\n" +
                "          margin: 0 !important;\n" +
                "          padding: 0 12px !important;\n" +
                "          border-radius: 8px !important;\n" +
                "          font-size: 13px !important;\n" +
                "          font-weight: 600 !important;\n" +
                "          display: flex !important;\n" +
                "          align-items: center !important;\n" +
                "          justify-content: center !important;\n" +
                "          gap: 6px !important;\n" +
                "          cursor: pointer !important;\n" +
                "          box-sizing: border-box !important;\n" +
                "          text-decoration: none !important;\n" +
                "          outline: none !important;\n" +
                "          width: 100% !important;\n" +
                "          line-height: 1 !important;\n" +
                "          transition: all 0.15s ease !important;\n" +
                "        }\n" +
                "        .tg-btn-primary {\n" +
                "          background: #2481cc !important;\n" +
                "          color: #ffffff !important;\n" +
                "          border: none !important;\n" +
                "          box-shadow: 0 2px 5px rgba(36, 129, 204, 0.35) !important;\n" +
                "        }\n" +
                "        .tg-btn-primary:active {\n" +
                "          background: #1c72b5 !important;\n" +
                "          transform: translateY(1px) !important;\n" +
                "        }\n" +
                "        .tg-btn-secondary {\n" +
                "          background: rgba(255, 255, 255, 0.06) !important;\n" +
                "          color: #f1f5f9 !important;\n" +
                "          border: 1px solid rgba(255, 255, 255, 0.12) !important;\n" +
                "        }\n" +
                "        .tg-btn-secondary:active {\n" +
                "          background: rgba(255, 255, 255, 0.1) !important;\n" +
                "          transform: translateY(1px) !important;\n" +
                "        }\n" +
                "        .tg-feedback {\n" +
                "          margin-top: 10px !important;\n" +
                "          margin-bottom: 0 !important;\n" +
                "          font-size: 12px !important;\n" +
                "          font-weight: 600 !important;\n" +
                "          line-height: 1.5 !important;\n" +
                "          padding: 8px 12px !important;\n" +
                "          border-radius: 6px !important;\n" +
                "          background: rgba(255, 255, 255, 0.04) !important;\n" +
                "        }\n" +
                "        .button-row > .btn-primary, .update-actions > .btn-primary, .tg-btn-grid > *, .button-row > * {\n" +
                "          margin: 0 !important;\n" +
                "        }\n" +
                "      `;\n" +
                "      document.head.appendChild(s);\n" +
                "    }\n" +
                "  } catch(e) {}\n" +
                "\n" +
                "  // Sync token from localStorage to native Android\n" +
                "  function syncAuth() {\n" +
                "    try {\n" +
                "      const t = localStorage.getItem('cf_msg_token');\n" +
                "      const u = localStorage.getItem('cf_msg_user');\n" +
                "      if (t && window.Android && window.Android.saveAuthToken) {\n" +
                "        let uid = '';\n" +
                "        try { uid = JSON.parse(u).id || ''; } catch(e){}\n" +
                "        window.Android.saveAuthToken(t, uid, location.origin);\n" +
                "      }\n" +
                "    } catch(e) {}\n" +
                "  }\n" +
                "  syncAuth();\n" +
                "  window.addEventListener('storage', syncAuth);\n" +
                "\n" +
                "  // Hook Telegram links to open native app\n" +
                "  document.addEventListener('click', function(e) {\n" +
                "    const link = e.target.closest('a');\n" +
                "    if (link && link.href && (link.href.includes('t.me/') || link.href.startsWith('tg://'))) {\n" +
                "      e.preventDefault();\n" +
                "      if (window.Android && window.Android.openInTelegram) {\n" +
                "        window.Android.openInTelegram(link.href);\n" +
                "      }\n" +
                "    }\n" +
                "  }, true);\n" +
                "\n" +
                "  // Intercept clipboard write if needed\n" +
                "  if (navigator.clipboard) {\n" +
                "    const origWrite = navigator.clipboard.writeText;\n" +
                "    navigator.clipboard.writeText = function(text) {\n" +
                "      if (window.Android && window.Android.copyToClipboard) {\n" +
                "        window.Android.copyToClipboard(text);\n" +
                "      }\n" +
                "      return origWrite.call(navigator.clipboard, text);\n" +
                "    };\n" +
                "  }\n" +
                "\n" +
                "  // Bridge Web Notification to native Android Notification\n" +
                "  if (typeof window.Notification !== 'undefined') {\n" +
                "    window.Notification.requestPermission = function() { return Promise.resolve('granted'); };\n" +
                "    window.Notification.permission = 'granted';\n" +
                "  }\n" +
                "\n" +
                "  // DOM Enhancements for Settings, Server, and Notifications\n" +
                "  function enhanceNativeSettings() {\n" +
                "    const originHost = location.host || location.origin;\n" +
                "\n" +
                "    // 1. In #settings-navigation (Inside the Settings modal)\n" +
                "    const nav = document.getElementById('settings-navigation');\n" +
                "    if (nav) {\n" +
                "      let serverRow = document.getElementById('settings-server');\n" +
                "      if (!serverRow) {\n" +
                "        serverRow = document.createElement('button');\n" +
                "        serverRow.id = 'settings-server';\n" +
                "        serverRow.className = 'settings-row';\n" +
                "        serverRow.type = 'button';\n" +
                "        serverRow.innerHTML = `<svg class=\"ui-icon\" aria-hidden=\"true\"><use href=\"#i-server\"/></svg><span><strong>سرور کلادفلر</strong><small id=\"txt-server-host\">${originHost}</small></span><svg class=\"ui-icon row-chevron\" aria-hidden=\"true\"><use href=\"#i-back\"/></svg>`;\n" +
                "        nav.appendChild(serverRow);\n" +
                "      } else {\n" +
                "        const small = serverRow.querySelector('small');\n" +
                "        if (small && (!small.textContent || small.textContent.includes('تغییر'))) small.textContent = originHost;\n" +
                "      }\n" +
                "      serverRow.onclick = function(e) {\n" +
                "        e.preventDefault();\n" +
                "        e.stopPropagation();\n" +
                "        window.Android?.openServerSettings();\n" +
                "      };\n" +
                "    }\n" +
                "\n" +
                "    // 2. In #main-menu (Hamburger menu)\n" +
                "    const mainMenu = document.getElementById('main-menu');\n" +
                "    if (mainMenu && !document.getElementById('btn-menu-server')) {\n" +
                "      const logoutBtn = document.getElementById('btn-logout');\n" +
                "      const btn = document.createElement('button');\n" +
                "      btn.id = 'btn-menu-server';\n" +
                "      btn.className = 'menu-item';\n" +
                "      btn.type = 'button';\n" +
                "      btn.innerHTML = `<svg class=\"ui-icon\" aria-hidden=\"true\"><use href=\"#i-server\"/></svg><span>تنظیمات سرور (${originHost})</span>`;\n" +
                "      btn.onclick = function(e) {\n" +
                "        e.preventDefault();\n" +
                "        e.stopPropagation();\n" +
                "        window.Android?.openServerSettings();\n" +
                "      };\n" +
                "      if (logoutBtn && logoutBtn.parentNode) {\n" +
                "        logoutBtn.parentNode.insertBefore(btn, logoutBtn);\n" +
                "      } else {\n" +
                "        mainMenu.appendChild(btn);\n" +
                "      }\n" +
                "    }\n" +
                "\n" +
                "    // 3. On #auth-form (Login screen before login)\n" +
                "    const authForm = document.getElementById('auth-form');\n" +
                "    if (authForm && !document.getElementById('btn-auth-change-server')) {\n" +
                "      const btn = document.createElement('button');\n" +
                "      btn.type = 'button';\n" +
                "      btn.id = 'btn-auth-change-server';\n" +
                "      btn.className = 'quiet-button';\n" +
                "      btn.style.cssText = 'margin-top: 10px; width: 100%; font-size: 0.88rem;';\n" +
                "      btn.textContent = `🌐 تغییر سرور کلادفلر (${originHost})`;\n" +
                "      btn.onclick = function(e) {\n" +
                "        e.preventDefault();\n" +
                "        e.stopPropagation();\n" +
                "        window.Android?.openServerSettings();\n" +
                "      };\n" +
                "      authForm.appendChild(btn);\n" +
                "    }\n" +
                "\n" +
                "    // 4. In #feature-content when 'اعلان‌ها' is opened\n" +
                "    const content = document.getElementById('feature-content');\n" +
                "    if (content) {\n" +
                "      const title = document.getElementById('feature-title');\n" +
                "      const isNotifModal = (title && title.textContent.includes('اعلان')) ||\n" +
                "                           content.querySelector('.notification-controls') ||\n" +
                "                           content.textContent.includes('اعلان این دستگاه');\n" +
                "      if (isNotifModal) {\n" +
                "        // Upgrade Box 1 (form for notification preview) to tg-card\n" +
                "        const profileForm = content.querySelector('#profile-form');\n" +
                "        if (profileForm && !profileForm.classList.contains('tg-card')) {\n" +
                "          profileForm.classList.add('tg-card');\n" +
                "          const saveBtn = profileForm.querySelector('button[type=\"submit\"]');\n" +
                "          if (saveBtn) {\n" +
                "            saveBtn.className = 'tg-btn-primary';\n" +
                "            saveBtn.style.marginTop = '12px';\n" +
                "            saveBtn.style.width = '100%';\n" +
                "          }\n" +
                "        }\n" +
                "\n" +
                "        // Upgrade Box 2 (native notification controls) to tg-card\n" +
                "        let controls = content.querySelector('.notification-controls');\n" +
                "        if (controls && controls.dataset.nativeEnhanced !== 'true') {\n" +
                "          controls.dataset.nativeEnhanced = 'true';\n" +
                "          controls.className = 'tg-card';\n" +
                "          controls.style.borderTop = 'none';\n" +
                "          controls.style.marginTop = '0';\n" +
                "          const isBattIgnored = window.Android?.isBatteryOptimizationIgnored ? window.Android.isBatteryOptimizationIgnored() : false;\n" +
                "          controls.innerHTML = `\n" +
                "            <div class=\"tg-card-header\">\n" +
                "              <div class=\"tg-card-title\">\n" +
                "                <span>⚡</span>\n" +
                "                <span>سرویس پس‌زمینه و باتری اندروید</span>\n" +
                "              </div>\n" +
                "              <span class=\"tg-card-badge\">Keep-Alive</span>\n" +
                "            </div>\n" +
                "            <p class=\"tg-card-desc\">\n" +
                "              در اپلیکیشن اندروید، پیام‌ها از طریق سرویس دائم پیش‌زمینه دریافت می‌شوند و به وب‌پوش مرورگر وابسته نیستند.\n" +
                "            </p>\n" +
                "            <button id=\"btn-native-dlg\" type=\"button\" class=\"tg-btn-primary\" style=\"margin-bottom:10px !important;\">\n" +
                "              ⚙️ پنجره جامع تنظیمات باتری و اعلان\n" +
                "            </button>\n" +
                "            <div class=\"tg-btn-grid\">\n" +
                "              <button id=\"btn-native-bat\" type=\"button\" class=\"tg-btn-secondary\">\n" +
                "                ${isBattIgnored ? '✅ باتری: مجاز است' : '⚡ رفع محدودیت باتری'}\n" +
                "              </button>\n" +
                "              <button id=\"btn-native-auto\" type=\"button\" class=\"tg-btn-secondary\">\n" +
                "                🚀 شروع خودکار گوشی\n" +
                "              </button>\n" +
                "            </div>\n" +
                "            <button id=\"btn-native-test-alert\" type=\"button\" class=\"tg-btn-secondary\" style=\"margin-top:10px !important;\">\n" +
                "              🔔 ارسال اعلان آزمایشی\n" +
                "            </button>\n" +
                "            <p id=\"native-feedback\" class=\"tg-feedback\"></p>\n" +
                "          `;\n" +
                "          document.getElementById('btn-native-dlg')?.addEventListener('click', () => { window.Android?.openNotificationSettings(); });\n" +
                "          document.getElementById('btn-native-bat')?.addEventListener('click', () => { window.Android?.requestIgnoreBatteryOptimization(); });\n" +
                "          document.getElementById('btn-native-auto')?.addEventListener('click', () => { window.Android?.openAutostartSettings(); });\n" +
                "          document.getElementById('btn-native-test-alert')?.addEventListener('click', () => {\n" +
                "            window.Android?.showNotification('پیام‌رسان ابرانه', 'این یک پیام آزمایشی اعلان است.', '');\n" +
                "            const f = document.getElementById('native-feedback');\n" +
                "            if (f) {\n" +
                "              f.style.color = '#38bdf8';\n" +
                "              f.textContent = 'اعلان تستی با موفقیت به اندروید ارسال شد.';\n" +
                "            }\n" +
                "          });\n" +
                "        }\n" +
                "      }\n" +
                "\n" +
                "      // 5. In #feature-content when 'به‌روزرسانی' is opened\n" +
                "      const isUpdateModal = (title && title.textContent.includes('به‌روزرسانی')) ||\n" +
                "                            content.querySelector('#client-update-check') ||\n" +
                "                            content.querySelector('#client-update-mode');\n" +
                "      if (isUpdateModal) {\n" +
                "        let updateSec = content.querySelector('.feature-section');\n" +
                "        if (updateSec && updateSec.dataset.nativeEnhanced !== 'true') {\n" +
                "          updateSec.dataset.nativeEnhanced = 'true';\n" +
                "          const appVer = window.Android?.getAppVersion ? window.Android.getAppVersion() : '1.4.5';\n" +
                "          const appArch = window.Android?.getDeviceArchitecture ? window.Android.getDeviceArchitecture() : 'arm64-v8a';\n" +
                "\n" +
                "          // Box 1: Telegram card for Native APK\n" +
                "          const nativeCard = document.createElement('div');\n" +
                "          nativeCard.id = 'native-apk-update-card';\n" +
                "          nativeCard.className = 'tg-card';\n" +
                "          nativeCard.innerHTML = `\n" +
                "            <div class=\"tg-card-header\">\n" +
                "              <div class=\"tg-card-title\">\n" +
                "                <span>📱</span>\n" +
                "                <span>اپلیکیشن اندروید (APK)</span>\n" +
                "              </div>\n" +
                "              <span class=\"tg-card-badge\">${appArch}</span>\n" +
                "            </div>\n" +
                "            <p class=\"tg-card-desc\">\n" +
                "              نسخهٔ نصب‌شده: <bdi style=\"font-weight:bold; color:#fff;\">v${appVer}</bdi><br>\n" +
                "              دریافت مستقیم و به‌روزرسانی خودکار آخرین بیلد منتشرشده\n" +
                "            </p>\n" +
                "            <div class=\"tg-btn-grid\">\n" +
                "              <button id=\"btn-native-apk-check\" type=\"button\" class=\"tg-btn-primary\">\n" +
                "                <span>🔍</span>\n" +
                "                <span>بررسی نسخه جدید</span>\n" +
                "              </button>\n" +
                "              <button id=\"btn-native-apk-releases\" type=\"button\" class=\"tg-btn-secondary\">\n" +
                "                <span>🌐</span>\n" +
                "                <span>نسخه‌های گیت‌هاب</span>\n" +
                "              </button>\n" +
                "            </div>\n" +
                "            <p id=\"native-apk-feedback\" class=\"tg-feedback\"></p>\n" +
                "          `;\n" +
                "          updateSec.parentNode.insertBefore(nativeCard, updateSec);\n" +
                "          updateSec.style.display = 'none';\n" +
                "\n" +
                "          // Box 2: Style the Server section as matching tg-card if present\n" +
                "          const allSections = content.querySelectorAll('.feature-section');\n" +
                "          allSections.forEach(sec => {\n" +
                "            if (sec !== updateSec && !sec.classList.contains('tg-card')) {\n" +
                "              sec.classList.add('tg-card');\n" +
                "              sec.style.borderTop = 'none';\n" +
                "              sec.style.marginTop = '0';\n" +
                "              const h4 = sec.querySelector('h4');\n" +
                "              if (h4 && !sec.querySelector('.tg-card-header')) {\n" +
                "                const header = document.createElement('div');\n" +
                "                header.className = 'tg-card-header';\n" +
                "                header.innerHTML = `\n" +
                "                  <div class=\"tg-card-title\">\n" +
                "                    <span>☁️</span>\n" +
                "                    <span>${h4.textContent}</span>\n" +
                "                  </div>\n" +
                "                  <span class=\"tg-card-badge\">Backend</span>\n" +
                "                `;\n" +
                "                sec.insertBefore(header, h4);\n" +
                "                h4.style.display = 'none';\n" +
                "              }\n" +
                "              const actions = sec.querySelector('.update-actions');\n" +
                "              if (actions) {\n" +
                "                actions.className = 'tg-btn-grid';\n" +
                "                actions.querySelectorAll('button').forEach((b, idx) => {\n" +
                "                  b.className = idx === 0 ? 'tg-btn-secondary' : 'tg-btn-primary';\n" +
                "                });\n" +
                "              }\n" +
                "            }\n" +
                "          });\n" +
                "\n" +
                "          document.getElementById('btn-native-apk-check')?.addEventListener('click', () => {\n" +
                "            const fb = document.getElementById('native-apk-feedback');\n" +
                "            if (fb) {\n" +
                "              fb.style.color = '#38bdf8';\n" +
                "              fb.textContent = 'در حال بررسی گیت‌هاب…';\n" +
                "            }\n" +
                "            window.Android?.checkForUpdates();\n" +
                "          });\n" +
                "\n" +
                "          document.getElementById('btn-native-apk-releases')?.addEventListener('click', () => {\n" +
                "            window.Android?.openGitHubReleases();\n" +
                "          });\n" +
                "        }\n" +
                "      }\n" +
                "    }\n" +
                "  }\n" +
                "\n" +
                "  window.onAndroidUpdateResult = function(available, latest, current, err) {\n" +
                "    const fb = document.getElementById('native-apk-feedback');\n" +
                "    if (!fb) return;\n" +
                "    fb.style.display = 'block';\n" +
                "    if (err) {\n" +
                "      fb.style.color = '#ef4444';\n" +
                "      fb.style.background = 'rgba(239, 68, 68, 0.12)';\n" +
                "      fb.textContent = 'خطا در بررسی نسخه: ' + err;\n" +
                "    } else if (available) {\n" +
                "      fb.style.color = '#22c55e';\n" +
                "      fb.style.background = 'rgba(34, 197, 94, 0.12)';\n" +
                "      fb.textContent = 'نسخه جدید (v' + latest + ') در دسترس است! پنجره دانلود باز شد.';\n" +
                "    } else {\n" +
                "      fb.style.color = '#54a9eb';\n" +
                "      fb.style.background = 'rgba(84, 169, 235, 0.12)';\n" +
                "      fb.textContent = 'برنامه به‌روز است. شما از آخرین نسخه (v' + current + ') استفاده می‌کنید.';\n" +
                "    }\n" +
                "  };\n" +
                "\n" +
                "  const observer = new MutationObserver(enhanceNativeSettings);\n" +
                "  observer.observe(document.body, { childList: true, subtree: true });\n" +
                "  enhanceNativeSettings();\n" +
                "\n" +
                "  // Dispatch readiness event\n" +
                "  window.dispatchEvent(new CustomEvent('wihm-android-ready'));\n" +
                "})();";

        view.evaluateJavascript(js, null);
    }

    private void setupErrorView() {
        btnRetry.setOnClickListener(v -> {
            errorLayout.setVisibility(View.GONE);
            webView.setVisibility(View.VISIBLE);
            if (currentServerUrl != null && !currentServerUrl.isEmpty()) {
                webView.loadUrl(currentServerUrl);
            }
        });

        btnChangeServer.setOnClickListener(v -> openServerConfig());
    }

    private void showErrorLayout() {
        webView.setVisibility(View.GONE);
        errorLayout.setVisibility(View.VISIBLE);
    }

    /**
     * Android 13 and later animate a back gesture before it ends, so they must know at once whether the page will use it.
     * The page reports this whenever it may have changed. A page that never reports keeps back, as before.
     */
    void setPageHasBack(boolean hasBack) {
        if (backCallback != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) backCallback.setEnabled(hasBack);
    }

    private void setupBackNavigation() {
        backCallback = new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                // Query webview to see if a modal is open or active chat is open
                String checkJs = "(function() {" +
                        "  if (window.wihmBack) return window.wihmBack() ? 'modal_closed' : 'none';" +
                        "  const modals = document.querySelectorAll('.modal-overlay');" +
                        "  for (const m of modals) {" +
                        "    if (m.style.display !== 'none' && !m.hidden) {" +
                        "      const closeBtn = m.querySelector('.icon-btn, button[aria-label*=\"بستن\"]');" +
                        "      if (closeBtn) { closeBtn.click(); return 'modal_closed'; }" +
                        "    }" +
                        "  }" +
                        "  const activeChat = document.getElementById('active-chat-wrapper');" +
                        "  if (activeChat && activeChat.style.display !== 'none') {" +
                        "    const backBtn = document.getElementById('btn-back-to-chats');" +
                        "    if (backBtn) { backBtn.click(); return 'chat_closed'; }" +
                        "  }" +
                        "  return 'none';" +
                        "})();";

                webView.evaluateJavascript("window.wihmNativeBack=true;" + checkJs, value -> {
                    if ("\"modal_closed\"".equals(value) || "\"chat_closed\"".equals(value)) return;
                    moveTaskToBack(true);
                });
            }
        };
        getOnBackPressedDispatcher().addCallback(this, backCallback);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIncomingIntent(intent);
    }

    private void handleIncomingIntent(Intent intent) {
        if (intent == null) return;

        // Shared text from another app
        if (Intent.ACTION_SEND.equals(intent.getAction()) && "text/plain".equals(intent.getType())) {
            String sharedText = intent.getStringExtra(Intent.EXTRA_TEXT);
            if (sharedText != null && !sharedText.isEmpty() && currentServerUrl != null && !currentServerUrl.isEmpty()) {
                // The page holds shared text for the next opened chat, and never sends it by itself.
                // After #, so the text is never sent to the server or kept in its logs.
                webView.loadUrl(Uri.parse(currentServerUrl).buildUpon().encodedFragment("share=" + Uri.encode(sharedText)).build().toString());
            }
        }

        // Notification click targeting chat
        String targetChatId = intent.getStringExtra("target_chat_id");
        if (targetChatId != null && !targetChatId.isEmpty()) {
            openTargetChat(targetChatId);
        }

        if (intent.getBooleanExtra(IncomingCall.EXTRA_ANSWER, false)) {
            // Handled once, so reopening the app later can't answer another call.
            intent.removeExtra(IncomingCall.EXTRA_ANSWER);
            answeringCall = true;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
                setShowWhenLocked(true);
                setTurnScreenOn(true);
            }
            runOnPage(clickWhenShown(".call-accept", 60));
        }
    }

    private void openTargetChat(String chatId) {
        if (!UrlRules.isChatId(chatId)) return;
        runOnPage(clickWhenShown("[data-chat-id=\"" + chatId + "\"]", 40));
    }

    /** The page signs in and lists chats after it loads, so this retries every half second. */
    private static String clickWhenShown(String selector, int attempts) {
        return "(function(){var left=" + attempts + ";var timer=setInterval(function(){"
                + "var target=document.querySelector(" + JSONObject.quote(selector) + ");"
                + "if(target&&target.getClientRects().length){target.click();clearInterval(timer);}"
                + "else if(--left<=0)clearInterval(timer);},500);})();";
    }

    private void runOnPage(String script) {
        if (pageLoaded) webView.evaluateJavascript(script, null);
        else pendingScripts.add(script);
    }

    public void showNotificationSettingsDialog() {
        View dialogView = getLayoutInflater().inflate(R.layout.dialog_notification_settings, null);
        AlertDialog dialog = new AlertDialog.Builder(this)
                .setView(dialogView)
                .create();

        if (dialog.getWindow() != null) {
            dialog.getWindow().setBackgroundDrawableResource(android.R.color.transparent);
        }

        SwitchCompat switchKeepAlive = dialogView.findViewById(R.id.switch_keep_alive);
        TextView tvBatteryStatus = dialogView.findViewById(R.id.tv_battery_status);
        Button btnIgnoreBattery = dialogView.findViewById(R.id.btn_ignore_battery);
        Button btnOpenAutostart = dialogView.findViewById(R.id.btn_open_autostart);
        Button btnTestNotif = dialogView.findViewById(R.id.btn_test_notif);
        Button btnClose = dialogView.findViewById(R.id.btn_close_dialog);

        SharedPreferences prefs = getSharedPreferences(ServerConfigActivity.PREFS_NAME, Context.MODE_PRIVATE);
        boolean keepAlive = prefs.getBoolean("keep_alive_enabled", true);
        switchKeepAlive.setChecked(keepAlive);

        switchKeepAlive.setOnCheckedChangeListener((buttonView, isChecked) -> {
            prefs.edit().putBoolean("keep_alive_enabled", isChecked).apply();
            if (isChecked) {
                WihmNotificationService.start(MainActivity.this);
                Toast.makeText(MainActivity.this, MainActivity.this.getString(R.string.service_turned_on), Toast.LENGTH_SHORT).show();
            } else {
                WihmNotificationService.stop(MainActivity.this);
                Toast.makeText(MainActivity.this, MainActivity.this.getString(R.string.service_turned_off), Toast.LENGTH_SHORT).show();
            }
        });

        // Update battery status
        boolean batteryIgnored = PowerHelper.isIgnoringBatteryOptimizations(this);
        if (batteryIgnored) {
            tvBatteryStatus.setText(MainActivity.this.getString(R.string.battery_free));
            tvBatteryStatus.setTextColor(ContextCompat.getColor(this, R.color.success));
        } else {
            tvBatteryStatus.setText(MainActivity.this.getString(R.string.battery_limited));
            tvBatteryStatus.setTextColor(ContextCompat.getColor(this, R.color.primary_light));
        }

        btnIgnoreBattery.setOnClickListener(v -> {
            PowerHelper.requestIgnoreBatteryOptimizations(MainActivity.this);
        });

        btnOpenAutostart.setOnClickListener(v -> {
            PowerHelper.openAutostartSettings(MainActivity.this);
        });

        btnTestNotif.setOnClickListener(v -> {
            NotificationHelper.showNotification(MainActivity.this, MainActivity.this.getString(R.string.test_title), MainActivity.this.getString(R.string.test_body), null);
            Toast.makeText(MainActivity.this, MainActivity.this.getString(R.string.test_sent), Toast.LENGTH_SHORT).show();
        });

        btnClose.setOnClickListener(v -> dialog.dismiss());

        dialog.show();
    }

    public void openServerConfig() {
        Intent intent = new Intent(this, ServerConfigActivity.class);
        startActivityForResult(intent, REQUEST_CODE_SERVER_CONFIG);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_CODE_UNLOCK) {
            unlocking = false;
            unlocked = resultCode == RESULT_OK;
            if (unlocked) webView.setVisibility(View.VISIBLE);
            else moveTaskToBack(true);
            return;
        }
        if (requestCode == REQUEST_CODE_SERVER_CONFIG && resultCode == RESULT_OK) {
            SharedPreferences prefs = getSharedPreferences(ServerConfigActivity.PREFS_NAME, Context.MODE_PRIVATE);
            currentServerUrl = prefs.getString(ServerConfigActivity.KEY_SERVER_URL, "");
            WihmNotificationService.proxyChanged(this);
            if (currentServerUrl != null && !currentServerUrl.isEmpty()) {
                loadServer(currentServerUrl);
            }
        }
    }

    public void saveAndReloadServer(String url) {
        currentServerUrl = url;
        SharedPreferences prefs = getSharedPreferences(ServerConfigActivity.PREFS_NAME, Context.MODE_PRIVATE);
        prefs.edit().putString(ServerConfigActivity.KEY_SERVER_URL, url).apply();
        loadServer(url);
    }

    public String getServerUrl() {
        return currentServerUrl;
    }

    public void notifyWebUpdateStatus(boolean available, String latest, String current, String err) {
        if (webView == null) return;
        String js;
        if (err != null) {
            js = String.format("window.onAndroidUpdateResult && window.onAndroidUpdateResult(false, null, '%s', '%s');",
                    current != null ? current : "", err.replace("'", "\\'"));
        } else {
            js = String.format("window.onAndroidUpdateResult && window.onAndroidUpdateResult(%b, '%s', '%s', null);",
                    available, latest != null ? latest : "", current != null ? current : "");
        }
        runOnUiThread(() -> webView.evaluateJavascript(js, null));
    }

    private void loadServer(String url) {
        if (url == null || url.trim().isEmpty()) {
            openServerConfig();
            return;
        }
        errorLayout.setVisibility(View.GONE);
        webView.setVisibility(View.VISIBLE);
        ProxySettings.applyToWebView(this, () -> webView.loadUrl(url));
    }

    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        getMenuInflater().inflate(R.menu.main_menu, menu);
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(@NonNull MenuItem item) {
        int id = item.getItemId();
        if (id == R.id.action_refresh) {
            webView.reload();
            return true;
        } else if (id == R.id.action_update) {
            UpdateHelper.checkForUpdate(this, true, this::notifyWebUpdateStatus);
            return true;
        } else if (id == R.id.action_server) {
            openServerConfig();
            return true;
        } else if (id == R.id.action_about) {
            new AlertDialog.Builder(this)
                    .setTitle(R.string.menu_about)
                    .setMessage(R.string.about_message)
                    .setPositiveButton(MainActivity.this.getString(R.string.close), null)
                    .show();
            return true;
        }
        return super.onOptionsItemSelected(item);
    }
}
