package com.wihm.messenger;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.util.Base64;
import androidx.test.core.app.ApplicationProvider;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;
import java.util.Arrays;
import okhttp3.mockwebserver.Dispatcher;
import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import okhttp3.mockwebserver.RecordedRequest;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;

@RunWith(RobolectricTestRunner.class)
public class AddressFailoverTest {
    // Signed by Node as WebCrypto signs (r||s), so the DER conversion meets real server output.
    private static final String KEY = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEcopY7ju9eL0hY62zgx4Oh+DMr2s5A9bjxkSeG315AANmewgMJw4YMbV8hpPGfTSyrDEzMKCpOoac6X/m95kAhw==";
    private static final String HIGH_CHALLENGE = "vector-challenge-000001aaaaaa";
    private static final String HIGH = "4p8SolAWHwF1H6ttPbGM+hDh9nrYhgd+YPmvEHfH/Sa+cJjsSRkFGzyY4n39kMhTLLbg9EtKfaHZBCwQaJj7jQ==";
    private static final String ZERO_CHALLENGE = "vector-challenge-000110aaaaaa";
    private static final String ZERO = "AKdwev8TCMKkxR7irOqHA887cIViTggRg8ngeSBgAVF2Qz2OgKoHuxmi19AFq3WUJ/1SXvWvpXEgTvaks2Zabw==";

    private static JSONObject answer(String key, String signature, String... addresses) throws Exception {
        return new JSONObject().put("format", "wihm-addresses/1").put("publicKey", key).put("signature", signature)
                .put("addresses", new JSONArray(Arrays.asList(addresses)));
    }

    @Test
    public void acceptsServerSignaturesWhoseIntegersNeedPaddingOrTrimming() throws Exception {
        AddressFailover.Known high = AddressFailover.signedAddresses(HIGH_CHALLENGE, answer(KEY, HIGH, "https://a.example", "https://b.example"), "");
        assertNotNull(high);
        assertEquals(Arrays.asList("https://a.example", "https://b.example"), high.addresses);
        assertEquals(KEY, high.key);
        assertNotNull(AddressFailover.signedAddresses(ZERO_CHALLENGE, answer(KEY, ZERO, "https://a.example", "https://b.example"), KEY));
    }

    @Test
    public void rejectsAnotherKeyAReplayAndAChangedList() throws Exception {
        assertNull("a lapsed domain with its own key", AddressFailover.signedAddresses(HIGH_CHALLENGE, answer(KEY, HIGH, "https://a.example", "https://b.example"), "AAAA"));
        assertNull("an answer to an older challenge", AddressFailover.signedAddresses(ZERO_CHALLENGE, answer(KEY, HIGH, "https://a.example", "https://b.example"), KEY));
        assertNull(AddressFailover.signedAddresses(HIGH_CHALLENGE, answer(KEY, HIGH, "https://a.example", "https://evil.example"), KEY));
        assertNull(AddressFailover.signedAddresses(HIGH_CHALLENGE, answer(KEY, "not base64", "https://a.example", "https://b.example"), KEY));
        assertNull(AddressFailover.signedAddresses(HIGH_CHALLENGE, null, KEY));
    }

    @Test
    public void addressesAreBareHttpsOrigins() {
        assertTrue(AddressFailover.validAddress("https://chat.example.com"));
        for (String bad : new String[] {"http://chat.example.com", "https://chat.example.com/", "https://chat.example.com/x",
                "https://chat.example.com:8443", "https://u@chat.example.com", "https://Chat.example.com", "https://chat.example.com?x", "nonsense"}) {
            assertFalse(bad, AddressFailover.validAddress(bad));
        }
    }

    /** WebCrypto's r||s from Java's DER, so the fake server answers like the real one. */
    private static byte[] raw(byte[] der) {
        byte[] out = new byte[64];
        int rLength = der[3], sOffset = 4 + rLength, sLength = der[sOffset + 1];
        copyInteger(der, 4, rLength, out, 0);
        copyInteger(der, sOffset + 2, sLength, out, 32);
        return out;
    }

    private static void copyInteger(byte[] der, int offset, int length, byte[] out, int at) {
        int skip = length > 32 ? length - 32 : 0;
        System.arraycopy(der, offset + skip, out, at + 32 - (length - skip), length - skip);
    }

    @Test
    public void failoverPicksOnlyAnAddressSignedWithThePinnedKey() throws Exception {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
        generator.initialize(new ECGenParameterSpec("secp256r1"));
        KeyPair server = generator.generateKeyPair(), impostor = generator.generateKeyPair();
        String serverKey = Base64.encodeToString(server.getPublic().getEncoded(), Base64.NO_WRAP);
        MockWebServer lapsed = new MockWebServer(), good = new MockWebServer();
        lapsed.setDispatcher(signer(impostor));
        good.setDispatcher(signer(server));
        lapsed.start();
        good.start();
        try {
            Context context = ApplicationProvider.getApplicationContext();
            String lapsedUrl = lapsed.url("").toString().replaceAll("/$", ""), goodUrl = good.url("").toString().replaceAll("/$", "");
            SharedPreferences prefs = context.getSharedPreferences(ServerConfigActivity.PREFS_NAME, Context.MODE_PRIVATE);
            prefs.edit().putString(AddressFailover.KEY_ADDRESSES, "https://blocked.example\n" + lapsedUrl + "\n" + goodUrl)
                    .putString(AddressFailover.KEY_ADDRESS_KEY, serverKey).apply();
            assertEquals(goodUrl, AddressFailover.findAlternate(context, "https://blocked.example"));
            assertTrue(AddressFailover.known(context, goodUrl));
            AddressFailover.forget(context);
            assertNull("nothing is trusted before a key is pinned", AddressFailover.findAlternate(context, "https://blocked.example"));
        } finally {
            lapsed.shutdown();
            good.shutdown();
        }
    }

    private static Dispatcher signer(KeyPair pair) {
        return new Dispatcher() {
            @Override
            public MockResponse dispatch(RecordedRequest request) {
                try {
                    String challenge = Uri.parse(request.getPath()).getQueryParameter("challenge");
                    String message = "wihm-addresses/1\n" + challenge + "\nhttps://a.example";
                    Signature signer = Signature.getInstance("SHA256withECDSA");
                    signer.initSign(pair.getPrivate());
                    signer.update(message.getBytes(StandardCharsets.UTF_8));
                    String signature = Base64.encodeToString(raw(signer.sign()), Base64.NO_WRAP);
                    String key = Base64.encodeToString(pair.getPublic().getEncoded(), Base64.NO_WRAP);
                    return new MockResponse().setBody(answer(key, signature, "https://a.example").toString());
                } catch (Exception e) {
                    return new MockResponse().setResponseCode(500);
                }
            }
        };
    }
}
