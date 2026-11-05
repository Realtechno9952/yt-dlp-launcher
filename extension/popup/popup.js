"use strict";
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const send = (m) => browser.runtime.sendMessage(m);
const SVGNS = "http://www.w3.org/2000/svg";
const YTL = window.YTL;

const RES = [["0", "Best", "Highest quality available"], ["4320", "8K", "Up to 4320p"], ["2160", "4K", "Up to 2160p"], ["1440", "1440p"],
             ["1080", "1080p"], ["720", "720p"], ["480", "480p"], ["360", "360p"]];
const AUDIO = [["low", "Low", "About 50 kbps. Smallest files."], ["medium", "Medium", "About 128 kbps, like standard streaming."],
               ["high", "High", "Up to about 160 kbps Opus, YouTube's usual best."], ["super", "Super High", "The highest YouTube offers (256 kbps on some videos)."]];
const THEMES = [["system", "System"], ["light", "Light"], ["dark", "Dark"]];
const CONC = [["1", "1"], ["2", "2"], ["3", "3"]];
const ACCENTS = [["ember", "Ember", "#d93a12", "#b3123f"], ["ocean", "Ocean", "#0a63d8", "#0b3fb0"], ["violet", "Violet", "#7b3fe4", "#a02bc4"],
                 ["forest", "Forest", "#13833a", "#0a6a5a"], ["graphite", "Graphite", "#3d3d4a", "#1f1f29"], ["clear", "Clear", "", ""]];
const EXTS = [["mkv", "MKV"], ["mp4", "MP4"], ["webm", "WebM"], ["mp3", "MP3"], ["m4a", "M4A"], ["opus", "Opus"], ["flac", "FLAC"]];
const THUMBFMTS = [["png", "PNG"], ["jpg", "JPG"], ["jpeg", "JPEG"], ["webp", "WebP"], ["jxl", "JPEG XL"]];
const AUDIO_EXTS = ["mp3", "m4a", "opus", "flac"];
const CIRCLE = "M8 1.75a6.25 6.25 0 1 0 0 12.5 6.25 6.25 0 0 0 0-12.5z";
const ICONS = { good: CIRCLE + "M5.25 8.25l2 2 3.5-4.25", bad: CIRCLE + "M8 4.9v3.9M8 11.2h.01", neutral: CIRCLE + "M5.6 5.6l4.8 4.8" };
const DEFAULT_SETTINGS = {
  height: "0", subs: true, audio: "high", idInName: false, login: false, maxConcurrent: 2, theme: "system", accent: "ember", motion: true, labels: true,
  thumb: true, meta: true, desc: true, chapters: true, sponsor: false, infoJson: false, subLangs: "en", ext: "mkv", folder: "", clipTool: false,
  clipAccurate: true, thumbFmt: "png", playlistMax: 100, checkUpdates: true, advOpen: false,
};
// Runs inside the page: og:image for sites without a known thumbnail, plus the player's current time (for the Clip tool).
const PAGE_CODE = '(function(){var v=document.querySelector("video");function m(p){var e=document.querySelector(\'meta[property="\'+p+\'"],meta[name="\'+p+\'"]\');return e&&e.content||""}return{image:m("og:image")||m("twitter:image"),title:m("og:title")||document.title,time:v?v.currentTime:null,duration:v&&isFinite(v.duration)?v.duration:null}})()';

let tab = { id: 0, target: null, info: null };
let data = { jobs: [], history: [], settings: { ...DEFAULT_SETTINGS }, helper: { status: "unknown" }, updates: {}, op: {}, releasesUrl: "" };
let form = { height: "0", subs: true, playlist: false };
const seen = { height: null, subs: null };
const forceForm = new Set(), forceTry = new Set();
let clipFor = null, clipDuration = 0;
let dock = null, histKey = "", toastTimer = 0;
const cards = new Map();

