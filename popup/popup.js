/* rethink — popup controller. Arms the active tab, edits BYOK settings. */

const $ = (s) => document.querySelector(s);
const settings = { rethink_or_key: "", rethink_model: "", rethink_mode: "classes" };
let armed = false;
let activeTab = null;

async function getActiveTab() {
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  return t;
}

// Send to the content script, injecting it first if it isn't there yet.
async function sendToTab(payload) {
  if (!activeTab) return { ok: false, error: "no tab" };
  try {
    return await chrome.tabs.sendMessage(activeTab.id, payload);
  } catch (_) {
    try {
      await chrome.scripting.insertCSS({ target: { tabId: activeTab.id }, files: ["content/content.css"] });
      await chrome.scripting.executeScript({ target: { tabId: activeTab.id }, files: ["content/content.js"] });
      return await chrome.tabs.sendMessage(activeTab.id, payload);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
}

function paintMode() {
  document.querySelectorAll("#modepick button").forEach((b) =>
    b.classList.toggle("on", b.dataset.mode === settings.rethink_mode)
  );
  $("#defaultMode").value = settings.rethink_mode;
}

function paintModel() {
  const name = settings.rethink_model || "—";
  $("#modelName").textContent = name;
  $("#modelName2").textContent = name;
}

function paintToggle() {
  const t = $("#toggle");
  t.classList.toggle("on", armed);
  t.querySelector(".label").textContent = armed ? "rethink mode is ON" : "Activate rethink mode";
}

function paintKeyWarning() {
  $("#warnKey").hidden = !!settings.rethink_or_key;
}

async function load() {
  activeTab = await getActiveTab();
  Object.assign(settings, await chrome.runtime.sendMessage({ type: "GET_SETTINGS" }));
  // ask the content script whether it's already armed on this tab
  try {
    const st = await chrome.tabs.sendMessage(activeTab.id, { type: "RETHINK_STATE" });
    armed = !!(st && st.armed);
  } catch (_) {
    armed = false;
  }
  paintMode();
  paintModel();
  paintToggle();
  paintKeyWarning();
}

// ── tabs ─────────────────────────────────────────────────────────────────────
document.querySelectorAll(".tab").forEach((tab) =>
  tab.addEventListener("click", () => switchTab(tab.dataset.tab))
);
function switchTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t.dataset.tab === name));
  document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("on", p.dataset.panel === name));
  if (name === "usage") loadUsage();
}

// ── usage ────────────────────────────────────────────────────────────────────
function fmtCost(c) {
  if (typeof c !== "number") return "—";
  if (c === 0) return "free";
  return "$" + (c < 0.01 ? c.toFixed(6) : c.toFixed(4));
}
function shortModel(id) { return id ? (id.includes("/") ? id.split("/").pop() : id) : "—"; }
function relTime(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}
async function loadUsage() {
  const list = document.getElementById("useList");
  const r = await chrome.runtime.sendMessage({ type: "GET_USAGE", payload: { offset: 0, limit: 10 } });
  if (!r || !r.ok) { list.innerHTML = `<div class="empty">Couldn't load usage.</div>`; return; }
  document.getElementById("useTotal").textContent = fmtCost(r.totalCost);
  document.getElementById("useTok").textContent =
    `${r.total} generation${r.total === 1 ? "" : "s"} · ${r.totalIn.toLocaleString()} in / ${r.totalOut.toLocaleString()} out`;
  if (!r.entries.length) { list.innerHTML = `<div class="empty">No generations yet — rethink a block to start logging.</div>`; return; }
  list.innerHTML = r.entries.map((e) => {
    const free = e.cost === 0 || e.cost == null;
    return `<div class="userow">
      <span class="cost ${free ? "free" : ""}">${fmtCost(e.cost)}</span>
      <span class="meta">
        <span class="model">${escapeHtml(shortModel(e.model))}</span>
        <span class="sub">${escapeHtml(e.host || "—")} · ${escapeHtml(e.mode || "—")} · ${(e.pin ?? "?")}→${(e.pout ?? "?")} tok</span>
      </span>
      <span class="when">${relTime(e.ts)}</span>
    </div>`;
  }).join("");
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
document.getElementById("openLogs").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("usage/usage.html") });
  window.close();
});
document.getElementById("clearUsage").addEventListener("click", async () => {
  if (!confirm("Clear the entire usage log? This can't be undone.")) return;
  await chrome.runtime.sendMessage({ type: "CLEAR_USAGE" });
  loadUsage();
});
document.addEventListener("click", (e) => {
  const g = e.target.closest("[data-goto]");
  if (g) {
    e.preventDefault();
    switchTab(g.dataset.goto);
  }
});

// ── toggle arm/disarm ────────────────────────────────────────────────────────
$("#toggle").addEventListener("click", async () => {
  if (!armed) {
    const r = await sendToTab({ type: "RETHINK_ARM", mode: settings.rethink_mode });
    if (r && r.ok) {
      armed = true;
    } else {
      alert("rethink can't run on this page.\n" + (r?.error || "")); // e.g. chrome:// pages
    }
  } else {
    await sendToTab({ type: "RETHINK_DISARM" });
    armed = false;
  }
  paintToggle();
  window.close(); // get out of the way so the user can hover the page
});

// ── mode picker (main) ───────────────────────────────────────────────────────
document.querySelectorAll("#modepick button").forEach((b) =>
  b.addEventListener("click", async () => {
    settings.rethink_mode = b.dataset.mode;
    paintMode();
    await chrome.runtime.sendMessage({ type: "SET_SETTINGS", payload: { rethink_mode: settings.rethink_mode } });
    if (armed) sendToTab({ type: "RETHINK_SET_MODE", mode: settings.rethink_mode });
  })
);

// ── shortcut rebind ──────────────────────────────────────────────────────────
$("#editShortcut").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  window.close();
});

// ── model pickers → open the options page (roomy enough for the modal) ────────
$("#pickModel").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("#pickModel2").addEventListener("click", () => chrome.runtime.openOptionsPage());

// ── settings ─────────────────────────────────────────────────────────────────
$("#key").value = ""; // filled on load below
$("#reveal").addEventListener("click", () => {
  const k = $("#key");
  k.type = k.type === "password" ? "text" : "password";
});
$("#defaultMode").addEventListener("change", () => {
  settings.rethink_mode = $("#defaultMode").value;
  paintMode();
});
$("#save").addEventListener("click", async () => {
  const payload = {
    rethink_or_key: $("#key").value.trim(),
    rethink_mode: $("#defaultMode").value,
  };
  Object.assign(settings, await chrome.runtime.sendMessage({ type: "SET_SETTINGS", payload }));
  paintKeyWarning();
  const el = $("#saved");
  el.hidden = false;
  setTimeout(() => (el.hidden = true), 1400);
});

// keep the key field in sync with stored value after load
chrome.runtime.sendMessage({ type: "GET_SETTINGS" }).then((s) => {
  if (s?.rethink_or_key) $("#key").value = s.rethink_or_key;
});

// re-read model when the popup regains focus (after picking in options tab)
window.addEventListener("focus", async () => {
  Object.assign(settings, await chrome.runtime.sendMessage({ type: "GET_SETTINGS" }));
  paintModel();
});

load();
