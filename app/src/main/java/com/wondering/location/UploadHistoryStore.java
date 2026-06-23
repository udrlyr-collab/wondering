package com.wondering.location;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.location.Location;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

final class UploadHistoryStore {
    static final String ACTION_CHANGED = "com.wondering.location.UPLOAD_HISTORY_CHANGED";
    private static final String KEY_HISTORY = "upload_history_json";
    private static final int MAX_HISTORY = 60;

    private UploadHistoryStore() {}

    static void recordLocation(
        Context context,
        long timestamp,
        Location location,
        float distanceM,
        int httpStatus,
        boolean success,
        String message
    ) {
        JSONObject item = baseItem(timestamp, "location", httpStatus, success, message);
        try {
            item.put("latitude", location.getLatitude());
            item.put("longitude", location.getLongitude());
            item.put("accuracyMeters", location.hasAccuracy() ? location.getAccuracy() : JSONObject.NULL);
            item.put("distanceMeters", distanceM);
        } catch (Exception ignored) {
        }
        append(context, item);
    }

    static void recordEvent(
        Context context,
        long timestamp,
        String event,
        float distanceM,
        int httpStatus,
        boolean success,
        String message
    ) {
        JSONObject item = baseItem(timestamp, event, httpStatus, success, message);
        try {
            item.put("distanceMeters", distanceM);
        } catch (Exception ignored) {
        }
        append(context, item);
    }

    static String formattedHistory(Context context) {
        JSONArray items = read(context);
        if (items.length() == 0) return "No upload records yet.";

        StringBuilder builder = new StringBuilder();
        for (int i = 0; i < items.length(); i += 1) {
            JSONObject item = items.optJSONObject(i);
            if (item == null) continue;
            if (builder.length() > 0) builder.append("\n\n");
            builder.append(formatItem(item));
        }
        return builder.toString();
    }

    private static JSONObject baseItem(long timestamp, String type, int httpStatus, boolean success, String message) {
        JSONObject item = new JSONObject();
        try {
            item.put("timestamp", timestamp);
            item.put("type", type);
            item.put("httpStatus", httpStatus);
            item.put("success", success);
            item.put("message", message == null ? "" : message);
        } catch (Exception ignored) {
        }
        return item;
    }

    private static synchronized void append(Context context, JSONObject item) {
        JSONArray oldItems = read(context);
        JSONArray next = new JSONArray();
        next.put(item);
        for (int i = 0; i < oldItems.length() && next.length() < MAX_HISTORY; i += 1) {
            JSONObject oldItem = oldItems.optJSONObject(i);
            if (oldItem != null) next.put(oldItem);
        }
        SharePrefs.get(context).edit().putString(KEY_HISTORY, next.toString()).apply();
        Intent intent = new Intent(ACTION_CHANGED);
        intent.setPackage(context.getPackageName());
        context.sendBroadcast(intent);
    }

    private static JSONArray read(Context context) {
        SharedPreferences prefs = SharePrefs.get(context);
        String raw = prefs.getString(KEY_HISTORY, "[]");
        try {
            return new JSONArray(raw);
        } catch (Exception ignored) {
            return new JSONArray();
        }
    }

    private static String formatItem(JSONObject item) {
        long timestamp = item.optLong("timestamp", 0L);
        String time = timestamp > 0
            ? new SimpleDateFormat("MM-dd HH:mm:ss", Locale.US).format(new Date(timestamp))
            : "--";
        boolean success = item.optBoolean("success", false);
        int httpStatus = item.optInt("httpStatus", -1);
        String type = item.optString("type", "location");
        String status = success ? "OK" : "FAIL";
        String code = httpStatus > 0 ? " HTTP " + httpStatus : "";

        StringBuilder builder = new StringBuilder();
        builder.append(time).append(" · ").append(status).append(code).append(" · ").append(type);

        if (item.has("latitude") && item.has("longitude")) {
            builder
                .append("\n")
                .append(String.format(Locale.US, "%.5f / %.5f", item.optDouble("latitude"), item.optDouble("longitude")));
        }

        if (!item.isNull("accuracyMeters")) {
            builder.append(" · +/-").append(Math.round(item.optDouble("accuracyMeters"))).append("m");
        }

        if (item.has("distanceMeters")) {
            builder.append(" · ").append(Math.round(item.optDouble("distanceMeters"))).append("m");
        }

        String message = item.optString("message", "");
        if (!message.isEmpty()) builder.append("\n").append(message);
        return builder.toString();
    }
}