/* ---------- helpers ---------- */
const thumbUrl = (id) => "https://i.ytimg.com/vi/" + id + "/mqdefault.jpg";
const thumbFor = (t, info) => !t ? "" : t.videoId ? thumbUrl(t.videoId) : info && /^https?:\/\//.test(info.image || "") ? info.image : "";
const jobThumb = (j) => (j.videoId ? thumbUrl(j.videoId) : j.thumb || "");
const show = (id, on) => { $(id).hidden = !on; };
const isActive = (j) => j.phase === "queued" || j.phase === "running";
const extLabel = (e) => (EXTS.find((x) => x[0] === e) || EXTS[0])[1];
const resLabel = (h) => (RES.find((r) => r[0] === String(h)) || RES[0])[1];
const isAudioExt = (e) => AUDIO_EXTS.includes(e);
const shortPath = (p) => { const parts = String(p).split(/[\\/]+/).filter(Boolean); return parts.length > 2 ? "\u2026\\" + parts.slice(-2).join("\\") : String(p); };
function ago(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + " min ago";
  if (s < 86400) return Math.floor(s / 3600) + " h ago";
  return new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60, p = (n) => String(n).padStart(2, "0");
  return h ? h + ":" + p(m) + ":" + p(s) : m + ":" + p(s);
}
// "83", "1:23" or "1:02:03" -> seconds. null = empty, NaN = not a time.
function parseTime(str) {
  const s = String(str || "").trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  const parts = s.split(":");
  if (parts.length < 2 || parts.length > 3 || !parts.every((p) => /^\d+(\.\d+)?$/.test(p))) return NaN;
  const nums = parts.map(Number);
  if (nums.slice(1).some((n) => n >= 60)) return NaN;
  return nums.reduce((acc, n) => acc * 60 + n, 0);
}
function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3400);
}
function icon(d, cls) {
  const s = document.createElementNS(SVGNS, "svg"); s.setAttribute("viewBox", "0 0 16 16"); if (cls) s.setAttribute("class", cls);
  const p = document.createElementNS(SVGNS, "path"); p.setAttribute("d", d); s.append(p); return s;
}
const xIcon = () => icon("M4 4l8 8M12 4l-8 8");
const folderIcon = () => icon("M2 4.5A1.5 1.5 0 0 1 3.5 3h2.8l1.4 1.5h4.8A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z");
const againIcon = () => icon("M13 8a5 5 0 1 1-1.7-3.8M13 2.6v3.2h-3.2");
function setBanner(tone) {
  const svg = $("bannerIcon");
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const p = document.createElementNS(SVGNS, "path"); p.setAttribute("d", ICONS[tone]); svg.append(p);
}
async function pageInfo() {
  try { const r = await browser.tabs.executeScript(tab.id, { code: PAGE_CODE }); return r && r[0] ? r[0] : null; } catch (e) { return null; }
}
async function reveal(path) {
  const r = await send({ type: "reveal", path });
  if (r && r.ok === false) toast(r.message || "Couldn't open the folder.");
  else if (r && r.fallback) toast("Opened your Downloads folder.");
}
const set = (patch) => send({ type: "setSettings", patch });
const checkRadio = (name, value) => document.getElementsByName(name).forEach((i) => { i.checked = i.value === String(value); });
function setData(d) { data = { jobs: [], history: [], updates: {}, op: {}, helper: { status: "unknown" }, releasesUrl: "", ...d, settings: { ...DEFAULT_SETTINGS, ...(d.settings || {}) } }; }

/* ---------- builders (run once) ---------- */
function buildChips(box, name, onPick, items) {
  for (const [value, label, tip] of items || RES) {
    const l = el("label", "chip"); if (tip) l.title = tip;
    const i = el("input"); i.type = "radio"; i.name = name; i.value = value; i.addEventListener("change", () => onPick(value));
    l.append(i, el("span", null, label)); box.append(l);
  }
}
function buildSeg(box, items, name, onPick) {
  box.setAttribute("role", "radiogroup");
  for (const [value, label] of items) {
    const l = el("label", "seg-item");
    const i = el("input"); i.type = "radio"; i.name = name; i.value = value; i.addEventListener("change", () => onPick(value));
    l.append(i, el("span", null, label)); box.append(l);
  }
}
function buildSwatches() {
  for (const [id, label, c1, c2] of ACCENTS) {
    const b = el("button", "sw" + (id === "clear" ? " clear" : "")); b.type = "button"; b.dataset.accent = id; b.title = label;
    b.setAttribute("role", "radio"); b.setAttribute("aria-label", label);
    if (c1) b.style.background = "linear-gradient(135deg," + c1 + "," + c2 + ")";
    b.addEventListener("click", () => set({ accent: id }));
    $("setAccent").append(b);
  }
}

