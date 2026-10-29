"use strict";
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const send = (m) => browser.runtime.sendMessage(m);
const SVGNS = "http://www.w3.org/2000/svg";

const RES = [["0", "Best", "Highest quality available"], ["4320", "8K", "Up to 4320p"], ["2160", "4K", "Up to 2160p"], ["1440", "1440p"],
             ["1080", "1080p"], ["720", "720p"], ["480", "480p"], ["360", "360p"]];
const AUDIO = [["low", "Low", "About 50 kbps. Smallest files."], ["medium", "Medium", "About 128 kbps, like standard streaming."],
               ["high", "High", "Up to about 160 kbps Opus, YouTube's usual best."], ["super", "Super High", "The highest YouTube offers (256 kbps on some videos)."]];
const THEMES = [["system", "System"], ["light", "Light"], ["dark", "Dark"]];
const CONC = [["1", "1"], ["2", "2"], ["3", "3"]];
const ACCENTS = [["ember", "Ember", "#d93a12", "#b3123f"], ["ocean", "Ocean", "#0a63d8", "#0b3fb0"], ["violet", "Violet", "#7b3fe4", "#a02bc4"],
                 ["forest", "Forest", "#13833a", "#0a6a5a"], ["graphite", "Graphite", "#3d3d4a", "#1f1f29"]];
const CIRCLE = "M8 1.75a6.25 6.25 0 1 0 0 12.5 6.25 6.25 0 0 0 0-12.5z";
const ICONS = { good: CIRCLE + "M5.25 8.25l2 2 3.5-4.25", bad: CIRCLE + "M8 4.9v3.9M8 11.2h.01", neutral: CIRCLE + "M5.6 5.6l4.8 4.8" };

let tab = { id: "", url: "", title: "" };
let data = { jobs: [], history: [], settings: { height: "0", subs: true, audio: "high", idInName: false, login: false, maxConcurrent: 2, theme: "system", accent: "ember", motion: true }, helper: { status: "unknown" } };
let form = { height: "0", subs: true };
const seen = { height: null, subs: null };
const forceForm = new Set();
let dock = null, histKey = "", toastTimer = 0;
const cards = new Map();

/* ---------- helpers ---------- */
function parseTab(t) {
  const none = { id: "", url: "", title: "" };
  if (!t || !t.url) return none;
  let u; try { u = new URL(t.url); } catch (e) { return none; }
  const host = u.hostname.replace(/^(www|m|music)\./, "");
  let id = "";
  if (host === "youtube.com") {
    if (u.pathname === "/watch") id = u.searchParams.get("v") || "";
    else { const m = /^\/(shorts|live|embed)\/([\w-]{11})/.exec(u.pathname); if (m) id = m[2]; }
  } else if (host === "youtu.be") id = u.pathname.slice(1, 12);
  if (!/^[\w-]{11}$/.test(id)) return none;
  const title = (t.title || "").replace(/^\(\d+\)\s*/, "").replace(/\s*-\s*YouTube( Music)?$/, "");
  return { id, url: "https://www.youtube.com/watch?v=" + id, title: title || "YouTube video" };
}
const thumbUrl = (id) => "https://i.ytimg.com/vi/" + id + "/mqdefault.jpg";
const show = (id, on) => { $(id).hidden = !on; };
const resLabel = (h) => (RES.find((r) => r[0] === String(h)) || RES[0])[1];
function ago(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + " min ago";
  if (s < 86400) return Math.floor(s / 3600) + " h ago";
  return new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}
function xIcon() {
  const s = document.createElementNS(SVGNS, "svg"); s.setAttribute("viewBox", "0 0 16 16");
  const p = document.createElementNS(SVGNS, "path"); p.setAttribute("d", "M4 4l8 8M12 4l-8 8"); s.append(p); return s;
}
function folderIcon() {
  const s = document.createElementNS(SVGNS, "svg"); s.setAttribute("viewBox", "0 0 16 16");
  const p = document.createElementNS(SVGNS, "path"); p.setAttribute("d", "M2 4.5A1.5 1.5 0 0 1 3.5 3h2.8l1.4 1.5h4.8A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"); s.append(p); return s;
}
function setBanner(tone) {
  const svg = $("bannerIcon");
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const p = document.createElementNS(SVGNS, "path"); p.setAttribute("d", ICONS[tone]); svg.append(p);
}
async function reveal(path) {
  const r = await send({ type: "reveal", path });
  if (r && r.ok === false) toast(r.message || "Couldn't open the folder.");
  else if (r && r.fallback) toast("Opened your Downloads folder.");
}

/* ---------- builders (run once) ---------- */
function buildChips(box, name, onPick) {
  for (const [value, label, tip] of RES) {
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
    const b = el("button", "sw"); b.type = "button"; b.dataset.accent = id; b.title = label;
    b.setAttribute("role", "radio"); b.setAttribute("aria-label", label);
    b.style.background = "linear-gradient(135deg," + c1 + "," + c2 + ")";
    b.addEventListener("click", () => set({ accent: id }));
    $("setAccent").append(b);
  }
}
const checkRadio = (name, value) => document.getElementsByName(name).forEach((i) => { i.checked = i.value === String(value); });
const set = (patch) => send({ type: "setSettings", patch });

