/*! Copyright (c) 2026 DarkPoesidon. Abraneh: https://github.com/DarkPoesidon/Abraneh. PolyForm Noncommercial 1.0.0; see LICENSE and NOTICE. */
package com.wihm.messenger;

import android.content.Context;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;
import android.os.PowerManager;
import androidx.annotation.RequiresApi;
import java.util.List;

/** Chooses where a call is heard, since a web page can't. Turns the screen off at the ear, as phone calls do. */
final class CallAudio {
    private final AudioManager audio;
    private final PowerManager.WakeLock proximity;

    CallAudio(Context context) {
        audio = (AudioManager) context.getApplicationContext().getSystemService(Context.AUDIO_SERVICE);
        PowerManager power = (PowerManager) context.getApplicationContext().getSystemService(Context.POWER_SERVICE);
        proximity = power.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK)
                ? power.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "wihm:call") : null;
    }

    /** route is "earpiece", "speaker" or "off". Returns false for anything else. */
    boolean set(String route) {
        if ("off".equals(route)) {
            stop();
            return true;
        }
        boolean speaker = "speaker".equals(route);
        if (!speaker && !"earpiece".equals(route)) return false;
        audio.setMode(AudioManager.MODE_IN_COMMUNICATION);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            AudioDeviceInfo device = pick(audio.getAvailableCommunicationDevices(), speaker);
            if (device != null) audio.setCommunicationDevice(device);
        } else {
            audio.setSpeakerphoneOn(speaker);
        }
        if (proximity != null) {
            if (speaker && proximity.isHeld()) proximity.release();
            else if (!speaker && !proximity.isHeld()) proximity.acquire(4 * 60 * 60_000L);
        }
        return true;
    }

    void stop() {
        if (proximity != null && proximity.isHeld()) proximity.release();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) audio.clearCommunicationDevice();
        else audio.setSpeakerphoneOn(false);
        audio.setMode(AudioManager.MODE_NORMAL);
    }

    /** A connected headset takes priority over the earpiece, as it does for phone calls. */
    @RequiresApi(Build.VERSION_CODES.S)
    private static AudioDeviceInfo pick(List<AudioDeviceInfo> devices, boolean speaker) {
        int[] order = speaker
                ? new int[]{AudioDeviceInfo.TYPE_BUILTIN_SPEAKER}
                : new int[]{AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_USB_HEADSET,
                        AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET, AudioDeviceInfo.TYPE_BUILTIN_EARPIECE};
        for (int type : order) {
            for (AudioDeviceInfo device : devices) {
                if (device.getType() == type) return device;
            }
        }
        return null;
    }
}
