const statusEl = document.querySelector("#status");
const signalDotEl = document.querySelector("#signalDot");
const lastSeenEl = document.querySelector("#lastSeen");
const coordsEl = document.querySelector("#coords");
const distanceEl = document.querySelector("#distance");
const modeLabelEl = document.querySelector("#modeLabel");
const locationStateDotEl = document.querySelector("#locationStateDot");
const adminPanelEl = document.querySelector("#adminPanel");
const pinLockEl = document.querySelector("#pinLock");
const pinFormEl = document.querySelector("#pinForm");
const pinInput = document.querySelector("#pinInput");
const pinFeedbackEl = document.querySelector("#pinFeedback");
const dateInput = document.querySelector("#dateInput");
const routeDateInput = document.querySelector("#routeDateInput");
const selectedDateLabelEl = document.querySelector("#selectedDateLabel");
const pollSelect = document.querySelector("#pollSelect");
const publicPollSelect = document.querySelector("#publicPollSelect");
const publicMaxRecordsInput = document.querySelector("#publicMaxRecordsInput");
const publicInvalidInput = document.querySelector("#publicInvalidInput");
const newTokenInput = document.querySelector("#newTokenInput");
const copyTokenButton = document.querySelector("#copyTokenButton");
const adminFeedbackEl = document.querySelector("#adminFeedback");
const mapInstructionEl = document.querySelector("#mapInstruction");
const mapSubStatusEl = document.querySelector("#mapSubStatus");
const mapEl = document.querySelector("#map");
const locateCurrentButton = document.querySelector("#locateCurrentButton");
const uploadHistoryListEl = document.querySelector("#uploadHistoryList");
const refreshUploadHistoryButton = document.querySelector("#refreshUploadHistoryButton");

const MAX_RECORDS = 1500;
const MAX_INVALID_MARKERS = 200;
const MAX_CONNECTED_GAP_M = 2000;
const INTERPOLATION_STEP_M = 80;
const ROUTE_TOLERANCE_PX = 3;
const MARKER_ANIMATION_MS = 650;
const VIEWER_HEARTBEAT_MS = 15000;
const CURRENT_LOCATION_ZOOM = 17.7;
const CURRENT_LOCATION_MAX_ZOOM = 18.3;
const DEFAULT_CAMERA = {
  center: [126.978, 37.5665],
  zoom: 16.2,
  pitch: 62,
  bearing: -28,
};
const DEFAULT_SETTINGS = {
  publicPollMs: 10000,
  publicMaxRecords: 1500,
  publicShowInvalidPoints: true,
};
const hostname = window.location.hostname.toLowerCase();
const isLocalHost = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
const isAdminMode =
  hostname.startsWith("admin.") || (isLocalHost && new URLSearchParams(window.location.search).get("admin") === "1");
const adminSessionStorageKey = "wonderingAdminSession";
const MAP_COLORS = {
  paper: "#EAEBE6",
  paperDeep: "#D9E0DC",
  park: "#CFDCDA",
  woodland: "#C6D4CF",
  residential: "#F2E9DA",
  aeroway: "#E6DDD0",
  water: "#B4E4EA",
  waterLine: "#8ACBD3",
  road: "#FAFBF6",
  roadCasing: "#C9D2CF",
  roadMajor: "#FCD2A4",
  roadMajorCasing: "#E9BE8E",
  roadMotorway: "#FCD2A4",
  roadMotorwayCasing: "#E9BE8E",
  rail: "#B7C7C6",
  transit: "#9EB7BA",
  buildingShadow: "#C0CCC8",
  buildingFill: "#F9FCF2",
  buildingSide: "#DCE2DA",
  buildingTall: "#C9D2CF",
  label: "#4A4F52",
  mutedLabel: "#7E8986",
  route: "#101010",
  routeHalo: "#ffffff",
  routeAccent: "#0877ff",
  locationDisabled: "#8C928E",
  locationDisabledLine: "#757D78",
  invalid: "#7B8581",
};

let pollTimer = null;
let marker = null;
let markerAnimation = null;
let latestTrackedLngLat = null;
let mapReady = false;
let hasInitialLocationFocus = false;
let selectedRouteDate = "";
let appSettings = { ...DEFAULT_SETTINGS };
let viewerTotalViewMs = 0;
let viewerPendingViewMs = 0;
let viewerLastViewTickAt = Date.now();
let viewerLastHeartbeatAt = Date.now();
let viewerTickTimer = null;
let resizeTimer = null;

const emptyFeatureCollection = { type: "FeatureCollection", features: [] };
const transparentIcon = {
  width: 1,
  height: 1,
  data: new Uint8Array([0, 0, 0, 0]),
};

const map = new maplibregl.Map({
  container: "map",
  style: "https://tiles.openfreemap.org/styles/positron",
  center: DEFAULT_CAMERA.center,
  zoom: DEFAULT_CAMERA.zoom,
  pitch: DEFAULT_CAMERA.pitch,
  bearing: DEFAULT_CAMERA.bearing,
  antialias: true,
  attributionControl: true,
});

map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");
map.dragRotate.enable();
map.touchZoomRotate.enableRotation();
document.body.classList.toggle("is-admin", isAdminMode);
document.body.classList.toggle("is-viewer", !isAdminMode);
if (modeLabelEl) modeLabelEl.textContent = isAdminMode ? "Admin" : "Viewing Time";
setAdminUnlocked(false);
if (!isAdminMode) startViewerStats();
syncRouteDate(routeDateInput?.value || dateInput?.value || todayDateValue());

pinFormEl?.addEventListener("submit", loginAdmin);
document.querySelector("#lockAdminButton")?.addEventListener("click", lockAdmin);
document.querySelector("#saveSettingsButton")?.addEventListener("click", saveAdminSettings);
copyTokenButton?.addEventListener("click", copyUploadToken);
document.querySelector("#generateTokenButton")?.addEventListener("click", generateUploadToken);
document.querySelector("#rotateTokenButton")?.addEventListener("click", rotateUploadToken);
locateCurrentButton?.addEventListener("click", focusTrackedLocation);
refreshUploadHistoryButton?.addEventListener("click", loadUploadHistory);

