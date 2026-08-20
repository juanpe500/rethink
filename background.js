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
You MUST reply with a single JSON object and nothing else: {"html": "<the transformed block>", "notes": "<one short sentence>"}.
The "html" value is a complete replacement for the block, including its own outermost element.
Never wrap the JSON in markdown. Never emit <script> tags. Never invent external URLs, images, or fonts.`;

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

// Pull the {"html": ...} object out of a model reply, tolerating stray prose or
// a ```json fence if the model ignores the "JSON only" rule.
function extractResult(content) {
  if (!content) return null;
  const tryParse = (t) => {
    try {
      const o = JSON.parse(t);
      if (o && typeof o.html === "string") return o;
    } catch (_) {}
    return null;
  };
  let out = tryParse(content.trim());
  if (out) return out;

  const fence = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    out = tryParse(fence[1].trim());
    if (out) return out;
  }
  // last resort: first {...} that parses
  const brace = content.match(/\{[\s\S]*\}/);
  if (brace) {
    out = tryParse(brace[0]);
    if (out) return out;
  }
  return null;
}

async function callOpenRouter({ prompt, html, css, mode }) {
  const { rethink_or_key: key, rethink_model: model } = await getSettings();
  if (!key) {
    return { ok: false, error: "No OpenRouter API key set. Open the popup → Settings and paste your key." };
  }
  const body = {
    model,
    messages: [
      { role: "system", content: systemPrompt(mode) },
      { role: "user", content: userPrompt({ prompt, html, css }) },
    ],
    temperature: 0.7,
  };
  // Note: we deliberately do NOT send response_format:json_object — many
  // OpenRouter providers 400 on it. The prompt asks for JSON and extractResult()
  // tolerates fences/prose, which keeps every model in the catalogue usable.

  let resp;
  try {
    resp = await fetch(`${OR_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        "HTTP-Referer": "https://github.com/juanpe500/ai_model_selector",
        "X-Title": "rethink",
      },
      body: JSON.stringify(body),
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
  const content = data?.choices?.[0]?.message?.content;
  const result = extractResult(content);
  if (!result) {
    return { ok: false, error: "Model did not return usable JSON.", raw: content };
  }
  return { ok: true, html: result.html, notes: result.notes || "", model };
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
      case "OR_CHAT":
        sendResponse(await callOpenRouter(msg.payload || {}));
        break;
      case "OR_MODELS":
        sendResponse(await fetchModels());
        break;
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
