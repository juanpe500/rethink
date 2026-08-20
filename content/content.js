/* rethink — content script.
 *
 * Lifecycle: injected on every page but dormant until the popup arms it.
 *   hovering  → nested-outline highlight under the cursor + a "rethink" tag
 *   selected  → a side panel docks beside the block: prompt input + HTML/CSS/JS tabs
 *   loading   → the model streams; deltas fill the tabs live, CSS applies live,
 *               the HTML tab shows a red/green diff vs the original
 *   done      → the HTML is applied under the chosen mode (with undo) and flashes
 *
 * All rethink UI lives in a Shadow DOM host so the page's own CSS can't touch it.
 */
(() => {
  "use strict";
  if (window.__rethinkLoaded) return;
  window.__rethinkLoaded = true;

  const MAX_DEPTH = 4;
  const MAX_BOXES = 120;
  const PRESERVE_ATTRS = ["id", "name", "value", "href", "src", "alt", "type", "for"];
  const DIFF_CELL_CAP = 260000; // n*m guard for the O(nm) diff

  const state = {
    armed: false,
    mode: "classes",
    phase: "idle", // idle | hovering | selected | loading | done | error
    hovered: null,
    selected: null,
    originalHtml: "",
    harvestedCss: "",
    previewScheduled: false,
    undo: null,
    htmlApplied: false, // has the html block been applied to the page this run?
    htmlUndo: null,
    lastAppliedCss: "", // last complete-rule CSS string pushed to the page
    cssEl: null, // live-injected <style> for streamed CSS
    port: null,
    raw: "",
    sections: { html: "", css: "", js: "" },
    activeTab: "html",
    diffScheduled: false,
    rafPending: false,
    lastEvent: null,
  };

  // ── Shadow DOM scaffold ────────────────────────────────────────────────────
  let host, root, overlayLayer, pill, panel;

  function buildUI() {
    host = document.createElement("div");
    host.id = "rethink-root";
    host.style.cssText =
      "position:fixed;inset:0;width:0;height:0;margin:0;padding:0;border:0;z-index:2147483647;pointer-events:none;";
    root = host.attachShadow({ mode: "open" });

    const styleEl = document.createElement("style");
    styleEl.textContent = SHADOW_CSS;
    root.appendChild(styleEl);

    overlayLayer = document.createElement("div");
    overlayLayer.className = "overlay";
    root.appendChild(overlayLayer);

    pill = document.createElement("div");
    pill.className = "pill-wrap";
    pill.style.display = "none";
    root.appendChild(pill);

    panel = document.createElement("div");
    panel.className = "panel";
    panel.style.display = "none";
    root.appendChild(panel);

    (document.documentElement || document.body).appendChild(host);
  }

  const SHADOW_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .overlay { position: fixed; inset: 0; pointer-events: none; }
    .box { position: fixed; box-sizing: border-box; pointer-events: none; border: 1px solid rgba(99,102,241,0.9); border-radius: 2px; }
    .box.sel { border: 2px solid rgba(99,102,241,1); box-shadow: 0 0 0 2px rgba(99,102,241,0.25); }

    .pill-wrap { position: fixed; pointer-events: none; z-index: 2; font: 13px ui-sans-serif, system-ui, sans-serif; }
    .pill { display: inline-flex; align-items: center; gap: 6px; background: #6366f1; color: #fff; padding: 3px 9px; border-radius: 999px; font-weight: 600; box-shadow: 0 2px 8px rgba(0,0,0,.25); white-space: nowrap; }

    .panel {
      position: fixed; width: 384px; max-width: 92vw; max-height: 78vh;
      display: flex; flex-direction: column; pointer-events: auto; z-index: 3;
      background: #17172a; color: #ececf4; border: 1px solid #33334d; border-radius: 12px;
      box-shadow: 0 18px 50px rgba(0,0,0,.5); overflow: hidden;
      font: 13px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    }
    .phead { display: flex; align-items: center; gap: 8px; padding: 9px 11px; border-bottom: 1px solid #2a2a44; }
    .phead .ttl { font-weight: 700; letter-spacing: .2px; }
    .phead .ttl .spk { color: #a5b4fc; }
    .phead .model { margin-left: auto; font: 11px ui-monospace, monospace; color: #8888a6; max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .phead .x { border: 0; background: transparent; color: #8888a6; cursor: pointer; font-size: 15px; padding: 0 2px; }
    .phead .x:hover { color: #fff; }

    .pprompt { padding: 10px 11px; border-bottom: 1px solid #2a2a44; }
    .pinput { width: 100%; resize: none; overflow: hidden; background: #10101e; color: #f4f4f8; border: 1px solid #33334d; border-radius: 8px; padding: 8px 9px; font: inherit; line-height: 1.4; min-height: 20px; max-height: 30vh; outline: none; }
    .pinput:focus { border-color: #6366f1; }
    .prow { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 8px; }
    .pmodes { display: flex; gap: 4px; }
    .pmodes button { font: 11px ui-sans-serif, system-ui, sans-serif; padding: 4px 8px; border-radius: 6px; cursor: pointer; border: 1px solid #33334d; background: #23233a; color: #c9c9db; }
    .pmodes button.on { background: #6366f1; border-color: #6366f1; color: #fff; }
    .prun { border: 0; background: #6366f1; color: #fff; border-radius: 7px; padding: 6px 13px; font: 600 12px ui-sans-serif, system-ui, sans-serif; cursor: pointer; }
    .prun:disabled { opacity: .55; cursor: default; }

    .ptabs { display: flex; align-items: center; gap: 2px; padding: 6px 8px 0; border-bottom: 1px solid #2a2a44; }
    .ptab { position: relative; border: 0; background: transparent; color: #9a9ab0; cursor: pointer; padding: 6px 11px; font: 600 12px ui-sans-serif, system-ui, sans-serif; border-radius: 7px 7px 0 0; }
    .ptab.on { color: #fff; background: #20203a; }
    .ptab .dot { display: none; width: 6px; height: 6px; border-radius: 50%; background: #34d399; position: absolute; top: 5px; right: 4px; }
    .ptab.has .dot { display: block; }
    .pstatus { margin-left: auto; font: 11px ui-monospace, monospace; color: #8888a6; padding-right: 4px; display: flex; align-items: center; gap: 6px; }
    .spin { width: 10px; height: 10px; border: 2px solid #6366f1; border-top-color: transparent; border-radius: 50%; display: inline-block; animation: rspin .7s linear infinite; }
    @keyframes rspin { to { transform: rotate(360deg); } }

    .pbody { flex: 1; min-height: 90px; overflow: auto; background: #101019; }
    .pane { display: none; margin: 0; padding: 10px 11px; font: 12px/1.55 ui-monospace, "Cascadia Code", Consolas, monospace; white-space: pre-wrap; word-break: break-word; color: #c7c7dd; }
    .pane.on { display: block; }
    .pane .add { background: rgba(52,211,153,.16); color: #9ff0cf; display: block; }
    .pane .del { background: rgba(239,68,68,.16); color: #fca5a5; display: block; text-decoration: none; }
    .pane .ctx { display: block; color: #8a8aa4; }
    .pane .empty { color: #6a6a86; font-style: italic; }
    .pane .sys { color: #7f7f9e; }
    .pane .sep { color: #6366f1; font-weight: 700; display: block; margin: 8px 0; }
    .pane .hl { background: rgba(99,102,241,.42); color: #fff; border-radius: 3px; padding: 0 2px; box-shadow: 0 0 0 1px rgba(129,140,248,.6); }

    .pfoot { display: flex; align-items: center; gap: 8px; padding: 9px 11px; border-top: 1px solid #2a2a44; flex-wrap: wrap; }
    .pfoot button { border: 1px solid #33334d; background: #23233a; color: #e6e6f2; border-radius: 7px; padding: 5px 11px; font: 600 12px ui-sans-serif, system-ui, sans-serif; cursor: pointer; }
    .pfoot button.primary { background: #6366f1; border-color: #6366f1; color: #fff; }
    .pfoot button.warn { border-color: #b45309; color: #fbbf24; }
    .pfoot .msg { color: #fca5a5; font: 12px ui-sans-serif, system-ui, sans-serif; flex: 1; }
    .pfoot .ok { color: #34d399; font-weight: 600; }
  `;

  // ── highlight drawing ──────────────────────────────────────────────────────
  function clearBoxes() { overlayLayer.textContent = ""; }
  function rectVisible(r) {
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  }
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
      const alpha = Math.max(0.12, 0.9 - depth * 0.22);
      if (!(isRoot && selected)) box.style.borderColor = `rgba(99,102,241,${alpha})`;
      box.style.left = r.left + "px";
      box.style.top = r.top + "px";
      box.style.width = r.width + "px";
      box.style.height = r.height + "px";
      frag.appendChild(box);
      count++;
    };
    let level = [el];
    for (let depth = 0; depth <= MAX_DEPTH && level.length && count < MAX_BOXES; depth++) {
      const next = [];
      for (const node of level) {
        addBox(node, depth, node === el);
        if (depth < MAX_DEPTH) for (const child of node.children) next.push(child);
      }
      level = next;
    }
    overlayLayer.appendChild(frag);
  }

  function showPill(el) {
    pill.innerHTML = `<span class="pill"><span style="opacity:.9">✦</span> rethink</span>`;
    pill.style.display = "block";
    positionPill(el);
  }
  function positionPill(el) {
    const r = el.getBoundingClientRect();
    pill.style.left = "0px"; pill.style.top = "0px";
    requestAnimationFrame(() => {
      const w = pill.firstElementChild.offsetWidth || 84;
      const h = pill.firstElementChild.offsetHeight || 24;
      let left = r.right - w, top = r.top - h - 6;
      if (top < 4) top = r.top + 6;
      left = Math.max(4, Math.min(left, innerWidth - w - 4));
      pill.style.left = left + "px";
      pill.style.top = top + "px";
    });
  }
  function hidePill() { pill.style.display = "none"; }

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
          out.push(rule.cssText.split("{")[0] + " {");
          scan(rule.cssRules);
          out.push("}");
          continue;
        }
        if (rule.selectorText) {
          for (const t of tokens) {
            if (rule.selectorText.includes(t)) { out.push(rule.cssText); budget -= rule.cssText.length; break; }
          }
        }
      }
    };
    for (const sheet of document.styleSheets) {
      try { if (sheet.cssRules) scan(sheet.cssRules); } catch (_) {}
      if (budget <= 0) break;
    }
    return out.join("\n");
  }

  // ── the side panel ─────────────────────────────────────────────────────────
  function showPanel(el) {
    hidePill();
    state.raw = "";
    state.sections = { html: "", css: "", js: "" };
    state.activeTab = "html";
    panel.style.display = "flex";
    panel.innerHTML = `
      <div class="phead">
        <span class="ttl"><span class="spk">✦</span> rethink</span>
        <span class="model"></span>
        <button class="x" title="close">✕</button>
      </div>
      <div class="pprompt">
        <textarea class="pinput" rows="1" placeholder="describe how to rethink this block…  (Enter to run · Shift+Enter newline)"></textarea>
        <div class="prow">
          <div class="pmodes">
            <button data-mode="everything">everything</button>
            <button data-mode="classes">classes</button>
            <button data-mode="freedom">freedom</button>
          </div>
          <button class="prun">rethink ✦</button>
        </div>
      </div>
      <div class="ptabs">
        <button class="ptab on" data-tab="html">HTML<span class="dot"></span></button>
        <button class="ptab" data-tab="css">CSS<span class="dot"></span></button>
        <button class="ptab" data-tab="js">JS<span class="dot"></span></button>
        <button class="ptab" data-tab="prompt">Prompt</button>
        <span class="pstatus"></span>
      </div>
      <div class="pbody">
        <pre class="pane on" data-pane="html"><span class="empty">the diff will appear here as the model streams…</span></pre>
        <pre class="pane" data-pane="css"><span class="empty">any new CSS the model adds shows here, applied live.</span></pre>
        <pre class="pane" data-pane="js"><span class="empty">suggested JS shows here — never run automatically.</span></pre>
        <pre class="pane" data-pane="prompt"><span class="empty">the exact prompt sent to the model — your text highlighted.</span></pre>
      </div>
      <div class="pfoot"></div>`;

    const ta = panel.querySelector(".pinput");
    const run = panel.querySelector(".prun");
    const modeBtns = [...panel.querySelectorAll(".pmodes button")];
    const paintMode = () => modeBtns.forEach((b) => b.classList.toggle("on", b.dataset.mode === state.mode));
    paintMode();
    modeBtns.forEach((b) => b.addEventListener("click", () => {
      state.mode = b.dataset.mode;
      chrome.storage.local.set({ rethink_mode: state.mode });
      paintMode();
      schedulePreview();
      ta.focus();
    }));

    const grow = () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, innerHeight * 0.3) + "px"; };
    ta.addEventListener("input", () => { grow(); schedulePreview(); });
    ta.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); startRun(ta.value.trim()); }
      else if (e.key === "Escape") { e.preventDefault(); deselect(); }
    });
    run.addEventListener("click", () => startRun(ta.value.trim()));
    panel.querySelector(".x").addEventListener("click", deselect);
    panel.querySelectorAll(".ptab").forEach((t) => t.addEventListener("click", () => switchTab(t.dataset.tab)));

    positionPanel(el);
    setTimeout(() => { ta.focus(); grow(); }, 0);
  }

  function positionPanel(el) {
    if (panel.style.display === "none") return;
    const r = el.getBoundingClientRect();
    const pw = panel.offsetWidth || 384;
    const ph = panel.offsetHeight || 320;
    let left = r.right + 12;
    if (left + pw > innerWidth - 8) left = r.left - 12 - pw; // flip to the left
    if (left < 8) left = Math.max(8, innerWidth - pw - 8); // pin to viewport
    let top = r.top;
    if (top + ph > innerHeight - 8) top = innerHeight - ph - 8;
    if (top < 8) top = 8;
    panel.style.left = left + "px";
    panel.style.top = top + "px";
  }

  function switchTab(tab) {
    state.activeTab = tab;
    panel.querySelectorAll(".ptab").forEach((t) => t.classList.toggle("on", t.dataset.tab === tab));
    panel.querySelectorAll(".pane").forEach((p) => p.classList.toggle("on", p.dataset.pane === tab));
    if (tab === "prompt") renderPromptPreview();
  }

  // Fetch the exact system + user message from the background and show it with
  // the user's own instruction highlighted where it's injected.
  function schedulePreview() {
    if (state.previewScheduled) return;
    state.previewScheduled = true;
    setTimeout(() => { state.previewScheduled = false; if (state.activeTab === "prompt") renderPromptPreview(); }, 160);
  }

  async function renderPromptPreview() {
    const pane = panel.querySelector('[data-pane="prompt"]');
    if (!pane) return;
    const ta = panel.querySelector(".pinput");
    const prompt = ta ? ta.value.trim() : "";
    let resp;
    try {
      resp = await chrome.runtime.sendMessage({
        type: "OR_PREVIEW",
        payload: { prompt, mode: state.mode, html: state.originalHtml, css: state.harvestedCss },
      });
    } catch (e) { resp = null; }
    if (!resp || !resp.ok) { pane.innerHTML = `<span class="empty">preview unavailable</span>`; return; }

    const needle = resp.promptText;
    let userHtml = escapeHtml(resp.user);
    const escNeedle = escapeHtml(needle);
    const at = userHtml.indexOf(escNeedle);
    if (at >= 0) {
      userHtml = userHtml.slice(0, at) + `<span class="hl">${escNeedle}</span>` + userHtml.slice(at + escNeedle.length);
    }
    pane.innerHTML =
      `<span class="sys">${escapeHtml(resp.system)}</span>` +
      `<span class="sep">──────── user message (your instruction highlighted) ────────</span>` +
      userHtml;
  }

  function setStatus(html) { const s = panel.querySelector(".pstatus"); if (s) s.innerHTML = html; }
  function setFoot(html) { const f = panel.querySelector(".pfoot"); if (f) f.innerHTML = html; }

  // ── streaming ──────────────────────────────────────────────────────────────
  // Parse the streamed fences. `closed` marks which blocks have seen their
  // terminating ``` — that's the "block is ready to apply" signal.
  function parseFences(text) {
    const out = { html: "", css: "", js: "", closed: { html: false, css: false, js: false } };
    if (!text) return out;
    let cur = null;
    for (const line of text.split("\n")) {
      const f = line.match(/^\s*```([a-zA-Z]*)\s*$/);
      if (f) {
        if (cur) { if (cur !== "_skip") out.closed[cur] = true; cur = null; }
        else { let l = (f[1] || "").toLowerCase(); if (l === "javascript") l = "js"; cur = l === "html" || l === "css" || l === "js" ? l : "_skip"; }
        continue;
      }
      if (cur && cur !== "_skip") out[cur] += line + "\n";
    }
    out.html = out.html.replace(/\s+$/, "");
    out.css = out.css.replace(/\s+$/, "");
    out.js = out.js.replace(/\s+$/, "");
    return out;
  }

  // Largest prefix of `css` that ends on a complete rule — so we never inject a
  // half-written declaration like ".x{color:re".
  function cssUpToLastRule(css) {
    const i = css.lastIndexOf("}");
    return i >= 0 ? css.slice(0, i + 1) : "";
  }

  function startRun(prompt) {
    if (!state.selected || state.phase === "loading") return;
    // revert a previous result so a re-run diffs against the pristine original
    if (state.undo) { state.undo(); state.undo = null; }
    state.phase = "loading";
    state.htmlApplied = false;
    state.htmlUndo = null;
    state.lastAppliedCss = "";
    const run = panel.querySelector(".prun");
    if (run) run.disabled = true;
    setFoot("");
    setStatus(`<span class="spin"></span> streaming`);

    const html = state.originalHtml;
    const css = state.harvestedCss;

    let port;
    try { port = chrome.runtime.connect({ name: "rethink-stream" }); }
    catch (e) { return streamFailed("Could not reach the extension: " + e.message); }
    state.port = port;
    state.raw = "";

    port.onMessage.addListener((m) => {
      if (m.type === "start") {
        const el = panel.querySelector(".model");
        if (el) el.textContent = m.model || "";
      } else if (m.type === "delta") {
        state.raw += m.text;
        scheduleRender(false);
      } else if (m.type === "done") {
        state.raw = m.full || state.raw;
        renderStream(true);
        finishRun();
        try { port.disconnect(); } catch (_) {}
        state.port = null;
      } else if (m.type === "error") {
        if (m.full) state.raw = m.full;
        streamFailed(m.error);
        try { port.disconnect(); } catch (_) {}
        state.port = null;
      }
    });
    port.onDisconnect.addListener(() => { if (state.phase === "loading") streamFailed("Stream disconnected."); });

    port.postMessage({ type: "run", payload: { prompt, html, css, mode: state.mode } });
  }

  function scheduleRender() {
    if (state.diffScheduled) return;
    state.diffScheduled = true;
    requestAnimationFrame(() => { state.diffScheduled = false; renderStream(false); });
  }

  function renderStream(done) {
    const s = parseFences(state.raw);
    state.sections = s;

    // HTML tab: live diff vs original
    const htmlPane = panel.querySelector('[data-pane="html"]');
    if (htmlPane) {
      if (s.html) htmlPane.innerHTML = renderDiff(state.originalHtml, s.html);
      else htmlPane.innerHTML = `<span class="empty">waiting for the html block…</span>`;
    }
    // CSS tab: show the raw stream, but only inject COMPLETE rules to the page,
    // and only when they actually changed (so the page isn't restyled per char).
    const cssPane = panel.querySelector('[data-pane="css"]');
    if (cssPane) cssPane.textContent = s.css || "";
    if (!s.css && cssPane) cssPane.innerHTML = `<span class="empty">no extra CSS.</span>`;
    if (s.css) {
      const ready = s.closed.css ? s.css : cssUpToLastRule(s.css);
      if (ready && ready !== state.lastAppliedCss) { applyCss(ready); state.lastAppliedCss = ready; }
    }

    // HTML: apply the whole block the moment it's complete (or the stream ends).
    // One atomic apply — never a partial tag — and guarded so it happens once.
    if (!state.htmlApplied && s.html && (s.closed.html || done)) applyHtmlNow(s.html);

    // JS tab: show only
    const jsPane = panel.querySelector('[data-pane="js"]');
    if (jsPane) jsPane.textContent = s.js || "";
    if (!s.js && jsPane) jsPane.innerHTML = `<span class="empty">no JS suggested.</span>`;

    // tab activity dots
    panel.querySelector('[data-tab="css"]')?.classList.toggle("has", !!s.css);
    panel.querySelector('[data-tab="js"]')?.classList.toggle("has", !!s.js);

    if (state.htmlApplied && !done) setStatus(`<span class="spin"></span> applied · streaming`);
    if (done) setStatus(`done`);
  }

  // Apply the html block once; records the undo and flashes. Returns success.
  function applyHtmlNow(html) {
    try {
      state.htmlUndo = applyHtml(html); // parses + applies per mode, updates state.selected
      state.htmlApplied = true;
      flash(state.selected);
      return true;
    } catch (_) {
      return false; // e.g. fence closed early / not yet valid — retry at done
    }
  }

  function finishRun() {
    const s = state.sections;
    const run = panel.querySelector(".prun");
    if (run) run.disabled = false;
    if (!s.html) { streamFailed("Model returned no html block."); return; }

    // The html block usually applied mid-stream; if it never did (e.g. no closing
    // fence), apply it now. Then commit the final complete CSS.
    if (!state.htmlApplied && !applyHtmlNow(s.html)) { streamFailed("Could not apply the returned HTML."); return; }
    if (s.css) {
      const ready = s.closed.css ? s.css : cssUpToLastRule(s.css);
      if (ready && ready !== state.lastAppliedCss) { applyCss(ready); state.lastAppliedCss = ready; }
    }
    state.undo = () => { state.htmlUndo && state.htmlUndo(); removeCss(); };
    state.phase = "done";

    const jsBtn = state.sections.js && state.mode === "freedom"
      ? `<button class="warn" data-act="runjs" title="runs the suggested JS in the page, once">⚠ run JS once</button>` : "";
    setFoot(`<span class="ok">✓ applied</span>
      <button data-act="again">again</button>
      <button data-act="undo">undo</button>
      ${jsBtn}
      <button class="primary" data-act="done">done</button>`);
    panel.querySelector('[data-act="again"]').addEventListener("click", () => {
      const ta = panel.querySelector(".pinput"); state.phase = "selected"; setStatus(""); ta && ta.focus();
    });
    panel.querySelector('[data-act="undo"]').addEventListener("click", () => { if (state.undo) state.undo(); state.undo = null; deselect(); });
    panel.querySelector('[data-act="done"]').addEventListener("click", () => { removeSelectionButKeepResult(); });
    const rj = panel.querySelector('[data-act="runjs"]');
    if (rj) rj.addEventListener("click", () => runSuggestedJs(state.sections.js, rj));
    syncToSelected();
  }

  function streamFailed(msg) {
    state.phase = "error";
    const run = panel.querySelector(".prun");
    if (run) run.disabled = false;
    setStatus("error");
    setFoot(`<span class="msg">⚠ ${escapeHtml(msg)}</span><button class="primary" data-act="close">close</button>`);
    panel.querySelector('[data-act="close"]')?.addEventListener("click", () => {
      state.phase = "selected"; setStatus(""); setFoot("");
    });
  }

  // ── applying ───────────────────────────────────────────────────────────────
  function applyCss(css) {
    if (!state.cssEl) {
      state.cssEl = document.createElement("style");
      state.cssEl.setAttribute("data-rethink-css", "");
      (document.head || document.documentElement).appendChild(state.cssEl);
    }
    state.cssEl.textContent = css;
  }
  function removeCss() { if (state.cssEl) { state.cssEl.remove(); state.cssEl = null; } }

  // Returns an undo function; updates state.selected to the applied node.
  function applyHtml(newHtml) {
    const tpl = document.createElement("template");
    tpl.innerHTML = (newHtml || "").trim();
    const newRoot = tpl.content.firstElementChild;
    if (!newRoot) throw new Error("no element in html block");
    if (state.mode === "classes") return applyClassesOnly(state.selected, newRoot);
    if (state.mode === "everything") return applyEverything(state.selected, newRoot);
    return applyFreedom(state.selected, newRoot);
  }

  function applyFreedom(selectedEl, newRoot) {
    const originalClone = selectedEl.cloneNode(true);
    selectedEl.replaceWith(newRoot);
    state.selected = newRoot;
    syncToSelected();
    return () => { const back = originalClone.cloneNode(true); state.selected.replaceWith(back); state.selected = back; syncToSelected(); };
  }

  function applyClassesOnly(liveEl, aiEl) {
    const changes = [];
    const walk = (live, ai) => {
      if (!live || !ai || live.tagName !== ai.tagName) return;
      changes.push([live, live.getAttribute("class"), live.getAttribute("style")]);
      const nc = ai.getAttribute("class"), ns = ai.getAttribute("style");
      if (nc === null) live.removeAttribute("class"); else live.setAttribute("class", nc);
      if (ns === null) live.removeAttribute("style"); else live.setAttribute("style", ns);
      const lc = live.children, ac = ai.children, n = Math.min(lc.length, ac.length);
      for (let i = 0; i < n; i++) walk(lc[i], ac[i]);
    };
    walk(liveEl, aiEl);
    state.selected = liveEl;
    syncToSelected();
    return () => {
      for (const [el, cls, sty] of changes) {
        if (cls === null) el.removeAttribute("class"); else el.setAttribute("class", cls);
        if (sty === null) el.removeAttribute("style"); else el.setAttribute("style", sty);
      }
      syncToSelected();
    };
  }

  function applyEverything(selectedEl, newRoot) {
    const originalClone = selectedEl.cloneNode(true);
    const origById = new Map();
    const attrSnap = new Map();
    const indexOrig = (el) => {
      if (el.id) {
        origById.set(el.id, el);
        const snap = {};
        for (const a of el.attributes) if (a.name.startsWith("data-") || PRESERVE_ATTRS.includes(a.name)) snap[a.name] = a.value;
        attrSnap.set(el.id, snap);
      }
      for (const c of el.children) indexOrig(c);
    };
    indexOrig(selectedEl);

    const graft = (aiNode) => {
      if (aiNode.nodeType !== 1) return aiNode.cloneNode(true);
      const id = aiNode.id;
      if (id && origById.has(id)) {
        const o = origById.get(id);
        origById.delete(id);
        for (const a of [...o.attributes]) o.removeAttribute(a.name);
        for (const a of aiNode.attributes) o.setAttribute(a.name, a.value);
        const snap = attrSnap.get(id) || {};
        for (const k in snap) if (!o.hasAttribute(k)) o.setAttribute(k, snap[k]);
        o.id = id;
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
    if (origById.size) {
      const vault = document.createElement("div");
      vault.setAttribute("data-rethink-preserved", "");
      vault.hidden = true; vault.style.display = "none";
      for (const node of origById.values()) vault.appendChild(node);
      live.appendChild(vault);
      console.warn("[rethink] AI dropped ids; preserved in hidden vault:", [...origById.keys()]);
    }
    selectedEl.replaceWith(live);
    state.selected = live;
    syncToSelected();
    return () => { const back = originalClone.cloneNode(true); state.selected.replaceWith(back); state.selected = back; syncToSelected(); };
  }

  function flash(el) {
    if (!el || el.nodeType !== 1) return;
    el.classList.add("rethink-flash");
    setTimeout(() => el.classList.remove("rethink-flash"), 950);
  }

  // User-gated, freedom-mode only: run the suggested JS once in the page world.
  function runSuggestedJs(js, btn) {
    if (!js) return;
    try {
      const s = document.createElement("script");
      s.textContent = `(function(){try{\n${js}\n}catch(e){console.error('[rethink JS]',e);}})();`;
      (document.head || document.documentElement).appendChild(s);
      s.remove();
      if (btn) { btn.textContent = "✓ ran"; btn.disabled = true; }
    } catch (e) {
      if (btn) btn.textContent = "JS blocked (CSP)";
      console.warn("[rethink] page CSP blocked injected JS:", e);
    }
  }

  // ── diff (LCS line diff over pretty-printed HTML) ──────────────────────────
  function prettyHtml(html) {
    return html.replace(/>\s*</g, ">\n<").replace(/\n{2,}/g, "\n").trim();
  }
  function lineDiff(aLines, bLines) {
    const n = aLines.length, m = bLines.length;
    if (n * m > DIFF_CELL_CAP) return bLines.map((l) => ({ t: "add", l }));
    const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[i][j] = aLines[i] === bLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const out = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (aLines[i] === bLines[j]) { out.push({ t: "ctx", l: bLines[j] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: "del", l: aLines[i] }); i++; }
      else { out.push({ t: "add", l: bLines[j] }); j++; }
    }
    while (i < n) out.push({ t: "del", l: aLines[i++] });
    while (j < m) out.push({ t: "add", l: bLines[j++] });
    return out;
  }
  function renderDiff(oldHtml, newHtml) {
    const a = prettyHtml(oldHtml).split("\n");
    const b = prettyHtml(newHtml).split("\n");
    const rows = lineDiff(a, b);
    const sym = { add: "+ ", del: "- ", ctx: "  " };
    return rows.map((r) => `<span class="${r.t}">${escapeHtml(sym[r.t] + r.l)}</span>`).join("");
  }

  // ── selection lifecycle ────────────────────────────────────────────────────
  function syncToSelected() {
    if (state.selected) { drawSubtree(state.selected, { selected: true }); positionPanel(state.selected); }
  }

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
      if (!el) return;
      if (el.closest && el.closest("#rethink-root")) return;
      if (el === state.hovered) { drawSubtree(el); positionPill(el); return; }
      state.hovered = el;
      drawSubtree(el);
      showPill(el);
    });
  }

  function onClick(e) {
    if (!state.armed) return;
    const path = e.composedPath ? e.composedPath() : [];
    if (path.includes(host)) return; // clicks inside our UI
    if (state.phase !== "hovering") return;
    const el = state.hovered || document.elementFromPoint(e.clientX, e.clientY);
    if (!el) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    select(el);
  }

  function select(el) {
    state.selected = el;
    state.originalHtml = el.outerHTML;
    state.harvestedCss = collectCss(el); // harvested once; reused for run + preview
    state.phase = "selected";
    drawSubtree(el, { selected: true });
    showPanel(el);
  }

  // "done": dismiss the panel but keep the applied result on the page
  function removeSelectionButKeepResult() {
    state.undo = null; // commit
    hardReset();
  }

  function deselect() {
    if (state.port) { try { state.port.disconnect(); } catch (_) {} state.port = null; }
    // if there's an uncommitted result, leave it as-is (user chose close, not undo)
    hardReset();
  }

  function hardReset() {
    state.selected = null;
    state.hovered = null;
    state.raw = "";
    state.sections = { html: "", css: "", js: "" };
    state.phase = state.armed ? "hovering" : "idle";
    clearBoxes();
    hidePill();
    panel.style.display = "none";
    panel.innerHTML = "";
  }

  function reposition() {
    if (state.phase === "hovering" && state.hovered) { drawSubtree(state.hovered); positionPill(state.hovered); }
    else if (state.selected) syncToSelected();
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
    if (state.port) { try { state.port.disconnect(); } catch (_) {} state.port = null; }
    hardReset();
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
    if (e.key === "Escape" && state.phase === "hovering") {
      disarm();
      chrome.storage.local.set({ rethink_active: false });
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ── messaging from popup ───────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "RETHINK_ARM") { arm(msg.mode); sendResponse({ ok: true, armed: true }); }
    else if (msg?.type === "RETHINK_DISARM") { disarm(); sendResponse({ ok: true, armed: false }); }
    else if (msg?.type === "RETHINK_STATE") { sendResponse({ ok: true, armed: state.armed, phase: state.phase, mode: state.mode }); }
    else if (msg?.type === "RETHINK_SET_MODE") { state.mode = msg.mode || state.mode; sendResponse({ ok: true, mode: state.mode }); }
    return true;
  });
})();
