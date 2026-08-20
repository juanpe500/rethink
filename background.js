/* rethink — background service worker.
 *
 * Owns three things the page must never touch directly:
 *   1. persisted settings (OpenRouter key, chosen model, default mode)
 *   2. the OpenRouter model catalogue (for the model picker)
 *   3. the actual AI call (the BYOK key lives here, never in a page world)
 *
 * Everything is BYOK / no-server: the key sits in chrome.storage.local and the
 * fetch goes straight to openrouter.ai from this worker.
 */

const OR_BASE = "https://openrouter.ai/api/v1";

const DEFAULTS = {
  rethink_or_key: "",
  rethink_model: "google/gemini-2.5-flash",
  rethink_mode: "classes", // 'everything' | 'classes' | 'freedom'
};

async function getSettings() {
  const s = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...s };
}

// ── prompt construction ──────────────────────────────────────────────────────
// Each mode has a hard contract. Mode 2 ("classes") is additionally enforced in
// the content script by structural diffing — the prompt is only the first line
// of defence.
function systemPrompt(mode) {
  const common = `You are "rethink", an expert front-end designer that rewrites a single block of live HTML.
You receive: (a) the user's instruction, (b) the block's outerHTML, (c) the CSS rules currently matching that block.

REPLY FORMAT — stream these fenced blocks, in this exact order, and nothing else:
\`\`\`html
<the complete replacement for the block, including its own outermost element>
\`\`\`
\`\`\`css
/* OPTIONAL: extra or overriding CSS rules. Omit this block entirely if not needed. */
\`\`\`
\`\`\`js
// OPTIONAL: behaviour you suggest. It is shown to the user but NOT auto-executed. Omit if not needed.
\`\`\`
Always output the html block first and complete. Do not write any prose outside the fences.
Never put <script> tags inside the html block. Never invent external URLs, images, or fonts.`;

  const perMode = {
    everything: `MODE: RESTYLE EVERYTHING.
You may rename, add, and remove classes; add/rewrite inline styles; introduce new wrapper elements; and change the internal DOM structure freely.
HARD CONSTRAINTS — the output is rejected if any is violated:
- Preserve EVERY id attribute that existed in the input, on an element representing the same content.
- Preserve EVERY data-* attribute, plus name, value, href, src, alt, type, and for/aria-* attributes.
- Preserve all text content the user can read.
- The HTML must be valid and self-contained (no unclosed tags).
It is acceptable for JS event bindings to detach; the host will re-attach any element it can match by id.`,

    classes: `MODE: RESTYLE CLASSES ONLY.
You may ONLY change the "class" attribute and the inline "style" attribute of existing elements.
HARD CONSTRAINTS — the host discards any change that violates these, so do not attempt them:
- Do NOT add, remove, reorder, or rename elements.
- Do NOT change tag names.
- Do NOT touch ids or any attribute other than class and style.
- The element tree must be structurally identical to the input (same tags, same nesting, same order).
Return the same tree with only class/style edited.`,

    freedom: `MODE: FULL FREEDOM.
Do whatever best satisfies the user's instruction. No constraints beyond valid, script-free HTML.`,
  };

  return `${common}\n\n${perMode[mode] || perMode.freedom}`;
}

function userPrompt({ prompt, html, css }) {
  const clippedCss = (css || "").slice(0, 40000);
  return `USER INSTRUCTION:
${prompt || "(no extra instruction — use your best judgement)"}

BLOCK HTML:
${html}

MATCHING CSS RULES:
${clippedCss || "(none captured)"}`;
}

