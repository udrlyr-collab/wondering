package com.wondering.location;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

final class ShareStateUploader {
    private ShareStateUploader() {}

    static void uploadAsync(Context context, String event, float distanceM, int dailySteps) {
        Context appContext = context.getApplicationContext();
        new Thread(() -> upload(appContext, event, distanceM, dailySteps), "wondering-share-state").start();
    }

    private static void upload(Context context, String event, float distanceM, int dailySteps) {
        SharedPreferences prefs = SharePrefs.get(context);
        HttpURLConnection conn = null;
        long timestamp = System.currentTimeMillis();
        int httpStatus = -1;
        boolean success = false;
        String message = "";
        try {
            String endpoint = prefs.getString(SharePrefs.KEY_ENDPOINT, SharePrefs.DEFAULT_ENDPOINT);
            conn = (HttpURLConnection) new URL(SharePrefs.apiUrl(endpoint)).openConnection();
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(5000);
            conn.setReadTimeout(5000);
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            conn.setRequestProperty("Accept", "application/json");
            String token = prefs.getString(SharePrefs.KEY_TOKEN, "");
            if (token != null && !token.trim().isEmpty()) {
                conn.setRequestProperty("Authorization", "Bearer " + token.trim());
            }

            JSONObject body = new JSONObject()
                .put("recordType", "event")
                .put("event", event)
                .put("deviceId", prefs.getString(SharePrefs.KEY_DEVICE_ID, "android"))
                .put("deviceName", prefs.getString(SharePrefs.KEY_DEVICE_NAME, "Android"))
                .put("timestamp", timestamp)
                .put("date", new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date(timestamp)))
                .put("source", "share_state")
                .put("steps", dailySteps)
                .put("distanceMeters", distanceM);

            byte[] bytes = body.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8);
            try (OutputStream os = conn.getOutputStream()) {
                os.write(bytes);
            }
            httpStatus = conn.getResponseCode();
            success = httpStatus >= 200 && httpStatus < 300;
            if (!success) message = "Server rejected upload.";
        } catch (Exception ex) {
            message = ex.getClass().getSimpleName();
        } finally {
            if (conn != null) conn.disconnect();
            UploadHistoryStore.recordEvent(context, timestamp, event, distanceM, dailySteps, httpStatus, success, message);
        }
    }
}
