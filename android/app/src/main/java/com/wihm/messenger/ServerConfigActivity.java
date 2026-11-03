package com.wihm.messenger;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.WebStorage;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.ProgressBar;
import android.widget.RadioButton;
import android.widget.TextView;
import android.widget.Toast;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import java.net.HttpURLConnection;
import java.net.Proxy;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class ServerConfigActivity extends AppCompatActivity {
    public static final String PREFS_NAME = "wihm_messenger_prefs";
    public static final String KEY_SERVER_URL = "server_url";
    public static final String KEY_AUTH_TOKEN = "auth_token";
    public static final String KEY_USER_ID = "auth_user_id";

    private EditText editServerUrl;
    private ImageView btnPasteUrl;
    private TextView txtStatus;
    private ProgressBar progressTest;
    private Button btnTest;
    private Button btnSave;
    private Button btnClearData;
    private CheckBox checkProxy;
    private RadioButton radioSocks;
    private EditText editProxyHost;
    private EditText editProxyPort;

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_server_config);
        WebViewCheck.warnIfOld(this);

        editServerUrl = findViewById(R.id.edit_server_url);
        btnPasteUrl = findViewById(R.id.btn_paste_url);
        txtStatus = findViewById(R.id.txt_status);
        progressTest = findViewById(R.id.progress_test);
        btnTest = findViewById(R.id.btn_test_connection);
        btnSave = findViewById(R.id.btn_save_connect);
        btnClearData = findViewById(R.id.btn_clear_data);
        checkProxy = findViewById(R.id.check_proxy);
        radioSocks = findViewById(R.id.radio_proxy_socks);
        editProxyHost = findViewById(R.id.edit_proxy_host);
        editProxyPort = findViewById(R.id.edit_proxy_port);
        View proxyFields = findViewById(R.id.proxy_fields);

        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        String currentUrl = prefs.getString(KEY_SERVER_URL, "");
        if (currentUrl != null && !currentUrl.isEmpty()) {
            editServerUrl.setText(currentUrl);
            editServerUrl.setSelection(currentUrl.length());
        }

        checkProxy.setChecked(prefs.getBoolean(ProxySettings.KEY_ENABLED, false));
        radioSocks.setChecked(!ProxySettings.HTTP.equals(prefs.getString(ProxySettings.KEY_TYPE, ProxySettings.SOCKS5)));
        ((RadioButton) findViewById(R.id.radio_proxy_http)).setChecked(!radioSocks.isChecked());
        editProxyHost.setText(prefs.getString(ProxySettings.KEY_HOST, ""));
        int proxyPort = prefs.getInt(ProxySettings.KEY_PORT, 0);
        if (proxyPort > 0) editProxyPort.setText(String.valueOf(proxyPort));
        proxyFields.setVisibility(checkProxy.isChecked() ? View.VISIBLE : View.GONE);
        checkProxy.setOnCheckedChangeListener((button, checked) -> proxyFields.setVisibility(checked ? View.VISIBLE : View.GONE));

        btnPasteUrl.setOnClickListener(v -> pasteFromClipboard());
        btnTest.setOnClickListener(v -> testConnection());
        btnSave.setOnClickListener(v -> saveAndFinish());
        btnClearData.setOnClickListener(v -> confirmClearData());
    }

    private void pasteFromClipboard() {
        try {
            ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            if (clipboard != null && clipboard.hasPrimaryClip() && clipboard.getPrimaryClip() != null) {
                ClipData.Item item = clipboard.getPrimaryClip().getItemAt(0);
                if (item != null && item.getText() != null) {
                    String pasted = item.getText().toString().trim();
                    editServerUrl.setText(pasted);
                    editServerUrl.setSelection(pasted.length());
                    Toast.makeText(this, ServerConfigActivity.this.getString(R.string.pasted), Toast.LENGTH_SHORT).show();
                }
            }
        } catch (Exception ignored) {
        }
    }

    private String sanitizeUrl(String raw) {
        if (raw == null) return "";
        String trimmed = raw.trim();
        if (trimmed.isEmpty()) return "";
        // Login tokens travel in these requests, so plain http is refused.
        if (trimmed.startsWith("http://")) return "";
        if (!trimmed.startsWith("https://")) {
            trimmed = "https://" + trimmed;
        }
        if (trimmed.endsWith("/")) {
            trimmed = trimmed.substring(0, trimmed.length() - 1);
        }
        return trimmed;
    }

    private int typedProxyPort() {
        try {
            return Integer.parseInt(editProxyPort.getText().toString().trim());
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    private String typedProxyHost() {
        return editProxyHost.getText().toString().trim();
    }

    private boolean proxyFieldsValid() {
        if (!checkProxy.isChecked() || ProxySettings.valid(typedProxyHost(), typedProxyPort())) return true;
        txtStatus.setVisibility(View.VISIBLE);
        txtStatus.setTextColor(Color.parseColor("#ef4444"));
        txtStatus.setText(R.string.proxy_invalid);
        return false;
    }

    private void testConnection() {
        if (!proxyFieldsValid()) return;
        final Proxy proxy = checkProxy.isChecked()
                ? ProxySettings.proxy(radioSocks.isChecked() ? ProxySettings.SOCKS5 : ProxySettings.HTTP, typedProxyHost(), typedProxyPort())
                : Proxy.NO_PROXY;
        final String rawUrl = editServerUrl.getText() != null ? editServerUrl.getText().toString() : "";
        final String url = sanitizeUrl(rawUrl);

        if (url.isEmpty()) {
            txtStatus.setVisibility(View.VISIBLE);
            txtStatus.setTextColor(Color.parseColor("#ef4444"));
            txtStatus.setText(R.string.invalid_url);
            return;
        }

        progressTest.setVisibility(View.VISIBLE);
        txtStatus.setVisibility(View.VISIBLE);
        txtStatus.setTextColor(Color.parseColor("#94a3b8"));
        txtStatus.setText(R.string.testing_connection);
        btnTest.setEnabled(false);

        executor.execute(() -> {
            boolean success = false;
            String errorMessage = "";
            try {
                URL target = new URL(url + "/manifest.json");
                HttpURLConnection conn = (HttpURLConnection) target.openConnection(proxy);
                conn.setConnectTimeout(8000);
                conn.setReadTimeout(8000);
                conn.setRequestMethod("GET");
                conn.setRequestProperty("User-Agent", "WIHM-Android-Client/1.4.1");
                conn.connect();

                int responseCode = conn.getResponseCode();
                if (responseCode >= 200 && responseCode < 400) {
                    success = true;
                } else {
                    URL rootTarget = new URL(url + "/");
                    HttpURLConnection connRoot = (HttpURLConnection) rootTarget.openConnection(proxy);
                    connRoot.setConnectTimeout(6000);
                    connRoot.setReadTimeout(6000);
                    connRoot.setRequestMethod("GET");
                    int rootCode = connRoot.getResponseCode();
                    if (rootCode >= 200 && rootCode < 500) {
                        success = true;
                    } else {
                        errorMessage = "کد پاسخ: " + responseCode;
                    }
                }
            } catch (Exception e) {
                errorMessage = e.getMessage();
            }

            final boolean finalSuccess = success;
            final String finalErr = errorMessage;
            mainHandler.post(() -> {
                progressTest.setVisibility(View.GONE);
                btnTest.setEnabled(true);
                if (finalSuccess) {
                    txtStatus.setTextColor(Color.parseColor("#22c55e"));
                    txtStatus.setText(R.string.connection_success);
                } else {
                    txtStatus.setTextColor(Color.parseColor("#ef4444"));
                    txtStatus.setText(getString(R.string.connection_failed) + (finalErr != null && !finalErr.isEmpty() ? " (" + finalErr + ")" : ""));
                }
            });
        });
    }

    private void saveAndFinish() {
        if (!proxyFieldsValid()) return;
        String raw = editServerUrl.getText() != null ? editServerUrl.getText().toString() : "";
        String url = sanitizeUrl(raw);

        if (url.isEmpty()) {
            txtStatus.setVisibility(View.VISIBLE);
            txtStatus.setTextColor(Color.parseColor("#ef4444"));
            txtStatus.setText(R.string.invalid_url);
            return;
        }

        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        prefs.edit().putString(KEY_SERVER_URL, url)
                .putBoolean(ProxySettings.KEY_ENABLED, checkProxy.isChecked())
                .putString(ProxySettings.KEY_TYPE, radioSocks.isChecked() ? ProxySettings.SOCKS5 : ProxySettings.HTTP)
                .putString(ProxySettings.KEY_HOST, typedProxyHost())
                .putInt(ProxySettings.KEY_PORT, typedProxyPort())
                .apply();

        Toast.makeText(this, ServerConfigActivity.this.getString(R.string.server_saved), Toast.LENGTH_SHORT).show();
        Intent resultIntent = new Intent();
        resultIntent.putExtra(KEY_SERVER_URL, url);
        setResult(RESULT_OK, resultIntent);
        finish();
    }

    private void confirmClearData() {
        new AlertDialog.Builder(this)
                .setTitle(ServerConfigActivity.this.getString(R.string.clear_title))
                .setMessage(ServerConfigActivity.this.getString(R.string.clear_message))
                .setPositiveButton(ServerConfigActivity.this.getString(R.string.clear_yes), (dialog, which) -> {
                    clearAllData();
                })
                .setNegativeButton(ServerConfigActivity.this.getString(R.string.cancel), null)
                .show();
    }

    private void clearAllData() {
        try {
            SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            prefs.edit().clear().apply();

            CookieManager.getInstance().removeAllCookies(null);
            CookieManager.getInstance().flush();
            WebStorage.getInstance().deleteAllData();

            editServerUrl.setText("");
            txtStatus.setVisibility(View.VISIBLE);
            txtStatus.setTextColor(Color.parseColor("#22c55e"));
            txtStatus.setText(ServerConfigActivity.this.getString(R.string.cleared));
            Toast.makeText(this, ServerConfigActivity.this.getString(R.string.cleared_short), Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            Toast.makeText(this, "خطا در پاک‌سازی: " + e.getMessage(), Toast.LENGTH_SHORT).show();
        }
    }
}