/* ---------- rendering ---------- */
function applyAppearance() {
  const s = data.settings, root = document.documentElement;
  const dark = s.theme === "dark" || (s.theme === "system" && !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches));
  root.dataset.theme = s.theme; root.dataset.scheme = dark ? "dark" : "light"; root.dataset.accent = s.accent; root.dataset.motion = s.motion ? "on" : "off";
}
function syncForm() {
  const s = data.settings;
  if (seen.height !== s.height) { form.height = s.height; seen.height = s.height; }
  if (seen.subs !== s.subs) { form.subs = s.subs; seen.subs = s.subs; }
}
function curJob() {
  if (!tab.id) return null;
  for (let i = data.jobs.length - 1; i >= 0; i--) if (data.jobs[i].videoId === tab.id) return data.jobs[i];
  return null;
}
const isActive = (j) => j.phase === "queued" || j.phase === "running";

function renderStack() {
  const others = data.jobs.filter((j) => isActive(j) && j.videoId !== tab.id);
  const shown = others.slice(0, 3), box = $("stack");
  box.hidden = !others.length;
  const keep = new Set(shown.map((j) => j.id));
  for (const [id, c] of cards) if (!keep.has(id)) { c.root.remove(); cards.delete(id); }
  for (const j of shown) {
    let c = cards.get(j.id);
    if (!c) {
      const root = el("div", "mini");
      const img = el("img", "mthumb"); img.alt = ""; img.src = thumbUrl(j.videoId); img.onerror = () => { img.style.visibility = "hidden"; };
      const info = el("div"), title = el("div", "mtitle"), stat = el("div", "mstat"); info.append(title, stat);
      const x = el("button", "mx"); x.type = "button"; x.title = "Cancel download"; x.setAttribute("aria-label", "Cancel download"); x.append(xIcon());
      x.addEventListener("click", () => send({ type: "cancel", id: j.id }));
      const bar = el("div", "mbar"), fill = el("div", "mfill"); bar.append(fill);
      root.append(img, info, x, bar);
      c = { root, title, stat, fill }; cards.set(j.id, c); box.append(root);
    }
    c.title.textContent = j.title;
    const dl = typeof j.percent === "number" && /^Downloading/.test(j.stage || "");
    c.stat.textContent = j.phase === "queued" ? "Queued" : dl ? [Math.floor(j.percent) + "%", j.speed, j.eta && j.eta + " left"].filter(Boolean).join(" · ") : j.stage || "Working";
    c.fill.style.width = dl ? j.percent + "%" : j.phase === "queued" ? "0" : "100%";
    c.fill.style.opacity = dl || j.phase === "queued" ? "1" : ".35";
  }
  let more = $("stackMore");
  if (others.length > 3) {
    if (!more) { more = el("div", "more"); more.id = "stackMore"; box.append(more); }
    more.textContent = "+" + (others.length - 3) + " more in progress";
  } else if (more) more.remove();
}

function setThumb(id) {
  const img = $("thumb"), box = $("thumbBox");
  if (img.dataset.id === id) return;
  img.dataset.id = id;
  box.classList.toggle("no-img", !id);
  img.onerror = () => box.classList.add("no-img");
  img.onload = () => box.classList.remove("no-img");
  if (id) img.src = thumbUrl(id); else img.removeAttribute("src");
}

function renderHome() {
  const cur = curJob(), h = data.helper;
  let v;
  if (cur && isActive(cur)) v = "busy";
  else if (!tab.id) v = "empty";
  else if (h.status === "error") v = "setup";
  else if (cur && !forceForm.has(tab.id)) v = "result";
  else v = "form";
  show("card", v !== "empty" && !!tab.id);
  if (tab.id) { $("title").textContent = tab.title; setThumb(tab.id); }
  for (const s of ["empty", "setup", "form", "busy", "result"]) show(s, s === v);

  if (v === "busy") {
    const dl = typeof cur.percent === "number" && /^Downloading/.test(cur.stage || "");
    $("stage").textContent = cur.phase === "queued" ? "Queued" : cur.stage || "Working";
    $("pct").textContent = dl ? Math.floor(cur.percent) + "%" : "";
    $("bar").style.width = dl ? cur.percent + "%" : "";
    $("progress").classList.toggle("indeterminate", !dl);
    if (dl) $("progress").setAttribute("aria-valuenow", String(Math.floor(cur.percent))); else $("progress").removeAttribute("aria-valuenow");
    $("speed").textContent = dl ? cur.speed || "" : "";
    $("eta").textContent = dl && cur.eta ? cur.eta + " left" : "";
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
  } else if (v === "form") {
    checkRadio("res", form.height);
    $("subs").checked = form.subs;
    $("ffwarn").hidden = !(h.status === "ok" && h.ffmpeg === false);
  }
}

