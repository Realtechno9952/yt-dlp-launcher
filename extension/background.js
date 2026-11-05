"use strict";
// Owns settings, history, updates and every download. Each download gets its own native helper process.

const HOST = "yt_dlp_host";
const REPOS = { launcher: "Realtechno9952/yt-dlp-launcher", ytdlp: "yt-dlp/yt-dlp", ffmpeg: "yt-dlp/FFmpeg-Builds" };
const RELEASES_URL = "https://github.com/Realtechno9952/yt-dlp-launcher/releases";
const FFMPEG_STALE_DAYS = 30;   // ffmpeg builds come out daily, so only flag a build this much older than the newest
const DEFAULTS = {
  height: "0", subs: true, audio: "high", idInName: false, login: false, maxConcurrent: 2,
  theme: "system", accent: "ember", motion: true, labels: true,
  thumb: true, meta: true, desc: true, chapters: true, sponsor: false, infoJson: false, subLangs: "en",
  ext: "mkv", folder: "", clipTool: false, clipAccurate: true, thumbFmt: "png", playlistMax: 100,
  checkUpdates: true, advOpen: false,
};
const CHOICES = {
  height: ["0", "4320", "2160", "1440", "1080", "720", "480", "360"],
  audio: ["low", "medium", "high", "super"],
  theme: ["system", "light", "dark"],
  accent: ["ember", "ocean", "violet", "forest", "graphite", "clear"],
  ext: ["mkv", "mp4", "webm", "mp3", "m4a", "opus", "flac"],
  thumbFmt: ["png", "jpg", "jpeg", "webp", "jxl"],
};
const BOOLS = ["subs", "idInName", "login", "motion", "labels", "thumb", "meta", "desc", "chapters", "sponsor", "infoJson", "clipTool", "clipAccurate", "checkUpdates", "advOpen"];
const ACTIVE = ["queued", "running"];

let settings = { ...DEFAULTS };
let history = [];
let jobs = [];
let nextId = 1;
let helper = { status: "unknown" };
let updates = { checkedAt: 0, checking: false, any: false, ytdlp: null, ffmpeg: null, launcher: null };
let op = { running: false, target: "", line: "", ok: null, message: "" };
const ports = new Map();
const timers = new Map();
const streams = new Map();

const ready = (async () => {
  try {
    const s = await browser.storage.local.get({ settings: {}, history: [], updates: null });
    settings = { ...DEFAULTS, ...clean(s.settings || {}) };
    history = Array.isArray(s.history) ? s.history.slice(0, 50) : [];
    if (s.updates && typeof s.updates === "object") updates = { ...updates, ...s.updates, checking: false };
  } catch (e) {}
})();

