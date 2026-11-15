/*! Copyright (c) 2026 DarkPoesidon. Abraneh: https://github.com/DarkPoesidon/Abraneh. PolyForm Noncommercial 1.0.0; see LICENSE and NOTICE. */
package com.wihm.messenger;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Base64;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.TimeUnit;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * When one address of the server is filtered, moves to another address of the same server.
 * The server's key is pinned on first contact, and an address counts only if it signs a fresh challenge
 * with that key, so a lapsed or hijacked alternate domain can't take the user over. src/addresses.ts signs.
 */
final class AddressFailover {
    static final String KEY_ADDRESSES = "server_addresses";
    static final String KEY_ADDRESS_KEY = "server_address_key";
    private static final SecureRandom RANDOM = new SecureRandom();

    private AddressFailover() {
    }

    static final class Known {
        final List<String> addresses;
        final String key;

        Known(List<String> addresses, String key) {
            this.addresses = addresses;
            this.key = key;
        }
    }

    /** The addresses a server signed for this challenge, or null. With a pinned key the server must sign with it. */
    static Known signedAddresses(String challenge, JSONObject data, String pinnedKey) {
        try {
            if (data == null || !"wihm-addresses/1".equals(data.optString("format"))) return null;
            String key = data.optString("publicKey", "");
            if (key.isEmpty() || (pinnedKey != null && !pinnedKey.isEmpty() && !pinnedKey.equals(key))) return null;
            JSONArray list = data.optJSONArray("addresses");
            if (list == null || list.length() == 0) return null;
            List<String> addresses = new ArrayList<>();
            StringBuilder message = new StringBuilder("wihm-addresses/1\n").append(challenge);
            for (int i = 0; i < list.length(); i++) {
                String address = list.optString(i, "");
                if (!validAddress(address)) return null;
                addresses.add(address);
                message.append('\n').append(address);
            }
            PublicKey publicKey = KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(Base64.decode(key, Base64.DEFAULT)));
            Signature verifier = Signature.getInstance("SHA256withECDSA");
            verifier.initVerify(publicKey);
            verifier.update(message.toString().getBytes(StandardCharsets.UTF_8));
            return verifier.verify(der(Base64.decode(data.optString("signature", ""), Base64.DEFAULT))) ? new Known(addresses, key) : null;
        } catch (Exception e) {
            return null;
        }
    }

    /** An https origin with nothing after the host, as the app stores server addresses. */
    static boolean validAddress(String address) {
        try {
            URI uri = new URI(address);
            return "https".equals(uri.getScheme()) && uri.getHost() != null && uri.getRawUserInfo() == null && uri.getPort() == -1
                    && (uri.getRawPath() == null || uri.getRawPath().isEmpty()) && uri.getRawQuery() == null && uri.getRawFragment() == null
                    && address.equals("https://" + uri.getHost().toLowerCase(java.util.Locale.ROOT));
        } catch (Exception e) {
            return false;
        }
    }

    /** WebCrypto signs as r||s; Java verifies the DER form. */
    static byte[] der(byte[] raw) {
        if (raw.length != 64) throw new IllegalArgumentException("P-256 signatures are 64 bytes");
        byte[] r = integer(Arrays.copyOfRange(raw, 0, 32)), s = integer(Arrays.copyOfRange(raw, 32, 64));
        byte[] out = new byte[6 + r.length + s.length];
        out[0] = 0x30;
        out[1] = (byte) (4 + r.length + s.length);
        out[2] = 0x02;
        out[3] = (byte) r.length;
        System.arraycopy(r, 0, out, 4, r.length);
        out[4 + r.length] = 0x02;
        out[5 + r.length] = (byte) s.length;
        System.arraycopy(s, 0, out, 6 + r.length, s.length);
        return out;
    }

    /** A DER INTEGER body: no extra leading zeros, and one zero when the top bit would make it negative. */
    private static byte[] integer(byte[] value) {
        int start = 0;
        while (start < value.length - 1 && value[start] == 0) start++;
        byte[] trimmed = Arrays.copyOfRange(value, start, value.length);
        if ((trimmed[0] & 0x80) == 0) return trimmed;
        byte[] padded = new byte[trimmed.length + 1];
        System.arraycopy(trimmed, 0, padded, 1, trimmed.length);
        return padded;
    }

    /** Asks a server for its signed addresses; must run off the main thread. */
    static Known ask(Context context, String server, String pinnedKey) {
        byte[] bytes = new byte[32];
        RANDOM.nextBytes(bytes);
        String challenge = Base64.encodeToString(bytes, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
        OkHttpClient client = ProxySettings.client(context).newBuilder().callTimeout(8, TimeUnit.SECONDS).build();
        try (Response response = client.newCall(new Request.Builder().url(server + "/api/addresses?challenge=" + challenge).build()).execute()) {
            if (!response.isSuccessful() || response.body() == null) return null;
            return signedAddresses(challenge, new JSONObject(response.body().string()), pinnedKey);
        } catch (Exception e) {
            return null;
        }
    }

    /** Learns the current server's other addresses, pinning its key on first contact. Off the main thread. */
    static void remember(Context context, String server) {
        SharedPreferences prefs = prefs(context);
        Known known = ask(context, server, prefs.getString(KEY_ADDRESS_KEY, ""));
        // The user may have moved to another server meanwhile.
        if (known == null || !server.equals(prefs.getString(ServerConfigActivity.KEY_SERVER_URL, ""))) return;
        prefs.edit().putString(KEY_ADDRESSES, join(known.addresses)).putString(KEY_ADDRESS_KEY, known.key).apply();
    }

    /** The first other address that proves it is this server, or null. Off the main thread. */
    static String findAlternate(Context context, String current) {
        SharedPreferences prefs = prefs(context);
        String pinned = prefs.getString(KEY_ADDRESS_KEY, "");
        if (pinned.isEmpty()) return null;
        for (String address : prefs.getString(KEY_ADDRESSES, "").split("\n")) {
            if (address.isEmpty() || address.equals(current)) continue;
            if (ask(context, address, pinned) != null) return address;
        }
        return null;
    }

    /** Whether a server address is one of the known server's, so its pinned key still applies. */
    static boolean known(Context context, String server) {
        return Arrays.asList(prefs(context).getString(KEY_ADDRESSES, "").split("\n")).contains(server);
    }

    /** Another server has another key, so its addresses are learned afresh. */
    static void forget(Context context) {
        prefs(context).edit().remove(KEY_ADDRESSES).remove(KEY_ADDRESS_KEY).apply();
    }

    private static String join(List<String> addresses) {
        StringBuilder out = new StringBuilder();
        for (String address : addresses) out.append(out.length() == 0 ? "" : "\n").append(address);
        return out.toString();
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(ServerConfigActivity.PREFS_NAME, Context.MODE_PRIVATE);
    }
}
