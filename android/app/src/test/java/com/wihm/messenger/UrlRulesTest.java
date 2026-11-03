package com.wihm.messenger;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class UrlRulesTest {
    private static final String SERVER = "https://chat.workers.dev";

    @Test
    public void webViewVersionRule() {
        assertTrue(UrlRules.webViewTooOld("Mozilla/5.0 (Linux; Android 5.0) Version/4.0 Chrome/37.0.0.0 Mobile Safari/537.36"));
        assertTrue(UrlRules.webViewTooOld("Mozilla/5.0 Chrome/93.0.4577.82 Mobile"));
        assertFalse(UrlRules.webViewTooOld("Mozilla/5.0 Chrome/94.0.4606.61 Mobile"));
        assertFalse(UrlRules.webViewTooOld("Mozilla/5.0 Chrome/138.0.0.0 Mobile"));
        assertFalse(UrlRules.webViewTooOld("unknown"));
        assertFalse(UrlRules.webViewTooOld(null));
    }

    @Test
    public void sameOriginAcceptsPagesOnTheServer() {
        assertTrue(UrlRules.sameOrigin("https://chat.workers.dev/?chat=1", SERVER));
        assertTrue(UrlRules.sameOrigin("https://CHAT.workers.dev:443/a", SERVER));
    }

    @Test
    public void sameOriginRejectsLookalikeHosts() {
        assertFalse(UrlRules.sameOrigin("https://chat.workers.dev.evil.com/", SERVER));
        assertFalse(UrlRules.sameOrigin("https://chat.workers.dev@evil.com/", SERVER));
        assertFalse(UrlRules.sameOrigin("http://chat.workers.dev/", SERVER));
        assertFalse(UrlRules.sameOrigin("https://chat.workers.dev:8443/", SERVER));
        assertFalse(UrlRules.sameOrigin("not a url", SERVER));
        assertFalse(UrlRules.sameOrigin("javascript:alert(1)", SERVER));
    }

    @Test
    public void telegramLinksAreMatchedByHostNotBySubstring() {
        assertTrue(UrlRules.isTelegramLink("https://t.me/channel"));
        assertTrue(UrlRules.isTelegramLink("tg://resolve?domain=x"));
        assertFalse(UrlRules.isTelegramLink("https://evil.com/t.me/channel"));
        assertFalse(UrlRules.isTelegramLink("https://cat.me/channel"));
    }

    @Test
    public void chatIdsCannotCarryScript() {
        assertTrue(UrlRules.isChatId("a1_b-2"));
        assertFalse(UrlRules.isChatId("x\"]');alert(1);//"));
        assertFalse(UrlRules.isChatId(""));
        assertFalse(UrlRules.isChatId(null));
    }

    @Test
    public void onlyAndroidTagsCountAsAppReleases() {
        assertEquals("1.5.0", UrlRules.androidReleaseVersion("android-v1.5.0"));
        assertNull(UrlRules.androidReleaseVersion("installer-v1.6.1"));
        assertNull(UrlRules.androidReleaseVersion("v1.4.7"));
        assertNull(UrlRules.androidReleaseVersion("android-vnext"));
        assertNull(UrlRules.androidReleaseVersion(null));
    }
}
