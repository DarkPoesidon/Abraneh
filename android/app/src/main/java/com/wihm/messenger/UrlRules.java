package com.wihm.messenger;

import java.net.URI;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Pure URL and version rules, kept free of Android types so they can be unit tested. */
final class UrlRules {
    private static final String ANDROID_TAG_PREFIX = "android-v";
    // The web client's secure bundle is built for es2022, which needs Chrome 94.
    private static final int MIN_WEBVIEW = 94;

    private UrlRules() {
    }

    /** userAgent is WebView's own, which names its Chrome version. An unreadable one is not treated as old. */
    static boolean webViewTooOld(String userAgent) {
        Matcher chrome = Pattern.compile("Chrome/(\\d+)").matcher(userAgent == null ? "" : userAgent);
        return chrome.find() && Integer.parseInt(chrome.group(1)) < MIN_WEBVIEW;
    }

    /** A plain string prefix would accept https://server.example.evil.com for https://server.example. */
    static boolean sameOrigin(String first, String second) {
        try {
            URI a = new URI(first);
            URI b = new URI(second);
            return a.getScheme() != null && a.getHost() != null
                    && a.getScheme().equalsIgnoreCase(b.getScheme())
                    && a.getHost().equalsIgnoreCase(b.getHost())
                    && effectivePort(a) == effectivePort(b);
        } catch (Exception e) {
            return false;
        }
    }

    private static int effectivePort(URI uri) {
        if (uri.getPort() != -1) return uri.getPort();
        return "https".equalsIgnoreCase(uri.getScheme()) ? 443 : 80;
    }

    static boolean isTelegramLink(String url) {
        try {
            URI uri = new URI(url);
            if ("tg".equalsIgnoreCase(uri.getScheme())) return true;
            String host = uri.getHost();
            return host != null && (host.equalsIgnoreCase("t.me") || host.equalsIgnoreCase("telegram.me"));
        } catch (Exception e) {
            return false;
        }
    }

    /** Chat ids are placed inside injected JavaScript, so only the characters the server issues may pass. */
    static boolean isChatId(String id) {
        return id != null && id.matches("[a-zA-Z0-9_-]{1,100}");
    }

    /**
     * APK releases live beside the installer's releases in the public repository, so only tags
     * named android-v1.2.3 count. Returns the version, or null for any other tag.
     */
    static String androidReleaseVersion(String tag) {
        if (tag == null || !tag.startsWith(ANDROID_TAG_PREFIX)) return null;
        String version = tag.substring(ANDROID_TAG_PREFIX.length());
        return version.matches("\\d+(\\.\\d+)*") ? version : null;
    }
}
