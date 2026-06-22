const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const port = Number(process.env.PORT || 5174);
const envToken = process.env.LOCATION_SHARE_TOKEN || "";
const adminPin = process.env.ADMIN_PIN || "";
const publicDir = path.join(__dirname, "public");
const dataDir = path.join(__dirname, "data");
const dataFile = path.join(dataDir, "locations.jsonl");
const settingsFile = path.join(dataDir, "settings.json");
const authFile = path.join(dataDir, "auth.json");

const DISPLAY_RULES = {
  maxAccuracyM: 50,
  duplicateDistanceM: 5,
  jumpWindowMs: 60000,
  jumpDistanceM: 1000,
  maxSpeedMps: 55,
};
const SHARE_STATE_EVENTS = new Set(["sharing_off"]);

const DEFAULT_PUBLIC_SETTINGS = {
  publicPollMs: 10000,
  publicMaxRecords: 1500,
  publicShowInvalidPoints: true,
};
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const PIN_FAILURE_WINDOW_MS = 5 * 60 * 1000;
const PIN_FAILURE_LIMIT = 10;
const adminSessions = new Map();
const pinFailures = new Map();

fs.mkdirSync(dataDir, { recursive: true });

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, payload) {
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function activeToken() {
  const auth = readJsonFile(authFile, {});
  const savedToken = typeof auth.locationShareToken === "string" ? auth.locationShareToken.trim() : "";
  return savedToken || envToken;
}

function bearerToken(req) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function isAuthorized(req) {
  const token = activeToken();
  if (!token) return true;
  return timingSafeEqualString(bearerToken(req), token);
}

function publicSettings() {
  const saved = readJsonFile(settingsFile, {});
  return sanitizeSettings(saved);
}

function sanitizeSettings(input = {}) {
  const publicPollMs = Number(input.publicPollMs);
  const publicMaxRecords = Number(input.publicMaxRecords);
  return {
    publicPollMs: [5000, 10000, 30000].includes(publicPollMs) ? publicPollMs : DEFAULT_PUBLIC_SETTINGS.publicPollMs,
    publicMaxRecords: Number.isFinite(publicMaxRecords)
      ? Math.max(100, Math.min(1500, Math.round(publicMaxRecords)))
      : DEFAULT_PUBLIC_SETTINGS.publicMaxRecords,
    publicShowInvalidPoints:
      typeof input.publicShowInvalidPoints === "boolean"
        ? input.publicShowInvalidPoints
        : DEFAULT_PUBLIC_SETTINGS.publicShowInvalidPoints,
  };
}

function assertAuthorized(req, res) {
  if (isAuthorized(req)) return true;
  sendJson(res, 401, { error: "unauthorized" });
  return false;
}

function cleanupAdminSessions() {
  const now = Date.now();
  for (const [sessionToken, session] of adminSessions.entries()) {
    if (session.expiresAt <= now) adminSessions.delete(sessionToken);
  }
}

function isAdminAuthorized(req) {
  cleanupAdminSessions();
  const session = adminSessions.get(bearerToken(req));
  return Boolean(session && session.expiresAt > Date.now());
}

function assertAdminAuthorized(req, res) {
  if (isAdminAuthorized(req)) return true;
  sendJson(res, 401, { error: "admin session required" });
  return false;
}

function clientKey(req) {
  const forwardedFor = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwardedFor || req.socket.remoteAddress || "unknown";
}

function pinFailureRecord(req) {
  const key = clientKey(req);
  const now = Date.now();
  const current = pinFailures.get(key);
  if (!current || current.resetAt <= now) {
    const fresh = { count: 0, resetAt: now + PIN_FAILURE_WINDOW_MS };
    pinFailures.set(key, fresh);
    return fresh;
  }
  return current;
}

function isPinLimited(req) {
  return pinFailureRecord(req).count >= PIN_FAILURE_LIMIT;
}

function registerPinFailure(req) {
  pinFailureRecord(req).count += 1;
}

function createAdminSession() {
  const sessionToken = crypto.randomBytes(32).toString("hex");
  const expiresAt = Date.now() + ADMIN_SESSION_TTL_MS;
  adminSessions.set(sessionToken, { expiresAt });
  return { sessionToken, expiresAt };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function parseRecord(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function loadRecords() {
  if (!fs.existsSync(dataFile)) return [];
  return fs
    .readFileSync(dataFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(parseRecord)
    .filter(Boolean);
}

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function distanceMeters(a, b) {
  const radius = 6371000;
  const lat1 = (a.latitude * Math.PI) / 180;
  const lat2 = (b.latitude * Math.PI) / 180;
  const dLat = ((b.latitude - a.latitude) * Math.PI) / 180;
  const dLng = ((b.longitude - a.longitude) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * radius * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function dateFromTimestamp(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function normalizeShareStateEvent(value) {
  const event = String(value || "").trim().toLowerCase();
  return SHARE_STATE_EVENTS.has(event) ? event : "";
}

function hasCoordinates(point) {
  return (
    Number.isFinite(Number(point.latitude)) &&
    Number.isFinite(Number(point.longitude)) &&
    Number(point.latitude) >= -90 &&
    Number(point.latitude) <= 90 &&
    Number(point.longitude) >= -180 &&
    Number(point.longitude) <= 180
  );
}

function withRawStatus(records) {
  let previousRaw = null;
  let previousValid = null;

  return records.map((record) => {
    const point = { ...record };
    const reasons = [];
    const event = normalizeShareStateEvent(point.event);

    if (event) {
      if (previousRaw && point.timestamp < previousRaw.timestamp) reasons.push("time_reversed");
      point.recordType = "event";
      point.event = event;
      point.raw_status = event;
      point.raw_status_reasons = reasons;
      point.accuracyMeters = null;
      point.speedMps = null;
      previousRaw = point;
      previousValid = null;
      return point;
    }

    if (!hasCoordinates(point)) {
      if (previousRaw && point.timestamp < previousRaw.timestamp) reasons.push("time_reversed");
      reasons.push("invalid_payload");
      point.raw_status = reasons[0];
      point.raw_status_reasons = reasons;
      point.accuracyMeters = null;
      point.speedMps = null;
      previousRaw = point;
      return point;
    }

    const accuracyMeters = toFiniteNumber(point.accuracyMeters ?? point.accuracy);
    const speedMps = toFiniteNumber(point.speedMps ?? point.speed);

    if (previousRaw && point.timestamp < previousRaw.timestamp) reasons.push("time_reversed");
    if (accuracyMeters !== null && accuracyMeters > DISPLAY_RULES.maxAccuracyM) reasons.push("low_accuracy");

    if (previousValid) {
      const gapM = distanceMeters(previousValid, point);
      const gapMs = point.timestamp - previousValid.timestamp;
      const computedSpeed = gapMs > 0 ? gapM / (gapMs / 1000) : null;
      const effectiveSpeed = speedMps ?? computedSpeed;
      if (gapM < DISPLAY_RULES.duplicateDistanceM) reasons.push("duplicate");
      if (
        gapMs > 0 &&
        ((effectiveSpeed !== null && effectiveSpeed > DISPLAY_RULES.maxSpeedMps) ||
          (gapMs <= DISPLAY_RULES.jumpWindowMs && gapM > DISPLAY_RULES.jumpDistanceM))
      ) {
        reasons.push("jump_suspected");
      }
    }

    point.accuracyMeters = accuracyMeters;
    point.speedMps = speedMps;
    point.raw_status = reasons[0] || "valid";
    point.raw_status_reasons = reasons;
    previousRaw = point;
    if (point.raw_status === "valid") previousValid = point;
    return point;
  });
}

function normalizePoint(input) {
  const event = normalizeShareStateEvent(input.event);
  if (event) return normalizeShareState(input, event);

  const latitude = Number(input.latitude);
  const longitude = Number(input.longitude);
  const timestamp = Number(input.timestamp || Date.now());
  const accuracyMeters = toFiniteNumber(input.accuracyMeters ?? input.accuracy);
  const speedMps = toFiniteNumber(input.speedMps ?? input.speed);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) return null;
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) return null;
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;

  return {
    id: `${timestamp}-${Math.random().toString(36).slice(2, 10)}`,
    serverReceivedAt: Date.now(),
    deviceId: String(input.deviceId || "android"),
    deviceName: String(input.deviceName || "Android"),
    latitude,
    longitude,
    timestamp,
    date: String(input.date || ""),
    source: String(input.source || "gps"),
    accuracyMeters,
    speedMps,
    steps: Number(input.steps || 0),
    distanceMeters: Number(input.distanceMeters || 0),
  };
}

function normalizeShareState(input, event) {
  const timestamp = Number(input.timestamp || Date.now());
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;

  return {
    id: `${timestamp}-${Math.random().toString(36).slice(2, 10)}`,
    serverReceivedAt: Date.now(),
    recordType: "event",
    event,
    deviceId: String(input.deviceId || "android"),
    deviceName: String(input.deviceName || "Android"),
    timestamp,
    date: String(input.date || dateFromTimestamp(timestamp)),
    source: String(input.source || "share_state"),
    distanceMeters: Number(input.distanceMeters || 0),
  };
}

function serveStatic(req, res, url) {
  const pathname = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = path.normalize(path.join(publicDir, pathname));
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const type =
    {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
    }[path.extname(filePath)] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": type });
  fs.createReadStream(filePath).pipe(res);
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, { ok: true, tokenRequired: Boolean(activeToken()) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/settings") {
    sendJson(res, 200, { settings: publicSettings() });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/admin/login") {
    if (!adminPin) {
      sendJson(res, 503, { error: "admin pin is not configured" });
      return;
    }
    if (isPinLimited(req)) {
      sendJson(res, 429, { error: "too many pin attempts" });
      return;
    }
    try {
      const raw = await readBody(req);
      const payload = JSON.parse(raw || "{}");
      const pin = typeof payload.pin === "string" ? payload.pin.trim() : "";
      if (!timingSafeEqualString(pin, adminPin)) {
        registerPinFailure(req);
        sendJson(res, 401, { error: "invalid pin" });
        return;
      }
      const session = createAdminSession();
      sendJson(res, 200, { ok: true, ...session, settings: publicSettings() });
    } catch {
      sendJson(res, 400, { error: "invalid json" });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/admin/session") {
    if (!assertAdminAuthorized(req, res)) return;
    sendJson(res, 200, { ok: true, settings: publicSettings() });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/locations") {
    const settings = publicSettings();
    const requestedLimit = Number(url.searchParams.get("limit") || settings.publicMaxRecords);
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(requestedLimit, settings.publicMaxRecords))
      : settings.publicMaxRecords;
    const date = url.searchParams.get("date");
    const records = withRawStatus(loadRecords())
      .filter((record) => !date || record.date === date)
      .sort((a, b) => a.timestamp - b.timestamp);
    sendJson(res, 200, { records: records.slice(-limit), displayRules: DISPLAY_RULES, settings });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/latest") {
    const records = withRawStatus(loadRecords()).sort((a, b) => a.timestamp - b.timestamp);
    sendJson(res, 200, { record: records.at(-1) || null });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/locations") {
    if (!assertAuthorized(req, res)) return;
    try {
      const raw = await readBody(req);
      const point = normalizePoint(JSON.parse(raw || "{}"));
      if (!point) {
        sendJson(res, 400, { error: "invalid location payload" });
        return;
      }
      fs.appendFileSync(dataFile, `${JSON.stringify(point)}\n`, "utf8");
      sendJson(res, 201, { ok: true, record: point });
    } catch {
      sendJson(res, 400, { error: "invalid json" });
    }
    return;
  }

  if (req.method === "PUT" && url.pathname === "/api/settings") {
    if (!assertAdminAuthorized(req, res)) return;
    try {
      const raw = await readBody(req);
      const settings = sanitizeSettings(JSON.parse(raw || "{}"));
      writeJsonFile(settingsFile, { ...settings, updatedAt: Date.now() });
      sendJson(res, 200, { ok: true, settings });
    } catch {
      sendJson(res, 400, { error: "invalid json" });
    }
    return;
  }

  if (req.method === "PUT" && url.pathname === "/api/admin/token") {
    if (!assertAdminAuthorized(req, res)) return;
    try {
      const raw = await readBody(req);
      const payload = JSON.parse(raw || "{}");
      const nextToken = typeof payload.token === "string" ? payload.token.trim() : "";
      if (nextToken.length < 24) {
        sendJson(res, 400, { error: "token must be at least 24 characters" });
        return;
      }
      writeJsonFile(authFile, { locationShareToken: nextToken, updatedAt: Date.now() });
      sendJson(res, 200, { ok: true, tokenRequired: true });
    } catch {
      sendJson(res, 400, { error: "invalid json" });
    }
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/api/")) {
    handleApi(req, res, url);
    return;
  }
  serveStatic(req, res, url);
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Wondering dashboard listening on http://localhost:${port}`);
});