/* ---------- hover tilt on the thumbnail ---------- */
function attachTilt() {
  const box = $("thumbBox"), MAX = 7;
  const still = () => !data.settings.motion || (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  box.addEventListener("pointermove", (e) => {
    if (still()) return;
    const r = box.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const px = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), py = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    // the edge nearest the mouse rises toward you, and the whole card lifts and grows a little
    const ry = (0.5 - px) * 2 * MAX, rx = (py - 0.5) * 2 * MAX;
    box.classList.add("tilting");
    box.style.transform = "translateY(-4px) scale(1.04) rotateX(" + rx.toFixed(2) + "deg) rotateY(" + ry.toFixed(2) + "deg)";
    box.style.setProperty("--gx", (px * 100).toFixed(1) + "%"); box.style.setProperty("--gy", (py * 100).toFixed(1) + "%");
  });
  const leave = () => { box.classList.remove("tilting"); box.style.transform = ""; };
  box.addEventListener("pointerleave", leave);
  box.addEventListener("pointercancel", leave);
}

/* ---------- rendering ---------- */
function applyAppearance() {
  const s = data.settings, root = document.documentElement;
  const dark = s.theme === "dark" || (s.theme === "system" && !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches));
  root.dataset.theme = s.theme; root.dataset.scheme = dark ? "dark" : "light"; root.dataset.accent = s.accent;
  root.dataset.motion = s.motion ? "on" : "off"; root.dataset.labels = s.labels ? "on" : "off";
}
function syncForm() {
  const s = data.settings;
  if (seen.height !== s.height) { form.height = s.height; seen.height = s.height; }
  if (seen.subs !== s.subs) { form.subs = s.subs; seen.subs = s.subs; }
}
function matches(j) {
  const t = tab.target;
  return !!t && (j.key === t.key || (!!t.listId && j.key === "ytl:" + t.listId));
}
function curJob() {
  for (let i = data.jobs.length - 1; i >= 0; i--) if (matches(data.jobs[i])) return data.jobs[i];
  return null;
}

function renderStack() {
  const others = data.jobs.filter((j) => isActive(j) && !matches(j));
  const shown = others.slice(0, 3), box = $("stack");
  box.hidden = !others.length;
  const keep = new Set(shown.map((j) => j.id));
  for (const [id, c] of cards) if (!keep.has(id)) { c.root.remove(); cards.delete(id); }
  for (const j of shown) {
    let c = cards.get(j.id);
    if (!c) {
      const root = el("div", "mini");
      const img = el("img", "mthumb"); img.alt = ""; const u = jobThumb(j);
      if (u) { img.src = u; img.onerror = () => { img.style.visibility = "hidden"; }; } else img.style.visibility = "hidden";
      const info = el("div"), title = el("div", "mtitle"), stat = el("div", "mstat"); info.append(title, stat);
      const x = el("button", "mx"); x.type = "button"; x.title = "Cancel download"; x.setAttribute("aria-label", "Cancel download"); x.append(xIcon());
      x.addEventListener("click", () => send({ type: "cancel", id: j.id }));
      const bar = el("div", "mbar"), fill = el("div", "mfill"); bar.append(fill);
      root.append(img, info, x, bar);
      c = { root, title, stat, fill }; cards.set(j.id, c); box.append(root);
    }
    c.title.textContent = j.title;
    const pct = j.item && typeof j.overall === "number" ? j.overall : j.percent;
    const live = typeof pct === "number" && (/^Downloading/.test(j.stage || "") || !!j.item);
    c.stat.textContent = j.phase === "queued" ? "Queued"
      : live ? [j.item ? "Item " + j.item.index + "/" + j.item.total : "", Math.floor(pct) + "%", j.speed, j.eta && j.eta + " left"].filter(Boolean).join(" \u00b7 ")
      : j.stage || "Working";
    c.fill.style.width = live ? pct + "%" : j.phase === "queued" ? "0" : "100%";
    c.fill.style.opacity = live || j.phase === "queued" ? "1" : ".35";
  }
  let more = $("stackMore");
  if (others.length > 3) {
    if (!more) { more = el("div", "more"); more.id = "stackMore"; box.append(more); }
    more.textContent = "+" + (others.length - 3) + " more in progress";
  } else if (more) more.remove();
}

