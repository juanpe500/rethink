/* rethink — content script.
 *
 * Lifecycle: injected on every page but dormant until the popup arms it.
 *   hovering  → draw a nested-outline highlight under the cursor + a "rethink" tag
 *   selected  → lock a block, the tag morphs into an auto-growing textarea
 *   loading   → prompt+HTML+CSS sent to the background → OpenRouter
 *   done      → the block is redrawn per the chosen mode (with undo)
 *
 * All rethink UI lives in a Shadow DOM host so the page's own CSS can't touch it.
 */
(() => {
  "use strict";
  if (window.__rethinkLoaded) return;
  window.__rethinkLoaded = true;

  const MAX_DEPTH = 4; // how deep the nested outline goes
  const MAX_BOXES = 120; // hard cap so huge subtrees stay cheap
  const PRESERVE_ATTRS = ["id", "name", "value", "href", "src", "alt", "type", "for"];

  const state = {
    armed: false,
    mode: "classes",
    phase: "idle", // idle | hovering | selected | loading | done | error
    hovered: null,
    selected: null,
    undo: null, // () => void
    rafPending: false,
    lastEvent: null,
  };

  // ── Shadow DOM scaffold ────────────────────────────────────────────────────
  let host, root, styleEl, overlayLayer, hud, hudInner;

  function buildUI() {
    host = document.createElement("div");
    host.id = "rethink-root";
    host.style.cssText =
      "position:fixed;inset:0;width:0;height:0;margin:0;padding:0;border:0;z-index:2147483647;pointer-events:none;";
    root = host.attachShadow({ mode: "open" });

    styleEl = document.createElement("style");
    styleEl.textContent = SHADOW_CSS;
    root.appendChild(styleEl);

    overlayLayer = document.createElement("div");
    overlayLayer.className = "overlay";
    root.appendChild(overlayLayer);

    hud = document.createElement("div");
    hud.className = "hud";
    hud.style.display = "none";
    hudInner = document.createElement("div");
    hudInner.className = "hud-inner";
    hud.appendChild(hudInner);
    root.appendChild(hud);

    (document.documentElement || document.body).appendChild(host);
  }

  const SHADOW_CSS = `
    :host { all: initial; }
    .overlay { position: fixed; inset: 0; pointer-events: none; }
    .box {
      position: fixed; box-sizing: border-box; pointer-events: none;
      border: 1px solid rgba(99,102,241,0.9); border-radius: 2px;
      transition: none;
    }
    .box.sel { border: 2px solid rgba(99,102,241,1); box-shadow: 0 0 0 2px rgba(99,102,241,0.25); }
    .hud {
      position: fixed; pointer-events: none; z-index: 2;
      font: 13px/1.35 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    }
    .hud-inner { pointer-events: auto; }
    .tag {
      display: inline-flex; align-items: center; gap: 6px;
      background: #6366f1; color: #fff; padding: 3px 9px; border-radius: 999px;
      font-weight: 600; letter-spacing: .2px; box-shadow: 0 2px 8px rgba(0,0,0,.25);
      cursor: pointer; user-select: none; white-space: nowrap;
    }
    .tag .spark { font-size: 12px; opacity: .9; }
    .editor {
      background: #1e1e2e; color: #f4f4f8; border: 1px solid #6366f1;
      border-radius: 10px; padding: 8px; box-shadow: 0 8px 28px rgba(0,0,0,.4);
      width: 340px; max-width: 60vw;
    }
    .editor textarea {
      width: 100%; box-sizing: border-box; resize: none; overflow: hidden;
      background: transparent; color: inherit; border: 0; outline: 0;
      font: inherit; line-height: 1.4; min-height: 20px; max-height: 40vh; padding: 2px 2px;
    }
    .editor .row { display: flex; align-items: center; justify-content: space-between; margin-top: 6px; gap: 8px; }
    .editor .modepick { display: flex; gap: 4px; }
    .editor .modepick button {
      font: 11px/1 inherit; padding: 4px 7px; border-radius: 6px; cursor: pointer;
      border: 1px solid #3a3a52; background: #2a2a3e; color: #c9c9db;
    }
    .editor .modepick button.on { background: #6366f1; border-color: #6366f1; color: #fff; }
    .editor .hint { font-size: 11px; color: #9a9ab0; }
    .editor .go {
      border: 0; background: #6366f1; color: #fff; border-radius: 6px;
      padding: 5px 12px; font: 600 12px/1 inherit; cursor: pointer;
    }
    .editor .go:disabled { opacity: .5; cursor: default; }
    .toast {
      display: inline-flex; align-items: center; gap: 10px;
      background: #1e1e2e; color: #f4f4f8; border: 1px solid #3a3a52;
      border-radius: 999px; padding: 6px 12px; box-shadow: 0 6px 20px rgba(0,0,0,.35);
      font-weight: 500;
    }
    .toast button {
      border: 0; background: transparent; color: #a5b4fc; cursor: pointer;
      font: 600 12px/1 inherit; padding: 2px 4px;
    }
    .toast.err { border-color: #ef4444; }
    .toast.err .msg { color: #fca5a5; max-width: 360px; }
    .spin { width: 12px; height: 12px; border: 2px solid #6366f1; border-top-color: transparent;
      border-radius: 50%; display: inline-block; animation: rspin .7s linear infinite; }
    @keyframes rspin { to { transform: rotate(360deg); } }
  `;

  // ── highlight drawing ──────────────────────────────────────────────────────
  function clearBoxes() {
    overlayLayer.textContent = "";
  }

  function rectVisible(r) {
    return (
      r.width > 0 &&
      r.height > 0 &&
      r.bottom > 0 &&
      r.right > 0 &&
      r.top < innerHeight &&
      r.left < innerWidth
    );
  }

  // Outline `el` and its descendants; deeper = softer border (as requested).
  function drawSubtree(el, { selected = false } = {}) {
    clearBoxes();
    if (!el) return;
    const frag = document.createDocumentFragment();
    let count = 0;

    const addBox = (node, depth, isRoot) => {
      if (count >= MAX_BOXES) return;
      const r = node.getBoundingClientRect();
      if (!rectVisible(r)) return;
      const box = document.createElement("div");
      box.className = "box" + (isRoot && selected ? " sel" : "");
      // depth 0 strong, fading with depth
      const alpha = Math.max(0.12, 0.9 - depth * 0.22);
      if (!(isRoot && selected)) {
        box.style.borderColor = `rgba(99,102,241,${alpha})`;
      }
      box.style.left = r.left + "px";
      box.style.top = r.top + "px";
      box.style.width = r.width + "px";
      box.style.height = r.height + "px";
      frag.appendChild(box);
      count++;
    };

    // BFS by depth
    let level = [el];
    for (let depth = 0; depth <= MAX_DEPTH && level.length && count < MAX_BOXES; depth++) {
      const next = [];
      for (const node of level) {
        addBox(node, depth, node === el);
        if (depth < MAX_DEPTH) {
          for (const child of node.children) next.push(child);
        }
      }
      level = next;
    }
    overlayLayer.appendChild(frag);
  }

  // ── the "rethink" tag / editor HUD ─────────────────────────────────────────
  function positionHudTopRight(el) {
    const r = el.getBoundingClientRect();
    // Anchor the HUD's right edge to the block's right edge, sitting just above it.
    hud.style.display = "block";
    hud.style.left = "0px";
    hud.style.top = "0px";
    // measure after render
    requestAnimationFrame(() => {
      const hw = hudInner.offsetWidth || 80;
      const hh = hudInner.offsetHeight || 24;
      let left = r.right - hw;
      let top = r.top - hh - 6;
      if (top < 4) top = r.top + 6; // flip inside if no room above
      if (left < 4) left = 4;
      if (left + hw > innerWidth - 4) left = innerWidth - hw - 4;
      hud.style.left = left + "px";
      hud.style.top = top + "px";
    });
  }

  function showTag(el) {
    hudInner.className = "hud-inner";
    hudInner.innerHTML = `<span class="tag"><span class="spark">✦</span>rethink</span>`;
    positionHudTopRight(el);
  }

  function showEditor(el) {
    hudInner.className = "hud-inner";
    hudInner.innerHTML = `
      <div class="editor">
        <textarea rows="1" placeholder="describe how to rethink this block…  (Enter to run · Esc to cancel)"></textarea>
        <div class="row">
          <div class="modepick">
            <button data-mode="everything">everything</button>
            <button data-mode="classes">classes</button>
            <button data-mode="freedom">freedom</button>
          </div>
          <button class="go">rethink ✦</button>
        </div>
      </div>`;
    const ta = hudInner.querySelector("textarea");
    const go = hudInner.querySelector(".go");
    const modeBtns = [...hudInner.querySelectorAll(".modepick button")];
    const paintMode = () =>
      modeBtns.forEach((b) => b.classList.toggle("on", b.dataset.mode === state.mode));
    paintMode();
    modeBtns.forEach((b) =>
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        state.mode = b.dataset.mode;
        chrome.storage.local.set({ rethink_mode: state.mode });
        paintMode();
        ta.focus();
      })
    );

    const grow = () => {
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, window.innerHeight * 0.4) + "px";
    };
    ta.addEventListener("input", grow);
    ta.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submit(ta.value.trim());
      } else if (e.key === "Escape") {
        e.preventDefault();
        deselect();
      }
    });
    go.addEventListener("click", (e) => {
      e.stopPropagation();
      submit(ta.value.trim());
    });
    positionHudTopRight(el);
    setTimeout(() => {
      ta.focus();
      grow();
    }, 0);
  }

  function showToast(html, kind = "") {
    hudInner.className = "hud-inner";
    hudInner.innerHTML = `<div class="toast ${kind}">${html}</div>`;
    if (state.selected) positionHudTopRight(state.selected);
  }

  // ── CSS harvesting ─────────────────────────────────────────────────────────
  function collectCss(el) {
    const tokens = new Set();
    const push = (e) => {
      if (e.id) tokens.add("#" + e.id);
      e.classList && e.classList.forEach((c) => tokens.add("." + c));
      tokens.add(e.tagName.toLowerCase());
    };
    push(el);
    el.querySelectorAll("*").forEach(push);

    const out = [];
    let budget = 40000;
    const scan = (rules) => {
      for (const rule of rules) {
        if (budget <= 0) return;
        if (rule.cssRules && (rule.media || rule.conditionText !== undefined)) {
          // @media / @supports — descend
          const head = rule.cssText.split("{")[0];
          out.push(head + " {");
          scan(rule.cssRules);
          out.push("}");
          continue;
        }
        if (rule.selectorText) {
          const sel = rule.selectorText;
          for (const t of tokens) {
            if (sel.includes(t)) {
              const txt = rule.cssText;
              out.push(txt);
              budget -= txt.length;
              break;
            }
          }
        }
      }
    };
    for (const sheet of document.styleSheets) {
      try {
        if (sheet.cssRules) scan(sheet.cssRules);
      } catch (_) {
        /* cross-origin sheet — skip */
      }
      if (budget <= 0) break;
    }
    return out.join("\n");
  }

  // ── submit → background → apply ────────────────────────────────────────────
  async function submit(prompt) {
    if (!state.selected) return;
    state.phase = "loading";
    const el = state.selected;
    drawSubtree(el, { selected: true });
    showToast(`<span class="spin"></span><span>rethinking…</span>`);

    const html = el.outerHTML;
    const css = collectCss(el);

    let resp;
    try {
      resp = await chrome.runtime.sendMessage({
        type: "OR_CHAT",
        payload: { prompt, html, css, mode: state.mode },
      });
    } catch (e) {
      resp = { ok: false, error: e.message };
    }

    if (!resp || !resp.ok) {
      state.phase = "error";
      const msg = (resp && resp.error) || "Unknown error";
      showToast(
        `<span class="msg">⚠ ${escapeHtml(msg)}</span> <button data-act="retry">retry</button> <button data-act="cancel">close</button>`,
        "err"
      );
      hudInner.querySelector('[data-act="retry"]').addEventListener("click", (e) => {
        e.stopPropagation();
        showEditor(el);
      });
      hudInner.querySelector('[data-act="cancel"]').addEventListener("click", (e) => {
        e.stopPropagation();
        deselect();
      });
      return;
    }

    try {
      applyResult(el, resp.html, state.mode);
      state.phase = "done";
      showToast(
        `<span>✓ rethought${resp.notes ? " — " + escapeHtml(resp.notes) : ""}</span>
         <button data-act="undo">undo</button>
         <button data-act="again">again</button>
         <button data-act="done">done</button>`
      );
      hudInner.querySelector('[data-act="undo"]').addEventListener("click", (e) => {
        e.stopPropagation();
        if (state.undo) state.undo();
        deselect();
      });
      hudInner.querySelector('[data-act="again"]').addEventListener("click", (e) => {
        e.stopPropagation();
        showEditor(state.selected);
      });
      hudInner.querySelector('[data-act="done"]').addEventListener("click", (e) => {
        e.stopPropagation();
        deselect();
      });
    } catch (e) {
      state.phase = "error";
      showToast(
        `<span class="msg">⚠ could not apply: ${escapeHtml(e.message)}</span> <button data-act="cancel">close</button>`,
        "err"
      );
      hudInner.querySelector('[data-act="cancel"]').addEventListener("click", (ev) => {
        ev.stopPropagation();
        deselect();
      });
    }
  }

  // ── apply strategies (the mode contracts) ──────────────────────────────────
  function applyResult(selectedEl, newHtml, mode) {
    const tpl = document.createElement("template");
    tpl.innerHTML = (newHtml || "").trim();
    const newRoot = tpl.content.firstElementChild;
    if (!newRoot) throw new Error("model returned no element");

    if (mode === "classes") {
      applyClassesOnly(selectedEl, newRoot);
      return;
    }
    if (mode === "everything") {
      applyEverything(selectedEl, newRoot);
      return;
    }
    // freedom
    const originalClone = selectedEl.cloneNode(true);
    const live = tpl.content.firstElementChild;
    selectedEl.replaceWith(live);
    state.selected = live;
    state.undo = () => {
      const back = originalClone.cloneNode(true);
      state.selected.replaceWith(back);
      state.selected = back;
    };
    drawSubtree(live, { selected: true });
    positionHudTopRight(live);
  }

  // MODE 2: only class + inline style may change, structure is frozen. We walk the
  // live tree and the AI tree in lockstep and copy nothing but class/style where
  // the structure matches; any structural divergence is ignored (kept as-is).
  function applyClassesOnly(liveEl, aiEl) {
    const changes = [];
    const walk = (live, ai) => {
      if (!live || !ai) return;
      if (live.tagName !== ai.tagName) return; // divergence → freeze here
      changes.push([live, live.getAttribute("class"), live.getAttribute("style")]);
      const nc = ai.getAttribute("class");
      const ns = ai.getAttribute("style");
      if (nc === null) live.removeAttribute("class");
      else live.setAttribute("class", nc);
      if (ns === null) live.removeAttribute("style");
      else live.setAttribute("style", ns);
      const lc = live.children,
        ac = ai.children;
      const n = Math.min(lc.length, ac.length);
      for (let i = 0; i < n; i++) walk(lc[i], ac[i]);
    };
    walk(liveEl, aiEl);
    state.selected = liveEl;
    state.undo = () => {
      for (const [el, cls, sty] of changes) {
        if (cls === null) el.removeAttribute("class");
        else el.setAttribute("class", cls);
        if (sty === null) el.removeAttribute("style");
        else el.setAttribute("style", sty);
      }
    };
    drawSubtree(liveEl, { selected: true });
    positionHudTopRight(liveEl);
  }

  // MODE 1: free restructure, but every id/data survives and any element the AI
  // keeps by id is grafted back in as its ORIGINAL live node — so its event
  // listeners come along for free ("rehook when they come back").
  function applyEverything(selectedEl, newRoot) {
    const originalClone = selectedEl.cloneNode(true);

    // index every original element by id, and snapshot its preservable attrs
    const origById = new Map();
    const attrSnap = new Map();
    const indexOrig = (el) => {
      if (el.id) {
        origById.set(el.id, el);
        const snap = {};
        for (const a of el.attributes) {
          if (a.name.startsWith("data-") || PRESERVE_ATTRS.includes(a.name)) snap[a.name] = a.value;
        }
        attrSnap.set(el.id, snap);
      }
      for (const c of el.children) indexOrig(c);
    };
    indexOrig(selectedEl);

    const graft = (aiNode) => {
      if (aiNode.nodeType !== 1) return aiNode.cloneNode(true); // text/comment
      const id = aiNode.id;
      if (id && origById.has(id)) {
        const o = origById.get(id);
        origById.delete(id);
        // adopt AI's attributes (styling etc.), then guarantee preserved attrs
        for (const a of [...o.attributes]) o.removeAttribute(a.name);
        for (const a of aiNode.attributes) o.setAttribute(a.name, a.value);
        const snap = attrSnap.get(id) || {};
        for (const k in snap) if (!o.hasAttribute(k)) o.setAttribute(k, snap[k]);
        o.id = id;
        // rebuild children from AI (nested ids resolve back to originals here)
        while (o.firstChild) o.removeChild(o.firstChild);
        for (const child of aiNode.childNodes) o.appendChild(graft(child));
        return o;
      }
      const clone = document.createElement(aiNode.tagName);
      for (const a of aiNode.attributes) clone.setAttribute(a.name, a.value);
      for (const child of aiNode.childNodes) clone.appendChild(graft(child));
      return clone;
    };

    const live = graft(newRoot);

    // any id the AI dropped: keep its node (and data + listeners) in a hidden vault
    if (origById.size) {
      const vault = document.createElement("div");
      vault.setAttribute("data-rethink-preserved", "");
      vault.hidden = true;
      vault.style.display = "none";
      for (const node of origById.values()) vault.appendChild(node);
      live.appendChild(vault);
      console.warn(
        "[rethink] AI dropped ids; preserved in hidden vault:",
        [...origById.keys()]
      );
    }

    selectedEl.replaceWith(live);
    state.selected = live;
    state.undo = () => {
      const back = originalClone.cloneNode(true);
      state.selected.replaceWith(back);
      state.selected = back;
    };
    drawSubtree(live, { selected: true });
    positionHudTopRight(live);
  }

  // ── interaction ────────────────────────────────────────────────────────────
  function onMove(e) {
    if (!state.armed || state.phase !== "hovering") return;
    state.lastEvent = e;
    if (state.rafPending) return;
    state.rafPending = true;
    requestAnimationFrame(() => {
      state.rafPending = false;
      const ev = state.lastEvent;
      if (!ev) return;
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      if (!el || el === state.hovered) {
        if (el === state.hovered && el) {
          drawSubtree(el);
          positionHudTopRight(el);
        }
        return;
      }
      if (el.closest && el.closest("#rethink-root")) return;
      state.hovered = el;
      drawSubtree(el);
      showTag(el);
    });
  }

  function onClick(e) {
    if (!state.armed) return;
    // ignore clicks on our own HUD
    const path = e.composedPath ? e.composedPath() : [];
    if (path.includes(host)) return;
    if (state.phase !== "hovering") return;
    const el = state.hovered || document.elementFromPoint(e.clientX, e.clientY);
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    select(el);
  }

  function select(el) {
    state.selected = el;
    state.phase = "selected";
    drawSubtree(el, { selected: true });
    showEditor(el);
  }

  function deselect() {
    state.selected = null;
    state.undo = null;
    state.phase = state.armed ? "hovering" : "idle";
    state.hovered = null;
    clearBoxes();
    hud.style.display = "none";
    hudInner.innerHTML = "";
  }

  function reposition() {
    if (state.phase === "selected" || state.phase === "loading" || state.phase === "done") {
      if (state.selected) {
        drawSubtree(state.selected, { selected: true });
        positionHudTopRight(state.selected);
      }
    } else if (state.phase === "hovering" && state.hovered) {
      drawSubtree(state.hovered);
      positionHudTopRight(state.hovered);
    }
  }

  // ── arm / disarm ───────────────────────────────────────────────────────────
  function arm(mode) {
    if (mode) state.mode = mode;
    if (state.armed) return;
    state.armed = true;
    state.phase = "hovering";
    if (!host) buildUI();
    document.documentElement.classList.add("rethink-armed");
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("click", onClick, true);
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition, true);
    document.addEventListener("keydown", onGlobalKey, true);
  }

  function disarm() {
    state.armed = false;
    deselect();
    state.phase = "idle";
    document.documentElement.classList.remove("rethink-armed");
    window.removeEventListener("mousemove", onMove, true);
    window.removeEventListener("click", onClick, true);
    window.removeEventListener("scroll", reposition, true);
    window.removeEventListener("resize", reposition, true);
    document.removeEventListener("keydown", onGlobalKey, true);
  }

  function onGlobalKey(e) {
    if (!state.armed) return;
    if (e.key === "Escape" && state.phase !== "selected") {
      // Esc while just hovering exits the whole mode
      disarm();
      chrome.storage.local.set({ rethink_active: false });
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  // ── messaging from popup ───────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "RETHINK_ARM") {
      arm(msg.mode);
      sendResponse({ ok: true, armed: true });
    } else if (msg?.type === "RETHINK_DISARM") {
      disarm();
      sendResponse({ ok: true, armed: false });
    } else if (msg?.type === "RETHINK_STATE") {
      sendResponse({ ok: true, armed: state.armed, phase: state.phase, mode: state.mode });
    } else if (msg?.type === "RETHINK_SET_MODE") {
      state.mode = msg.mode || state.mode;
      sendResponse({ ok: true, mode: state.mode });
    }
    return true;
  });
})();
