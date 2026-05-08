#!/usr/bin/env node
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const ENV_PATH = path.join(ROOT, ".env");
const PORT = Number(process.env.NAVITIME_PROXY_PORT || 8890);
const BIND_HOST = process.env.NAVITIME_PROXY_HOST || "0.0.0.0";
const CACHE_TTL_MS = Number(process.env.NAVITIME_MEMORY_CACHE_TTL_MS || 6 * 60 * 60 * 1000);
const HOST = "navitime-route-totalnavi.p.rapidapi.com";
const API_BASE = `https://${HOST}`;
const START_TIME = process.env.NAVITIME_START_TIME || "2026-05-08T08:00:00";
const DEMO_DATA_PATH = path.join(ROOT, "src/data/demo_prefecture_routes.json");
const REQUEST_INTERVAL_MS = Number(process.env.NAVITIME_REQUEST_INTERVAL_MS || 1600);

const TOKYO_STATION = { lat: 35.681236, lon: 139.767125, name: "東京駅" };
const TARGET_ALIASES = {
  fukuoka: "福岡県",
  hokkaido: "北海道",
  osaka: "大阪府",
  miyagi: "宮城県",
  okayama: "岡山県",
  okinawa: "沖縄県",
  wakayama: "和歌山県",
  shimane: "島根県",
  toyama: "富山県",
  akita: "秋田県"
};
const { targets: TARGETS, allTargetKeys: ALL_TARGET_KEYS } = loadTargetsFromDemo();
const SAMPLE_TARGETS = ["okinawa", "wakayama", "shimane", "toyama", "akita"];

function loadTargetsFromDemo() {
  const demo = JSON.parse(fs.readFileSync(DEMO_DATA_PATH, "utf8"));
  const targets = {};
  const allTargetKeys = [];
  (demo.places || []).forEach((place, index) => {
    const key = `pref${String(index + 1).padStart(2, "0")}`;
    const target = {
      prefecture: place.prefecture,
      name: place.name,
      lat: place.lat,
      lon: place.lng
    };
    targets[key] = target;
    allTargetKeys.push(key);
  });
  Object.entries(TARGET_ALIASES).forEach(([alias, prefecture]) => {
    const key = allTargetKeys.find(candidate => targets[candidate].prefecture === prefecture);
    if (key) targets[alias] = targets[key];
  });
  return { targets, allTargetKeys };
}

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return Object.fromEntries(
    fs.readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith("#") && line.includes("="))
      .map(line => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      })
  );
}