function setThumb(url) {
  const img = $("thumb"), box = $("thumbBox");
  if (img.dataset.src === url) return;
  img.dataset.src = url;
  box.classList.toggle("no-img", !url);
  img.onerror = () => box.classList.add("no-img");
  img.onload = () => box.classList.remove("no-img");
  if (url) img.src = url; else img.removeAttribute("src");
}

function renderHome() {
  const t = tab.target, h = data.helper, s = data.settings, cur = curJob();
  const known = !!t && (t.known || forceTry.has(t.key));
  let v;
  if (cur && isActive(cur)) v = "busy";
  else if (!t) v = "empty";
  else if (!known && !cur) v = "empty";
  else if (h.status === "error") v = "setup";
  else if (clipFor === t.key && !(cur && !forceForm.has(t.key))) v = "clip";
  else if (cur && !forceForm.has(t.key)) v = "result";
  else v = "form";

  show("card", !!t && v !== "empty");
  if (t) {
    $("title").textContent = t.title; setThumb(thumbFor(t, tab.info));
    const line = t.kind === "playlist" ? "YouTube playlist" : !t.yt ? t.site : "";
    $("siteLine").hidden = !line; $("siteLine").textContent = line;
  }
  for (const id of ["empty", "setup", "form", "clip", "busy", "result"]) show(id, id === v);

  if (v === "empty") {
    const unknown = !!t && !known;
    $("emptyTitle").textContent = unknown ? "Not a known video site" : "Open a video";
    $("emptyMsg").textContent = unknown ? t.site + " isn't on my list, but yt-dlp supports many more sites." : "Then open this panel again to download it.";
    $("tryPage").hidden = !unknown;
  } else if (v === "busy") {
    const pct = cur.item && typeof cur.overall === "number" ? cur.overall : cur.percent;
    const live = typeof pct === "number" && (/^Downloading/.test(cur.stage || "") || !!cur.item);
    const itemText = cur.item ? "Item " + cur.item.index + " of " + cur.item.total + " \u00b7 " : "";
    $("stage").textContent = cur.phase === "queued" ? "Queued" : itemText + (cur.stage || "Working");
    $("pct").textContent = live ? Math.floor(pct) + "%" : "";
    $("bar").style.width = live ? pct + "%" : "";
    $("progress").classList.toggle("indeterminate", !live);
    if (live) $("progress").setAttribute("aria-valuenow", String(Math.floor(pct))); else $("progress").removeAttribute("aria-valuenow");
    $("speed").textContent = live ? cur.speed || "" : "";
    $("eta").textContent = live && cur.eta ? cur.eta + " left" : "";
    $("cancel").disabled = cur.stage === "Cancelling";
  } else if (v === "result") {
    const tone = cur.phase === "done" ? "good" : cur.phase === "error" ? "bad" : "neutral";
    $("banner").className = "banner " + tone; setBanner(tone);
    $("bannerTitle").textContent = cur.phase === "done" ? "Download finished" : cur.phase === "error" ? "Download failed" : "Download cancelled";
    $("bannerMsg").textContent = cur.phase === "cancelled" ? "Nothing was saved. You can try again." : cur.message || "";
    const detail = cur.phase === "error" && cur.detail && cur.detail !== cur.message;
    $("bannerDetail").hidden = !detail; $("bannerDetail").textContent = detail ? cur.detail : "";
    show("reveal", cur.phase === "done" && !!cur.filePath);
    $("again").textContent = cur.phase === "done" ? "Download another quality" : "Try again";
  } else if (v === "setup") {
    const noHelper = h.reason === "helper";
    $("setupTitle").textContent = noHelper ? "Helper not set up" : "yt-dlp not found";
    $("setupMsg").textContent = noHelper ? "Run install.ps1 from the host folder (once), then reload the extension." : "Install it, restart Firefox, then check again.";
    $("setupDetail").hidden = !h.detail; $("setupDetail").textContent = h.detail || "";
    $("setupCode").textContent = noHelper ? "powershell -ExecutionPolicy Bypass -File .\\install.ps1" : "winget install yt-dlp.yt-dlp";
  } else if (v === "clip") {
    $("clipGo").textContent = "Download clip as " + extLabel(s.ext);
    validateClip();
  } else if (v === "form") {
    const aud = isAudioExt(s.ext);
    const pl = t.kind === "playlist" || (t.kind === "video" && !!t.listId && form.playlist);
    $("plChoice").hidden = !(t.kind === "video" && !!t.listId);
    checkRadio("plmode", form.playlist ? "list" : "one");
    $("resField").classList.toggle("dim", aud);
    document.getElementsByName("res").forEach((i) => { i.disabled = aud; });
    $("resLegend").textContent = aud ? "Resolution (not used for audio)" : "Resolution";
    checkRadio("res", form.height);
    $("subsRow").hidden = aud; $("subs").checked = form.subs;
    $("ffwarn").hidden = !(h.status === "ok" && h.ffmpeg === false);
    $("go").textContent = (pl ? "Download playlist as " : "Download as ") + extLabel(s.ext);
    $("clipBtn").hidden = !(s.clipTool && !pl && t.kind !== "playlist");
    $("goHint").textContent = "Saved to " + (s.folder ? shortPath(s.folder) : "your Downloads folder");
  }
}

