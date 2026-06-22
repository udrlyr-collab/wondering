package com.wondering.location;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
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

import java.util.ArrayList;
import java.util.List;

public class MainActivity extends Activity {
    private SharedPreferences prefs;
    private Switch enabledSwitch;
    private EditText endpointInput;
    private EditText tokenInput;
    private TextView stateText;
    private RadioGroup intervalGroup;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = SharePrefs.get(this);
        requestNeededPermissions();
        setContentView(buildContent());
        refreshUi();
    }

    private View buildContent() {
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(20), dp(28), dp(20), dp(28));
        scroll.addView(root);

        TextView title = text("Wondering Location", 24, true);
        root.addView(title);
        root.addView(text("관리자용 위치 공유 앱", 14, false));
        root.addView(space(22));

        stateText = text("", 14, false);
        root.addView(stateText);
        root.addView(space(18));

        enabledSwitch = new Switch(this);
        enabledSwitch.setText("웹 위치 공유");
        enabledSwitch.setTextSize(17);
        enabledSwitch.setOnCheckedChangeListener(this::onEnabledChanged);
        root.addView(enabledSwitch);
        root.addView(space(16));

        endpointInput = input("서버 주소");
        root.addView(label("서버 주소"));
        root.addView(endpointInput);
        root.addView(space(14));

        tokenInput = input("공유 토큰");
        root.addView(label("공유 토큰"));
        root.addView(tokenInput);
        root.addView(space(18));

        root.addView(label("업로드 간격"));
        intervalGroup = new RadioGroup(this);
        intervalGroup.setOrientation(RadioGroup.HORIZONTAL);
        intervalGroup.addView(radio("15초", 15000));
        intervalGroup.addView(radio("60초", 60000));
        intervalGroup.addView(radio("5분", 300000));
        root.addView(intervalGroup);
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

        root.addView(space(18));
        TextView note = text("기본 업로드 간격은 60초입니다. 배터리 사용량을 줄이려면 60초 또는 5분을 사용하세요.", 13, false);
        root.addView(note);
        return scroll;
    }

    private void refreshUi() {
        enabledSwitch.setChecked(prefs.getBoolean(SharePrefs.KEY_ENABLED, false));
        endpointInput.setText(prefs.getString(SharePrefs.KEY_ENDPOINT, SharePrefs.DEFAULT_ENDPOINT));
        tokenInput.setText(prefs.getString(SharePrefs.KEY_TOKEN, ""));
        long refreshMs = prefs.getLong(SharePrefs.KEY_REFRESH_MS, SharePrefs.DEFAULT_REFRESH_MS);
        intervalGroup.check((int) refreshMs);
        stateText.setText(enabledSwitch.isChecked() ? "공유 상태: 켜짐" : "공유 상태: 꺼짐");
    }

    private void saveSettings(boolean toast) {
        long refreshMs = intervalGroup.getCheckedRadioButtonId();
        if (refreshMs <= 0) refreshMs = SharePrefs.DEFAULT_REFRESH_MS;
        prefs.edit()
            .putString(SharePrefs.KEY_ENDPOINT, endpointInput.getText().toString().trim())
            .putString(SharePrefs.KEY_TOKEN, tokenInput.getText().toString().trim())
            .putLong(SharePrefs.KEY_REFRESH_MS, SharePrefs.safeRefreshMs(refreshMs))
            .apply();
        restartIfEnabled();
        if (toast) Toast.makeText(this, "저장했습니다", Toast.LENGTH_SHORT).show();
    }

    private void onEnabledChanged(CompoundButton button, boolean checked) {
        if (button.isPressed()) setSharing(checked);
    }

    private void setSharing(boolean enabled) {
        prefs.edit().putBoolean(SharePrefs.KEY_ENABLED, enabled).apply();
        if (enabled) startTrackingService();
        else stopService(new Intent(this, LocationShareService.class));
        refreshUi();
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
        radio.setGravity(Gravity.CENTER);
        radio.setPadding(0, 0, dp(18), 0);
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
