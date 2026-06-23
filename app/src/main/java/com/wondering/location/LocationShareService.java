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
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.location.Location;
import android.os.Build;
import android.os.Handler;
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

public class LocationShareService extends Service implements SensorEventListener {
    private static final String CHANNEL_ID = "wondering_location";
    private static final int NOTIFICATION_ID = 7001;

    private SharedPreferences prefs;
    private FusedLocationProviderClient fusedLocation;
    private SensorManager sensorManager;
    private Sensor stepCounterSensor;
    private LocationCallback callback;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final Handler uploadHandler = new Handler(Looper.getMainLooper());
    private final Runnable periodicUpload = new Runnable() {
        @Override
        public void run() {
            uploadLatestLocation();
        }
    };
    private boolean hasLast;
    private double lastLat;
    private double lastLng;
    private float distanceM;
    private int dailySteps;
    private Location lastKnownLocation;
    private volatile boolean uploadInProgress;

    @Override
    public void onCreate() {
        super.onCreate();
        prefs = SharePrefs.get(this);
        fusedLocation = LocationServices.getFusedLocationProviderClient(this);
        sensorManager = getSystemService(SensorManager.class);
        ensureDailyCounters();
        distanceM = prefs.getFloat(SharePrefs.KEY_DISTANCE_M, 0f);
        dailySteps = prefs.getInt(SharePrefs.KEY_DAILY_STEPS, 0);
        markServiceRunning("Service starting");
        createChannel();
        startForeground(NOTIFICATION_ID, notification("Location sharing ready"));
        startStepUpdates();
        startLocationUpdates();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (!prefs.getBoolean(SharePrefs.KEY_ENABLED, false)) {
            markServiceStopped("Sharing disabled");
            stopSelf();
            return START_NOT_STICKY;
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        uploadHandler.removeCallbacks(periodicUpload);
        if (callback != null) fusedLocation.removeLocationUpdates(callback);
        if (sensorManager != null) sensorManager.unregisterListener(this);
        if (prefs != null && !prefs.getBoolean(SharePrefs.KEY_ENABLED, false)) {
            ensureDailyCounters();
            ShareStateUploader.uploadAsync(this, "sharing_off", distanceM, dailySteps);
        }
        markServiceStopped("Service stopped");
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
            markServiceStopped("Location permission missing");
            stopSelf();
            return;
        }

        long intervalMs = currentIntervalMs();
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
        updateUploadStatus(false, "Waiting for location", -1, false, 0L, System.currentTimeMillis());
        scheduleNextUpload(0L);
    }

    private boolean hasLocationPermission() {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
            || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasActivityPermission() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
            || checkSelfPermission(Manifest.permission.ACTIVITY_RECOGNITION) == PackageManager.PERMISSION_GRANTED;
    }

    private void startStepUpdates() {
        if (sensorManager == null || !hasActivityPermission()) return;
        stepCounterSensor = sensorManager.getDefaultSensor(Sensor.TYPE_STEP_COUNTER);
        if (stepCounterSensor != null) {
            sensorManager.registerListener(this, stepCounterSensor, SensorManager.SENSOR_DELAY_NORMAL);
        }
    }

