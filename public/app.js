// Day One web page: upload or paste → live agent progress → plain-language summary.
// Plain browser JavaScript, no build step.

const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null) n.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return n;
};

let images = []; // data URLs, one per page
let status = null;

// ── Status pills ────────────────────────────────────────────────────────────
async function loadStatus() {
  try {
    status = await (await fetch("/api/status")).json();
  } catch {
    return;
  }
  const list = $("status");
  list.replaceChildren();
  if (status.sampleMode) list.append(el("li", { class: "warn", text: "Sample mode" }));
  list.append(el("li", { class: status.nightshift === "online" || status.sampleMode ? "ok" : "bad", text: `Meterless Nightshift: ${status.nightshift}` }));
  list.append(el("li", { class: status.zetaris.ok ? "ok" : "bad", text: `Zetaris: ${status.zetaris.ok ? "connected" : "offline"}`, title: status.zetaris.detail }));
  list.append(el("li", { class: status.vision ? "ok" : "warn", text: status.vision ? "Photo reading on" : "Photo reading off" }));
  $("vision-note").hidden = !!status.vision;
}

// ── Input ───────────────────────────────────────────────────────────────────
function selectTab(which) {
  for (const t of ["photo", "text"]) {
    $(`tab-${t}`).setAttribute("aria-selected", String(t === which));
    $(`panel-${t}`).hidden = t !== which;
  }
}
$("tab-photo").onclick = () => selectTab("photo");
$("tab-text").onclick = () => selectTab("text");

$("files").onchange = async (e) => {
  images = [];
  $("thumbs").replaceChildren();
  const files = [...e.target.files].slice(0, 10);
  for (const [i, f] of files.entries()) {
    const url = await downscale(f);
    images.push(url);
    $("thumbs").append(el("figure", {}, el("img", { src: url, alt: `Page ${i + 1}` }), el("figcaption", { text: `Page ${i + 1}` })));
  }
};

