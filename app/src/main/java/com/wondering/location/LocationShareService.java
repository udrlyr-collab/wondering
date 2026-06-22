package com.wondering.location;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.location.Location;
import android.os.Build;
import android.os.IBinder;
import android.os.Looper;

import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;

import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class LocationShareService extends Service {
    private static final String CHANNEL_ID = "wondering_location";
    private static final int NOTIFICATION_ID = 7001;

    private SharedPreferences prefs;
    private FusedLocationProviderClient fusedLocation;
    private LocationCallback callback;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private boolean hasLast;
    private double lastLat;
    private double lastLng;
    private float distanceM;

    @Override
    public void onCreate() {
        super.onCreate();
        prefs = SharePrefs.get(this);
        fusedLocation = LocationServices.getFusedLocationProviderClient(this);
        distanceM = prefs.getFloat(SharePrefs.KEY_DISTANCE_M, 0f);
        createChannel();
        startForeground(NOTIFICATION_ID, notification("위치 공유 준비 중"));
        startLocationUpdates();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (!prefs.getBoolean(SharePrefs.KEY_ENABLED, false)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        if (callback != null) fusedLocation.removeLocationUpdates(callback);
        if (prefs != null && !prefs.getBoolean(SharePrefs.KEY_ENABLED, false)) {
            ShareStateUploader.uploadAsync(this, "sharing_off", distanceM);
        }
        executor.shutdownNow();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @SuppressWarnings("MissingPermission")
    private void startLocationUpdates() {
        if (!hasLocationPermission()) {
            stopSelf();
            return;
        }

        long intervalMs = SharePrefs.safeRefreshMs(
            prefs.getLong(SharePrefs.KEY_REFRESH_MS, SharePrefs.DEFAULT_REFRESH_MS)
        );
        int priority = intervalMs >= 60000L
            ? Priority.PRIORITY_BALANCED_POWER_ACCURACY
            : Priority.PRIORITY_HIGH_ACCURACY;
        float minDistance = intervalMs >= 60000L ? 25f : 10f;

        LocationRequest request = new LocationRequest.Builder(priority, intervalMs)
            .setMinUpdateIntervalMillis(intervalMs)
            .setMinUpdateDistanceMeters(minDistance)
            .setMaxUpdateDelayMillis(intervalMs * 2)
            .build();

        callback = new LocationCallback() {
            @Override
            public void onLocationResult(LocationResult result) {
                for (Location location : result.getLocations()) {
                    handleLocation(location);
                }
            }
        };

        fusedLocation.requestLocationUpdates(request, callback, Looper.getMainLooper());
    }

    private boolean hasLocationPermission() {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
            || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private void handleLocation(Location location) {
        if (!prefs.getBoolean(SharePrefs.KEY_ENABLED, false)) return;
        updateDistance(location);
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.notify(NOTIFICATION_ID, notification("위치 전송 중 · " + Math.round(distanceM) + "m"));
        executor.execute(() -> upload(location));
    }

    private void updateDistance(Location location) {
        if (hasLast) {
            float[] result = new float[1];
            Location.distanceBetween(lastLat, lastLng, location.getLatitude(), location.getLongitude(), result);
            if (result[0] >= 3f && result[0] < 200f) {
                distanceM += result[0];
                prefs.edit().putFloat(SharePrefs.KEY_DISTANCE_M, distanceM).apply();
            }
        }
        hasLast = true;
        lastLat = location.getLatitude();
        lastLng = location.getLongitude();
    }

    private void upload(Location location) {
        HttpURLConnection conn = null;
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

            long timestamp = System.currentTimeMillis();
            JSONObject body = new JSONObject()
                .put("deviceId", prefs.getString(SharePrefs.KEY_DEVICE_ID, "android"))
                .put("deviceName", prefs.getString(SharePrefs.KEY_DEVICE_NAME, "Android"))
                .put("latitude", location.getLatitude())
                .put("longitude", location.getLongitude())
                .put("timestamp", timestamp)
                .put("date", new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date(timestamp)))
                .put("source", "gps")
                .put("accuracyMeters", location.hasAccuracy() ? location.getAccuracy() : JSONObject.NULL)
                .put("speedMps", location.hasSpeed() ? location.getSpeed() : JSONObject.NULL)
                .put("steps", 0)
                .put("distanceMeters", distanceM);

            byte[] bytes = body.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8);
            try (OutputStream os = conn.getOutputStream()) {
                os.write(bytes);
            }
            conn.getResponseCode();
        } catch (Exception ignored) {
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private Notification notification(String text) {
        Intent intent = new Intent(this, MainActivity.class);
        PendingIntent pendingIntent = PendingIntent.getActivity(
            this,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, CHANNEL_ID)
            : new Notification.Builder(this);
        return builder
            .setContentTitle("Wondering Location")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .build();
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "Wondering Location",
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setShowBadge(false);
        getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }
}