function histSub(h) {
  const audio = AUDIO_EXTS.includes(h.ext), parts = [];
  if (h.playlist) parts.push("Playlist"); else if (h.clip) parts.push("Clip");
  if (!audio) parts.push(resLabel(h.height));
  if (audio || (h.ext && h.ext !== "mkv")) parts.push(extLabel(h.ext));
  parts.push(ago(h.finishedAt));
  return parts.join(" \u00b7 ");
}
function renderHistory() {
  const list = data.history, key = list.map((h) => h.id).join();
  $("histEmpty").hidden = list.length > 0; $("clearHist").hidden = list.length === 0;
  if (key === histKey && $("histList").childElementCount === list.length) return;
  histKey = key;
  const box = $("histList"); while (box.firstChild) box.removeChild(box.firstChild);
  for (const h of list) {
    const row = el("div", "hist");
    const img = el("img", "hthumb"); img.alt = "";
    const u = h.videoId ? thumbUrl(h.videoId) : h.thumb || "";
    if (u) { img.src = u; img.onerror = () => { img.style.visibility = "hidden"; }; } else img.style.visibility = "hidden";
    const mid = el("div"); mid.append(el("div", "htitle", h.title));
    mid.append(el("div", "hsub" + (h.ok ? "" : " bad"), h.ok ? histSub(h) : "Failed \u00b7 " + ago(h.finishedAt)));
    const acts = el("div", "hacts");
    if (h.url) {
      const a = el("button", "hx"); a.type = "button"; a.title = "Download again"; a.setAttribute("aria-label", "Download again"); a.append(againIcon());
      a.addEventListener("click", () => send({ type: "again", id: h.id }).then((r) => { if (r && r.error) toast(r.error); else toast("Download started"); })); acts.append(a);
    }
    if (h.ok && h.filePath) {
      const f = el("button", "hx"); f.type = "button"; f.title = "Show in folder"; f.setAttribute("aria-label", "Show in folder"); f.append(folderIcon());
      f.addEventListener("click", () => reveal(h.filePath)); acts.append(f);
    }
    const x = el("button", "hx"); x.type = "button"; x.title = "Remove"; x.setAttribute("aria-label", "Remove from history"); x.append(xIcon());
    x.addEventListener("click", () => send({ type: "removeHistory", id: h.id })); acts.append(x);
    row.append(img, mid, acts); box.append(row);
  }
}