const env = { ...loadEnv(ENV_PATH), ...process.env };
const apiKey = env.NAVITIME_API_KEY;
const memoryCache = new Map();
let lastRequestAt = 0;

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res, status, body) {
  cors(res);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function cacheGet(key) {
  const hit = memoryCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    memoryCache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value) {
  memoryCache.set(key, {
    value,
    expiresAt: Date.now() + CACHE_TTL_MS
  });
}

function hhmm(value) {
  const date = new Date(value);
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

function classifyMove(move) {
  const transport = move.transport || {};
  const name = `${transport.name || ""} ${transport.type || ""}`;
  if (name.includes("空路") || name.includes("航空")) return "air";
  if (name.includes("新幹線") || name.includes("のぞみ") || name.includes("こまち") || name.includes("はやぶさ")) return "shinkansen";
  if (!transport.name) return "local";
  return "rail";
}

function safeId(value) {
  return String(value || "point").replace(/[^\w\u3040-\u30ff\u3400-\u9fff]/g, "_");
}

function pointId(targetKey, index, point) {
  return `live_${targetKey}_${index}_${safeId(point.name)}`;
}

function coordPoint(coord) {
  return { lat: coord[1], lon: coord[0] };
}

function coordDistance(a, b) {
  const ax = a.lon;
  const ay = a.lat;
  const bx = b.lon;
  const by = b.lat;
  const x = (ax - bx) * Math.cos(((ay + by) / 2) * Math.PI / 180);
  const y = ay - by;
  return Math.sqrt(x * x + y * y);
}

function minDistanceToPath(path, point) {
  return path.reduce((best, candidate) => Math.min(best, coordDistance(candidate, point)), Infinity);
}

function nearestIndex(path, point) {
  let bestIndex = 0;
  let best = Infinity;
  path.forEach((candidate, index) => {
    const d = coordDistance(candidate, point);
    if (d < best) {
      best = d;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function appendPath(out, path) {
  path.forEach(point => {
    const last = out[out.length - 1];
    if (!last || coordDistance(last, point) > 0.00001) out.push(point);
  });
}

function shapePathForLeg(features, cursor, fromCoord, toCoord, type) {
  const from = { lat: fromCoord.lat, lon: fromCoord.lon };
  const to = { lat: toCoord.lat, lon: toCoord.lon };
  const threshold = type === "air" ? 0.12 : type === "shinkansen" ? 0.018 : 0.004;
  const collected = [];
  let started = false;

  for (let i = cursor; i < features.length; i++) {
    const geometry = features[i].geometry || {};
    if (geometry.type !== "LineString" || !Array.isArray(geometry.coordinates)) continue;
    const path = geometry.coordinates.map(coordPoint);
    if (!path.length) continue;
    if (!started) {
      started = minDistanceToPath(path, from) < threshold || i === cursor;
    }
    if (!started) continue;
    if (type !== "air") appendPath(collected, path);
    if (minDistanceToPath(path, to) < threshold || coordDistance(path[path.length - 1], to) < threshold) {
      return {
        points: type === "air" ? [from, to] : normalizeLegPath(collected, from, to),
        nextCursor: i + 1
      };
    }
  }

  return {
    points: [from, to],
    nextCursor: cursor
  };
}

function normalizeLegPath(points, from, to) {
  if (!points.length) return [from, to];
  const fromIndex = nearestIndex(points, from);
  const toIndex = nearestIndex(points, to);
  const sliced = fromIndex <= toIndex
    ? points.slice(fromIndex, toIndex + 1)
    : points.slice(toIndex, fromIndex + 1).reverse();
  const out = sliced.length ? [...sliced] : [from, to];
  if (coordDistance(out[0], from) > 0.003) out.unshift(from);
  if (coordDistance(out[out.length - 1], to) > 0.003) out.push(to);
  return out.map(point => ({ lat: point.lat, lon: point.lon }));
}

function displayPathOverride(targetKey, section, fromPoint, toPoint, type) {
  const line = section.transport ? section.transport.name || "" : "";
  if (targetKey === "shimane" && line.includes("出雲空港-松江")) {
    return [
      { lat: fromPoint.coord.lat, lon: fromPoint.coord.lon },
      { lat: 35.4285, lon: 132.8878 },
      { lat: 35.4505, lon: 132.9255 },
      { lat: 35.4638, lon: 132.9765 },
      { lat: 35.4684, lon: 133.0185 },
      { lat: toPoint.coord.lat, lon: toPoint.coord.lon }
    ];
  }
  return null;
}

function addDetailedVisualPath(targetKey, visualPoints, visualPaths, pathId, pointCounter, fromId, toId, pathPoints) {
  const ids = [fromId];
  pathPoints.slice(1, -1).forEach((point, index) => {
    const id = `live_${targetKey}_shape_${pointCounter}_${index}`;
    visualPoints[id] = [point.lat, point.lon];
    ids.push(id);
  });
  ids.push(toId);
  visualPaths[pathId] = ids;
}

function toLivePayload(targetKey, target, routeJson, shapeGeojson) {
  const item = routeJson.items && routeJson.items[0];
  if (!item) throw new Error("NAVITIME response has no route item");

  const sections = item.sections || [];
  const visualPoints = {};
  const visualPaths = {};
  const legs = [];
  const statusEvents = [];
  const shapeFeatures = Array.isArray(shapeGeojson.features) ? shapeGeojson.features : [];
  let shapeCursor = 0;
  let previousPoint = null;
  let previousPointId = null;
  let pointCounter = 0;

  sections.forEach(section => {
    if (section.type === "point") {
      const id = pointId(targetKey, pointCounter++, section);
      visualPoints[id] = [section.coord.lat, section.coord.lon];
      previousPoint = section;
      previousPointId = id;
      return;
    }

    if (section.type !== "move" || !previousPoint) return;
    const nextPoint = sections.slice(sections.indexOf(section) + 1).find(s => s.type === "point");
    if (!nextPoint) return;
    const nextId = pointId(targetKey, pointCounter++, nextPoint);
    visualPoints[nextId] = [nextPoint.coord.lat, nextPoint.coord.lon];
    const pathId = `live_${targetKey}_path_${legs.length}`;

    const type = classifyMove(section);
    const overridePath = displayPathOverride(targetKey, section, previousPoint, nextPoint, type);
    const shapePath = overridePath
      ? { points: overridePath, nextCursor: shapeCursor + 1 }
      : shapePathForLeg(shapeFeatures, shapeCursor, previousPoint.coord, nextPoint.coord, type);
    shapeCursor = shapePath.nextCursor;
    addDetailedVisualPath(targetKey, visualPoints, visualPaths, pathId, pointCounter, previousPointId, nextId, shapePath.points);
    pointCounter += shapePath.points.length;

    const line = section.transport ? section.transport.name : "徒歩";
    const dep = hhmm(section.from_time);
    const arr = hhmm(section.to_time);
    legs.push({
      type,
      mode: type === "air" ? "domestic_flight" : type === "shinkansen" ? "superexpress_train" : "live_navitime",
      line,
      from: previousPoint.name,
      to: nextPoint.name,
      dep,
      arr,
      visual_path_id: pathId
    });
    statusEvents.push({
      time: dep,
      label: `${target.prefecture} ${line}`,
      priority: type === "air" ? 4 : type === "shinkansen" ? 3 : 2
    });

    previousPoint = nextPoint;
    previousPointId = nextId;
  });

  const summary = item.summary.move;
  const arrivalLabel = hhmm(summary.to_time);
  statusEvents.push({ time: arrivalLabel, label: `${target.name} 着弾`, priority: 3 });

  return {
    mode: "live_navitime_memory_only",
    generated_at: new Date().toISOString(),
    start_time: START_TIME,
    prefecture: target.prefecture,
    place: {
      prefecture: target.prefecture,
      name: target.name,
      lat: target.lat,
      lng: target.lon,
      duration_minutes: summary.time,
      arrival_label: arrivalLabel,
      rank: 0,
      route_type: summary.move_type && summary.move_type.includes("domestic_flight")
        ? "air"
        : summary.move_type && summary.move_type.includes("superexpress_train")
          ? "shinkansen"
          : "rail",
      time_bucket: "live",
      source_quality: "NAVITIME live response, memory only",
      legs,
      status_events: statusEvents
    },
    visual_points: visualPoints,
    visual_paths: visualPaths,
    route_geojson: shapeGeojson,
    diagnostics: {
      total_minutes: summary.time,
      arrival_label: arrivalLabel,
      transit_count: summary.transit_count,
      move_type: summary.move_type,
      shape_features: Array.isArray(shapeGeojson.features) ? shapeGeojson.features.length : 0,
      transports: legs.filter(leg => leg.line !== "徒歩").map(leg => ({
        type: leg.type,
        line: leg.line,
        dep: leg.dep,
        arr: leg.arr
      })),
      visual_path_points: Object.fromEntries(Object.entries(visualPaths).map(([id, ids]) => [id, ids.length]))
    }
  };
}

async function navitimeGet(endpoint, params) {
  if (!apiKey) throw new Error("NAVITIME_API_KEY is missing in .env");
  const cacheKey = JSON.stringify({ endpoint, params });
  const cached = cacheGet(cacheKey);
  if (cached) {
    console.log(`[memory-cache hit] ${endpoint}`);
    return cached;
  }
  const waitMs = Math.max(0, lastRequestAt + REQUEST_INTERVAL_MS - Date.now());
  if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
  lastRequestAt = Date.now();
  const url = new URL(`${API_BASE}/${endpoint}`);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  console.log(`[navitime fetch] ${endpoint}`);
  const response = await fetch(url, {
    headers: {
      "x-rapidapi-host": HOST,
      "x-rapidapi-key": apiKey
    }
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`NAVITIME ${endpoint} failed: ${response.status} ${text.slice(0, 240)}`);
  }
  const json = JSON.parse(text);
  cacheSet(cacheKey, json);
  return json;
}

async function fetchTarget(targetKey) {
  const target = TARGETS[targetKey];
  if (!target) throw new Error(`Unknown target: ${targetKey}`);
  const common = {
    start: JSON.stringify(TOKYO_STATION),
    goal: JSON.stringify({ lat: target.lat, lon: target.lon, name: target.name }),
    start_time: START_TIME,
    shape_color: "railway_line"
  };
  const [routeJson, shapeGeojson] = await Promise.all([
    navitimeGet("route_transit", { ...common, shape: "true" }),
    navitimeGet("shape_transit", { ...common, format: "geojson", options: "transport_shape" })
  ]);
  return toLivePayload(targetKey, target, routeJson, shapeGeojson);
}

async function fetchTargets(targetKeys) {
  const routes = [];
  for (const key of targetKeys) {
    routes.push(await fetchTarget(key));
  }
  return combinePayloads(routes);
}

function combinePayloads(routes) {
  const features = [];
  const visualPoints = {};
  const visualPaths = {};
  routes.forEach(route => {
    Object.assign(visualPoints, route.visual_points);
    Object.assign(visualPaths, route.visual_paths);
    const routeFeatures = route.route_geojson && Array.isArray(route.route_geojson.features)
      ? route.route_geojson.features
      : [];
    routeFeatures.forEach(feature => {
      features.push({
        ...feature,
        properties: {
          ...(feature.properties || {}),
          prefecture: route.prefecture
        }
      });
    });
  });
  return {
    mode: "live_navitime_memory_only",
    generated_at: new Date().toISOString(),
    start_time: START_TIME,
    prefecture: routes.length === 1 ? routes[0].prefecture : null,
    prefectures: routes.map(route => route.prefecture),
    place: routes.length === 1 ? routes[0].place : null,
    places: routes.map(route => route.place),
    visual_points: visualPoints,
    visual_paths: visualPaths,
    route_geojson: {
      type: "FeatureCollection",
      features
    },
    diagnostics: {
      count: routes.length,
      routes: routes.map(route => ({
        prefecture: route.prefecture,
        total_minutes: route.diagnostics.total_minutes,
        arrival_label: route.diagnostics.arrival_label,
        transit_count: route.diagnostics.transit_count,
        move_type: route.diagnostics.move_type,
        shape_features: route.diagnostics.shape_features,
        transports: route.diagnostics.transports
      }))
    }
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }
  const requestUrl = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  if (requestUrl.pathname === "/health") {
    sendJson(res, 200, { ok: true, mode: "memory_only" });
    return;
  }
  if (requestUrl.pathname !== "/api/navitime/fukuoka" && requestUrl.pathname !== "/api/navitime/sample") {
    sendJson(res, 404, { error: "not_found" });
    return;
  }
  try {
    const targetParam = requestUrl.searchParams.get("targets");
    const targetKeys = requestUrl.pathname === "/api/navitime/fukuoka"
      ? ["fukuoka"]
      : targetParam === "all"
        ? ALL_TARGET_KEYS
        : (targetParam || SAMPLE_TARGETS.join(",")).split(",").map(v => v.trim()).filter(Boolean);
    const payload = await fetchTargets(targetKeys);
    sendJson(res, 200, payload);
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(PORT, BIND_HOST, () => {
  console.log(`NAVITIME live proxy listening on http://${BIND_HOST}:${PORT}`);
  console.log("Responses are transformed in memory and are not written to disk.");
  console.log(`Memory cache TTL: ${Math.round(CACHE_TTL_MS / 1000)}s; cleared when this process exits.`);
  console.log(`NAVITIME request interval: ${REQUEST_INTERVAL_MS}ms.`);
});