routeDateInput?.addEventListener("change", () => changeRouteDate(routeDateInput.value));
dateInput?.addEventListener("change", () => changeRouteDate(dateInput.value));
pollSelect?.addEventListener("change", resetPolling);
map.on("zoomend", () => loadLocations({ keepViewport: true }));
map.on("pitchend", updateMapDiagnostics);
map.on("rotateend", updateMapDiagnostics);
map.on("idle", updateMapDiagnostics);
map.on("style.load", initializeMap);
map.on("load", initializeMap);
window.addEventListener("resize", scheduleMapResize);
map.on("styleimagemissing", (event) => {
  if (!map.hasImage(event.id)) map.addImage(event.id, transparentIcon);
});
map.on("error", (event) => {
  if (mapEl) mapEl.dataset.mapError = event.error?.message || "map error";
});
loadSettings();
verifyAdminSession();

function headers() {
  if (!isAdminMode) return {};
  const token = sessionStorage.getItem(adminSessionStorageKey) || "";
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function setAdminUnlocked(unlocked) {
  if (adminPanelEl) adminPanelEl.hidden = !isAdminMode || !unlocked;
  if (pinLockEl) pinLockEl.hidden = !isAdminMode || unlocked;
  document.body.classList.toggle("admin-unlocked", Boolean(isAdminMode && unlocked));
  document.body.classList.toggle("admin-locked", Boolean(isAdminMode && !unlocked));
  if (unlocked) {
    pinFormEl?.classList.remove("pin-error");
    pinInput?.blur();
  } else if (isAdminMode) {
    setTimeout(() => pinInput?.focus(), 50);
  }
  scheduleMapResize();
}

function scheduleMapResize() {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    resizeMapNow();
  }, 80);
}

function resizeMapNow() {
  if (!map) return;
  map.resize();
  updateMapDiagnostics();
}

function resetCameraPadding() {
  if (typeof map.setPadding !== "function") return;
  map.setPadding({ top: 0, right: 0, bottom: 0, left: 0 });
}

function todayDateValue() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeDateValue(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function formatRouteDate(value) {
  const normalized = normalizeDateValue(value);
  if (!normalized) return "All Dates";
  const [year, month, day] = normalized.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).format(date);
}

function syncRouteDate(value) {
  selectedRouteDate = normalizeDateValue(value) || todayDateValue();
  if (routeDateInput) routeDateInput.value = selectedRouteDate;
  if (dateInput) dateInput.value = selectedRouteDate;
  if (selectedDateLabelEl) selectedDateLabelEl.textContent = formatRouteDate(selectedRouteDate);
}

function changeRouteDate(value) {
  syncRouteDate(value);
  hasInitialLocationFocus = false;
  loadLocations();
}

function isSelectedRouteToday() {
  return selectedRouteDate === todayDateValue();
}

function adminMessage(message) {
  if (!adminFeedbackEl) return;
  adminFeedbackEl.textContent = message;
}

function pinMessage(message, tone = "") {
  if (!pinFeedbackEl) return;
  pinFeedbackEl.textContent = message;
  pinFeedbackEl.classList.toggle("is-error", tone === "error");
  pinFeedbackEl.classList.toggle("is-success", tone === "success");
  if (tone === "error") {
    pinFormEl?.classList.remove("pin-error");
    window.setTimeout(() => pinFormEl?.classList.add("pin-error"), 0);
  } else {
    pinFormEl?.classList.remove("pin-error");
  }
}

function applySettingsToForm() {
  if (publicPollSelect) publicPollSelect.value = String(appSettings.publicPollMs);
  if (publicMaxRecordsInput) publicMaxRecordsInput.value = String(appSettings.publicMaxRecords);
  if (publicInvalidInput) publicInvalidInput.checked = Boolean(appSettings.publicShowInvalidPoints);
}

function applyUploadToken(token) {
  if (newTokenInput) newTokenInput.value = token || "";
  if (copyTokenButton) copyTokenButton.disabled = !token;
}

function applyAdminData(data) {
  appSettings = normalizeSettings(data.settings);
  applySettingsToForm();
  applyUploadToken(typeof data.uploadToken === "string" ? data.uploadToken : "");
}

function selectedLimit() {
  if (isAdminMode) return MAX_RECORDS;
  return Math.min(MAX_RECORDS, Number(appSettings.publicMaxRecords) || DEFAULT_SETTINGS.publicMaxRecords);
}

function shouldShowInvalidPoints() {
  return isAdminMode || Boolean(appSettings.publicShowInvalidPoints);
}

function normalizeSettings(input = {}) {
  const publicPollMs = Number(input.publicPollMs);
  const publicMaxRecords = Number(input.publicMaxRecords);
  return {
    publicPollMs: [5000, 10000, 30000].includes(publicPollMs) ? publicPollMs : DEFAULT_SETTINGS.publicPollMs,
    publicMaxRecords: Number.isFinite(publicMaxRecords)
      ? Math.max(100, Math.min(1500, Math.round(publicMaxRecords)))
      : DEFAULT_SETTINGS.publicMaxRecords,
    publicShowInvalidPoints:
      typeof input.publicShowInvalidPoints === "boolean"
        ? input.publicShowInvalidPoints
        : DEFAULT_SETTINGS.publicShowInvalidPoints,
  };
}

async function loadSettings() {
  try {
    const res = await fetch("/api/settings");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    appSettings = normalizeSettings(data.settings);
    applySettingsToForm();
    resetPolling();
  } catch {
    appSettings = { ...DEFAULT_SETTINGS };
    applySettingsToForm();
  }
}