function reqHeaders(key) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${key}`,
    "HTTP-Referer": "https://github.com/juanpe500/rethink",
    "X-Title": "rethink",
  };
}

function chatBody(model, mode, payload, stream) {
  return JSON.stringify({
    model,
    stream: !!stream,
    temperature: 0.7,
    // Ask OpenRouter to include token counts + cost (works for stream & non-stream).
    usage: { include: true },
    messages: [
      { role: "system", content: systemPrompt(mode) },
      { role: "user", content: userPrompt(payload) },
    ],
  });
}

// ── usage log (metadata only — never the prompt or the response) ─────────────
const USAGE_KEY = "rethink_usage";
const USAGE_CAP = 5000;

async function recordUsage(usage, model, mode, sender) {
  if (!usage) return null;
  const url = sender?.tab?.url || sender?.url || "";
  let host = "";
  try { host = new URL(url).hostname; } catch (_) {}
  const entry = {
    ts: Date.now(),
    host,
    model: model || "",
    mode: mode || "",
    pin: usage.prompt_tokens ?? usage.input_tokens ?? null,
    pout: usage.completion_tokens ?? usage.output_tokens ?? null,
    cost: typeof usage.cost === "number" ? usage.cost : null,
  };
  const store = await chrome.storage.local.get({ [USAGE_KEY]: [] });
  const arr = store[USAGE_KEY];
  arr.unshift(entry); // newest first
  if (arr.length > USAGE_CAP) arr.length = USAGE_CAP;
  await chrome.storage.local.set({ [USAGE_KEY]: arr });
  return entry;
}

async function getUsage(offset = 0, limit = 10) {
  const { [USAGE_KEY]: arr = [] } = await chrome.storage.local.get({ [USAGE_KEY]: [] });
  const totalCost = arr.reduce((s, e) => s + (e.cost || 0), 0);
  const totalIn = arr.reduce((s, e) => s + (e.pin || 0), 0);
  const totalOut = arr.reduce((s, e) => s + (e.pout || 0), 0);
  return { ok: true, total: arr.length, totalCost, totalIn, totalOut, entries: arr.slice(offset, offset + limit) };
}

// Split the fenced reply into { html, css, js }. Tolerant of a still-open final
// fence so partial (streaming) text parses too — the content script calls the
// same logic on every delta.
function parseFences(text) {
  const out = { html: "", css: "", js: "" };
  if (!text) return out;
  let cur = null;
  for (const line of text.split("\n")) {
    const f = line.match(/^\s*```([a-zA-Z]*)\s*$/);
    if (f) {
      if (cur) {
        cur = null;
      } else {
        let l = (f[1] || "").toLowerCase();
        if (l === "javascript") l = "js";
        cur = l === "html" || l === "css" || l === "js" ? l : "_skip";
      }
      continue;
    }
    if (cur && cur !== "_skip") out[cur] += line + "\n";
  }
  out.html = out.html.trim();
  out.css = out.css.trim();
  out.js = out.js.trim();
  return out;
}

// Non-streaming fallback (used if a Port stream can't be opened).
async function callOpenRouter({ prompt, html, css, mode }) {
  const { rethink_or_key: key, rethink_model: model } = await getSettings();
  if (!key) {
    return { ok: false, error: "No OpenRouter API key set. Open the popup → Settings and paste your key." };
  }
  let resp;
  try {
    resp = await fetch(`${OR_BASE}/chat/completions`, {
      method: "POST",
      headers: reqHeaders(key),
      body: chatBody(model, mode, { prompt, html, css }, false),
    });
  } catch (e) {
    return { ok: false, error: `Network error reaching OpenRouter: ${e.message}` };
  }
  const text = await resp.text();
  if (!resp.ok) {
    let msg = text;
    try { msg = JSON.parse(text)?.error?.message || text; } catch (_) {}
    return { ok: false, error: `OpenRouter ${resp.status}: ${msg}` };
  }
  let data;
  try { data = JSON.parse(text); } catch (_) {
    return { ok: false, error: "OpenRouter returned non-JSON." };
  }
  const content = data?.choices?.[0]?.message?.content || "";
  const parts = parseFences(content);
  if (!parts.html) return { ok: false, error: "Model returned no html block.", raw: content };
  return { ok: true, ...parts, model, usage: data.usage || null };
}

