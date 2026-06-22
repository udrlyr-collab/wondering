const statusEl = document.querySelector("#status");
const lastSeenEl = document.querySelector("#lastSeen");
const coordsEl = document.querySelector("#coords");
const distanceEl = document.querySelector("#distance");
const pointCountEl = document.querySelector("#pointCount");
const tokenInput = document.querySelector("#tokenInput");
const dateInput = document.querySelector("#dateInput");
const pollSelect = document.querySelector("#pollSelect");
const heroDayEl = document.querySelector("#heroDay");
const miniDayEl = document.querySelector("#miniDay");
const monthLabelEl = document.querySelector("#monthLabel");
const weekdayLabelEl = document.querySelector("#weekdayLabel");
const mapCaptionEl = document.querySelector("#mapCaption");

const MAX_RECORDS = 1500;
const MAX_INVALID_MARKERS = 200;
const MAX_CONNECTED_GAP_M = 2000;
const INTERPOLATION_STEP_M = 80;
const ROUTE_TOLERANCE_PX = 3;
const MARKER_ANIMATION_MS = 650;

let pollTimer = null;
let marker = null;
let markerAnimation = null;
let accuracyCircle = null;
let routeHalo = null;
let routeLine = null;
let invalidLayer = null;
let hasFitRoute = false;

const map = L.map("map", { zoomControl: false }).setView([37.5665, 126.978], 13);
L.control.zoom({ position: "bottomright" }).addTo(map);
L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
  maxZoom: 20,
  attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
}).addTo(map);
requestAnimationFrame(() => map.invalidateSize());
window.addEventListener("resize", () => map.invalidateSize());

invalidLayer = L.layerGroup().addTo(map);
tokenInput.value = localStorage.getItem("wonderingDashboardToken") || "";

document.querySelector("#saveTokenButton").addEventListener("click", () => {
  localStorage.setItem("wonderingDashboardToken", tokenInput.value.trim());
  loadLocations();
});

document.querySelector("#refreshButton").addEventListener("click", loadLocations);
dateInput.addEventListener("change", () => {
  hasFitRoute = false;
  loadLocations();
});
pollSelect.addEventListener("change", resetPolling);
map.on("zoomend", () => loadLocations({ keepViewport: true }));

