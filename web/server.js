const http = require("http");
const fs = require("fs");
const path = require("path");

const port = Number(process.env.PORT || 5174);
const token = process.env.LOCATION_SHARE_TOKEN || "";
const publicDir = path.join(__dirname, "public");
const dataDir = path.join(__dirname, "data");
const dataFile = path.join(dataDir, "locations.jsonl");

const DISPLAY_RULES = {
  maxAccuracyM: 50,
  duplicateDistanceM: 5,
  jumpWindowMs: 60000,
  jumpDistanceM: 1000,
  maxSpeedMps: 55,
};

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

function isAuthorized(req) {
  if (!token) return true;
  return req.headers.authorization === `Bearer ${token}`;
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

function withRawStatus(records) {
  let previousRaw = null;
  let previousValid = null;

  return records.map((record) => {
    const point = { ...record };
    const reasons = [];
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
  if (!isAuthorized(req)) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, { ok: true, tokenRequired: Boolean(token) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/locations") {
    const limit = Math.min(Number(url.searchParams.get("limit") || 500), 5000);
    const date = url.searchParams.get("date");
    const records = withRawStatus(loadRecords())
      .filter((record) => !date || record.date === date)
      .sort((a, b) => a.timestamp - b.timestamp);
    sendJson(res, 200, { records: records.slice(-limit), displayRules: DISPLAY_RULES });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/latest") {
    const records = withRawStatus(loadRecords()).sort((a, b) => a.timestamp - b.timestamp);
    sendJson(res, 200, { record: records.at(-1) || null });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/locations") {
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