async function verifyAdminSession() {
  if (!isAdminMode) return;
  const token = sessionStorage.getItem(adminSessionStorageKey) || "";
  if (!token) {
    setAdminUnlocked(false);
    pinMessage("Enter password.");
    return;
  }

  try {
    const res = await fetch("/api/admin/session", { headers: headers() });
    if (res.status === 401) {
      lockAdmin("Password session expired.");
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    applyAdminData(data);
    setAdminUnlocked(true);
    adminMessage("Admin unlocked.");
    loadUploadHistory();
  } catch {
    lockAdmin("Password verification failed.");
  }
}

async function loginAdmin(event) {
  event?.preventDefault();
  if (!isAdminMode) return;
  const pin = (pinInput?.value || "").trim();
  if (!pin) {
    pinMessage("Enter password.", "error");
    return;
  }

  try {
    pinMessage("Checking password...");
    const res = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin }),
    });
    if (res.status === 401) {
      pinMessage("Incorrect password. Try again.", "error");
      return;
    }
    if (res.status === 429) {
      pinMessage("Too many password attempts. Try again later.", "error");
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    sessionStorage.setItem(adminSessionStorageKey, data.sessionToken);
    if (pinInput) pinInput.value = "";
    applyAdminData(data);
    setAdminUnlocked(true);
    adminMessage("Admin unlocked.");
    loadLocations({ keepViewport: true });
    loadUploadHistory();
  } catch {
    pinMessage("Password login request failed.", "error");
  }
}

function lockAdmin(message = "Admin locked.") {
  if (!isAdminMode) return;
  sessionStorage.removeItem(adminSessionStorageKey);
  setAdminUnlocked(false);
  applyUploadToken("");
  renderUploadHistory([]);
  pinMessage(message);
  adminMessage("");
}

async function saveAdminSettings() {
  if (!isAdminMode) return;
  const settings = normalizeSettings({
    publicPollMs: publicPollSelect?.value,
    publicMaxRecords: publicMaxRecordsInput?.value,
    publicShowInvalidPoints: Boolean(publicInvalidInput?.checked),
  });

  try {
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...headers() },
      body: JSON.stringify(settings),
    });
    if (res.status === 401) {
      lockAdmin("Password session expired.");
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    appSettings = normalizeSettings(data.settings);
    applySettingsToForm();
    resetPolling();
    loadLocations({ keepViewport: true });
    adminMessage("Viewer settings saved.");
  } catch {
    adminMessage("Failed to save settings.");
  }
}

function generateUploadToken() {
  if (!isAdminMode || !newTokenInput) return;
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  newTokenInput.value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (copyTokenButton) copyTokenButton.disabled = false;
  adminMessage("Generated a new candidate token. Press Rotate token to activate it.");
}

async function copyUploadToken() {
  if (!isAdminMode) return;
  const token = (newTokenInput?.value || "").trim();
  if (!token) {
    adminMessage("No upload token to copy.");
    return;
  }

  try {
    await navigator.clipboard.writeText(token);
    adminMessage("Upload token copied.");
  } catch {
    adminMessage("Copy failed. Select the token field and copy it manually.");
  }
}

async function rotateUploadToken() {
  if (!isAdminMode) return;
  const nextToken = (newTokenInput?.value || "").trim();
  if (nextToken.length < 24) {
    adminMessage("New token must be at least 24 characters.");
    return;
  }

  try {
    const res = await fetch("/api/admin/token", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...headers() },
      body: JSON.stringify({ token: nextToken }),
    });
    if (res.status === 401) {
      lockAdmin("Password session expired.");
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    applyUploadToken(typeof data.uploadToken === "string" ? data.uploadToken : nextToken);
    adminMessage("Upload token rotated. Copy this token to the Android app.");
  } catch {
    adminMessage("Failed to rotate token.");
  }
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}H ${String(minutes).padStart(2, "0")}M`;
  if (minutes > 0) return `${minutes}M ${String(seconds).padStart(2, "0")}S`;
  return `${seconds}S`;
}

function renderViewerWatchTime() {
  if (isAdminMode || !statusEl) return;
  statusEl.textContent = formatDuration(viewerTotalViewMs + viewerPendingViewMs);
  signalDotEl?.classList.remove("live");
}

function collectViewerElapsed() {
  const now = Date.now();
  if (document.visibilityState === "visible") {
    viewerPendingViewMs += now - viewerLastViewTickAt;
  }
  viewerLastViewTickAt = now;
}

async function loadViewerStats() {
  if (isAdminMode) return;
  try {
    const res = await fetch("/api/viewer-stats");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const totalViewMs = Number(data.stats?.totalViewMs);
    if (Number.isFinite(totalViewMs)) viewerTotalViewMs = Math.max(0, totalViewMs);
  } catch {
    // The page can still show the current local session time if stats fail.
  }
  renderViewerWatchTime();
}

async function flushViewerHeartbeat(useBeacon = false) {
  if (isAdminMode) return;
  collectViewerElapsed();
  const durationMs = Math.floor(viewerPendingViewMs);
  if (durationMs < 1000) {
    renderViewerWatchTime();
    return;
  }
  viewerPendingViewMs -= durationMs;

  const body = JSON.stringify({ durationMs });
  if (useBeacon && navigator.sendBeacon) {
    const sent = navigator.sendBeacon(
      "/api/viewer-heartbeat",
      new Blob([body], { type: "application/json" })
    );
    if (sent) {
      viewerTotalViewMs += durationMs;
      renderViewerWatchTime();
    } else {
      viewerPendingViewMs += durationMs;
    }
    return;
  }

  try {
    const res = await fetch("/api/viewer-heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const totalViewMs = Number(data.stats?.totalViewMs);
    if (Number.isFinite(totalViewMs)) viewerTotalViewMs = Math.max(0, totalViewMs);
  } catch {
    viewerPendingViewMs += durationMs;
    // Keep pending time so a later heartbeat can retry it.
  }
  renderViewerWatchTime();
}

function tickViewerStats() {
  if (isAdminMode) return;
  collectViewerElapsed();
  renderViewerWatchTime();
  const now = Date.now();
  if (now - viewerLastHeartbeatAt >= VIEWER_HEARTBEAT_MS) {
    viewerLastHeartbeatAt = now;
    flushViewerHeartbeat();
  }
}

function startViewerStats() {
  renderViewerWatchTime();
  loadViewerStats();
  if (viewerTickTimer) clearInterval(viewerTickTimer);
  viewerTickTimer = setInterval(tickViewerStats, 1000);
  document.addEventListener("visibilitychange", () => {
    tickViewerStats();
    viewerLastViewTickAt = Date.now();
  });
  window.addEventListener("pagehide", () => flushViewerHeartbeat(true));
  window.addEventListener("beforeunload", () => flushViewerHeartbeat(true));
}

function setOperationalStatus(text, live = false) {
  if (!isAdminMode) return;
  statusEl.textContent = text;
  signalDotEl.classList.toggle("live", Boolean(live));
}

function setLocationSharingIndicator(isOn) {
  if (!locationStateDotEl) return;
  locationStateDotEl.classList.toggle("is-on", Boolean(isOn));
  locationStateDotEl.setAttribute("aria-label", isOn ? "Location sharing on" : "Location sharing off");
}

function fmtClock(ms) {
  if (!ms) return "--:--:--";
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(ms));
}

function fmtDistance(meters) {
  const value = Number(meters || 0);
  if (value >= 1000) return `${(value / 1000).toFixed(1)} KM`;
  return `${Math.round(value)} M`;
}

function fmtSteps(steps) {
  const value = Math.max(0, Math.floor(Number(steps || 0)));
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K`;
  return `${value}`;
}