function headers() {
  const token = localStorage.getItem("wonderingDashboardToken") || "";
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function fmtTime(ms) {
  if (!ms) return "-";
  return new Intl.DateTimeFormat("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(ms));
}

function fmtClock(ms) {
  if (!ms) return "--:--";
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(ms));
}

function fmtDistance(meters) {
  const value = Number(meters || 0);
  if (value >= 1000) return `${(value / 1000).toFixed(1)} km`;
  return `${Math.round(value)} m`;
}

function fmtAge(ms) {
  if (!ms) return "새 위치 수신 대기 중";
  const ageSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (ageSec < 20) return "실시간 수신 중";
  if (ageSec < 120) return "새 위치 수신 대기 중";
  return `마지막 업데이트 ${Math.floor(ageSec / 60)}분 전`;
}

function updateDateDisplay(ms) {
  const date = ms ? new Date(ms) : new Date();
  const monthNames = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const weekdayNames = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  heroDayEl.textContent = String(date.getDate()).padStart(2, "0");
  miniDayEl.textContent = String(date.getMonth() + 1).padStart(2, "0");
  monthLabelEl.textContent = monthNames[date.getMonth()];
  weekdayLabelEl.textContent = weekdayNames[date.getDay()];
}

function rawStatusLabel(status) {
  return {
    valid: "valid",
    low_accuracy: "low accuracy",
    duplicate: "duplicate",
    jump_suspected: "jump suspected",
    time_reversed: "time reversed",
  }[status] || status || "unknown";
}

function currentIcon() {
  return L.divIcon({
    className: "currentMarkerWrap",
    html: '<div class="currentMarker"></div>',
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

function toLatLng(point) {
  return [point.latitude, point.longitude];
}

function distanceMeters(a, b) {
  const aLat = Array.isArray(a) ? a[0] : a.latitude;
  const aLng = Array.isArray(a) ? a[1] : a.longitude;
  const bLat = Array.isArray(b) ? b[0] : b.latitude;
  const bLng = Array.isArray(b) ? b[1] : b.longitude;
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
  const zoom = map.getZoom();
  const projected = segment.map((point) => map.project(point, zoom));
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
  const valid = records
    .filter((record) => record.raw_status === "valid")
    .sort((a, b) => a.timestamp - b.timestamp);
  if (valid.length === 0) return [];

  const rawSegments = [];
  let current = [toLatLng(valid[0])];

  for (let i = 1; i < valid.length; i += 1) {
    const point = toLatLng(valid[i]);
    const previous = current[current.length - 1];
    if (distanceMeters(previous, point) > MAX_CONNECTED_GAP_M) {
      rawSegments.push(current);
      current = [point];
    } else {
      current.push(point);
    }
  }
  rawSegments.push(current);

  return rawSegments
    .map((segment) => chaikin(densifySegment(simplifySegment(segment))))
    .filter((segment) => segment.length >= 2);
}

function clearRoute() {
  if (routeHalo) routeHalo.remove();
  if (routeLine) routeLine.remove();
  routeHalo = null;
  routeLine = null;
}

function drawRoute(segments) {
  clearRoute();
  if (segments.length === 0) return;

  routeHalo = L.polyline(segments, {
    color: "#000000",
    weight: 10,
    opacity: 0.14,
    lineCap: "round",
    lineJoin: "round",
    interactive: false,
  }).addTo(map);

  routeLine = L.polyline(segments, {
    color: "#000000",
    weight: 4.5,
    opacity: 0.9,
    lineCap: "round",
    lineJoin: "round",
  }).addTo(map);
}

function drawInvalidPoints(records) {
  invalidLayer.clearLayers();
  records
    .filter((record) => record.raw_status !== "valid")
    .slice(-MAX_INVALID_MARKERS)
    .forEach((record) => {
      L.circleMarker(toLatLng(record), {
        radius: 4,
        color: "#111111",
        weight: 1,
        opacity: 0.24,
        fillColor: "#111111",
        fillOpacity: 0.08,
      })
        .bindTooltip(rawStatusLabel(record.raw_status), { direction: "top", opacity: 0.82 })
        .addTo(invalidLayer);
    });
}

function animateMarkerTo(nextLatLng) {
  if (!marker) {
    marker = L.marker(nextLatLng, { icon: currentIcon(), zIndexOffset: 1000 }).addTo(map);
    return;
  }

  if (markerAnimation) cancelAnimationFrame(markerAnimation);
  const start = marker.getLatLng();
  const from = [start.lat, start.lng];
  const startedAt = performance.now();

  function frame(now) {
    const t = Math.min(1, (now - startedAt) / MARKER_ANIMATION_MS);
    const eased = 1 - Math.pow(1 - t, 3);
    marker.setLatLng(interpolatePoint(from, nextLatLng, eased));
    if (t < 1) markerAnimation = requestAnimationFrame(frame);
  }

  markerAnimation = requestAnimationFrame(frame);
}

function updateAccuracyCircle(point) {
  if (accuracyCircle) accuracyCircle.remove();
  accuracyCircle = null;
  const accuracy = Number(point.accuracyMeters);
  if (!Number.isFinite(accuracy) || accuracy <= 0) return;

  accuracyCircle = L.circle(toLatLng(point), {
    radius: accuracy,
    color: "#000000",
    weight: 1,
    opacity: 0.22,
    fillColor: "#000000",
    fillOpacity: 0.06,
    interactive: false,
  }).addTo(map);
}

function fitViewport(segments, latestPoint, keepViewport) {
  if (keepViewport) return;
  const latestLatLng = toLatLng(latestPoint);
  const currentBounds = map.getBounds();
  if (hasFitRoute && currentBounds.pad(-0.15).contains(latestLatLng)) return;

  if (routeLine) {
    map.fitBounds(routeLine.getBounds(), { padding: [36, 36], maxZoom: 17 });
  } else if (segments.length === 0) {
    map.setView(latestLatLng, 16);
  }
  hasFitRoute = true;
}

function updateFreshness(latest) {
  const statusText = fmtAge(latest.timestamp);
  statusEl.textContent = `${latest.deviceName || "Android"} · ${statusText}`;
  mapCaptionEl.textContent = statusText;
  statusEl.classList.toggle("warning", Date.now() - latest.timestamp > 120000 || latest.raw_status !== "valid");
}

function render(records, options = {}) {
  const latestRaw = records.at(-1);
  const latestValid = [...records].reverse().find((record) => record.raw_status === "valid");
  const latestDisplay = latestValid || latestRaw;
  const validCount = records.filter((record) => record.raw_status === "valid").length;
  pointCountEl.textContent = `${validCount} / ${records.length}`;

  if (!latestRaw || !latestDisplay) {
    statusEl.textContent = "수신된 위치 없음";
    statusEl.classList.remove("warning");
    lastSeenEl.textContent = "--:--";
    coordsEl.textContent = "좌표 대기";
    distanceEl.textContent = "0 m";
    pointCountEl.textContent = "0 / 0";
    mapCaptionEl.textContent = "새 위치 수신 대기 중";
    updateDateDisplay();
    clearRoute();
    invalidLayer.clearLayers();
    return;
  }

  updateDateDisplay(latestRaw.timestamp);
  updateFreshness(latestRaw);
  lastSeenEl.textContent = fmtClock(latestRaw.timestamp);
  coordsEl.textContent = `${latestDisplay.latitude.toFixed(6)} / ${latestDisplay.longitude.toFixed(6)}`;
  distanceEl.textContent = fmtDistance(latestRaw.distanceMeters);

  const segments = buildDisplaySegments(records);
  drawRoute(segments);
  drawInvalidPoints(records);
  animateMarkerTo(toLatLng(latestDisplay));
  updateAccuracyCircle(latestDisplay);
  fitViewport(segments, latestDisplay, options.keepViewport);
}

async function loadLocations(options = {}) {
  try {
    const params = new URLSearchParams({ limit: String(MAX_RECORDS) });
    if (dateInput.value) params.set("date", dateInput.value);
    const res = await fetch(`/api/locations?${params.toString()}`, { headers: headers() });
    if (res.status === 401) {
      statusEl.textContent = "토큰 필요";
      mapCaptionEl.textContent = "토큰 필요";
      statusEl.classList.add("warning");
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    render(data.records || [], options);
  } catch {
    statusEl.textContent = "서버 연결 실패";
    mapCaptionEl.textContent = "서버 연결 실패";
    statusEl.classList.add("warning");
  }
}

function resetPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(loadLocations, Number(pollSelect.value));
}

updateDateDisplay();
loadLocations();
resetPolling();
