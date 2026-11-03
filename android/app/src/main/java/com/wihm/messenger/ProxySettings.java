package com.wihm.messenger;

import android.content.Context;
import android.content.SharedPreferences;
import androidx.core.content.ContextCompat;
import androidx.webkit.ProxyConfig;
import androidx.webkit.ProxyController;
import androidx.webkit.WebViewFeature;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.util.regex.Pattern;
import okhttp3.OkHttpClient;

/**
 * One proxy for the WebView, the inbox socket and the app's own requests.
 * shortcut: no username or password, because WebView can't authenticate to SOCKS5 proxies.
 * MTProto proxies can't work here either: they only carry Telegram's own protocol.
 */
final class ProxySettings {
    static final String KEY_ENABLED = "proxy_enabled";
    static final String KEY_TYPE = "proxy_type";
    static final String KEY_HOST = "proxy_host";
    static final String KEY_PORT = "proxy_port";
    static final String SOCKS5 = "socks5";
    static final String HTTP = "http";
    private static final Pattern HOST = Pattern.compile("^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$");

    private ProxySettings() {
    }

    static boolean valid(String host, int port) {
        return host != null && HOST.matcher(host).matches() && port >= 1 && port <= 65535;
    }

    /** Unresolved, so name lookups never run on the caller's thread and SOCKS5 resolves names remotely. */
    static Proxy proxy(String type, String host, int port) {
        return new Proxy(SOCKS5.equals(type) ? Proxy.Type.SOCKS : Proxy.Type.HTTP, InetSocketAddress.createUnresolved(host, port));
    }

    static Proxy current(Context context) {
        SharedPreferences prefs = prefs(context);
        String host = prefs.getString(KEY_HOST, "");
        int port = prefs.getInt(KEY_PORT, 0);
        if (!prefs.getBoolean(KEY_ENABLED, false) || !valid(host, port)) return Proxy.NO_PROXY;
        return proxy(prefs.getString(KEY_TYPE, SOCKS5), host, port);
    }

    static OkHttpClient client(Context context) {
        return new OkHttpClient.Builder().proxy(current(context)).build();
    }

    /** Runs next once the WebView uses the saved proxy, so no request leaves before it applies. */
    static void applyToWebView(Context context, Runnable next) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) {
            next.run();
            return;
        }
        Proxy proxy = current(context);
        ProxyController controller = ProxyController.getInstance();
        if (proxy == Proxy.NO_PROXY) {
            controller.clearProxyOverride(ContextCompat.getMainExecutor(context), next);
            return;
        }
        InetSocketAddress address = (InetSocketAddress) proxy.address();
        String scheme = proxy.type() == Proxy.Type.SOCKS ? "socks5" : "http";
        controller.setProxyOverride(
                new ProxyConfig.Builder().addProxyRule(scheme + "://" + address.getHostString() + ":" + address.getPort()).build(),
                ContextCompat.getMainExecutor(context), next);
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(ServerConfigActivity.PREFS_NAME, Context.MODE_PRIVATE);
    }
}