function fmtMovement(distanceMeters, steps) {
  return `${fmtDistance(distanceMeters)} / ${fmtSteps(steps)}`;
}

function rawStatusLabel(status) {
  return {
    valid: "valid",
    low_accuracy: "low accuracy",
    duplicate: "duplicate",
    jump_suspected: "jump suspected",
    time_reversed: "time reversed",
    sharing_off: "sharing off",
    invalid_payload: "invalid payload",
  }[status] || status || "unknown";
}

function fmtHistoryTime(ms) {
  if (!ms) return "--";
  return new Intl.DateTimeFormat("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(ms));
}

function historyTypeLabel(record) {
  if (record.raw_status === "sharing_off") return "sharing off";
  if (record.recordType === "event") return record.event || "event";
  return record.raw_status || "location";
}

function renderUploadHistory(records = []) {
  if (!uploadHistoryListEl) return;
  uploadHistoryListEl.replaceChildren();

  if (!records.length) {
    const empty = document.createElement("p");
    empty.className = "upload-history-empty";
    empty.textContent = "No upload records yet.";
    uploadHistoryListEl.append(empty);
    return;
  }

  for (const record of records) {
    const item = document.createElement("article");
    item.className = "upload-history-item";

    const head = document.createElement("div");
    head.className = "upload-history-head";

    const time = document.createElement("time");
    time.textContent = fmtHistoryTime(record.serverReceivedAt || record.timestamp);

    const badge = document.createElement("span");
    badge.className = "upload-history-badge";
    badge.dataset.status = record.raw_status || "unknown";
    badge.textContent = historyTypeLabel(record);

    head.append(time, badge);

    const main = document.createElement("strong");
    main.textContent = record.deviceName || record.deviceId || "Android";

    const meta = document.createElement("p");
    const parts = [fmtMovement(record.distanceMeters, record.steps)];
    if (Number.isFinite(Number(record.accuracyMeters))) {
      parts.push(`+/-${Math.round(Number(record.accuracyMeters))}m`);
    }
    if (Number.isFinite(Number(record.latitude)) && Number.isFinite(Number(record.longitude))) {
      parts.push(`${Number(record.latitude).toFixed(5)} / ${Number(record.longitude).toFixed(5)}`);
    }
    meta.textContent = parts.join(" · ");

    item.append(head, main, meta);
    uploadHistoryListEl.append(item);
  }
}

async function loadUploadHistory() {
  if (!isAdminMode || !uploadHistoryListEl) return;
  try {
    const res = await fetch("/api/admin/upload-history?limit=80", { headers: headers() });
    if (res.status === 401) {
      lockAdmin("Password session expired.");
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderUploadHistory(data.records || []);
  } catch {
    renderUploadHistory([]);
    adminMessage("Failed to load upload history.");
  }
}

function setPaint(layerId, property, value) {
  if (!map.getLayer(layerId)) return;
  try {
    map.setPaintProperty(layerId, property, value);
  } catch {
    // Hosted styles can vary; unsupported paint properties are skipped.
  }
}

function setLayout(layerId, property, value) {
  if (!map.getLayer(layerId)) return;
  try {
    map.setLayoutProperty(layerId, property, value);
  } catch {
    // Hosted styles can vary; unsupported layout properties are skipped.
  }
}

function applyWonderingMapTheme() {
  const layers = map.getStyle()?.layers || [];
  if (mapEl) mapEl.dataset.mapTheme = "mini-3d-light";
  setPaint("background", "background-color", MAP_COLORS.paper);
  setPaint("water", "fill-color", MAP_COLORS.water);
  setPaint("water", "fill-opacity", 0.98);
  setPaint("waterway", "line-color", MAP_COLORS.waterLine);
  setPaint("waterway", "line-opacity", 0.82);
  setPaint("park", "fill-color", MAP_COLORS.park);
  setPaint("park", "fill-opacity", 0.92);
  setPaint("landcover_wood", "fill-color", MAP_COLORS.woodland);
  setPaint("landcover_wood", "fill-opacity", 0.88);
  setPaint("landuse_residential", "fill-color", MAP_COLORS.residential);
  setPaint("landuse_residential", "fill-opacity", 0.62);
  setPaint("aeroway-area", "fill-color", MAP_COLORS.aeroway);
  setPaint("aeroway-area", "fill-opacity", 0.62);

  setPaint("highway_path", "line-color", MAP_COLORS.roadCasing);
  setPaint("highway_path", "line-opacity", 0.8);
  setPaint("highway_minor", "line-color", MAP_COLORS.road);
  setPaint("highway_minor", "line-opacity", 0.94);
  setPaint("road_pier", "line-color", MAP_COLORS.road);
  setPaint("road_area_pier", "fill-color", MAP_COLORS.road);
  setPaint("highway_major_casing", "line-color", MAP_COLORS.roadCasing);
  setPaint("highway_major_casing", "line-opacity", 1);
  setPaint("highway_major_inner", "line-color", MAP_COLORS.roadMajor);
  setPaint("highway_major_inner", "line-opacity", 0.96);
  setPaint("highway_major_subtle", "line-color", MAP_COLORS.roadMajor);
  setPaint("highway_major_subtle", "line-opacity", 0.42);
  setPaint("highway_motorway_casing", "line-color", MAP_COLORS.roadMotorwayCasing);
  setPaint("highway_motorway_casing", "line-opacity", 1);
  setPaint("highway_motorway_inner", "line-color", MAP_COLORS.roadMotorway);
  setPaint("highway_motorway_inner", "line-opacity", 0.96);
  setPaint("highway_motorway_subtle", "line-color", MAP_COLORS.roadMotorway);
  setPaint("highway_motorway_subtle", "line-opacity", 0.44);
  setPaint("highway_motorway_bridge_casing", "line-color", MAP_COLORS.roadMotorwayCasing);
  setPaint("highway_motorway_bridge_inner", "line-color", MAP_COLORS.roadMotorway);
  setPaint("tunnel_motorway_casing", "line-color", MAP_COLORS.roadMotorwayCasing);
  setPaint("tunnel_motorway_inner", "line-color", MAP_COLORS.roadMotorway);
  setPaint("railway", "line-color", MAP_COLORS.rail);
  setPaint("railway_dashline", "line-color", MAP_COLORS.rail);
  setPaint("railway_service", "line-color", MAP_COLORS.rail);
  setPaint("railway_service_dashline", "line-color", MAP_COLORS.rail);
  setPaint("railway_transit", "line-color", MAP_COLORS.transit);
  setPaint("railway_transit_dashline", "line-color", MAP_COLORS.transit);
  setPaint("boundary_2", "line-color", "#AAB5B1");
  setPaint("boundary_2", "line-opacity", 0.34);
  setPaint("boundary_3", "line-color", "#B8C1BD");
  setPaint("boundary_3", "line-opacity", 0.3);

  layers.forEach((layer) => {
    const id = layer.id;
    const sourceLayer = layer["source-layer"] || "";

    if (id === "building" || id === "building-top") return;

    if (layer.type === "symbol") {
      if (id.startsWith("poi_") || id.includes("shield") || id.startsWith("road_oneway") || id === "airport") {
        setLayout(id, "visibility", "none");
        return;
      }

      const textColor =
        sourceLayer === "transportation_name" || sourceLayer === "water_name" || sourceLayer === "waterway"
          ? MAP_COLORS.mutedLabel
          : MAP_COLORS.label;
      setPaint(id, "text-color", textColor);
      setPaint(id, "text-halo-color", MAP_COLORS.paper);
      setPaint(id, "text-halo-width", 1.6);
      setPaint(id, "text-opacity", 0.9);
      setPaint(id, "icon-opacity", 0);
    }
  });

  if (typeof map.setLight === "function") {
    try {
      map.setLight({ anchor: "viewport", color: "#ffffff", intensity: 0.42, position: [1.2, 210, 34] });
    } catch {
      // Light support depends on the active style version.
    }
  }
}

function initializeMap() {
  if (mapReady) {
    scheduleMapResize();
    updateMapDiagnostics();
    return;
  }
  if (!map.getStyle()?.layers?.length || !map.getSource("openmaptiles")) return;
  mapReady = true;
  resetCameraPadding();
  scheduleMapResize();
  setupMapLayers();
  loadLocations();
  resetPolling();
  setTimeout(updateMapDiagnostics, 1800);
  setTimeout(updateMapDiagnostics, 5000);
}

function updateMapDiagnostics() {
  if (!mapEl) return;
  mapEl.dataset.mapReady = String(mapReady);
  mapEl.dataset.mapLoaded = String(map.loaded());
  mapEl.dataset.pitch = String(Math.round(map.getPitch()));
  mapEl.dataset.bearing = String(Math.round(map.getBearing()));
  mapEl.dataset.zoom = map.getZoom().toFixed(1);
  mapEl.dataset.hasBuildingShadow = String(Boolean(map.getLayer("wondering-building-shadow")));
  mapEl.dataset.has3dBuildings = String(Boolean(map.getLayer("wondering-3d-buildings")));
  mapEl.dataset.hasRouteLayers = String(
    ["route-halo", "route-line", "route-direction", "accuracy-fill", "invalid-points"].every((id) =>
      Boolean(map.getLayer(id))
    )
  );
  try {
    mapEl.dataset.renderedFeatureCount = String(map.queryRenderedFeatures().length);
  } catch {
    mapEl.dataset.renderedFeatureCount = "unknown";
  }
}

function setupMapLayers() {
  applyWonderingMapTheme();

  if (map.getLayer("building")) map.setLayoutProperty("building", "visibility", "none");
  if (map.getLayer("building-top")) map.setLayoutProperty("building-top", "visibility", "none");

  const firstSymbolLayer = map.getStyle().layers.find((layer) => layer.type === "symbol");
  const beforeId = firstSymbolLayer ? firstSymbolLayer.id : undefined;

  if (map.getSource("openmaptiles") && !map.getLayer("wondering-building-shadow")) {
    map.addLayer(
      {
        id: "wondering-building-shadow",
        source: "openmaptiles",
        "source-layer": "building",
        type: "fill",
        minzoom: 14,
        paint: {
          "fill-color": MAP_COLORS.buildingShadow,
          "fill-opacity": [
            "interpolate",
            ["linear"],
            ["zoom"],
            14,
            0,
            15,
            0.38,
            17,
            0.48,
          ],
          "fill-translate": [2.5, 2.5],
          "fill-translate-anchor": "viewport",
        },
      },
      beforeId
    );
  }

  if (map.getSource("openmaptiles") && !map.getLayer("wondering-3d-buildings")) {
    map.addLayer(
      {
        id: "wondering-3d-buildings",
        source: "openmaptiles",
        "source-layer": "building",
        type: "fill-extrusion",
        minzoom: 14,
        paint: {
          "fill-extrusion-color": [
            "interpolate",
            ["linear"],
            ["to-number", ["get", "render_height"], ["to-number", ["get", "height"], 12]],
            0,
            MAP_COLORS.buildingFill,
            80,
            MAP_COLORS.buildingSide,
            180,
            MAP_COLORS.buildingTall,
          ],
          "fill-extrusion-height": [
            "interpolate",
            ["linear"],
            ["zoom"],
            14,
            0,
            15.5,
            ["max", 8, ["to-number", ["get", "render_height"], ["to-number", ["get", "height"], 12]]],
          ],
          "fill-extrusion-base": [
            "to-number",
            ["get", "render_min_height"],
            ["to-number", ["get", "min_height"], 0],
          ],
          "fill-extrusion-opacity": 0.94,
          "fill-extrusion-vertical-gradient": true,
        },
      },
      beforeId
    );
  }

  map.addSource("display-route", { type: "geojson", data: emptyFeatureCollection, lineMetrics: true });
  map.addSource("invalid-points", { type: "geojson", data: emptyFeatureCollection });
  map.addSource("accuracy-area", { type: "geojson", data: emptyFeatureCollection });

  map.addLayer({
    id: "accuracy-fill",
    type: "fill",
    source: "accuracy-area",
    paint: {
      "fill-color": MAP_COLORS.routeAccent,
      "fill-opacity": 0.08,
    },
  });

  map.addLayer({
    id: "accuracy-line",
    type: "line",
    source: "accuracy-area",
    paint: {
      "line-color": MAP_COLORS.routeAccent,
      "line-opacity": 0.22,
      "line-width": 1.4,
    },
  });

  map.addLayer({
    id: "route-halo",
    type: "line",
    source: "display-route",
    layout: {
      "line-cap": "round",
      "line-join": "round",
    },
    paint: {
      "line-color": MAP_COLORS.routeHalo,
      "line-opacity": 0.9,
      "line-width": ["interpolate", ["linear"], ["zoom"], 13, 8, 17, 14],
    },
  });

  map.addLayer({
    id: "route-line",
    type: "line",
    source: "display-route",
    layout: {
      "line-cap": "round",
      "line-join": "round",
    },
    paint: {
      "line-color": MAP_COLORS.route,
      "line-opacity": 0.96,
      "line-width": ["interpolate", ["linear"], ["zoom"], 13, 3.6, 17, 5.2],
    },
  });

  map.addLayer({
    id: "route-direction",
    type: "symbol",
    source: "display-route",
    minzoom: 15,
    layout: {
      "symbol-placement": "line",
      "symbol-spacing": 58,
      "text-field": "▶",
      "text-size": 13,
      "text-keep-upright": false,
      "text-rotation-alignment": "map",
      "text-pitch-alignment": "map",
    },
    paint: {
      "text-color": MAP_COLORS.routeAccent,
      "text-halo-color": MAP_COLORS.routeHalo,
      "text-halo-width": 1.4,
    },
  });

  map.addLayer({
    id: "invalid-points",
    type: "circle",
    source: "invalid-points",
    paint: {
      "circle-radius": 4,
      "circle-color": MAP_COLORS.invalid,
      "circle-opacity": 0.28,
      "circle-stroke-color": MAP_COLORS.paper,
      "circle-stroke-width": 1,
      "circle-stroke-opacity": 0.7,
    },
  });

  updateMapDiagnostics();
}

function toLngLat(point) {
  return [point.longitude, point.latitude];
}

function hasCoordinates(point) {
  if (!point) return false;
  const latitude = Number(point.latitude);
  const longitude = Number(point.longitude);
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

function distanceMeters(a, b) {
  const aLng = Array.isArray(a) ? a[0] : a.longitude;
  const aLat = Array.isArray(a) ? a[1] : a.latitude;
  const bLng = Array.isArray(b) ? b[0] : b.longitude;
  const bLat = Array.isArray(b) ? b[1] : b.latitude;
  const radius = 6371000;
  const lat1 = (aLat * Math.PI) / 180;
  const lat2 = (bLat * Math.PI) / 180;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * radius * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function interpolatePoint(a, b, ratio) {
  return [a[0] + (b[0] - a[0]) * ratio, a[1] + (b[1] - a[1]) * ratio];
}

function getSqSegDist(point, start, end) {
  let x = start.x;
  let y = start.y;
  let dx = end.x - x;
  let dy = end.y - y;

  if (dx !== 0 || dy !== 0) {
    const t = ((point.x - x) * dx + (point.y - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) {
      x = end.x;
      y = end.y;
    } else if (t > 0) {
      x += dx * t;
      y += dy * t;
    }
  }

  dx = point.x - x;
  dy = point.y - y;
  return dx * dx + dy * dy;
}

function simplifyDPStep(projected, first, last, sqTolerance, keep) {
  let maxSqDist = sqTolerance;
  let index = 0;

  for (let i = first + 1; i < last; i += 1) {
    const sqDist = getSqSegDist(projected[i], projected[first], projected[last]);
    if (sqDist > maxSqDist) {
      index = i;
      maxSqDist = sqDist;
    }
  }

  if (index) {
    keep[index] = true;
    simplifyDPStep(projected, first, index, sqTolerance, keep);
    simplifyDPStep(projected, index, last, sqTolerance, keep);
  }
}

function simplifySegment(segment) {
  if (segment.length <= 2) return segment;
  const projected = segment.map((point) => map.project(point));
  const keep = new Array(segment.length).fill(false);
  keep[0] = true;
  keep[segment.length - 1] = true;
  simplifyDPStep(projected, 0, segment.length - 1, ROUTE_TOLERANCE_PX * ROUTE_TOLERANCE_PX, keep);
  return segment.filter((_, index) => keep[index]);
}

function densifySegment(segment) {
  if (segment.length < 2) return segment;
  const out = [segment[0]];

  for (let i = 1; i < segment.length; i += 1) {
    const prev = out[out.length - 1];
    const next = segment[i];
    const gap = distanceMeters(prev, next);
    const steps = Math.min(24, Math.floor(gap / INTERPOLATION_STEP_M));
    for (let j = 1; j < steps; j += 1) out.push(interpolatePoint(prev, next, j / steps));
    out.push(next);
  }

  return out;
}

function chaikin(segment, iterations = 2) {
  if (segment.length < 3) return segment;
  let points = segment;

  for (let round = 0; round < iterations; round += 1) {
    const next = [points[0]];
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i];
      const b = points[i + 1];
      next.push(interpolatePoint(a, b, 0.25));
      next.push(interpolatePoint(a, b, 0.75));
    }
    next.push(points[points.length - 1]);
    points = next;
  }

  return points;
}

function buildDisplaySegments(records) {
  const rawSegments = [];
  let current = [];
  const sorted = [...records].sort((a, b) => a.timestamp - b.timestamp);

  for (const record of sorted) {
    if (record.raw_status === "sharing_off") {
      if (current.length > 0) rawSegments.push(current);
      current = [];
      continue;
    }

    if (record.raw_status !== "valid" || !hasCoordinates(record)) continue;

    const point = toLngLat(record);
    const previous = current[current.length - 1];
    if (previous && distanceMeters(previous, point) > MAX_CONNECTED_GAP_M) {
      if (current.length > 0) rawSegments.push(current);
      current = [point];
      continue;
    }
    current.push(point);
  }

  if (current.length > 0) rawSegments.push(current);

  return rawSegments
    .map((segment) => chaikin(densifySegment(simplifySegment(segment))))
    .filter((segment) => segment.length >= 2);
}

function routeGeoJson(segments) {
  return {
    type: "FeatureCollection",
    features: segments.map((segment) => ({
      type: "Feature",
      properties: {},
      geometry: { type: "LineString", coordinates: segment },
    })),
  };
}

function invalidGeoJson(records) {
  return {
    type: "FeatureCollection",
    features: records
      .filter((record) => record.raw_status !== "valid" && hasCoordinates(record))
      .slice(-MAX_INVALID_MARKERS)
      .map((record) => ({
        type: "Feature",
        properties: { raw_status: rawStatusLabel(record.raw_status) },
        geometry: { type: "Point", coordinates: toLngLat(record) },
      })),
  };
}

function circlePolygon(center, radiusMeters, steps = 72) {
  const [lng, lat] = center;
  const latRad = (lat * Math.PI) / 180;
  const dLat = radiusMeters / 111320;
  const dLng = radiusMeters / (111320 * Math.max(0.2, Math.cos(latRad)));
  const coordinates = [];

  for (let i = 0; i <= steps; i += 1) {
    const angle = (i / steps) * Math.PI * 2;
    coordinates.push([lng + Math.cos(angle) * dLng, lat + Math.sin(angle) * dLat]);
  }

  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: { type: "Polygon", coordinates: [coordinates] },
      },
    ],
  };
}

