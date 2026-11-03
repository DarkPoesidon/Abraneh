package com.wihm.messenger;

import android.content.ActivityNotFoundException;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.widget.Toast;
import androidx.core.content.FileProvider;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import okhttp3.Request;
import okhttp3.Response;

/** Saves a chat file to Downloads with the session's token. WebView can't save the page's blobs. */
final class FileDownload {
    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();

    private FileDownload() {
    }

    static void start(Context context, String url, String name, String mime, String token) {
        Context app = context.getApplicationContext();
        String safeName = name.replaceAll("[/\\\\\\p{Cntrl}]", "_");
        EXECUTOR.execute(() -> {
            Handler main = new Handler(Looper.getMainLooper());
            try {
                Uri saved = fetch(app, url, safeName, mime, token);
                main.post(() -> finished(app, saved, safeName, mime));
            } catch (IOException | RuntimeException e) {
                main.post(() -> Toast.makeText(app, app.getString(R.string.download_failed), Toast.LENGTH_LONG).show());
            }
        });
    }

    private static Uri fetch(Context context, String url, String name, String mime, String token) throws IOException {
        Request request = new Request.Builder().url(url).header("Authorization", "Bearer " + token).build();
        try (Response response = ProxySettings.client(context).newCall(request).execute()) {
            if (!response.isSuccessful() || response.body() == null) throw new IOException("HTTP " + response.code());
            try (InputStream in = response.body().byteStream()) {
                return Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ? toMediaStore(context, in, name, mime) : toAppFolder(context, in, name);
            }
        }
    }

    private static Uri toMediaStore(Context context, InputStream in, String name, String mime) throws IOException {
        ContentResolver resolver = context.getContentResolver();
        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
        values.put(MediaStore.MediaColumns.MIME_TYPE, mime);
        values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
        values.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (uri == null) throw new IOException("No download entry");
        try (OutputStream out = resolver.openOutputStream(uri)) {
            if (out == null) throw new IOException("No output");
            copy(in, out);
        } catch (IOException e) {
            resolver.delete(uri, null, null);
            throw e;
        }
        values.clear();
        values.put(MediaStore.MediaColumns.IS_PENDING, 0);
        resolver.update(uri, values, null, null);
        return uri;
    }

    /** Before Android 10, the shared Downloads folder would need a storage permission for this one task. */
    private static Uri toAppFolder(Context context, InputStream in, String name) throws IOException {
        File folder = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        if (folder == null) throw new IOException("No storage");
        File file = new File(folder, name);
        try (OutputStream out = new FileOutputStream(file)) {
            copy(in, out);
        }
        return FileProvider.getUriForFile(context, context.getPackageName() + ".provider", file);
    }

    private static void copy(InputStream in, OutputStream out) throws IOException {
        byte[] buffer = new byte[64 * 1024];
        for (int read; (read = in.read(buffer)) != -1; ) out.write(buffer, 0, read);
    }

    private static void finished(Context context, Uri uri, String name, String mime) {
        Toast.makeText(context, context.getString(R.string.download_saved, name), Toast.LENGTH_LONG).show();
        if (mime.startsWith("image/")) return;
        Intent open = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            context.startActivity(open);
        } catch (ActivityNotFoundException ignored) {
            // The file is saved; there is just no app for this type.
        }
    }
}