function renderHistory() {
  const list = data.history, key = list.map((h) => h.id).join();
  $("histEmpty").hidden = list.length > 0; $("clearHist").hidden = list.length === 0;
  if (key === histKey && $("histList").childElementCount === list.length) return;
  histKey = key;
  const box = $("histList"); while (box.firstChild) box.removeChild(box.firstChild);
  for (const h of list) {
    const row = el("div", "hist");
    const img = el("img", "hthumb"); img.alt = ""; img.src = thumbUrl(h.videoId); img.onerror = () => { img.style.visibility = "hidden"; };
    const mid = el("div"); mid.append(el("div", "htitle", h.title));
    mid.append(el("div", "hsub" + (h.ok ? "" : " bad"), h.ok ? resLabel(h.height) + " · " + ago(h.finishedAt) : "Failed · " + ago(h.finishedAt)));
    const acts = el("div", "hacts");
    if (h.ok && h.filePath) {
      const f = el("button", "hx"); f.type = "button"; f.title = "Show in folder"; f.setAttribute("aria-label", "Show in folder"); f.append(folderIcon());
      f.addEventListener("click", () => reveal(h.filePath)); acts.append(f);
    }
    const x = el("button", "hx"); x.type = "button"; x.title = "Remove"; x.setAttribute("aria-label", "Remove from history"); x.append(xIcon());
    x.addEventListener("click", () => send({ type: "removeHistory", id: h.id })); acts.append(x);
    row.append(img, mid, acts); box.append(row);
  }
}

function renderSettings() {
  const s = data.settings;
  checkRadio("defres", s.height); checkRadio("audio", s.audio); checkRadio("conc", String(s.maxConcurrent)); checkRadio("theme", s.theme);
  $("setSubs").checked = s.subs; $("setId").checked = s.idInName; $("setLogin").checked = s.login; $("setMotion").checked = s.motion;
  const a = AUDIO.find((x) => x[0] === s.audio); $("audioNote").textContent = a ? a[2] : "";
  document.querySelectorAll(".sw").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.accent === s.accent)));
}

function render() {
  applyAppearance(); renderStack(); renderHome(); renderHistory(); renderSettings();
}

function showPane(name, dir) {
  for (const n of ["home", "history", "settings"]) $("pane-" + n).hidden = n !== name;
  const p = $("pane-" + name);
  $("scroller").scrollTop = 0;
  if (data.settings.motion && p.animate) p.animate([{ opacity: 0, transform: "translateX(" + dir * 28 + "px)" }, { opacity: 1, transform: "none" }], { duration: 320, easing: "cubic-bezier(.2,.8,.2,1)" });
  render();
}

/* ---------- events ---------- */
function startJob() {
  forceForm.delete(tab.id);
  send({ type: "start", job: { url: tab.url, title: tab.title, height: parseInt(form.height, 10), subs: form.subs } });
}
$("go").addEventListener("click", startJob);
$("subs").addEventListener("change", () => { form.subs = $("subs").checked; });
$("cancel").addEventListener("click", () => { const c = curJob(); if (c) send({ type: "cancel", id: c.id }); });
$("reveal").addEventListener("click", () => { const c = curJob(); if (c && c.filePath) reveal(c.filePath); });
$("again").addEventListener("click", () => { forceForm.add(tab.id); render(); });
$("recheck").addEventListener("click", recheck);
$("clearHist").addEventListener("click", () => send({ type: "clearHistory" }));
$("resetSettings").addEventListener("click", () => send({ type: "resetSettings" }));
$("setSubs").addEventListener("change", () => set({ subs: $("setSubs").checked }));
$("setId").addEventListener("change", () => set({ idInName: $("setId").checked }));
$("setLogin").addEventListener("change", () => set({ login: $("setLogin").checked }));
$("setMotion").addEventListener("change", () => set({ motion: $("setMotion").checked }));

browser.runtime.onMessage.addListener((m) => {
  if (m && m.type === "update") { data = m.data; syncForm(); render(); }
});

async function recheck() {
  $("recheck").disabled = true;
  try { await send({ type: "checkHelper" }); } finally { $("recheck").disabled = false; }
}

(async function init() {
  buildChips($("chips"), "res", (v) => { form.height = v; });
  buildChips($("setRes"), "defres", (v) => set({ height: v }));
  buildSeg($("setAudio"), AUDIO, "audio", (v) => set({ audio: v }));
  buildSeg($("setConc"), CONC, "conc", (v) => set({ maxConcurrent: parseInt(v, 10) }));
  buildSeg($("setTheme"), THEMES, "theme", (v) => set({ theme: v }));
  buildSwatches();
  dock = window.createDock({ root: $("dock"), lens: $("lens"), tabs: [...document.querySelectorAll("#dock .tab")], initial: 1, onSelect: showPane });

  const [t] = await browser.tabs.query({ active: true, currentWindow: true });
  tab = parseTab(t);
  const r = await send({ type: "getAll" });
  if (r) data = r;
  syncForm(); render(); dock.place();
  if (window.requestAnimationFrame) window.requestAnimationFrame(() => dock.place());
  if (data.helper.status !== "ok") recheck();
})();