function clearMapData() {
  if (!mapReady) return;
  map.getSource("display-route").setData(emptyFeatureCollection);
  map.getSource("invalid-points").setData(emptyFeatureCollection);
  map.getSource("accuracy-area").setData(emptyFeatureCollection);
}

function clearAccuracyArea() {
  if (!mapReady) return;
  map.getSource("accuracy-area").setData(emptyFeatureCollection);
}

function removeCurrentMarker() {
  if (markerAnimation) {
    cancelAnimationFrame(markerAnimation);
    markerAnimation = null;
  }
  if (marker) {
    marker.remove();
    marker = null;
  }
  clearAccuracyArea();
}

function drawRoute(segments) {
  if (!mapReady) return;
  map.getSource("display-route").setData(routeGeoJson(segments));
}

function drawInvalidPoints(records) {
  if (!mapReady) return;
  map.getSource("invalid-points").setData(invalidGeoJson(records));
}

function setAccuracyAreaDisabled(disabled) {
  if (!mapReady || !map.getLayer("accuracy-fill") || !map.getLayer("accuracy-line")) return;
  map.setPaintProperty("accuracy-fill", "fill-color", disabled ? MAP_COLORS.locationDisabled : MAP_COLORS.routeAccent);
  map.setPaintProperty("accuracy-fill", "fill-opacity", disabled ? 0.11 : 0.08);
  map.setPaintProperty(
    "accuracy-line",
    "line-color",
    disabled ? MAP_COLORS.locationDisabledLine : MAP_COLORS.routeAccent
  );
  map.setPaintProperty("accuracy-line", "line-opacity", disabled ? 0.28 : 0.22);
}

