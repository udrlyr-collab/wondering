package com.wondering.location;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.widget.AdapterView;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.CompoundButton;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Spinner;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;

public class MainActivity extends Activity {
    private static final int CUSTOM_INTERVAL_POSITION = 5;
    private static final String[] INTERVAL_LABELS = {
        "5 sec",
        "10 sec",
        "15 sec",
        "60 sec",
        "5 min",
        "Custom"
    };
    private static final long[] INTERVAL_VALUES = {
        5000L,
        10000L,
        15000L,
        60000L,
        300000L
    };

    private SharedPreferences prefs;
    private Switch enabledSwitch;
    private EditText tokenInput;
    private EditText customIntervalInput;
    private TextView stateText;
    private TextView uploadStatusText;
    private Spinner intervalSpinner;
    private boolean historyReceiverRegistered;
    private final Handler statusHandler = new Handler(Looper.getMainLooper());
    private final Runnable statusTicker = new Runnable() {
        @Override
        public void run() {
            updateUploadStatus();
            statusHandler.postDelayed(this, 1000L);
        }
    };
    private final BroadcastReceiver uploadHistoryReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            updateUploadStatus();
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = SharePrefs.get(this);
        prefs.edit().putString(SharePrefs.KEY_ENDPOINT, SharePrefs.DEFAULT_ENDPOINT).apply();
        requestNeededPermissions();
        setContentView(buildContent());
        refreshUi();
    }

    @Override
    protected void onStart() {
        super.onStart();
        if (!historyReceiverRegistered) {
            IntentFilter filter = new IntentFilter(UploadHistoryStore.ACTION_CHANGED);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                registerReceiver(uploadHistoryReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
            } else {
                registerReceiver(uploadHistoryReceiver, filter);
            }
            historyReceiverRegistered = true;
        }
        statusHandler.removeCallbacks(statusTicker);
        statusHandler.post(statusTicker);
        if (prefs.getBoolean(SharePrefs.KEY_ENABLED, false)) {
            startTrackingService();
        }
    }

    @Override
    protected void onStop() {
        if (historyReceiverRegistered) {
            unregisterReceiver(uploadHistoryReceiver);
            historyReceiverRegistered = false;
        }
        statusHandler.removeCallbacks(statusTicker);
        super.onStop();
    }

    @Override
    protected void onResume() {
        super.onResume();
        updateUploadStatus();
    }

    private View buildContent() {
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(18), dp(36), dp(18), dp(20));
        scroll.addView(root);

        TextView title = text("Wondering Location", 23, true);
        root.addView(title);
        root.addView(text("Admin GPS uploader", 13, false));
        root.addView(space(14));

        stateText = text("", 14, true);
        root.addView(stateText);

        uploadStatusText = text("", 13, false);
        uploadStatusText.setPadding(0, dp(8), 0, dp(8));
        root.addView(uploadStatusText);
        root.addView(space(10));

        enabledSwitch = new Switch(this);
        enabledSwitch.setText("Location sharing");
        enabledSwitch.setTextSize(16);
        enabledSwitch.setOnCheckedChangeListener(this::onEnabledChanged);
        root.addView(enabledSwitch);
        root.addView(space(12));

        root.addView(label("Upload token"));
        tokenInput = input("Token from admin.wondering.kr");
        tokenInput.setSelectAllOnFocus(true);
        tokenInput.setOnClickListener(view -> tokenInput.selectAll());
        root.addView(tokenInput);
        root.addView(space(10));

        root.addView(label("Upload interval"));
        intervalSpinner = new Spinner(this);
        ArrayAdapter<String> adapter = new ArrayAdapter<>(
            this,
            android.R.layout.simple_spinner_item,
            INTERVAL_LABELS
        );
        adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
        intervalSpinner.setAdapter(adapter);
        intervalSpinner.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            @Override
            public void onItemSelected(AdapterView<?> parent, View view, int position, long id) {
                updateCustomIntervalState();
            }

            @Override
            public void onNothingSelected(AdapterView<?> parent) {
                updateCustomIntervalState();
            }
        });
        root.addView(intervalSpinner);

        customIntervalInput = input("Custom seconds");
        customIntervalInput.setInputType(InputType.TYPE_CLASS_NUMBER);
        customIntervalInput.setOnFocusChangeListener((view, hasFocus) -> {
            if (hasFocus) intervalSpinner.setSelection(CUSTOM_INTERVAL_POSITION);
        });
        customIntervalInput.setOnClickListener(view -> intervalSpinner.setSelection(CUSTOM_INTERVAL_POSITION));
        root.addView(customIntervalInput);
        root.addView(space(12));

        Button save = button("Save settings");
        save.setOnClickListener(v -> saveSettings(true));
        root.addView(save);

        LinearLayout serviceRow = row();
        Button start = button("Start");
        start.setOnClickListener(v -> {
            saveSettings(false);
            setSharing(true);
        });
        Button stop = button("Stop");
        stop.setOnClickListener(v -> setSharing(false));
        serviceRow.addView(start, weightedButtonParams(6));
        serviceRow.addView(spaceHorizontal(8));
        serviceRow.addView(stop, weightedButtonParams(6));
        root.addView(serviceRow);

        Button history = button("Upload history");
        history.setOnClickListener(v -> showUploadHistoryDialog());
        root.addView(history);

        root.addView(space(8));
        root.addView(text("60 sec is the balanced default. Short intervals update faster and use more battery.", 12, false));
        return scroll;
    }

    private void refreshUi() {
        enabledSwitch.setChecked(prefs.getBoolean(SharePrefs.KEY_ENABLED, false));
        tokenInput.setText(prefs.getString(SharePrefs.KEY_TOKEN, ""));
        long refreshMs = SharePrefs.safeRefreshMs(
            prefs.getLong(SharePrefs.KEY_REFRESH_MS, SharePrefs.DEFAULT_REFRESH_MS)
        );

        int position = intervalPosition(refreshMs);
        intervalSpinner.setSelection(position);
        if (position == CUSTOM_INTERVAL_POSITION) {
            customIntervalInput.setText(String.valueOf(refreshMs / 1000L));
        } else {
            customIntervalInput.setText("");
        }
        updateCustomIntervalState();
        updateUploadStatus();
        stateText.setText(enabledSwitch.isChecked() ? "Sharing ON" : "Sharing OFF");
    }

    private void updateUploadStatus() {
        if (uploadStatusText == null || prefs == null) return;

        boolean enabled = prefs.getBoolean(SharePrefs.KEY_ENABLED, false);
        boolean running = prefs.getBoolean(SharePrefs.KEY_SERVICE_RUNNING, false);
        boolean sending = prefs.getBoolean(SharePrefs.KEY_UPLOAD_IN_PROGRESS, false);
        long lastUploadAt = prefs.getLong(SharePrefs.KEY_LAST_UPLOAD_AT, 0L);
        long nextUploadAt = prefs.getLong(SharePrefs.KEY_NEXT_UPLOAD_AT, 0L);
        boolean lastSuccess = prefs.getBoolean(SharePrefs.KEY_LAST_UPLOAD_SUCCESS, false);
        int lastHttp = prefs.getInt(SharePrefs.KEY_LAST_UPLOAD_HTTP, -1);
        String message = prefs.getString(SharePrefs.KEY_LAST_UPLOAD_MESSAGE, "");
        float dailyDistanceM = prefs.getFloat(SharePrefs.KEY_DISTANCE_M, 0f);
        int dailySteps = prefs.getInt(SharePrefs.KEY_DAILY_STEPS, 0);

        StringBuilder builder = new StringBuilder();
        builder.append("Service: ");
        if (!enabled) builder.append("off");
        else builder.append(running ? "running" : "starting");

        builder.append("  |  Sending: ").append(sending ? "yes" : "no");

        builder.append("\nToday: ")
            .append(Math.round(dailyDistanceM))
            .append("m / ")
            .append(dailySteps)
            .append(" steps");

        builder.append("\nNext: ");
        if (!enabled) {
            builder.append("-");
        } else if (sending) {
            builder.append("now");
        } else if (nextUploadAt > 0L) {
            builder.append(formatDuration(Math.max(0L, nextUploadAt - System.currentTimeMillis())));
        } else {
            builder.append("waiting");
        }

        builder.append("  |  Last: ");
        if (lastUploadAt > 0L) {
            builder.append(formatTime(lastUploadAt))
                .append(lastSuccess ? " OK" : " FAIL");
            if (lastHttp > 0) builder.append(" ").append(lastHttp);
        } else {
            builder.append("-");
        }

        if (message != null && !message.trim().isEmpty()) {
            builder.append("\n").append(message.trim());
        }

        uploadStatusText.setText(builder.toString());
    }

    private void showUploadHistoryDialog() {
        ScrollView scroll = new ScrollView(this);
        TextView history = text(UploadHistoryStore.formattedHistory(this), 13, false);
        history.setPadding(dp(16), dp(12), dp(16), dp(12));
        scroll.addView(history);

        new AlertDialog.Builder(this)
            .setTitle("Upload history")
            .setView(scroll)
            .setPositiveButton("Close", null)
            .show();
    }

    private String formatDuration(long durationMs) {
        long totalSeconds = Math.max(0L, durationMs / 1000L);
        long minutes = totalSeconds / 60L;
        long seconds = totalSeconds % 60L;
        if (minutes > 0L) return minutes + "m " + String.format(Locale.US, "%02ds", seconds);
        return seconds + "s";
    }

    private String formatTime(long timestamp) {
        return new SimpleDateFormat("HH:mm:ss", Locale.US).format(new Date(timestamp));
    }

    private void saveSettings(boolean toast) {
        long refreshMs = selectedRefreshMs();
        prefs.edit()
            .putString(SharePrefs.KEY_ENDPOINT, SharePrefs.DEFAULT_ENDPOINT)
            .putString(SharePrefs.KEY_TOKEN, tokenInput.getText().toString().trim())
            .putLong(SharePrefs.KEY_REFRESH_MS, refreshMs)
            .apply();
        restartIfEnabled();
        updateUploadStatus();
        if (toast) Toast.makeText(this, "Saved", Toast.LENGTH_SHORT).show();
    }

    private long selectedRefreshMs() {
        int position = intervalSpinner.getSelectedItemPosition();
        if (position == CUSTOM_INTERVAL_POSITION) {
            String rawSeconds = customIntervalInput.getText().toString().trim();
            try {
                long seconds = Long.parseLong(rawSeconds);
                return SharePrefs.safeRefreshMs(seconds * 1000L);
            } catch (NumberFormatException ignored) {
                return SharePrefs.DEFAULT_REFRESH_MS;
            }
        }
        if (position >= 0 && position < INTERVAL_VALUES.length) {
            return SharePrefs.safeRefreshMs(INTERVAL_VALUES[position]);
        }
        return SharePrefs.DEFAULT_REFRESH_MS;
    }

    private int intervalPosition(long refreshMs) {
        for (int i = 0; i < INTERVAL_VALUES.length; i += 1) {
            if (INTERVAL_VALUES[i] == refreshMs) return i;
        }
        return CUSTOM_INTERVAL_POSITION;
    }

    private void updateCustomIntervalState() {
        if (customIntervalInput == null || intervalSpinner == null) return;
        boolean custom = intervalSpinner.getSelectedItemPosition() == CUSTOM_INTERVAL_POSITION;
        customIntervalInput.setVisibility(custom ? View.VISIBLE : View.GONE);
        customIntervalInput.setEnabled(custom);
    }

    private void onEnabledChanged(CompoundButton button, boolean checked) {
        if (button.isPressed()) setSharing(checked);
    }

    private void setSharing(boolean enabled) {
        prefs.edit().putBoolean(SharePrefs.KEY_ENABLED, enabled).apply();
        if (enabled) startTrackingService();
        else stopService(new Intent(this, LocationShareService.class));
        refreshUi();
        updateUploadStatus();
    }

    private void restartIfEnabled() {
        if (!prefs.getBoolean(SharePrefs.KEY_ENABLED, false)) return;
        stopService(new Intent(this, LocationShareService.class));
        startTrackingService();
    }

    private void startTrackingService() {
        Intent intent = new Intent(this, LocationShareService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(intent);
        else startService(intent);
    }

    private void requestNeededPermissions() {
        List<String> missing = new ArrayList<>();
        addMissing(missing, Manifest.permission.ACCESS_FINE_LOCATION);
        addMissing(missing, Manifest.permission.ACCESS_COARSE_LOCATION);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            addMissing(missing, Manifest.permission.POST_NOTIFICATIONS);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            addMissing(missing, Manifest.permission.ACTIVITY_RECOGNITION);
        }
        if (!missing.isEmpty()) requestPermissions(missing.toArray(new String[0]), 10);
    }

    private void addMissing(List<String> missing, String permission) {
        if (checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED) {
            missing.add(permission);
        }
    }

    private TextView label(String value) {
        TextView view = text(value, 12, true);
        view.setPadding(0, 0, 0, dp(4));
        return view;
    }

    private EditText input(String hint) {
        EditText editText = new EditText(this);
        editText.setSingleLine(true);
        editText.setHint(hint);
        editText.setTextSize(14);
        editText.setPadding(dp(10), 0, dp(10), 0);
        return editText;
    }

    private Button button(String label) {
        Button button = new Button(this);
        button.setText(label);
        button.setAllCaps(false);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        );
        lp.setMargins(0, 0, 0, dp(8));
        button.setLayoutParams(lp);
        return button;
    }

    private LinearLayout row() {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        return row;
    }

    private LinearLayout.LayoutParams weightedButtonParams(int weight) {
        return new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, weight);
    }

    private View spaceHorizontal(int dp) {
        View view = new View(this);
        view.setLayoutParams(new LinearLayout.LayoutParams(dp(dp), 1));
        return view;
    }

    private TextView text(String value, int sp, boolean bold) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(sp);
        if (bold) view.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        return view;
    }

    private View space(int dp) {
        View view = new View(this);
        view.setLayoutParams(new LinearLayout.LayoutParams(1, dp(dp)));
        return view;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
