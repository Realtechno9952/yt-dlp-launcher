"use strict";
// Shared by the background script and the popup: works out what a page URL is.
//   kind "video"    a single video (YouTube, or a site yt-dlp is known to handle)
//   kind "playlist" a YouTube playlist page
//   kind "page"     any other web page (yt-dlp might still find a video on it)
(function (g) {
  // [label, hostname test, path test]
  const SITES = [
    ["Vimeo", /(^|\.)vimeo\.com$/, /^\/(?:[\w-]+\/)*\d{5,}/],
    ["Twitch", /(^|\.)twitch\.tv$/, /^\/(?:videos\/\d+|[\w-]+\/clip\/[\w-]+|[\w-]+\/v\/\d+)/],
    ["Twitch", /^clips\.twitch\.tv$/, /^\/[\w-]+/],
    ["X (Twitter)", /^(?:www\.|mobile\.)?(?:twitter|x)\.com$/, /^\/\w+\/status\/\d+/],
    ["Reddit", /(^|\.)reddit\.com$/, /^\/r\/\w+\/comments\//],
    ["Reddit", /^v\.redd\.it$/, /^\/\w+/],
    ["TikTok", /(^|\.)tiktok\.com$/, /^\/(?:@[^/]+\/video\/\d+|t\/\w+)/],
    ["Instagram", /(^|\.)instagram\.com$/, /^\/(?:[\w.]+\/)?(?:p|reel|reels|tv)\/[\w-]+/],
    ["Facebook", /(^|\.)facebook\.com$/, /\/(?:watch|videos|reel)\b/],
    ["Facebook", /^fb\.watch$/, /^\/\w+/],
    ["Dailymotion", /(^|\.)dailymotion\.com$/, /^\/video\/\w+/],
    ["Dailymotion", /^dai\.ly$/, /^\/\w+/],
    ["SoundCloud", /(^|\.)soundcloud\.com$/, /^\/[^/]+\/[^/]+/],
    ["Bandcamp", /(^|\.)bandcamp\.com$/, /^\/(?:track|album)\//],
    ["Streamable", /^streamable\.com$/, /^\/\w+/],
    ["Rumble", /(^|\.)rumble\.com$/, /^\/v[\w-]+/],
    ["Odysee", /(^|\.)odysee\.com$/, /^\/@/],
    ["Bilibili", /(^|\.)bilibili\.com$/, /^\/video\//],
    ["Kick", /(^|\.)kick\.com$/, /^\/video\//],
  ];
  const BAD = /[\s"<>]/;
  const tidy = (t, yt) => {
    let s = String(t || "").replace(/^\(\d+\)\s*/, "");
    if (yt) s = s.replace(/\s*-\s*YouTube( Music)?$/, "");
    return s.trim().slice(0, 200);
  };

  function parse(rawUrl, rawTitle) {
    const raw = String(rawUrl || "");
    if (!raw || raw.length > 2000) return null;
    let u;
    try { u = new URL(raw); } catch (e) { return null; }
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    const host = u.hostname.toLowerCase();
    const yh = host.replace(/^(www|m|music)\./, "");

    if (yh === "youtube.com" || yh === "youtu.be") {
      let id = "", list = u.searchParams.get("list") || "";
      if (yh === "youtu.be") id = u.pathname.slice(1, 12);
      else if (u.pathname === "/watch") id = u.searchParams.get("v") || "";
      else { const m = /^\/(shorts|live|embed)\/([\w-]{11})/.exec(u.pathname); if (m) id = m[2]; }
      if (!/^[\w-]{11}$/.test(id)) id = "";
      if (!/^[\w-]{10,80}$/.test(list) || /^RD/.test(list)) list = "";   // "RD..." auto-mixes are not real playlists
      const title = tidy(rawTitle, true);
      if (id) return { kind: "video", site: "YouTube", yt: true, known: true, key: "yt:" + id, videoId: id, listId: list, url: "https://www.youtube.com/watch?v=" + id, title: title || "YouTube video" };
      if (u.pathname === "/playlist" && list) return { kind: "playlist", site: "YouTube", yt: true, known: true, key: "ytl:" + list, videoId: "", listId: list, url: "https://www.youtube.com/playlist?list=" + list, title: title || "YouTube playlist" };
      return null;
    }

    u.hash = "";
    const url = u.href;
    if (BAD.test(url) || url.length > 2000) return null;
    let site = "", known = false;
    for (const [name, hostRe, pathRe] of SITES) {
      if (hostRe.test(host) && (!pathRe || pathRe.test(u.pathname))) { site = name; known = true; break; }
    }
    return { kind: known ? "video" : "page", site: site || host.replace(/^www\./, ""), yt: false, known, key: "url:" + url, videoId: "", listId: "", url, title: tidy(rawTitle) || host };
  }

  g.YTL = { parse, SITES };
})(typeof globalThis !== "undefined" ? globalThis : this);