function setCurrentMarkerDisabled(disabled) {
  marker?.getElement()?.classList.toggle("is-disabled", disabled);
}

function animateMarkerTo(nextLngLat, disabled = false) {
  if (!marker) {
    const el = document.createElement("div");
    el.className = "currentMarker";
    el.classList.toggle("is-disabled", disabled);
    marker = new maplibregl.Marker({ element: el, anchor: "center", pitchAlignment: "map", rotationAlignment: "map" })
      .setLngLat(nextLngLat)
      .addTo(map);
    return;
  }

  setCurrentMarkerDisabled(disabled);
  if (markerAnimation) cancelAnimationFrame(markerAnimation);
  const start = marker.getLngLat();
  const from = [start.lng, start.lat];
  const startedAt = performance.now();

  function frame(now) {
    const t = Math.min(1, (now - startedAt) / MARKER_ANIMATION_MS);
    const eased = 1 - Math.pow(1 - t, 3);
    marker.setLngLat(interpolatePoint(from, nextLngLat, eased));
    if (t < 1) markerAnimation = requestAnimationFrame(frame);
  }

  markerAnimation = requestAnimationFrame(frame);
}

function updateAccuracyArea(point, disabled = false) {
  if (!mapReady) return;
  setAccuracyAreaDisabled(disabled);
  const accuracy = Number(point.accuracyMeters);
  const source = map.getSource("accuracy-area");
  if (!Number.isFinite(accuracy) || accuracy <= 0) {
    source.setData(emptyFeatureCollection);
    return;
  }
  source.setData(circlePolygon(toLngLat(point), accuracy));
}

