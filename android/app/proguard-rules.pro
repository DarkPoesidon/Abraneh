# ProGuard rules for WIHM Messenger

# Keep JavaScript Interface methods
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

-keep class com.wihm.messenger.WebAppInterface {
    *;
}

-keep class com.wihm.messenger.UpdateHelper {
    *;
}

# Keep native callbacks
-keepattributes *Annotation*
-keepattributes JavascriptInterface