/** Phone photos are huge; 1800 px on the long side is plenty to read text. */
function downscale(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 1800 / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

async function loadSamples() {
  try {
    const samples = await (await fetch("/api/samples")).json();
    for (const s of samples) $("sample").append(el("option", { value: s.text, text: s.name }));
  } catch {}
}
$("sample").onchange = (e) => {
  if (e.target.value) $("text").value = e.target.value;
};

$("go").onclick = async () => {
  const usePhoto = $("tab-photo").getAttribute("aria-selected") === "true";
  const body = usePhoto ? { images } : { text: $("text").value };
  $("input-error").hidden = true;
  if (usePhoto ? !images.length : !body.text.trim()) return showInputError(usePhoto ? "Choose a photo of at least one page." : "Paste the text of your summary first.");
  $("go").disabled = true;
  try {
    const res = await fetch("/api/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || "Something went wrong.");
    show("progress");
    history.replaceState(null, "", `?job=${out.id}`);
    poll(out.id);
  } catch (err) {
    showInputError(err.message);
  } finally {
    $("go").disabled = false;
  }
};

function showInputError(msg) {
  $("input-error").textContent = msg;
  $("input-error").hidden = false;
}

function show(view) {
  for (const v of ["input", "progress", "result"]) $(`${v}-view`).hidden = v !== view;
  window.scrollTo({ top: 0 });
}

// ── Progress ────────────────────────────────────────────────────────────────
const ICON = { waiting: "○", running: "", done: "✓", failed: "✕", skipped: "–" };
const NAMES = { orchestrator: "Orchestrator", scan: "Scan", extract: "Extract", lookup: "Lookup", memory: "Memory (H-MEM)", simplify: "Simplify", safety_checker: "Safety checker", qa: "Q&A", patient: "You" };

async function poll(id) {
  let job;
  try {
    job = await (await fetch(`/api/jobs/${id}`)).json();
  } catch {
    return setTimeout(() => poll(id), 2000);
  }
  renderSteps(job);
  renderMessages($("messages"), job.messages);
  if (job.status === "running") return setTimeout(() => poll(id), 1200);
  if (job.status === "done") return renderResult(job);
  show("input");
  if (job.status === "needs_rescan") showInputError(`Please take the photo again: ${job.rescan.map((r) => `page ${r.page} (${r.problem})`).join("; ")}.`);
  else showInputError(job.error || "Something went wrong.");
}

function renderSteps(job) {
  $("steps").replaceChildren(
    ...job.steps.map((s) => el("li", { class: s.status }, el("span", { class: "dot", "aria-hidden": "true", text: ICON[s.status] }), el("span", { text: s.label }), el("span", { class: "detail", text: s.detail || s.status }))),
  );
}

function renderMessages(list, messages) {
  const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 20;
  list.replaceChildren(
    ...messages.map((m) =>
      el("li", { class: m.kind }, el("span", { class: "who", text: `${NAMES[m.from] || m.from} → ${NAMES[m.to] || m.to}` }), el("span", { class: "kind", text: m.kind }), el("div", { text: m.text })),
    ),
  );
  if (atBottom) list.scrollTop = list.scrollHeight;
}

// ── Result ──────────────────────────────────────────────────────────────────
let current = null;

function renderResult(job) {
  current = job.output;
  const o = job.output;
  show("result");

  const fellBack = o.fallback_sections.map((f) => f.title);
  $("banner").className = `banner ${o.check.pass ? "pass" : "partial"}`;
  $("banner").replaceChildren(
    o.check.pass ? "✓ Checked for safety: every line traces back to your papers." : "Some parts couldn't be checked, so we show your original papers for those.",
    el("span", {
      class: "sub",
      text: `Reading level: grade ${o.check.reading_level}. ${fellBack.length ? `Original text shown for: ${fellBack.join(", ")}.` : ""}${
        o.check.model_checked === false ? " The AI meaning check was unavailable; the automatic dose, source and warning checks still ran." : ""
      }`,
    }),
  );

  const lineMap = new Map(o.scan.pages.flatMap((p) => p.lines.map((l) => [l.id, l.text])));
  const container = $("summary");
  container.replaceChildren();
  for (const s of o.summary.sections) {
    const fb = o.fallback_sections.find((f) => f.title === s.title);
    container.append(fb ? fallbackCard(fb) : sectionCard(s.title, s.bullets, o, lineMap));
  }
  // Fallbacks with no matching section (e.g. no plain version could be written at all).
  for (const fb of o.fallback_sections) {
    if (fb.title !== "Call 911 if" && !o.summary.sections.some((s) => s.title === fb.title)) container.append(fallbackCard(fb));
  }

  const fb911 = o.fallback_sections.find((f) => f.title === "Call 911 if");
  $("call911").replaceChildren(...(fb911 ? fallbackCard(fb911).childNodes : [el("h2", { text: "When to get help" }), bulletList(o.summary.call_911_if, o, lineMap)]));

  $("schedule").replaceChildren(el("h2", { text: "Your medicine schedule" }), scheduleTable(o.summary.med_schedule), compareTable(o.record));
  $("call911").hidden = !o.summary.call_911_if.length && !fb911;
  $("questions").replaceChildren(
    el("h2", { text: "Questions to ask your doctor" }),
    o.summary.questions_for_your_doctor.length ? el("ul", {}, o.summary.questions_for_your_doctor.map((q) => el("li", { text: q }))) : el("p", { class: "muted", text: "None." }),
  );
  renderEvidence(o, job);
  renderMessages($("final-messages"), job.messages);
  currentJobId = job.id;
  lineMapForQa = lineMap;
  $("qa-list").replaceChildren(...(job.qa || []).map(qaItem));
}

// ── Q&A ─────────────────────────────────────────────────────────────────────
let currentJobId = null;
let lineMapForQa = new Map();

function qaItem(a) {
  const src = el("div", { class: "src", hidden: true }, a.sources.map((s) => sourceRow(s, current, lineMapForQa)));
  const btn = a.sources.length ? el("button", { class: "src-btn", "aria-expanded": "false", text: "Where does this come from?" }) : null;
  if (btn) btn.onclick = () => { src.hidden = !src.hidden; btn.setAttribute("aria-expanded", String(!src.hidden)); };
  return el("li", {}, el("div", { class: "q", text: a.question }), el("div", { class: `a${a.answered ? "" : " unanswered"}`, text: a.answer }), btn, src);
}

$("qa-form").onsubmit = async (e) => {
  e.preventDefault();
  const question = $("qa-input").value.trim();
  if (!question || !currentJobId) return;
  $("qa-ask").disabled = true;
  const pending = el("li", {}, el("div", { class: "q", text: question }), el("div", { class: "muted", text: "Looking through your papers…" }));
  $("qa-list").append(pending);
  try {
    const res = await fetch(`/api/jobs/${currentJobId}/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question }) });
    const out = await res.json();
    pending.replaceWith(res.ok ? qaItem(out) : el("li", { class: "error", text: out.error || "Something went wrong." }));
    if (res.ok) $("qa-input").value = "";
  } catch {
    pending.replaceWith(el("li", { class: "error", text: "Couldn't reach the server." }));
  } finally {
    $("qa-ask").disabled = false;
  }
};

function sectionCard(title, bullets, o, lineMap) {
  return el("section", { class: "card" }, el("h2", { text: title }), bulletList(bullets, o, lineMap));
}

function fallbackCard(fb) {
  return el(
    "section",
    { class: "card fallback-sec" },
    el("h2", { text: fb.title }),
    el("p", { class: "ask", text: "Ask your care team about this part. We couldn't simplify it safely, so here is the original text:" }),
    el("div", { class: "orig", text: fb.original.map((l) => l.text).join("\n") || "(no original lines)" }),
  );
}

function bulletList(bullets, o, lineMap) {
  return el(
    "ul",
    { class: "bullets" },
    bullets.map((b) => {
      const words = b.text.split(/(\s+)/).map((w) => (w.trim() ? el("span", { class: "word", text: w }) : w));
      const srcBox = el("div", { class: "src", hidden: true }, b.sources.map((s) => sourceRow(s, o, lineMap)));
      const btn = el("button", { class: "src-btn", "aria-expanded": "false", text: "Where does this come from?" });
      btn.onclick = () => {
        srcBox.hidden = !srcBox.hidden;
        btn.setAttribute("aria-expanded", String(!srcBox.hidden));
      };
      const li = el("li", { "data-text": b.text }, el("div", { class: "text" }, words), btn, srcBox);
      return li;
    }),
  );
}

function sourceRow(s, o, lineMap) {
  let quote;
  if (lineMap.has(s.split("-")[0])) {
    const [page, range] = s.split(":L");
    const [from, to] = range.split("-").map(Number);
    const ids = [];
    for (let n = from; n <= (to || from); n++) ids.push(`${page}:L${n}`);
    quote = `Your papers, page ${page.slice(1)}: “${ids.map((i) => lineMap.get(i)).filter(Boolean).join(" ")}”`;
  } else if (s.startsWith("drug:")) {
    const d = o.record.lookups.drugs.find((x) => x.id === s);
    quote = d ? `FDA drug label (Zetaris drug_reference): ${d.generic} is ${d.plain_purpose}` : "FDA drug label";
  } else if (s.startsWith("term:")) {
    const t = o.record.lookups.terms.find((x) => x.id === s);
    quote = t ? `Medical terms (Zetaris): ${t.term} means “${t.plain}”` : "Medical terms";
  } else if (s.startsWith("record:")) {
    const d = o.record.hospital_record_diff.find((x) => x.source === s);
    quote = `Your hospital record (Zetaris): ${d ? `${d.drug} ${d.record ?? ""}` : "medication history"}`;
  } else if (s.startsWith("conflict:")) {
    const c = o.record.conflicts.find((x) => x.id === s);
    quote = `Memory check (H-MEM): ${c ? c.detail : "two sources disagree"}`;
  } else quote = s;
  const ledger = o.ledger[s];
  return el(
    "div",
    {},
    el("span", { class: "id", text: s }),
    " ",
    el("span", { class: "quote", text: quote }),
    ledger ? el("ul", { class: "ledger" }, ledger.map((e) => el("li", { text: `H-MEM ledger: ${e.action}` }))) : null,
  );
}

function scheduleTable(rows) {
  if (!rows.length) return el("p", { class: "muted", text: "No schedule." });
  const tick = (b) => el("td", { class: "tick", text: b ? "●" : "" });
  return el(
    "div",
    { class: "tbl-wrap" },
    el(
      "table",
      {},
      el("thead", {}, el("tr", {}, ["Medicine", "Morning", "Midday", "Evening", "Bedtime", "If needed"].map((h) => el("th", { text: h })))),
      el(
        "tbody",
        {},
        rows.map((r) => el("tr", {}, el("td", {}, el("strong", { text: r.drug }), ` ${r.dose}`, r.note ? el("div", { class: "muted", text: r.note }) : null), tick(r.morning), tick(r.midday), tick(r.evening), tick(r.night), tick(r.as_needed))),
      ),
    ),
  );
}

const CHANGE = { new: "New", changed: "Changed", stopped: "Stopped", continued: "Same as before", not_on_record: "Not in hospital record", not_on_paper: "Not on your papers" };
function compareTable(record) {
  const rows = record.hospital_record_diff;
  if (!record.matched_patient || !rows.length) return el("p", { class: "muted", text: "We couldn't compare with a hospital record." });
  return el(
    "div",
    {},
    el("h3", { text: "Compared with your hospital record" }),
    el(
      "div",
      { class: "tbl-wrap" },
      el(
        "table",
        {},
        el("thead", {}, el("tr", {}, ["Medicine", "Your papers", "Hospital record", ""].map((h) => el("th", { text: h })))),
        el(
          "tbody",
          {},
          rows.map((d) =>
            el(
              "tr",
              {},
              el("td", { text: d.drug }),
              el("td", { text: d.paper ?? "—" }),
              el("td", { text: d.record ?? "—" }),
              el("td", {}, el("span", { class: `tag ${d.change}`, text: CHANGE[d.change] || d.change }), d.conflict ? el("span", { class: "tag conflict", text: " Check with care team" }) : null),
            ),
          ),
        ),
      ),
    ),
  );
}

function renderEvidence(o, job) {
  const box = $("evidence");
  const byAgent = new Map();
  for (const m of o.models) byAgent.set(m.agent, [...(byAgent.get(m.agent) || []), m]);
  const head = el("thead", {}, el("tr", {}, ["Agent", "Calls", "Model that answered", "Signed receipts"].map((h) => el("th", { text: h }))));
  const rows = [...byAgent].map(([agent, ms]) =>
    el(
      "tr",
      {},
      el("td", { text: NAMES[agent] || agent }),
      el("td", { text: ms.length }),
      el("td", { text: [...new Set(ms.map((m) => m.model))].join(", ") }),
      el("td", { class: "mono", text: ms.map((m) => m.receipt).filter(Boolean).join(" ") }),
    ),
  );
  box.replaceChildren(
    el("h3", { text: "Models (via Meterless Nightshift)" }),
    el("div", { class: "tbl-wrap" }, el("table", {}, head, el("tbody", {}, rows))),
    el("h3", { text: "Data (via Zetaris)" }),
    el("p", { text: `Hospital record: ${o.record.matched_patient ? `${o.record.matched_patient.label}, matched by ${o.record.matched_patient.how}` : "no match"}. Drug labels: ${o.record.lookups.drugs.map((d) => d.generic).join(", ") || "none"}. Terms: ${o.record.lookups.terms.map((t) => t.term).join(", ") || "none"}.` }),
    el("h3", { text: "Patient memory (Meterless H-MEM engine)" }),
    el("p", { text: o.record.conflicts.length ? `${o.record.conflicts.length} open conflict(s): ${o.record.conflicts.map((c) => c.detail).join(" · ")}` : "No unexplained differences between your papers and your hospital record." }),
    el("h3", { text: "Safety check" }),
    el("p", { text: `${o.check.pass ? "Passed" : `${o.check.issues.length} issue(s) left`}. Reading level by section: ${Object.entries(o.check.reading_level_by_section).map(([k, v]) => `${k} ${v}`).join(", ")}.` }),
    o.check.issues.length ? el("ul", {}, o.check.issues.map((i) => el("li", { text: `[${i.type}] ${i.fix}` }))) : null,
    el("p", { class: "muted", text: `Job ${job.id} · full audit trail in runs/${job.id}/` }),
  );
}

// ── Read aloud (browser speech, word by word) ──────────────────────────────
$("speak").onclick = () => {
  if (!("speechSynthesis" in window)) return alert("This browser can't read aloud.");
  speechSynthesis.cancel();
  const items = [...document.querySelectorAll("#result-view .bullets li")];
  $("speak").hidden = true;
  $("stop").hidden = false;
  let i = 0;
  const next = () => {
    document.querySelectorAll(".speaking, .word.on").forEach((n) => n.classList.remove("speaking", "on"));
    if (i >= items.length) return stopSpeaking();
    const li = items[i++];
    const words = [...li.querySelectorAll(".word")];
    const text = li.dataset.text;
    li.classList.add("speaking");
    li.scrollIntoView({ block: "nearest", behavior: "smooth" });
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 0.9;
    const starts = [];
    let pos = 0;
    for (const w of words) {
      pos = text.indexOf(w.textContent, pos);
      starts.push(pos);
      pos += w.textContent.length;
    }
    u.onboundary = (e) => {
      if (e.name && e.name !== "word") return;
      let k = starts.findIndex((s, j) => e.charIndex >= s && (j === starts.length - 1 || e.charIndex < starts[j + 1]));
      words.forEach((w, j) => w.classList.toggle("on", j === k));
    };
    u.onend = next;
    speechSynthesis.speak(u);
  };
  next();
};
$("stop").onclick = stopSpeaking;
function stopSpeaking() {
  speechSynthesis.cancel();
  document.querySelectorAll(".speaking, .word.on").forEach((n) => n.classList.remove("speaking", "on"));
  $("speak").hidden = false;
  $("stop").hidden = true;
}
$("again").onclick = () => {
  stopSpeaking();
  history.replaceState(null, "", "/");
  show("input");
};

loadStatus();
loadSamples();
// A link like /?job=<id> opens that job (its progress, or its result).
const linked = new URLSearchParams(location.search).get("job");
if (linked) {
  show("progress");
  poll(linked);
}