// Streaming path: fetch with stream:true, read the SSE body, and forward each
// content delta to the content script over the Port. (Same reader/decoder/buffer
// shape the viclix dashboard uses, adapted to OpenRouter's `data: {...}` frames.)
async function streamOpenRouter(payload, port) {
  const { rethink_or_key: key, rethink_model: model } = await getSettings();
  if (!key) {
    port.postMessage({ type: "error", error: "No OpenRouter API key set. Open the popup → Settings and paste your key." });
    return;
  }
  let resp;
  try {
    resp = await fetch(`${OR_BASE}/chat/completions`, {
      method: "POST",
      headers: reqHeaders(key),
      body: chatBody(model, payload.mode, payload, true),
    });
  } catch (e) {
    port.postMessage({ type: "error", error: `Network error reaching OpenRouter: ${e.message}` });
    return;
  }
  if (!resp.ok || !resp.body) {
    let msg = "";
    try { msg = await resp.text(); } catch (_) {}
    try { msg = JSON.parse(msg)?.error?.message || msg; } catch (_) {}
    port.postMessage({ type: "error", error: `OpenRouter ${resp.status}: ${msg.slice(0, 300)}` });
    return;
  }

  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let full = "";
  let usage = null; // OpenRouter sends this in the final frame (usage.include)
  port.postMessage({ type: "start", model });
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line || line.startsWith(":")) continue; // keep-alive comment
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const j = JSON.parse(data);
          if (j.usage) usage = j.usage;
          const delta = j.choices?.[0]?.delta?.content || "";
          if (delta) {
            full += delta;
            port.postMessage({ type: "delta", text: delta });
          }
        } catch (_) {
          /* partial JSON across chunks is impossible here — frames are line-delimited */
        }
      }
    }
  } catch (e) {
    port.postMessage({ type: "error", error: `Stream interrupted: ${e.message}`, full });
    return;
  }
  const entry = await recordUsage(usage, model, payload.mode, port.sender);
  port.postMessage({ type: "done", full, usage, entry });
}

async function fetchModels() {
  const { rethink_or_key: key } = await getSettings();
  const headers = { "Content-Type": "application/json" };
  if (key) headers.Authorization = `Bearer ${key}`; // catalogue is public, key optional
  try {
    const resp = await fetch(`${OR_BASE}/models`, { headers });
    const text = await resp.text();
    if (!resp.ok) return { ok: false, error: `OpenRouter ${resp.status}: ${text.slice(0, 200)}` };
    return { ok: true, data: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── message router ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case "OR_CHAT": {
        const res = await callOpenRouter(msg.payload || {});
        if (res.ok && res.usage) res.entry = await recordUsage(res.usage, res.model, msg.payload?.mode, _sender);
        sendResponse(res);
        break;
      }
      case "GET_USAGE": {
        const { offset = 0, limit = 10 } = msg.payload || {};
        sendResponse(await getUsage(offset, limit));
        break;
      }
      case "CLEAR_USAGE":
        await chrome.storage.local.set({ [USAGE_KEY]: [] });
        sendResponse({ ok: true });
        break;
      case "OR_MODELS":
        sendResponse(await fetchModels());
        break;
      case "OR_PREVIEW": {
        // Exact strings that will be sent, so the panel can show the real prompt.
        const p = msg.payload || {};
        sendResponse({
          ok: true,
          system: systemPrompt(p.mode),
          user: userPrompt({ prompt: p.prompt, html: p.html, css: p.css }),
          promptText: p.prompt || "(no extra instruction — use your best judgement)",
        });
        break;
      }
      case "GET_SETTINGS":
        sendResponse(await getSettings());
        break;
      case "SET_SETTINGS":
        await chrome.storage.local.set(msg.payload || {});
        sendResponse(await getSettings());
        break;
      default:
        sendResponse({ ok: false, error: `Unknown message type: ${msg?.type}` });
    }
  })();
  return true; // keep the channel open for the async response
});

// ── streaming port ───────────────────────────────────────────────────────────
// The content script opens a Port and posts {type:'run', payload}; we stream
// deltas back over the same Port until 'done' or 'error'.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "rethink-stream") return;
  port.onMessage.addListener((msg) => {
    if (msg?.type === "run") streamOpenRouter(msg.payload || {}, port);
  });
});