function clean(p) {
  const o = {};
  for (const k of Object.keys(CHOICES)) if (k in p && CHOICES[k].includes(String(p[k]))) o[k] = String(p[k]);
  for (const k of BOOLS) if (k in p) o[k] = !!p[k];
  if ("maxConcurrent" in p) { const n = parseInt(p.maxConcurrent, 10); if (n >= 1 && n <= 3) o.maxConcurrent = n; }
  if ("playlistMax" in p) { const n = parseInt(p.playlistMax, 10); if (n >= 0 && n <= 1000) o.playlistMax = n; }
  if ("subLangs" in p) { const s = String(p.subLangs).trim(); if (/^[A-Za-z0-9*_.,-]{1,60}$/.test(s)) o.subLangs = s; }
  if ("folder" in p) { const f = String(p.folder).trim(); if (f === "" || (f.length <= 260 && !/["<>|?*\u0000-\u001f]/.test(f))) o.folder = f; }
  return o;
}
function cleanClip(c) {
  if (!c) return null;
  const s = Number(c.start), e = Number(c.end);
  if (!(s >= 0) || !(e > s) || e > 86400) return null;
  return { start: Math.floor(s), end: Math.ceil(e) };
}

const snap = () => ({ jobs: jobs.map((j) => ({ ...j })), history, settings, helper, updates, op, version: browser.runtime.getManifest().version, releasesUrl: RELEASES_URL });
const emit = () => { browser.runtime.sendMessage({ type: "update", data: snap() }).catch(() => {}); refreshIndicators(); };
function upd(j, p) { Object.assign(j, p); emit(); }
const jobById = (id) => jobs.find((j) => j.id === id);

function notify(title, message) {
  browser.notifications.create("ytdlp-launcher-" + title, {
    type: "basic", iconUrl: browser.runtime.getURL("icons/icon-96.png"), title,
    message: String(message || "").slice(0, 200),
  }).catch(() => {});
}

/* ---------- toolbar: active-download badge + red "update" dot ---------- */
let lastBadge = null, lastDot = null;
function loadImage(src) { return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; }); }
async function drawIcon(dot) {
  try {
    if (!dot) { await browser.browserAction.setIcon({ path: { 16: "icons/icon-16.png", 32: "icons/icon-32.png" } }); return; }
    const img = await loadImage(browser.runtime.getURL("icons/icon-96.png"));
    const imageData = {};
    for (const s of [16, 32, 48]) {
      const c = document.createElement("canvas"); c.width = c.height = s;
      const x = c.getContext("2d");
      x.drawImage(img, 0, 0, s, s);
      const r = Math.max(3, s * 0.2), cx = s - r - s * 0.04, cy = r + s * 0.04;
      x.beginPath(); x.arc(cx, cy, r + Math.max(1, s * 0.07), 0, Math.PI * 2); x.fillStyle = "#ffffff"; x.fill();
      x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.fillStyle = "#e5173f"; x.fill();
      imageData[s] = x.getImageData(0, 0, s, s);
    }
    await browser.browserAction.setIcon({ imageData });
  } catch (e) {}
}
function refreshIndicators() {
  try {
    const n = jobs.filter((j) => ACTIVE.includes(j.phase)).length, text = n ? String(n) : "";
    if (text !== lastBadge) {
      lastBadge = text;
      browser.browserAction.setBadgeText({ text });
      if (n) {
        browser.browserAction.setBadgeBackgroundColor({ color: "#d93a12" });
        try { browser.browserAction.setBadgeTextColor({ color: "#ffffff" }); } catch (e) {}
      }
    }
    const dot = !!updates.any;
    if (dot !== lastDot) { lastDot = dot; drawIcon(dot); }
  } catch (e) {}
}

/* ---------- history ---------- */
function addHistory(j) {
  history.unshift({ id: j.id + "-" + j.finishedAt, key: j.key, videoId: j.videoId, url: j.url, site: j.site, thumb: j.thumb, title: j.title,
                    ok: j.phase === "done", message: j.message, filePath: j.filePath, height: j.height, ext: j.ext, subs: j.subs,
                    playlist: j.playlist, clip: j.clip, finishedAt: j.finishedAt });
  history = history.slice(0, 50);
  browser.storage.local.set({ history }).catch(() => {});
}

function prune() {
  const done = jobs.filter((j) => !ACTIVE.includes(j.phase));
  if (done.length > 20) { const drop = new Set(done.slice(0, done.length - 20).map((j) => j.id)); jobs = jobs.filter((j) => !drop.has(j.id)); }
}

function finish(j, r) {
  clearTimeout(timers.get(j.id)); timers.delete(j.id);
  const phase = r.cancelled ? "cancelled" : r.ok ? "done" : "error";
  Object.assign(j, { phase, stage: "", speed: "", eta: "", percent: r.ok ? 100 : j.percent, overall: r.ok ? 100 : j.overall,
                     message: r.message || "", detail: r.detail || "", filePath: r.filePath || "", finishedAt: Date.now() });
  const p = ports.get(j.id); ports.delete(j.id);
  if (p) { try { p.disconnect(); } catch (e) {} }
  if (phase === "done") { addHistory(j); notify("Download finished", j.title); }
  if (phase === "error") { addHistory(j); notify("Download failed", r.message); }
  prune(); pump(); emit();
}

function onLog(j, line) {
  let m;
  if ((m = /^\[download\]\s+([\d.]+)%/.exec(line))) {
    const sp = /\bat\s+(\d\S*\/s)/.exec(line), eta = /\bETA\s+(\d\S*)/.exec(line);
    const percent = parseFloat(m[1]);
    const overall = j.item ? Math.min(100, ((j.item.index - 1 + percent / 100) / j.item.total) * 100) : null;
    upd(j, { percent, overall, speed: sp ? sp[1] : "", eta: eta ? eta[1] : "" });
  } else if ((m = /^\[download\] Downloading item (\d+) of (\d+)/.exec(line))) {
    streams.set(j.id, 0);
    const index = +m[1], total = Math.max(1, +m[2]);
    upd(j, { item: { index, total }, percent: 0, overall: ((index - 1) / total) * 100, speed: "", eta: "", stage: "Reading video info" });
  } else if ((m = /^\[download\] Downloading playlist: (.+)$/.exec(line))) {
    upd(j, { title: m[1].slice(0, 200) });
  } else if (line.startsWith("[download] Destination:")) {
    if (/\.(vtt|srt|ttml|json3|srv\d|ass|lrc|jpg|jpeg|png|webp)\s*$/i.test(line)) return;
    const n = (streams.get(j.id) || 0) + 1; streams.set(j.id, n);
    const audioOnly = ["mp3", "m4a", "opus", "flac"].includes(j.ext);
    upd(j, { stage: n === 1 && !audioOnly ? "Downloading video" : n === 1 ? "Downloading audio" : "Downloading audio", percent: 0, speed: "", eta: "" });
  } else {
    const stage = /has already been downloaded/.test(line) ? "Already downloaded"
      : /^\[info\].*subtitle/i.test(line) ? "Getting captions"
      : /^\[[A-Za-z0-9:]+\] [^:]+: Downloading/.test(line) && !/^\[download\]/.test(line) ? "Reading video info"
      : /^\[Merger\]/.test(line) ? "Merging video and audio"
      : /^\[ExtractAudio\]/.test(line) ? "Converting audio"
      : /^\[EmbedSubtitle\]/.test(line) ? "Embedding captions"
      : /^\[Metadata\]/.test(line) ? "Writing metadata"
      : /^\[(EmbedThumbnail|ThumbnailsConvertor)\]/.test(line) ? "Embedding thumbnail"
      : /^\[(VideoRemuxer|FFmpegVideoRemuxer)\]/.test(line) ? "Finishing up"
      : /^\[SponsorBlock\]/.test(line) ? "Checking SponsorBlock"
      : /^Captions were blocked/.test(line) ? "Retrying without captions" : "";
    if (stage) { if (/^Retrying/.test(stage)) streams.set(j.id, 0); upd(j, { stage, percent: null, speed: "", eta: "" }); }
  }
}

function launch(j) {
  Object.assign(j, { phase: "running", stage: "Starting" });
  streams.set(j.id, 0);
  try {
    const port = browser.runtime.connectNative(HOST);
    ports.set(j.id, port);
    port.onMessage.addListener((m) => { if (m.type === "log") onLog(j, String(m.line || "")); else if (m.type === "done") finish(j, m); });
    port.onDisconnect.addListener((p) => {
      if (ports.get(j.id) !== p) return;
      ports.delete(j.id);
      if (j.phase !== "running") return;
      const err = (p.error && p.error.message) || "";
      helper = { status: "unknown" };
      finish(j, { ok: false, detail: err,
        message: /no such native application/i.test(err)
          ? "The helper isn't installed. Run host\\install.ps1, then reload the extension."
          : "The helper stopped unexpectedly." });
    });
    port.postMessage({
      action: "download", url: j.url, height: j.height, subs: j.subs, ext: j.ext, playlist: j.playlist, clip: j.clip,
      audio: settings.audio, idInName: settings.idInName, login: settings.login, folder: settings.folder,
      thumb: settings.thumb, meta: settings.meta, desc: settings.desc, chapters: settings.chapters, sponsor: settings.sponsor,
      infoJson: settings.infoJson, subLangs: settings.subLangs, playlistMax: settings.playlistMax, clipAccurate: settings.clipAccurate,
    });
  } catch (e) {
    finish(j, { ok: false, message: "Couldn't start the helper.", detail: String((e && e.message) || e) });
  }
}

function pump() {
  let free = Math.max(1, settings.maxConcurrent) - jobs.filter((j) => j.phase === "running").length;
  for (const j of jobs.slice()) { if (free <= 0) break; if (j.phase === "queued") { launch(j); free--; } }
}

function start(req) {
  if (op.running) return { error: "An update is running. Try again in a moment." };
  const t = YTL.parse(req.url, req.title);
  if (!t) return { error: "That page can't be downloaded." };
  const asList = !!req.playlist && (t.kind === "playlist" || !!t.listId);
  const fromVideo = asList && t.kind === "video";
  const key = fromVideo ? "ytl:" + t.listId : t.key;
  const url = fromVideo ? "https://www.youtube.com/playlist?list=" + t.listId : t.url;
  const dup = jobs.find((j) => j.key === key && ACTIVE.includes(j.phase));
  if (dup) return { id: dup.id };
  jobs = jobs.filter((j) => j.key !== key);                       // only the newest job per video is kept
  const h = CHOICES.height.includes(String(req.height)) ? parseInt(req.height, 10) : parseInt(settings.height, 10);
  const j = {
    id: nextId++, key, kind: asList ? "playlist" : t.kind, site: t.site, url, videoId: t.videoId || "",
    thumb: /^https?:\/\/[^\s"<>]{1,500}$/.test(String(req.thumb || "")) ? String(req.thumb) : "",
    title: String(req.title || t.title || "Video").slice(0, 200), height: h, subs: !!req.subs,
    ext: CHOICES.ext.includes(String(req.ext)) ? String(req.ext) : settings.ext,
    playlist: asList, clip: asList ? null : cleanClip(req.clip),
    phase: "queued", stage: "Queued", percent: null, overall: null, item: null, speed: "", eta: "",
    message: "", detail: "", filePath: "", createdAt: Date.now(),
  };
  jobs.push(j);
  pump(); emit();
  return { id: j.id };
}

function again(hid) {
  const h = history.find((x) => x.id === hid);
  if (!h || !h.url) return { error: "That download can't be repeated." };
  return start({ url: h.url, title: h.title, height: h.height, subs: h.subs !== false, playlist: !!h.playlist, clip: h.clip || null, thumb: h.thumb, ext: h.ext });
}

function cancel(id) {
  const j = jobById(id);
  if (!j) return;
  if (j.phase === "queued") { Object.assign(j, { phase: "cancelled", stage: "", finishedAt: Date.now() }); emit(); return; }
  const port = ports.get(id);
  if (j.phase !== "running" || !port) return;
  upd(j, { stage: "Cancelling", percent: null, overall: null, speed: "", eta: "" });
  try { port.postMessage({ action: "cancel" }); } catch (e) {}
  // If the helper doesn't answer, drop the connection; the helper stops yt-dlp when it closes.
  timers.set(id, setTimeout(() => { if (j.phase === "running") finish(j, { ok: false, cancelled: true, message: "Download cancelled." }); }, 6000));
}

/* ---------- helper + folders + thumbnails ---------- */
async function checkHelper() {
  if (helper.status !== "ok") {
    try {
      const res = await browser.runtime.sendNativeMessage(HOST, { action: "check" });
      if (res && res.ok) helper = { status: "ok", ytdlp: res.ytdlp, ffmpeg: res.ffmpeg !== false };
      else if (res && res.type === "check") helper = { status: "error", reason: "ytdlp", message: res.message || "yt-dlp was not found.", detail: res.detail || "" };
      else { const m = (res && res.message) || "The helper reported a problem."; helper = { status: "error", reason: "helper", message: m, detail: m }; }
    } catch (e) {
      const m = String((e && e.message) || e);
      helper = { status: "error", reason: "helper", message: m, detail: m };
    }
    emit();
  }
  return helper;
}

async function reveal(path) {
  let res = null;
  try { res = await browser.runtime.sendNativeMessage(HOST, { action: "reveal", path: String(path || "") }); } catch (e) {}
  if (res && res.ok) return { ok: true };
  try { await browser.downloads.showDefaultFolder(); return { ok: true, fallback: true }; } catch (e) {}
  return { ok: false, message: (res && res.message) || "Couldn't open the folder." };
}

async function setSettings(patch) {
  await ready;
  settings = { ...settings, ...clean(patch || {}) };
  browser.storage.local.set({ settings }).catch(() => {});
  pump(); emit();
  return settings;
}

async function setFolder(path) {
  await ready;
  path = String(path || "").trim();
  if (!path) { await setSettings({ folder: "" }); return { ok: true, path: "" }; }
  if (!("folder" in clean({ folder: path }))) return { ok: false, message: "That isn't a valid folder path." };
  try {
    const res = await browser.runtime.sendNativeMessage(HOST, { action: "checkfolder", path });
    if (res && res.ok) { await setSettings({ folder: res.path }); return { ok: true, path: res.path }; }
    return { ok: false, message: (res && res.message) || "That folder can't be used." };
  } catch (e) { return { ok: false, message: "The helper isn't available." }; }
}

async function pickFolder() {
  await ready;
  try {
    const res = await browser.runtime.sendNativeMessage(HOST, { action: "pickfolder", start: settings.folder });
    if (res && res.ok && res.path) return setFolder(res.path);
    return { ok: false, cancelled: !!(res && res.cancelled), message: (res && res.message) || "" };
  } catch (e) { return { ok: false, message: "The helper isn't available." }; }
}

async function thumbnail(req) {
  await ready;
  const t = YTL.parse(req.url, req.title);
  if (!t || t.kind === "playlist") return { ok: false, message: "There's no thumbnail to save here." };
  try {
    const res = await browser.runtime.sendNativeMessage(HOST, { action: "thumbnail", url: t.url, format: settings.thumbFmt, folder: settings.folder });
    if (res && res.ok) { notify("Thumbnail saved", res.name || ""); return { ok: true, name: res.name, filePath: res.filePath }; }
    return { ok: false, message: (res && res.message) || "Couldn't save the thumbnail." };
  } catch (e) { return { ok: false, message: "The helper isn't available." }; }
}

/* ---------- updates: yt-dlp, ffmpeg and this extension ---------- */
const vparts = (s) => (String(s || "").match(/\d+/g) || []).map(Number);
function newer(a, b, n) {
  const x = vparts(a), y = vparts(b), len = n || Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) { const p = x[i] || 0, q = y[i] || 0; if (p !== q) return p > q; }
  return false;
}
const fmtDate = (ms) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

async function ghLatest(repo) {
  const r = await fetch("https://api.github.com/repos/" + repo + "/releases/latest", { headers: { Accept: "application/vnd.github+json" }, cache: "no-store" });
  if (r.status === 404) return { none: true };
  if (!r.ok) throw new Error(r.status === 403 ? "GitHub rate limit, try again later" : "GitHub answered " + r.status);
  return r.json();
}
const reason = (r) => String((r.reason && r.reason.message) || r.reason || "unknown error");

function judgeYtdlp(installed, g) {
  if (g.status !== "fulfilled") return { installed: installed || "", latest: "", available: false, text: "Couldn't check: " + reason(g) };
  const latest = g.value && g.value.tag_name ? String(g.value.tag_name).replace(/^v/, "") : "";
  if (!installed) return { installed: "", latest, available: false, text: "Not found by the helper" };
  const available = !!latest && newer(latest, installed, 3);
  return { installed, latest, available, text: available ? installed + " \u2192 " + latest : "Up to date (" + installed + ")" };
}
function judgeFfmpeg(installed, g) {
  if (g.status !== "fulfilled") return { installed: installed || "", latest: "", available: false, text: "Couldn't check: " + reason(g) };
  if (!installed) return { installed: "", latest: "", available: false, text: "Not found by the helper" };
  const m = /-(\d{4})(\d{2})(\d{2})$/.exec(installed);
  const has = m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null;
  const rel = g.value && g.value.published_at ? Date.parse(g.value.published_at) : null;
  if (!has || !rel) return { installed, latest: "", available: false, text: "Installed: " + installed };
  const available = (rel - has) / 86400000 >= FFMPEG_STALE_DAYS;
  return { installed, latest: fmtDate(rel), available, text: available ? "Build from " + fmtDate(has) + ", newer one available" : "Up to date (build from " + fmtDate(has) + ")" };
}
function judgeLauncher(g) {
  const installed = browser.runtime.getManifest().version;
  if (g.status !== "fulfilled") return { installed, latest: "", available: false, url: RELEASES_URL, text: "Couldn't check: " + reason(g) };
  if (g.value && g.value.none) return { installed, latest: "", available: false, url: RELEASES_URL, text: "v" + installed + " (no releases published yet)" };
  const latest = String((g.value && g.value.tag_name) || "").replace(/^v/i, "");
  const available = !!latest && newer(latest, installed);
  return { installed, latest, available, url: (g.value && g.value.html_url) || RELEASES_URL, text: available ? "v" + installed + " \u2192 v" + latest : "Up to date (v" + installed + ")" };
}

async function checkUpdates() {
  await ready;
  if (updates.checking) return updates;
  updates = { ...updates, checking: true }; emit();
  const [inst, gy, gf, gl] = await Promise.allSettled([
    browser.runtime.sendNativeMessage(HOST, { action: "versions" }), ghLatest(REPOS.ytdlp), ghLatest(REPOS.ffmpeg), ghLatest(REPOS.launcher),
  ]);
  const iv = inst.status === "fulfilled" && inst.value && inst.value.type === "versions" ? inst.value : {};
  const out = { checking: false, checkedAt: Date.now(), ytdlp: judgeYtdlp(iv.ytdlp, gy), ffmpeg: judgeFfmpeg(iv.ffmpeg, gf), launcher: judgeLauncher(gl), winget: !!iv.winget };
  out.any = !!(out.ytdlp.available || out.ffmpeg.available || out.launcher.available);
  updates = out;
  browser.storage.local.set({ updates }).catch(() => {});
  emit();
  return updates;
}

function cleanLine(s) { return String(s || "").replace(/[^\x20-\x7e]/g, " ").replace(/\s+/g, " ").trim().slice(-110); }
function updateTool(target) {
  if (target !== "ytdlp" && target !== "ffmpeg") return Promise.resolve({ ok: false, message: "Unknown update target." });
  if (op.running) return Promise.resolve({ ok: false, message: "An update is already running." });
  if (jobs.some((j) => ACTIVE.includes(j.phase))) return Promise.resolve({ ok: false, message: "Finish or cancel your downloads first." });
  op = { running: true, target, line: "Starting...", ok: null, message: "" }; emit();
  return new Promise((resolve) => {
    let port = null, finished = false;
    const done = (ok, message) => {
      if (finished) return; finished = true;
      op = { running: false, target, line: "", ok, message }; emit();
      if (port) { try { port.disconnect(); } catch (e) {} }
      notify(ok ? "Update finished" : "Update failed", message);
      (ok ? checkUpdates() : Promise.resolve()).then(() => resolve({ ok, message }));
    };
    try { port = browser.runtime.connectNative(HOST); } catch (e) { return done(false, "The helper isn't available."); }
    port.onMessage.addListener((m) => {
      if (m.type === "log") { op = { ...op, line: cleanLine(m.line) || op.line }; emit(); }
      else if (m.type === "done") done(!!m.ok, m.message || "");
    });
    port.onDisconnect.addListener(() => done(false, "The helper stopped unexpectedly."));
    port.postMessage({ action: "update", target });
  });
}

let lastAuto = 0;
async function autoCheck() {
  await ready;
  if (!settings.checkUpdates || Date.now() - lastAuto < 60000) return;
  lastAuto = Date.now();
  await checkUpdates();
}
browser.runtime.onStartup.addListener(autoCheck);
browser.runtime.onInstalled.addListener(autoCheck);
setTimeout(() => { ready.then(() => { if (settings.checkUpdates && Date.now() - (updates.checkedAt || 0) > 12 * 3600 * 1000) autoCheck(); }); }, 5000);
ready.then(() => { lastDot = null; refreshIndicators(); });

/* ---------- keyboard shortcut + right-click menu: "download with my defaults" ---------- */
async function quickDownload(url, title) {
  await ready;
  const t = YTL.parse(url, title);
  if (!t) { notify("Nothing to download", "Open a video page first."); return { ok: false }; }
  const r = start({ url: t.url, title: t.title, height: settings.height, subs: settings.subs, playlist: t.kind === "playlist" });
  if (r.error) { notify("Couldn't start the download", r.error); return { ok: false, message: r.error }; }
  notify("Download started", t.title);
  return { ok: true, id: r.id };
}
try {
  browser.commands.onCommand.addListener((cmd) => {
    if (cmd !== "download-default") return;
    browser.tabs.query({ active: true, currentWindow: true }).then(([tab]) => quickDownload(tab && tab.url, tab && tab.title));
  });
} catch (e) {}
try {
  browser.menus.create({ id: "ytl-default", title: "Download with yt-dlp (my defaults)", contexts: ["page", "link", "video"] });
  browser.menus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== "ytl-default") return;
    quickDownload(info.linkUrl || info.pageUrl || (tab && tab.url), info.linkUrl ? info.linkText : tab && tab.title);
  });
} catch (e) {}

