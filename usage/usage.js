/* rethink — full paginated usage logs. Reads chrome.storage via the worker. */

const PAGE_SIZE = 25;
let page = 0;
let total = 0;

const $ = (id) => document.getElementById(id);

function fmtCost(c) {
  if (typeof c !== "number") return "—";
  if (c === 0) return "free";
  return "$" + (c < 0.01 ? c.toFixed(6) : c.toFixed(4));
}
function fmtDate(ts) {
  const d = new Date(ts);
  return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function render() {
  const r = await chrome.runtime.sendMessage({ type: "GET_USAGE", payload: { offset: page * PAGE_SIZE, limit: PAGE_SIZE } });
  const rows = $("rows");
  if (!r || !r.ok) { rows.innerHTML = `<tr><td colspan="7" class="empty">Couldn't load usage.</td></tr>`; return; }

  total = r.total;
  $("sumCost").textContent = fmtCost(r.totalCost);
  $("sumN").textContent = r.total.toLocaleString();
  $("sumIn").textContent = r.totalIn.toLocaleString();
  $("sumOut").textContent = r.totalOut.toLocaleString();

  if (!r.entries.length) {
    rows.innerHTML = `<tr><td colspan="7" class="empty">No generations logged yet.</td></tr>`;
  } else {
    rows.innerHTML = r.entries.map((e) => {
      const free = e.cost === 0 || e.cost == null;
      return `<tr>
        <td>${fmtDate(e.ts)}</td>
        <td class="site" title="${esc(e.host || "")}">${esc(e.host || "—")}</td>
        <td class="model">${esc(e.model || "—")}</td>
        <td><span class="mode-pill">${esc(e.mode || "—")}</span></td>
        <td class="num">${e.pin == null ? "?" : e.pin.toLocaleString()}</td>
        <td class="num">${e.pout == null ? "?" : e.pout.toLocaleString()}</td>
        <td class="num cost ${free ? "free" : ""}">${fmtCost(e.cost)}</td>
      </tr>`;
    }).join("");
  }

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  $("pageInfo").textContent = `Page ${page + 1} of ${pages}`;
  $("prev").disabled = page <= 0;
  $("next").disabled = page >= pages - 1;
}

$("prev").addEventListener("click", () => { if (page > 0) { page--; render(); } });
$("next").addEventListener("click", () => { if ((page + 1) * PAGE_SIZE < total) { page++; render(); } });
$("clear").addEventListener("click", async () => {
  if (!confirm("Clear the entire usage log? This can't be undone.")) return;
  await chrome.runtime.sendMessage({ type: "CLEAR_USAGE" });
  page = 0;
  render();
});

render();
