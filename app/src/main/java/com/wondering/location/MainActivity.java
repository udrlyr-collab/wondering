package com.wondering.location;

import android.Manifest;
import android.app.Activity;
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
import android.widget.Button;
import android.widget.CompoundButton;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.RadioButton;
import android.widget.RadioGroup;
import android.widget.ScrollView;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;

public class MainActivity extends Activity {
    private static final int CUSTOM_INTERVAL_ID = 900001;

    private SharedPreferences prefs;
    private Switch enabledSwitch;
    private EditText endpointInput;
    private EditText tokenInput;
    private EditText customIntervalInput;
    private TextView stateText;
    private TextView uploadStatusText;
    private TextView uploadHistoryText;
    private RadioGroup intervalGroup;
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
            updateUploadHistory();
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = SharePrefs.get(this);
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
        updateUploadHistory();
        statusHandler.removeCallbacks(statusTicker);
        statusHandler.post(statusTicker);
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
        updateUploadHistory();
    }

    private View buildContent() {
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(20), dp(28), dp(20), dp(28));
        scroll.addView(root);

        root.addView(text("Wondering Location", 24, true));
        root.addView(text("관리자용 위치 공유 앱", 14, false));
        root.addView(space(22));

        stateText = text("", 14, false);
        root.addView(stateText);
        uploadStatusText = text("", 14, false);
        uploadStatusText.setPadding(0, dp(8), 0, dp(8));
        root.addView(uploadStatusText);
        root.addView(space(18));

        enabledSwitch = new Switch(this);
        enabledSwitch.setText("웹 위치 공유");
        enabledSwitch.setTextSize(17);
        enabledSwitch.setOnCheckedChangeListener(this::onEnabledChanged);
        root.addView(enabledSwitch);
        root.addView(space(16));

        endpointInput = input("https://wondering.kr");
        root.addView(label("서버 주소"));
        root.addView(endpointInput);
        root.addView(space(14));

        tokenInput = input("업로드 토큰");
        root.addView(label("업로드 토큰"));
        root.addView(tokenInput);
        root.addView(space(18));

        root.addView(label("업로드 간격"));
        intervalGroup = new RadioGroup(this);
        intervalGroup.setOrientation(RadioGroup.VERTICAL);
        intervalGroup.addView(radio("5초", 5000));
        intervalGroup.addView(radio("10초", 10000));
        intervalGroup.addView(radio("15초", 15000));
        intervalGroup.addView(radio("60초", 60000));
        intervalGroup.addView(radio("5분", 300000));
        intervalGroup.addView(radio("Custom", CUSTOM_INTERVAL_ID));
        intervalGroup.setOnCheckedChangeListener((group, checkedId) -> updateCustomIntervalState());
        root.addView(intervalGroup);

        customIntervalInput = input("커스텀 초 단위, 예: 30");
        customIntervalInput.setInputType(InputType.TYPE_CLASS_NUMBER);
        customIntervalInput.setOnFocusChangeListener((view, hasFocus) -> {
            if (hasFocus) intervalGroup.check(CUSTOM_INTERVAL_ID);
        });
        customIntervalInput.setOnClickListener(view -> intervalGroup.check(CUSTOM_INTERVAL_ID));
        root.addView(customIntervalInput);
        root.addView(space(22));

        Button save = button("설정 저장");
        save.setOnClickListener(v -> saveSettings(true));
        root.addView(save);

        Button start = button("서비스 시작");
        start.setOnClickListener(v -> {
            saveSettings(false);
            setSharing(true);
        });
        root.addView(start);

        Button stop = button("서비스 중지");
        stop.setOnClickListener(v -> setSharing(false));
        root.addView(stop);

        root.addView(space(14));
        root.addView(text("Upload history", 18, true));
        uploadHistoryText = text("", 13, false);
        uploadHistoryText.setPadding(0, dp(8), 0, dp(8));
        root.addView(uploadHistoryText);

        root.addView(space(18));
        root.addView(text("기본 업로드 간격은 60초입니다. 5초/10초는 더 빠르게 반영되지만 배터리 사용량이 늘 수 있습니다.", 13, false));
        return scroll;
    }

    private void refreshUi() {
        enabledSwitch.setChecked(prefs.getBoolean(SharePrefs.KEY_ENABLED, false));
        endpointInput.setText(prefs.getString(SharePrefs.KEY_ENDPOINT, SharePrefs.DEFAULT_ENDPOINT));
        tokenInput.setText(prefs.getString(SharePrefs.KEY_TOKEN, ""));
        long refreshMs = SharePrefs.safeRefreshMs(
            prefs.getLong(SharePrefs.KEY_REFRESH_MS, SharePrefs.DEFAULT_REFRESH_MS)
        );

        if (isPresetRefreshMs(refreshMs)) {
            intervalGroup.check((int) refreshMs);
            customIntervalInput.setText("");
        } else {
            intervalGroup.check(CUSTOM_INTERVAL_ID);
            customIntervalInput.setText(String.valueOf(refreshMs / 1000));
        }
        updateCustomIntervalState();
        updateUploadStatus();
        stateText.setText(enabledSwitch.isChecked() ? "공유 상태: 켜짐" : "공유 상태: 꺼짐");
    }

    private void updateUploadHistory() {
        if (uploadHistoryText == null || prefs == null) return;
        uploadHistoryText.setText(UploadHistoryStore.formattedHistory(this));
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

        StringBuilder builder = new StringBuilder();
        builder.append("Service: ");
        if (!enabled) builder.append("off");
        else builder.append(running ? "running" : "starting");

        builder.append("\nSending: ").append(sending ? "yes" : "no");

        builder.append("\nNext upload: ");
        if (!enabled) {
            builder.append("-");
        } else if (sending) {
            builder.append("now");
        } else if (nextUploadAt > 0L) {
            builder.append("in ").append(formatDuration(Math.max(0L, nextUploadAt - System.currentTimeMillis())));
        } else {
            builder.append("waiting for location");
        }

        builder.append("\nLast upload: ");
        if (lastUploadAt > 0L) {
            builder.append(formatTime(lastUploadAt))
                .append(lastSuccess ? " OK" : " FAIL");
            if (lastHttp > 0) builder.append(" HTTP ").append(lastHttp);
        } else {
            builder.append("-");
        }

        if (message != null && !message.trim().isEmpty()) {
            builder.append("\nStatus: ").append(message.trim());
        }

        uploadStatusText.setText(builder.toString());
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
            .putString(SharePrefs.KEY_ENDPOINT, endpointInput.getText().toString().trim())
            .putString(SharePrefs.KEY_TOKEN, tokenInput.getText().toString().trim())
            .putLong(SharePrefs.KEY_REFRESH_MS, refreshMs)
            .apply();
        restartIfEnabled();
        updateUploadStatus();
        if (toast) Toast.makeText(this, "저장했습니다", Toast.LENGTH_SHORT).show();
    }

    private long selectedRefreshMs() {
        int checkedId = intervalGroup.getCheckedRadioButtonId();
        if (checkedId == CUSTOM_INTERVAL_ID) {
            String rawSeconds = customIntervalInput.getText().toString().trim();
            try {
                long seconds = Long.parseLong(rawSeconds);
                return SharePrefs.safeRefreshMs(seconds * 1000L);
            } catch (NumberFormatException ignored) {
                return SharePrefs.DEFAULT_REFRESH_MS;
            }
        }
        if (checkedId > 0) return SharePrefs.safeRefreshMs(checkedId);
        return SharePrefs.DEFAULT_REFRESH_MS;
    }

    private boolean isPresetRefreshMs(long refreshMs) {
        return refreshMs == 5000L
            || refreshMs == 10000L
            || refreshMs == 15000L
            || refreshMs == 60000L
            || refreshMs == 300000L;
    }

    private void updateCustomIntervalState() {
        if (customIntervalInput == null || intervalGroup == null) return;
        boolean custom = intervalGroup.getCheckedRadioButtonId() == CUSTOM_INTERVAL_ID;
        customIntervalInput.setEnabled(custom);
        customIntervalInput.setAlpha(custom ? 1f : 0.45f);
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
        if (!missing.isEmpty()) requestPermissions(missing.toArray(new String[0]), 10);
    }

    private void addMissing(List<String> missing, String permission) {
        if (checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED) {
            missing.add(permission);
        }
    }

    private TextView label(String value) {
        TextView view = text(value, 13, false);
        view.setPadding(0, 0, 0, dp(6));
        return view;
    }

    private EditText input(String hint) {
        EditText editText = new EditText(this);
        editText.setSingleLine(true);
        editText.setHint(hint);
        editText.setTextSize(15);
        editText.setPadding(dp(12), 0, dp(12), 0);
        return editText;
    }

    private RadioButton radio(String label, int id) {
        RadioButton radio = new RadioButton(this);
        radio.setText(label);
        radio.setId(id);
        radio.setTextSize(15);
        radio.setGravity(Gravity.CENTER_VERTICAL);
        radio.setPadding(0, dp(3), 0, dp(3));
        return radio;
    }

    private Button button(String label) {
        Button button = new Button(this);
        button.setText(label);
        button.setAllCaps(false);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        );
        lp.setMargins(0, 0, 0, dp(10));
        button.setLayoutParams(lp);
        return button;
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