function setLocateButtonEnabled(enabled) {
  if (!locateCurrentButton) return;
  locateCurrentButton.disabled = !enabled;
  locateCurrentButton.setAttribute("aria-disabled", String(!enabled));
}

function focusTrackedLocation() {
  if (!mapReady || !latestTrackedLngLat) return;
  resizeMapNow();
  resetCameraPadding();
  const zoom = Math.min(Math.max(map.getZoom(), CURRENT_LOCATION_ZOOM), CURRENT_LOCATION_MAX_ZOOM);
  map.easeTo({
    center: latestTrackedLngLat,
    zoom,
    pitch: DEFAULT_CAMERA.pitch,
    bearing: DEFAULT_CAMERA.bearing,
    offset: isAdminMode ? [0, 42] : [0, 0],
    duration: 850,
    essential: true,
  });
}

function updateFreshness(latest) {
  if (latest.raw_status === "sharing_off") {
    setOperationalStatus("OFF", false);
    setLocationSharingIndicator(false);
    mapInstructionEl.textContent = "Location sharing off";
    mapSubStatusEl.textContent = `${latest.deviceName || "Android"} · ${fmtClock(latest.timestamp)}`;
    return;
  }

  const isStale = Date.now() - latest.timestamp > 120000;
  if (isStale) {
    setOperationalStatus("OFFLINE", false);
    setLocationSharingIndicator(false);
    mapInstructionEl.textContent = "Waiting for new location";
    mapSubStatusEl.textContent = `${latest.deviceName || "Android"} · ${fmtClock(latest.timestamp)}`;
    return;
  }

  if (latest.raw_status === "low_accuracy") {
    setOperationalStatus("GPS WEAK", false);
    setLocationSharingIndicator(true);
    mapInstructionEl.textContent = "GPS accuracy weak";
    mapSubStatusEl.textContent = `${latest.deviceName || "Android"} · ${fmtClock(latest.timestamp)}`;
    return;
  }

  setOperationalStatus("LIVE", true);
  setLocationSharingIndicator(true);
  mapInstructionEl.textContent = "Live location tracking";
  mapSubStatusEl.textContent = `${latest.deviceName || "Android"} · ${fmtClock(latest.timestamp)}`;
}

