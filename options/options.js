/* rethink — options page. Hosts the ai_model_selector modal and BYOK config. */

const $ = (s) => document.querySelector(s);
let settings = { rethink_or_key: "", rethink_model: "", rethink_mode: "classes" };
let modelsLoaded = false;

async function load() {
  settings = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
  if (settings.rethink_or_key) $("#key").value = settings.rethink_or_key;
  $("#modelName").textContent = settings.rethink_model || "—";
  $("#defaultMode").value = settings.rethink_mode || "classes";
}

// Pull the OpenRouter catalogue (via the background worker) into the global the
// model selector reads. Public endpoint, so it works even before a key is set.
async function ensureModels() {
  if (modelsLoaded) return true;
  $("#modelHelp").textContent = "Loading OpenRouter model catalogue…";
  const r = await chrome.runtime.sendMessage({ type: "OR_MODELS" });
  if (!r || !r.ok) {
    $("#modelHelp").textContent = "Could not load models: " + (r?.error || "unknown");
    return false;
  }
  window.OPENROUTER_MODELS = r.data; // { data: [...] }
  window.MS_API_STATUS = { openrouter: { configured: !!settings.rethink_or_key } };
  modelsLoaded = true;
  $("#modelHelp").textContent =
    "Selector powered by juanpe500/ai_model_selector over OpenRouter's catalogue.";
  return true;
}

$("#pickModel").addEventListener("click", async () => {
  const ok = await ensureModels();
  if (!ok) return;
  if (typeof ModelSelectorModal === "undefined") {
    $("#modelHelp").textContent = "Model selector failed to load.";
    return;
  }
  ModelSelectorModal.open({
    inputModalities: ["text"],
    outputModalities: ["text"],
    currentModel: settings.rethink_model || "",
    apis: ["openrouter"],
    onSelect: async (id) => {
      settings = await chrome.runtime.sendMessage({
        type: "SET_SETTINGS",
        payload: { rethink_model: id },
      });
      $("#modelName").textContent = id;
      ModelSelectorModal.close();
    },
  });
});

$("#reveal").addEventListener("click", () => {
  const k = $("#key");
  k.type = k.type === "password" ? "text" : "password";
});

$("#saveKey").addEventListener("click", async () => {
  const key = $("#key").value.trim();
  settings = await chrome.runtime.sendMessage({
    type: "SET_SETTINGS",
    payload: { rethink_or_key: key },
  });
  const st = $("#keyStatus");
  if (!key) {
    st.className = "status err";
    st.textContent = "Key cleared.";
  } else {
    st.className = "status ok";
    st.textContent = "Saved ✓";
  }
  modelsLoaded = false; // re-fetch catalogue with the new key next time
});

$("#defaultMode").addEventListener("change", async () => {
  settings = await chrome.runtime.sendMessage({
    type: "SET_SETTINGS",
    payload: { rethink_mode: $("#defaultMode").value },
  });
});

load();
