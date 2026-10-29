"use strict";
// Floating glass tab bar. A "lens" slides under the active tab with a springy ease.
//   Press:    the lens lifts slightly, right where it is. It never jumps to the cursor.
//   Move:     while pressed, the lens moves by exactly as far as the pointer moves.
//   Release:  it settles on the nearest tab. A press that barely moves is a tap: it goes to the tapped tab.
(function () {
  const TAP_PX = 5;      // a press that moves less than this counts as a tap
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  window.createDock = function createDock({ root, lens, tabs, initial = 0, onSelect }) {
    let active = initial, pressed = false, moved = false;
    let x = 0, startX = 0, startLensX = 0, curX = 0;
    const lo = () => tabs[0].offsetLeft, hi = () => tabs[tabs.length - 1].offsetLeft;
    const slotX = (i) => tabs[i].offsetLeft;
    const lensW = () => tabs[active].offsetWidth || lens.offsetWidth;

    function nearest(px) {
      const c = px + lensW() / 2;
      let best = 0, dist = Infinity;
      tabs.forEach((t, i) => { const d = Math.abs(t.offsetLeft + t.offsetWidth / 2 - c); if (d < dist) { dist = d; best = i; } });
      return best;
    }
    // The tab under a pointer position (used for taps).
    function tabAt(clientX) {
      const r = root.getBoundingClientRect(), px = clientX - r.left - root.clientLeft;
      for (let i = 0; i < tabs.length; i++) if (px >= tabs[i].offsetLeft && px < tabs[i].offsetLeft + tabs[i].offsetWidth) return i;
      return nearest(px - lensW() / 2);
    }
    // Where the lens is drawn right now (it may still be mid-slide).
    function visualX() {
      try {
        const t = getComputedStyle(lens).transform;
        if (t && t !== "none" && window.DOMMatrix) { const m = new DOMMatrix(t); if (isFinite(m.m41)) return m.m41; }
      } catch (e) {}
      return curX;
    }
    function rest(i) {
      curX = slotX(i);
      lens.style.width = tabs[i].offsetWidth + "px";
      lens.style.transform = "translate3d(" + curX + "px,0,0)";
    }
    const lift = () => { lens.style.transform = "translate3d(" + x + "px,-3px,0) scale(1.1)"; };
    const mark = (i) => tabs.forEach((t, k) => t.classList.toggle("under", k === i));

    function setActive(i, notify) {
      tabs.forEach((t, k) => { t.setAttribute("aria-selected", k === i ? "true" : "false"); t.tabIndex = k === i ? 0 : -1; });
      if (i !== active) {
        const dir = i > active ? 1 : -1;
        active = i;
        if (notify !== false && onSelect) onSelect(tabs[i].dataset.tab, dir);
      }
      rest(i);
    }

    root.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      pressed = true; moved = false;
      startX = e.clientX;
      startLensX = x = clamp(visualX(), lo(), hi());
      if (root.setPointerCapture && e.pointerId != null) { try { root.setPointerCapture(e.pointerId); } catch (err) {} }
      root.classList.add("holding"); root.classList.remove("tracking");
      lift(); mark(nearest(x));
    });
    function track(clientX) {
      const dx = clientX - startX;
      if (Math.abs(dx) > TAP_PX) moved = true;
      x = clamp(startLensX + dx, lo(), hi());
    }
    root.addEventListener("pointermove", (e) => {
      if (!pressed) return;
      track(e.clientX);
      root.classList.add("tracking");
      lift(); mark(nearest(x));
    });
    function end(cancelled, e) {
      if (!pressed) return;
      if (e && typeof e.clientX === "number") track(e.clientX);
      const tapAt = e && typeof e.clientX === "number" ? e.clientX : startX;
      pressed = false;
      root.classList.remove("holding", "tracking");
      mark(-1);
      // cancelled: stay put. dragged: settle on the nearest tab. tapped: go to the tab that was tapped.
      setActive(cancelled ? active : moved ? nearest(x) : tabAt(tapAt));
    }
    root.addEventListener("pointerup", (e) => end(false, e));
    root.addEventListener("pointercancel", () => end(true));

    // Keyboard and assistive tech: a real click with detail 0 selects directly.
    tabs.forEach((t, i) => t.addEventListener("click", (e) => { if (e.detail === 0) setActive(i); }));
    root.addEventListener("keydown", (e) => {
      let i = active;
      if (e.key === "ArrowRight") i = Math.min(tabs.length - 1, active + 1);
      else if (e.key === "ArrowLeft") i = Math.max(0, active - 1);
      else if (e.key === "Home") i = 0;
      else if (e.key === "End") i = tabs.length - 1;
      else return;
      e.preventDefault(); setActive(i); tabs[i].focus();
    });

    setActive(initial, false);
    return { select: (i) => setActive(i), place: () => rest(active), get active() { return active; } };
  };
})();