function putText(input, value) { if (document.activeElement !== input) input.value = value; }
function renderSettings() {
  const s = data.settings;
  checkRadio("defres", s.height); checkRadio("audio", s.audio); checkRadio("conc", String(s.maxConcurrent)); checkRadio("theme", s.theme);
  checkRadio("ext", s.ext); checkRadio("thumbfmt", s.thumbFmt);
  $("setSubs").checked = s.subs; $("setId").checked = s.idInName; $("setLogin").checked = s.login; $("setMotion").checked = s.motion; $("setLabels").checked = s.labels;
  $("setThumbEmb").checked = s.thumb; $("setDesc").checked = s.desc; $("setChapters").checked = s.chapters; $("setMeta").checked = s.meta;
  $("setSponsor").checked = s.sponsor; $("setInfo").checked = s.infoJson; $("setClip").checked = s.clipTool; $("setClipAcc").checked = s.clipAccurate;
  $("clipAccRow").hidden = !s.clipTool; $("setUpd").checked = s.checkUpdates;
  putText($("setSubLangs"), s.subLangs); putText($("setFolder"), s.folder); putText($("setPlMax"), String(s.playlistMax));
  const a = AUDIO.find((x) => x[0] === s.audio); $("audioNote").textContent = a ? a[2] : "";
  document.querySelectorAll(".sw").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.accent === s.accent)));
  $("advBody").hidden = !s.advOpen; $("advBtn").setAttribute("aria-expanded", String(!!s.advOpen));
}

function updRow(id, info, target) {
  const row = $(id), op = data.op || {}, avail = !!(info && info.available);
  row.querySelector(".upd-text").textContent = info ? info.text : "Not checked yet";
  row.classList.toggle("avail", avail);
  const btn = row.querySelector(".upd-btn");
  btn.classList.toggle("primary", avail); btn.classList.toggle("secondary", !avail);
  if (!target) { btn.textContent = avail ? "View release" : "Releases"; return; }
  const mine = op.target === target, running = !!op.running && mine, log = row.querySelector(".upd-log");
  btn.disabled = !!op.running; btn.textContent = running ? "Updating\u2026" : "Update";
  const note = running ? op.line : mine && op.ok !== null && op.message ? op.message : "";
  log.hidden = !note; log.textContent = note; log.className = "upd-log" + (!running && mine && note ? (op.ok ? " good" : " bad") : "");
}
function renderUpdates() {
  const u = data.updates || {}, op = data.op || {};
  $("updDot").hidden = $("tabDot").hidden = !u.any;
  updRow("updYt", u.ytdlp, "ytdlp"); updRow("updFf", u.ffmpeg, "ffmpeg"); updRow("updLn", u.launcher, null);
  $("updWhen").textContent = u.checking ? "Checking\u2026" : u.checkedAt ? "Checked " + ago(u.checkedAt) : "Not checked yet";
  $("updCheck").disabled = !!u.checking || !!op.running;
}

function render() { applyAppearance(); renderStack(); renderHome(); renderHistory(); renderSettings(); renderUpdates(); }

function showPane(name, dir) {
  for (const n of ["home", "history", "settings"]) $("pane-" + n).hidden = n !== name;
  const p = $("pane-" + name);
  $("scroller").scrollTop = 0;
  if (data.settings.motion && p.animate) p.animate([{ opacity: 0, transform: "translateX(" + dir * 28 + "px)" }, { opacity: 1, transform: "none" }], { duration: 320, easing: "cubic-bezier(.2,.8,.2,1)" });
  render();
}

