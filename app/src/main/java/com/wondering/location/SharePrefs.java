package com.wondering.location;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;

import java.util.UUID;

final class SharePrefs {
    static final String PREFS = "wondering_location_prefs";
    static final String KEY_ENABLED = "share_enabled";
    static final String KEY_ENDPOINT = "share_endpoint";
    static final String KEY_TOKEN = "share_token";
    static final String KEY_DEVICE_ID = "device_id";
    static final String KEY_DEVICE_NAME = "device_name";
    static final String KEY_REFRESH_MS = "refresh_ms";
    static final String KEY_DISTANCE_M = "distance_m";

    static final String DEFAULT_ENDPOINT = "https://wondering.kr";
    private static final String LEGACY_LOCAL_ENDPOINT = "http://10.0.2.2:5174";
    static final long DEFAULT_REFRESH_MS = 60000L;
    static final long MIN_REFRESH_MS = 15000L;
    static final long MAX_REFRESH_MS = 300000L;

    private SharePrefs() {}

    static SharedPreferences get(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        ensureDefaults(prefs);
        return prefs;
    }

    static void ensureDefaults(SharedPreferences prefs) {
        SharedPreferences.Editor edit = prefs.edit();
        boolean changed = false;
        if (!prefs.contains(KEY_ENABLED)) {
            edit.putBoolean(KEY_ENABLED, false);
            changed = true;
        }
        String savedEndpoint = prefs.getString(KEY_ENDPOINT, "");
        if (!prefs.contains(KEY_ENDPOINT) || savedEndpoint == null || savedEndpoint.trim().isEmpty()
            || LEGACY_LOCAL_ENDPOINT.equals(savedEndpoint.trim())) {
            edit.putString(KEY_ENDPOINT, DEFAULT_ENDPOINT);
            changed = true;
        }
        if (!prefs.contains(KEY_TOKEN)) {
            edit.putString(KEY_TOKEN, "");
            changed = true;
        }
        if (!prefs.contains(KEY_DEVICE_ID)) {
            edit.putString(KEY_DEVICE_ID, UUID.randomUUID().toString());
            changed = true;
        }
        if (!prefs.contains(KEY_DEVICE_NAME)) {
            edit.putString(KEY_DEVICE_NAME, defaultDeviceName());
            changed = true;
        }
        if (!prefs.contains(KEY_REFRESH_MS)) {
            edit.putLong(KEY_REFRESH_MS, DEFAULT_REFRESH_MS);
            changed = true;
        }
        if (changed) edit.apply();
    }

    static long safeRefreshMs(long value) {
        return Math.max(MIN_REFRESH_MS, Math.min(MAX_REFRESH_MS, value));
    }

    static String apiUrl(String endpoint) {
        String trimmed = endpoint == null ? "" : endpoint.trim();
        while (trimmed.endsWith("/")) {
            trimmed = trimmed.substring(0, trimmed.length() - 1);
        }
        return trimmed.endsWith("/api/locations") ? trimmed : trimmed + "/api/locations";
    }

    private static String defaultDeviceName() {
        String maker = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER.trim();
        String model = Build.MODEL == null ? "" : Build.MODEL.trim();
        String name = (maker + " " + model).trim();
        return name.isEmpty() ? "Android" : name;
    }
}
