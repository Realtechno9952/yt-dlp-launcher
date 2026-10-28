"use strict";
// Floating glass tab bar. A "lens" slides under the active tab with a springy ease.
// Press and hold anywhere on the bar: the lens lifts and follows the cursor; let go and it
// settles on the nearest tab.
(function () {
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  window.createDock = function createDock({ root, lens, tabs, initial = 0, onSelect }) {
    let active = initial, holding = false, x = 0;
    const slotX = (i) => tabs[i].offsetLeft;
    const lensW = () => tabs[active].offsetWidth || lens.offsetWidth;

    function nearest(px) {
      const c = px + lensW() / 2;
      let best = 0, dist = Infinity;
      tabs.forEach((t, i) => { const d = Math.abs(t.offsetLeft + t.offsetWidth / 2 - c); if (d < dist) { dist = d; best = i; } });
      return best;
    }
    const rest = (i) => { lens.style.width = tabs[i].offsetWidth + "px"; lens.style.transform = "translate3d(" + slotX(i) + "px,0,0)"; };
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
    function pointerX(e) {
      const r = root.getBoundingClientRect();
      return clamp(e.clientX - r.left - root.clientLeft - lensW() / 2, slotX(0), slotX(tabs.length - 1));
    }

    root.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      holding = true; x = pointerX(e);
      root.classList.add("holding"); root.classList.remove("tracking");
      if (root.setPointerCapture && e.pointerId != null) { try { root.setPointerCapture(e.pointerId); } catch (err) {} }
      lift(); mark(nearest(x));
    });
    root.addEventListener("pointermove", (e) => {
      if (!holding) return;
      x = pointerX(e);
      root.classList.add("tracking");
      lift(); mark(nearest(x));
    });
    function end(cancelled) {
      if (!holding) return;
      const i = cancelled ? active : nearest(x);
      holding = false;
      root.classList.remove("holding", "tracking");
      mark(-1);
      setActive(i);
    }
    root.addEventListener("pointerup", () => end(false));
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