/* ---------- clip tool ---------- */
function validateClip() {
  const a = parseTime($("clipStart").value), b = parseTime($("clipEnd").value);
  let msg = "", clip = null;
  if (Number.isNaN(a) || Number.isNaN(b)) msg = "Times look like 1:23, 1:02:03 or 83 (seconds).";
  else if (a != null && b != null) {
    if (b <= a) msg = "The end has to be after the start.";
    else if (clipDuration && b > clipDuration + 1) msg = "The end is past the end of the video (" + fmtTime(clipDuration) + ").";
    else clip = { start: Math.floor(a), end: Math.ceil(b) };
  }
  $("clipErr").hidden = !msg; $("clipErr").textContent = msg;
  $("clipInfo").textContent = clip ? "Length " + fmtTime(clip.end - clip.start) + (clipDuration ? " of " + fmtTime(clipDuration) : "")
    : "Play the video, then press Mark start and Mark end at the moments you want.";
  $("clipGo").disabled = !clip;
  return clip;
}
async function openClip() {
  const t = tab.target; if (!t) return;
  clipFor = t.key; clipDuration = 0; $("clipStart").value = ""; $("clipEnd").value = "";
  render();
  const i = await pageInfo();
  if (i && typeof i.duration === "number") { clipDuration = i.duration; validateClip(); }
}
async function mark(which) {
  const i = await pageInfo();
  if (!i || typeof i.time !== "number") { toast("Couldn't read the video player. Type the time instead."); return; }
  if (typeof i.duration === "number") clipDuration = i.duration;
  // round so the moment you marked is always inside the clip: start down, end up
  $(which === "start" ? "clipStart" : "clipEnd").value = fmtTime(which === "start" ? Math.floor(i.time) : Math.ceil(i.time));
  validateClip();
}

/* ---------- actions ---------- */
function startJob(extra) {
  const t = tab.target; if (!t) return;
  forceForm.delete(t.key); clipFor = null;
  send({ type: "start", job: { url: t.url, title: t.title, thumb: t.yt ? "" : thumbFor(t, tab.info), height: parseInt(form.height, 10), subs: form.subs,
                               playlist: t.kind === "playlist" || form.playlist, ...extra } })
    .then((r) => { if (r && r.error) toast(r.error); });
}
async function recheck() {
  $("recheck").disabled = true;
  try { await send({ type: "checkHelper" }); } finally { $("recheck").disabled = false; }
}

$("go").addEventListener("click", () => startJob({}));
$("subs").addEventListener("change", () => { form.subs = $("subs").checked; });
$("tryPage").addEventListener("click", () => { if (tab.target) { forceTry.add(tab.target.key); render(); } });
$("clipBtn").addEventListener("click", openClip);
$("clipBack").addEventListener("click", () => { clipFor = null; render(); });
$("markStart").addEventListener("click", () => mark("start"));
$("markEnd").addEventListener("click", () => mark("end"));
$("clipStart").addEventListener("input", validateClip);
$("clipEnd").addEventListener("input", validateClip);
$("clipGo").addEventListener("click", () => { const c = validateClip(); if (c) startJob({ clip: c }); });
$("cancel").addEventListener("click", () => { const c = curJob(); if (c) send({ type: "cancel", id: c.id }); });
$("reveal").addEventListener("click", () => { const c = curJob(); if (c && c.filePath) reveal(c.filePath); });
$("again").addEventListener("click", () => { if (tab.target) { forceForm.add(tab.target.key); render(); } });
$("recheck").addEventListener("click", recheck);
$("thumbBtn").addEventListener("click", async (e) => {
  e.stopPropagation();
  const t = tab.target, b = $("thumbBtn");
  if (!t || b.classList.contains("busy")) return;
  b.classList.add("busy");
  let r = null;
  try { r = await send({ type: "thumbnail", url: t.url, title: t.title }); } catch (err) {}
  b.classList.remove("busy");
  toast(r && r.ok ? "Saved " + (r.name || "thumbnail") : (r && r.message) || "Couldn't save the thumbnail.");
});
$("clearHist").addEventListener("click", () => send({ type: "clearHistory" }));
$("resetSettings").addEventListener("click", () => send({ type: "resetSettings" }));
for (const [id, key] of [["setSubs", "subs"], ["setId", "idInName"], ["setLogin", "login"], ["setMotion", "motion"], ["setLabels", "labels"], ["setThumbEmb", "thumb"],
  ["setDesc", "desc"], ["setChapters", "chapters"], ["setMeta", "meta"], ["setSponsor", "sponsor"], ["setInfo", "infoJson"], ["setClip", "clipTool"],
  ["setClipAcc", "clipAccurate"], ["setUpd", "checkUpdates"]]) $(id).addEventListener("change", () => set({ [key]: $(id).checked }));