    private void handleLocation(Location location) {
        if (!prefs.getBoolean(SharePrefs.KEY_ENABLED, false)) return;
        boolean hadLocation = lastKnownLocation != null;
        ensureDailyCounters();
        updateDistance(location);
        lastKnownLocation = new Location(location);
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.notify(NOTIFICATION_ID, notification("Location ready - " + Math.round(distanceM) + "m / " + dailySteps + " steps"));
        if (!hadLocation && !uploadInProgress) {
            scheduleNextUpload(0L);
        }
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
                .put("deviceId", prefs.getString(SharePrefs.KEY_DEVICE_ID, "android"))
                .put("deviceName", prefs.getString(SharePrefs.KEY_DEVICE_NAME, "Android"))
                .put("latitude", location.getLatitude())
                .put("longitude", location.getLongitude())
                .put("timestamp", timestamp)
                .put("date", new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date(timestamp)))
                .put("source", "gps")
                .put("accuracyMeters", location.hasAccuracy() ? location.getAccuracy() : JSONObject.NULL)
                .put("speedMps", location.hasSpeed() ? location.getSpeed() : JSONObject.NULL)
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
            UploadHistoryStore.recordLocation(this, timestamp, location, distanceM, dailySteps, httpStatus, success, message);
            long nextUploadAt = System.currentTimeMillis() + currentIntervalMs();
            updateUploadStatus(false, success ? "Last upload OK" : message, httpStatus, success, timestamp, nextUploadAt);
            uploadInProgress = false;
            if (prefs.getBoolean(SharePrefs.KEY_ENABLED, false)) {
                uploadHandler.post(() -> scheduleNextUpload(currentIntervalMs()));
            }
        }
    }

    @SuppressWarnings("MissingPermission")
    private void uploadLatestLocation() {
        if (!prefs.getBoolean(SharePrefs.KEY_ENABLED, false)) return;
        if (uploadInProgress) {
            scheduleNextUpload(1000L);
            return;
        }

        Location location = lastKnownLocation;
        if (location != null) {
            sendLocation(new Location(location));
            return;
        }

        long intervalMs = currentIntervalMs();
        updateUploadStatus(false, "Waiting for location", -1, false, 0L, System.currentTimeMillis() + intervalMs);
        fusedLocation.getLastLocation()
            .addOnSuccessListener(lastLocation -> {
                if (lastLocation != null) {
                    handleLocation(lastLocation);
                    sendLocation(new Location(lastLocation));
                } else {
                    updateUploadStatus(false, "No location yet", -1, false, 0L, System.currentTimeMillis() + currentIntervalMs());
                    scheduleNextUpload(currentIntervalMs());
                }
            })
            .addOnFailureListener(error -> {
                updateUploadStatus(false, error.getClass().getSimpleName(), -1, false, 0L, System.currentTimeMillis() + currentIntervalMs());
                scheduleNextUpload(currentIntervalMs());
            });
    }

    private void sendLocation(Location location) {
        ensureDailyCounters();
        uploadInProgress = true;
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.notify(NOTIFICATION_ID, notification("Uploading - " + Math.round(distanceM) + "m / " + dailySteps + " steps"));
        updateUploadStatus(true, "Sending to server", -1, false, 0L, System.currentTimeMillis() + currentIntervalMs());
        executor.execute(() -> upload(location));
    }

    private void scheduleNextUpload(long delayMs) {
        uploadHandler.removeCallbacks(periodicUpload);
        uploadHandler.postDelayed(periodicUpload, Math.max(0L, delayMs));
    }

    private long currentIntervalMs() {
        return SharePrefs.safeRefreshMs(prefs.getLong(SharePrefs.KEY_REFRESH_MS, SharePrefs.DEFAULT_REFRESH_MS));
    }

    private String todayDate() {
        return new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
    }

    private void ensureDailyCounters() {
        String today = todayDate();
        String distanceDate = prefs.getString(SharePrefs.KEY_DISTANCE_DATE, "");
        String stepDate = prefs.getString(SharePrefs.KEY_STEP_DATE, "");
        SharedPreferences.Editor edit = null;

        if (!today.equals(distanceDate)) {
            distanceM = 0f;
            hasLast = false;
            edit = prefs.edit()
                .putString(SharePrefs.KEY_DISTANCE_DATE, today)
                .putFloat(SharePrefs.KEY_DISTANCE_M, distanceM);
        }

        if (!today.equals(stepDate)) {
            dailySteps = 0;
            if (edit == null) edit = prefs.edit();
            edit.putString(SharePrefs.KEY_STEP_DATE, today)
                .putInt(SharePrefs.KEY_STEP_BASE_TOTAL, -1)
                .putInt(SharePrefs.KEY_DAILY_STEPS, dailySteps);
        }

        if (edit != null) edit.apply();
    }

    @Override
    public void onSensorChanged(SensorEvent event) {
        if (event.sensor.getType() != Sensor.TYPE_STEP_COUNTER || event.values.length == 0) return;
        ensureDailyCounters();
        int totalSteps = Math.max(0, Math.round(event.values[0]));
        int baseSteps = prefs.getInt(SharePrefs.KEY_STEP_BASE_TOTAL, -1);
        if (baseSteps < 0 || totalSteps < baseSteps) {
            baseSteps = totalSteps;
        }
        dailySteps = Math.max(0, totalSteps - baseSteps);
        prefs.edit()
            .putInt(SharePrefs.KEY_STEP_BASE_TOTAL, baseSteps)
            .putInt(SharePrefs.KEY_STEP_LAST_TOTAL, totalSteps)
            .putInt(SharePrefs.KEY_DAILY_STEPS, dailySteps)
            .apply();
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) {
        // Step counter accuracy changes do not require UI or upload changes.
    }

    private void markServiceRunning(String message) {
        long now = System.currentTimeMillis();
        prefs.edit()
            .putBoolean(SharePrefs.KEY_SERVICE_RUNNING, true)
            .putBoolean(SharePrefs.KEY_UPLOAD_IN_PROGRESS, false)
            .putString(SharePrefs.KEY_LAST_UPLOAD_MESSAGE, message)
            .putLong(SharePrefs.KEY_NEXT_UPLOAD_AT, now + currentIntervalMs())
            .apply();
        notifyStatusChanged();
    }

    private void markServiceStopped(String message) {
        prefs.edit()
            .putBoolean(SharePrefs.KEY_SERVICE_RUNNING, false)
            .putBoolean(SharePrefs.KEY_UPLOAD_IN_PROGRESS, false)
            .putString(SharePrefs.KEY_LAST_UPLOAD_MESSAGE, message)
            .putLong(SharePrefs.KEY_NEXT_UPLOAD_AT, 0L)
            .apply();
        notifyStatusChanged();
    }

    private void updateUploadStatus(
        boolean inProgress,
        String message,
        int httpStatus,
        boolean success,
        long lastUploadAt,
        long nextUploadAt
    ) {
        SharedPreferences.Editor edit = prefs.edit()
            .putBoolean(SharePrefs.KEY_SERVICE_RUNNING, true)
            .putBoolean(SharePrefs.KEY_UPLOAD_IN_PROGRESS, inProgress)
            .putString(SharePrefs.KEY_LAST_UPLOAD_MESSAGE, message == null ? "" : message)
            .putLong(SharePrefs.KEY_NEXT_UPLOAD_AT, nextUploadAt);
        if (lastUploadAt > 0L) {
            edit.putLong(SharePrefs.KEY_LAST_UPLOAD_AT, lastUploadAt)
                .putBoolean(SharePrefs.KEY_LAST_UPLOAD_SUCCESS, success)
                .putInt(SharePrefs.KEY_LAST_UPLOAD_HTTP, httpStatus);
        }
        edit.apply();
        notifyStatusChanged();
    }

    private void notifyStatusChanged() {
        Intent intent = new Intent(UploadHistoryStore.ACTION_CHANGED);
        intent.setPackage(getPackageName());
        sendBroadcast(intent);
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