function render(records, options = {}) {
  const latestRaw = records.at(-1);
  const latestValid = [...records].reverse().find((record) => record.raw_status === "valid");
  const latestDisplay = latestValid || (hasCoordinates(latestRaw) ? latestRaw : null);

  if (!latestRaw) {
    latestTrackedLngLat = null;
    setLocateButtonEnabled(false);
    setOperationalStatus("WAITING", false);
    setLocationSharingIndicator(false);
    mapInstructionEl.textContent = "Waiting for location";
    mapSubStatusEl.textContent = "Raw GPS saved · Display route smoothed";
    lastSeenEl.textContent = "--:--:--";
    coordsEl.textContent = "- / -";
    distanceEl.textContent = fmtMovement(0, 0);
    clearMapData();
    removeCurrentMarker();
    return;
  }

  updateFreshness(latestRaw);
  lastSeenEl.textContent = fmtClock(latestRaw.timestamp);
  distanceEl.textContent = fmtMovement(latestRaw.distanceMeters, latestRaw.steps);

  const segments = buildDisplaySegments(records);
  drawRoute(segments);
  drawInvalidPoints(shouldShowInvalidPoints() ? records : []);

  if (!latestDisplay) {
    coordsEl.textContent = "- / -";
    latestTrackedLngLat = null;
    setLocateButtonEnabled(false);
    removeCurrentMarker();
    return;
  }

  coordsEl.textContent = `${latestDisplay.latitude.toFixed(5)} / ${latestDisplay.longitude.toFixed(5)}`;
  latestTrackedLngLat = toLngLat(latestDisplay);
  const showCurrentLocation = isSelectedRouteToday();
  setLocateButtonEnabled(showCurrentLocation);

  if (!options.keepViewport && !hasInitialLocationFocus) {
    hasInitialLocationFocus = true;
    focusTrackedLocation();
  }

  if (showCurrentLocation) {
    const isSharingOff = latestRaw.raw_status === "sharing_off";
    animateMarkerTo(latestTrackedLngLat, isSharingOff);
    updateAccuracyArea(latestDisplay, isSharingOff);
  } else {
    removeCurrentMarker();
  }
}

async function loadLocations(options = {}) {
  if (!mapReady) return;
  try {
    const params = new URLSearchParams({ limit: String(selectedLimit()) });
    if (selectedRouteDate) params.set("date", selectedRouteDate);
    const res = await fetch(`/api/locations?${params.toString()}`, { headers: headers() });
    if (res.status === 401) {
      setOperationalStatus("TOKEN REQ", false);
      mapInstructionEl.textContent = "Token required";
      mapSubStatusEl.textContent = "Save the admin token";
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    render(data.records || [], options);
  } catch {
    setOperationalStatus("ERROR", false);
    mapInstructionEl.textContent = "Server connection failed";
    mapSubStatusEl.textContent = "Check the API response";
  }
}

function resetPolling() {
  if (pollTimer) clearInterval(pollTimer);
  const interval = isAdminMode ? Number(pollSelect?.value || DEFAULT_SETTINGS.publicPollMs) : appSettings.publicPollMs;
  pollTimer = setInterval(loadLocations, interval);
}