$("setSubLangs").addEventListener("change", () => {
  const v = $("setSubLangs").value.trim();
  if (!/^[A-Za-z0-9*_.,-]{1,60}$/.test(v)) { toast("Use language codes like en or en,es"); renderSettings(); return; }
  set({ subLangs: v });
});
$("setPlMax").addEventListener("change", () => {
  const n = parseInt($("setPlMax").value, 10);
  if (!(n >= 0 && n <= 1000)) { toast("Use a number from 0 to 1000"); renderSettings(); return; }
  set({ playlistMax: n });
});
$("setFolder").addEventListener("change", async () => {
  const r = await send({ type: "setFolder", path: $("setFolder").value });
  if (r && r.ok === false) { toast(r.message || "That folder can't be used."); renderSettings(); }
});
$("browseFolder").addEventListener("click", async () => {
  const r = await send({ type: "pickFolder" });
  if (r && r.ok === false && !r.cancelled && r.message) toast(r.message);
});
$("advBtn").addEventListener("click", () => set({ advOpen: !data.settings.advOpen }));
$("updCheck").addEventListener("click", () => send({ type: "checkUpdates" }));
$("updYt").querySelector(".upd-btn").addEventListener("click", () => send({ type: "updateTool", target: "ytdlp" }).then((r) => { if (r && r.ok === false && r.message) toast(r.message); }));
$("updFf").querySelector(".upd-btn").addEventListener("click", () => send({ type: "updateTool", target: "ffmpeg" }).then((r) => { if (r && r.ok === false && r.message) toast(r.message); }));
$("updLn").querySelector(".upd-btn").addEventListener("click", () => {
  const u = data.updates && data.updates.launcher && data.updates.launcher.url;
  browser.tabs.create({ url: u || data.releasesUrl || "https://github.com/Realtechno9952/yt-dlp-launcher/releases" });
});

browser.runtime.onMessage.addListener((m) => {
  if (m && m.type === "update") { setData(m.data); syncForm(); render(); }
});

(async function init() {
  buildChips($("chips"), "res", (v) => { form.height = v; });
  buildChips($("setRes"), "defres", (v) => set({ height: v }));
  buildChips($("setExt"), "ext", (v) => set({ ext: v }), EXTS);
  buildSeg($("plChoice"), [["one", "This video"], ["list", "Whole playlist"]], "plmode", (v) => { form.playlist = v === "list"; render(); });
  buildSeg($("setAudio"), AUDIO, "audio", (v) => set({ audio: v }));
  buildSeg($("setConc"), CONC, "conc", (v) => set({ maxConcurrent: parseInt(v, 10) }));
  buildSeg($("setTheme"), THEMES, "theme", (v) => set({ theme: v }));
  buildSeg($("setThumbFmt"), THUMBFMTS, "thumbfmt", (v) => set({ thumbFmt: v }));
  buildSwatches(); attachTilt();
  dock = window.createDock({ root: $("dock"), lens: $("lens"), tabs: [...document.querySelectorAll("#dock .tab")], initial: 1, onSelect: showPane });

  const [t] = await browser.tabs.query({ active: true, currentWindow: true });
  tab.id = t && t.id; tab.target = t ? YTL.parse(t.url, t.title) : null;
  const r = await send({ type: "getAll" });
  if (r) setData(r);
  syncForm(); render(); dock.place();
  if (window.requestAnimationFrame) window.requestAnimationFrame(() => dock.place());
  if (tab.target && !tab.target.yt) { tab.info = await pageInfo(); render(); }
  if (data.helper.status !== "ok" && !data.jobs.some(isActive)) recheck();
  const u = data.updates || {};
  if (data.settings.checkUpdates && !u.checking && Date.now() - (u.checkedAt || 0) > 24 * 3600 * 1000) send({ type: "checkUpdates" });
})();
