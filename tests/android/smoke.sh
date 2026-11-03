#!/bin/sh
# Installs and opens the app on the running emulator, and fails if Android rejects or crashes it.
# Usage: smoke.sh <apk> <screenshot.png> [no-webview]
# With no-webview the image has no WebView, so the app must leave politely instead of crashing.
set -eu
PACKAGE=com.wihm.messenger
adb install -r "$1"
# Some images refuse to clear the log, and then it only holds more than this run.
adb logcat -c || true
adb shell monkey -p "$PACKAGE" -c android.intent.category.LAUNCHER 1
sleep 20
adb exec-out screencap -p > "$2"
adb logcat -d > smoke-logcat.txt
if grep -A12 'FATAL EXCEPTION' smoke-logcat.txt | grep -q "$PACKAGE"; then
  grep -A25 'FATAL EXCEPTION' smoke-logcat.txt
  exit 1
fi
[ "${3:-}" = no-webview ] || adb shell dumpsys activity activities | grep -E 'mResumedActivity|topResumedActivity|mFocusedActivity' | grep -q "$PACKAGE"
echo "ok: $PACKAGE runs on API $(adb shell getprop ro.build.version.sdk | tr -d '\r')"