/* ---------- messages from the popup ---------- */
browser.runtime.onMessage.addListener((msg) => {
  switch (msg && msg.type) {
    case "getAll":        return ready.then(snap);
    case "checkHelper":   return checkHelper();
    case "start":         return ready.then(() => start(msg.job || {}));
    case "again":         return ready.then(() => again(msg.id));
    case "cancel":        cancel(msg.id); return Promise.resolve(true);
    case "dismiss":       jobs = jobs.filter((j) => j.id !== msg.id || ACTIVE.includes(j.phase)); emit(); return Promise.resolve(true);
    case "reveal":        return reveal(msg.path);
    case "thumbnail":     return thumbnail(msg);
    case "setSettings":   return setSettings(msg.patch);
    case "resetSettings": return setSettings(DEFAULTS);
    case "setFolder":     return setFolder(msg.path);
    case "pickFolder":    return pickFolder();
    case "checkUpdates":  return checkUpdates();
    case "updateTool":    return updateTool(msg.target);
    case "clearHistory":  history = []; browser.storage.local.set({ history }).catch(() => {}); emit(); return Promise.resolve(true);
    case "removeHistory": history = history.filter((h) => h.id !== msg.id); browser.storage.local.set({ history }).catch(() => {}); emit(); return Promise.resolve(true);
  }
});
