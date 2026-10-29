"use strict";
// Owns settings, history and every download. Each download gets its own native helper process.

const HOST = "yt_dlp_host";
const DEFAULTS = { height: "0", subs: true, audio: "high", idInName: false, login: false,
                   maxConcurrent: 2, theme: "system", accent: "ember", motion: true };
const CHOICES = {
  height: ["0", "4320", "2160", "1440", "1080", "720", "480", "360"],
  audio: ["low", "medium", "high", "super"],
  theme: ["system", "light", "dark"],
  accent: ["ember", "ocean", "violet", "forest", "graphite"],
};
const ACTIVE = ["queued", "running"];

let settings = { ...DEFAULTS };
let history = [];
let jobs = [];
let nextId = 1;
let helper = { status: "unknown" };
const ports = new Map();
const timers = new Map();
const streams = new Map();

const ready = (async () => {
  try {
    const s = await browser.storage.local.get({ settings: {}, history: [] });
    settings = { ...DEFAULTS, ...clean(s.settings || {}) };
    history = Array.isArray(s.history) ? s.history.slice(0, 50) : [];
  } catch (e) {}
})();

function clean(p) {
  const o = {};
  for (const k of Object.keys(CHOICES)) if (k in p && CHOICES[k].includes(String(p[k]))) o[k] = String(p[k]);
  for (const k of ["subs", "idInName", "login", "motion"]) if (k in p) o[k] = !!p[k];
  if ("maxConcurrent" in p) { const n = parseInt(p.maxConcurrent, 10); if (n >= 1 && n <= 3) o.maxConcurrent = n; }
  return o;
}

const snap = () => ({ jobs: jobs.map((j) => ({ ...j })), history, settings, helper });
const emit = () => browser.runtime.sendMessage({ type: "update", data: snap() }).catch(() => {});
function upd(j, p) { Object.assign(j, p); emit(); }
const jobById = (id) => jobs.find((j) => j.id === id);

function notify(title, message) {
  browser.notifications.create("ytdlp-launcher-" + title, {
    type: "basic", iconUrl: browser.runtime.getURL("icons/icon-96.png"), title,
    message: String(message || "").slice(0, 200),
  }).catch(() => {});
}

function addHistory(j) {
  history.unshift({ id: j.id + "-" + j.finishedAt, videoId: j.videoId, title: j.title, ok: j.phase === "done",
                    message: j.message, filePath: j.filePath, height: j.height, finishedAt: j.finishedAt });
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
  Object.assign(j, { phase, stage: "", speed: "", eta: "", percent: r.ok ? 100 : j.percent,
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
    upd(j, { percent: parseFloat(m[1]), speed: sp ? sp[1] : "", eta: eta ? eta[1] : "" });
  } else if (line.startsWith("[download] Destination:")) {
    if (/\.(vtt|srt|ttml|json3|srv\d|ass|lrc)\s*$/i.test(line)) return;
    const n = (streams.get(j.id) || 0) + 1; streams.set(j.id, n);
    upd(j, { stage: n === 1 ? "Downloading video" : "Downloading audio", percent: 0, speed: "", eta: "" });
  } else {
    const stage = /has already been downloaded/.test(line) ? "Already downloaded"
      : /^\[info\].*subtitle/i.test(line) ? "Getting captions"
      : /^\[youtube\]/.test(line) ? "Reading video info"
      : /^\[Merger\]/.test(line) ? "Merging video and audio"
      : /^\[EmbedSubtitle\]/.test(line) ? "Embedding captions"
      : /^\[Metadata\]/.test(line) ? "Writing metadata"
      : /^\[(EmbedThumbnail|ThumbnailsConvertor)\]/.test(line) ? "Embedding thumbnail"
      : /^\[VideoRemuxer\]/.test(line) ? "Finishing up"
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
    port.postMessage({ action: "download", url: j.url, height: j.height, subs: j.subs,
                       audio: settings.audio, idInName: settings.idInName, login: settings.login });
  } catch (e) {
    finish(j, { ok: false, message: "Couldn't start the helper.", detail: String((e && e.message) || e) });
  }
}

function pump() {
  let free = Math.max(1, settings.maxConcurrent) - jobs.filter((j) => j.phase === "running").length;
  for (const j of jobs.slice()) { if (free <= 0) break; if (j.phase === "queued") { launch(j); free--; } }
}

function start(req) {
  const m = /^https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})$/.exec(String(req.url || ""));
  if (!m) return null;
  const dup = jobs.find((j) => j.videoId === m[1] && ACTIVE.includes(j.phase));
  if (dup) return dup.id;
  jobs = jobs.filter((j) => !(j.videoId === m[1]));           // only the newest job per video is kept
  const h = CHOICES.height.includes(String(req.height)) ? parseInt(req.height, 10) : 0;
  const j = { id: nextId++, url: req.url, videoId: m[1], title: String(req.title || "YouTube video").slice(0, 200),
              height: h, subs: !!req.subs, phase: "queued", stage: "Queued", percent: null, speed: "", eta: "",
              message: "", detail: "", filePath: "", createdAt: Date.now() };
  jobs.push(j);
  pump(); emit();
  return j.id;
}

function cancel(id) {
  const j = jobById(id);
  if (!j) return;
  if (j.phase === "queued") { Object.assign(j, { phase: "cancelled", stage: "", finishedAt: Date.now() }); emit(); return; }
  const port = ports.get(id);
  if (j.phase !== "running" || !port) return;
  upd(j, { stage: "Cancelling", percent: null, speed: "", eta: "" });
  try { port.postMessage({ action: "cancel" }); } catch (e) {}
  // If the helper doesn't answer, drop the connection; the helper stops yt-dlp when it closes.
  timers.set(id, setTimeout(() => { if (j.phase === "running") finish(j, { ok: false, cancelled: true, message: "Download cancelled." }); }, 6000));
}

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

browser.runtime.onMessage.addListener((msg) => {
  switch (msg && msg.type) {
    case "getAll":       return ready.then(snap);
    case "checkHelper":  return checkHelper();
    case "start":        return ready.then(() => ({ id: start(msg.job || {}) }));
    case "cancel":       cancel(msg.id); return Promise.resolve(true);
    case "dismiss":      jobs = jobs.filter((j) => j.id !== msg.id || ACTIVE.includes(j.phase)); emit(); return Promise.resolve(true);
    case "reveal":       return reveal(msg.path);
    case "setSettings":  return setSettings(msg.patch);
    case "resetSettings": return setSettings(DEFAULTS);
    case "clearHistory": history = []; browser.storage.local.set({ history }).catch(() => {}); emit(); return Promise.resolve(true);
    case "removeHistory": history = history.filter((h) => h.id !== msg.id); browser.storage.local.set({ history }).catch(() => {}); emit(); return Promise.resolve(true);
  }
});
