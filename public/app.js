// Day One web app: landing → add your papers → live agent progress → plain-language summary.
// Plain browser JavaScript, no build step. Routes live in the URL hash:
//   #/            landing
//   #/start       add your papers
//   #/job/<id>    progress, then the summary when the job is done

const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) n.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return n;
};
const svg = (markup) => { const t = document.createElement("template"); t.innerHTML = markup.trim(); return t.content.firstChild; };
const ICONS = {
  alert: '<svg class="alert-icon" width="28" height="28" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l10 18H2z" fill="#DC2626"/><path d="M12 9.5v5M12 17.5v.5" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/></svg>',
  check: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#16A34A" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/></svg>',
  info: '<svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="#D97706"/><path d="M12 11v6M12 7.5v.5" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/></svg>',
  phone: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/></svg>',
  calendar: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#334155" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="5" width="16" height="16" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/></svg>',
  tick: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>',
  done: '<svg class="check-draw" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>',
  clipboard: '<svg width="150" height="120" viewBox="0 0 200 160" aria-hidden="true"><ellipse cx="100" cy="146" rx="92" ry="8" fill="#E2ECFA"/><rect x="30" y="18" width="96" height="124" rx="10" fill="#475A7A"/><rect x="40" y="30" width="76" height="104" rx="4" fill="#fff"/><rect x="58" y="10" width="40" height="16" rx="6" fill="#475A7A"/><circle cx="78" cy="12" r="4" fill="#fff"/><path d="M74 40h8v8h8v8h-8v8h-8v-8h-8v-8h8z" fill="#2563EB"/><path d="M50 82l4 4 7-8M50 100l4 4 7-8M50 118l4 4 7-8" fill="none" stroke="#2563EB" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><rect x="68" y="80" width="38" height="5" rx="2.5" fill="#BFDBFE"/><rect x="68" y="98" width="30" height="5" rx="2.5" fill="#BFDBFE"/><rect x="68" y="116" width="34" height="5" rx="2.5" fill="#BFDBFE"/><rect x="118" y="64" width="54" height="78" rx="8" fill="#2563EB"/><rect x="114" y="54" width="62" height="16" rx="4" fill="#E2E8F0"/><rect x="124" y="84" width="42" height="34" rx="3" fill="#fff"/><rect x="128" y="108" width="32" height="3" rx="1.5" fill="#CBD5E1"/></svg>',
};
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

let status = null;
let samples = [];
let pages = []; // { url: JPEG data URL, text: the page's own text layer (PDFs only) or null }
let pollTimer = null;
let currentJob = null;
let seenMessages = 0;

// ── Toast ───────────────────────────────────────────────────────────────────
function toast(msg) {
  const t = $("toast");
  t.hidden = true;
  t.textContent = msg;
  void t.offsetWidth; // restart the animation
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 2700);
}

// ── Reveal on scroll ────────────────────────────────────────────────────────
const revealer = "IntersectionObserver" in window && !reducedMotion()
  ? new IntersectionObserver((entries) => entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); revealer.unobserve(e.target); } }), { threshold: 0.12 })
  : null;
function watchReveals(root = document) {
  root.querySelectorAll(".reveal:not(.in)").forEach((n) => (revealer ? revealer.observe(n) : n.classList.add("in")));
}

// ── Larger text (remembered) ────────────────────────────────────────────────
function setBig(on) {
  document.documentElement.classList.toggle("big", on);
  $("big-text").setAttribute("aria-pressed", String(on));
  $("big-text").textContent = on ? "Normal text" : "Larger text";
  store.set("dayone.big", on);
}
$("big-text").onclick = () => setBig(!document.documentElement.classList.contains("big"));
setBig(store.get("dayone.big", false));

// ── Router ──────────────────────────────────────────────────────────────────
function show(view) {
  for (const v of document.querySelectorAll(".view")) {
    const on = v.dataset.view === view;
    if (on && v.hidden) { v.hidden = false; v.style.animation = "none"; void v.offsetWidth; v.style.animation = ""; }
    else if (!on) v.hidden = true;
  }
  document.body.classList.toggle("on-landing", view === "landing");
  if (view !== "result") stopSpeaking();
}

function route() {
  clearTimeout(pollTimer);
  const hash = location.hash.replace(/^#\/?/, "");
  const job = hash.match(/^job\/([\w-]+)/);
  if (job) {
    show("progress");
    resetProgress();
    window.scrollTo({ top: 0 });
    poll(job[1]);
  } else if (hash.startsWith("start")) {
    show("start");
    window.scrollTo({ top: 0 });
    $("view-start").querySelector(".h1").focus({ preventScroll: true });
  } else {
    show("landing");
    watchReveals();
  }
}
window.addEventListener("hashchange", route);

// In-page links on the landing page ("How it works", "Is it safe?").
document.querySelectorAll("[data-scroll]").forEach((a) => a.addEventListener("click", (e) => {
  e.preventDefault();
  if (location.hash && location.hash !== "#/") location.hash = "#/";
  requestAnimationFrame(() => $(a.dataset.scroll).scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth" }));
}));

// ── Status and samples ──────────────────────────────────────────────────────
async function loadStatus() {
  try { status = await (await fetch("/api/status")).json(); } catch { return; }
  $("sample-pill").hidden = !status.sampleMode;
  updateVisionNote();
}

/** Only warn about photo reading when something would actually need it: not for PDFs with a text layer. */
function updateVisionNote() {
  $("vision-note").hidden = !status || !!status.vision || (pages.length > 0 && pages.every((p) => p.text));
}

async function loadSamples() {
  try { samples = await (await fetch("/api/samples")).json(); } catch { samples = []; }
  const box = $("samples");
  box.replaceChildren(
    ...samples.map((s, i) => {
      const firstLine = s.text.split("\n").find((l) => l.trim()) || "";
      const title = s.name.replace(/^\d+\s*/, "");
      return el("button", { class: "sample", type: "button", onclick: (e) => pickSample(i, e.currentTarget) }, el("b", { text: title }), el("span", { text: firstLine.replace(/ - DISCHARGE SUMMARY$/i, "").slice(0, 48) }));
    }),
  );
}

function pickSample(i, btn) {
  $("text").value = samples[i].text;
  document.querySelectorAll(".sample.picked").forEach((n) => n.classList.remove("picked"));
  btn.classList.add("picked");
  hideError();
  toast("Example loaded. Press “Make it plain”.");
}

// ── Landing interactions ────────────────────────────────────────────────────
document.querySelector('[data-action="try-sample"]').onclick = async (e) => {
  const btn = e.currentTarget;
  if (!samples.length) await loadSamples();
  if (!samples.length) { location.hash = "#/start"; return; }
  btn.disabled = true;
  btn.textContent = "Starting…";
  try { await startJob({ text: samples[0].text }); }
  catch (err) { toast(err.message); }
  finally { btn.disabled = false; btn.textContent = "See an example"; }
};

document.querySelectorAll('[data-action="toggle-src"]').forEach((b) => (b.onclick = () => toggleCollapse(b, b.nextElementSibling)));
function toggleCollapse(btn, box) {
  const open = btn.getAttribute("aria-expanded") !== "true";
  btn.setAttribute("aria-expanded", String(open));
  box.classList.toggle("open", open);
}

// Landing demo: read one plain sentence aloud.
const demoBtn = $("demo-listen");
demoBtn.onclick = () => {
  const bar = demoBtn.closest(".listen-bar");
  const set = (on) => {
    demoBtn.setAttribute("aria-pressed", String(on));
    demoBtn.setAttribute("aria-label", on ? "Stop" : "Listen");
    bar.querySelector(".listen-text").textContent = on ? "Reading to you…" : "Listen";
    bar.querySelector(".wave").classList.toggle("on", on);
  };
  if (demoBtn.getAttribute("aria-pressed") === "true") { speechSynthesis?.cancel(); return set(false); }
  set(true);
  speak("Take furosemide 40 milligrams two times a day. It's a water pill that helps your body get rid of extra fluid.", { onend: () => set(false) });
};

// ── Add your papers ─────────────────────────────────────────────────────────
function selectTab(which) {
  for (const t of ["text", "photo"]) {
    $(`tab-${t}`).setAttribute("aria-selected", String(t === which));
    $(`panel-${t}`).hidden = t !== which;
  }
  document.querySelector(".segmented").classList.toggle("right", which === "text");
  hideError();
}
$("tab-text").onclick = () => selectTab("text");
$("tab-photo").onclick = () => selectTab("photo");
$("use-text").onclick = () => { selectTab("text"); $("text").focus(); };
$("use-pdf").onclick = () => $("pick").click();

const drop = $("drop");
["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("drag"); }));
["dragleave", "drop"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove("drag"); }));
drop.addEventListener("drop", (e) => addFiles([...e.dataTransfer.files]));
// The drop box opens the camera on phones (capture); PDFs and saved photos come in through the separate picker.
for (const id of ["files", "pick"]) $(id).onchange = (e) => { addFiles([...e.target.files]); e.target.value = ""; };
$("pick-btn").onclick = () => $("pick").click();

const isPdf = (f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name);

async function addFiles(files) {
  hideError();
  for (const f of files.filter((f) => f.type.startsWith("image/") || isPdf(f))) {
    if (pages.length >= 10) { showError("Up to 10 pages at a time."); break; }
    try {
      if (isPdf(f)) await addPdf(f);
      else pages.push({ url: await downscale(f), text: null });
    } catch {
      showError(isPdf(f) ? "That PDF couldn't be opened." : "That file couldn't be opened as a photo.");
    }
    renderThumbs();
  }
}

// pdf.js is only fetched the first time someone picks a PDF. The file itself never leaves the browser here.
const PDFJS = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build";
let pdfjs;
async function loadPdfjs() {
  if (!pdfjs) {
    pdfjs = await import(`${PDFJS}/pdf.min.mjs`);
    pdfjs.GlobalWorkerOptions.workerSrc = `${PDFJS}/pdf.worker.min.mjs`;
  }
  return pdfjs;
}

/** Each PDF page becomes a thumbnail plus its text layer. A scanned PDF has no text layer, so it goes the photo route. */
async function addPdf(file) {
  const lib = await loadPdfjs();
  const doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  for (let n = 1; n <= doc.numPages; n++) {
    if (pages.length >= 10) { showError("Up to 10 pages at a time."); break; }
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: 1800 / Math.max(base.width, base.height) });
    const c = document.createElement("canvas");
    c.width = Math.round(viewport.width);
    c.height = Math.round(viewport.height);
    // intent "print": the default display render waits on requestAnimationFrame, which never fires in a background tab.
    await page.render({ canvasContext: c.getContext("2d"), viewport, intent: "print" }).promise;
    const text = pdfPageText(await page.getTextContent());
    pages.push({ url: c.toDataURL("image/jpeg", 0.85), text: text.replace(/\s/g, "").length >= 40 ? text : null });
  }
  await doc.destroy();
}

/** Rebuild reading-order lines from pdf.js text runs: group runs by baseline, then left to right. */
function pdfPageText(content) {
  const rows = [];
  for (const it of content.items) {
    if (!it.str?.trim()) continue;
    const [x, y] = [it.transform[4], it.transform[5]];
    let row = rows.find((r) => Math.abs(r.y - y) < 2.5);
    if (!row) rows.push((row = { y, runs: [] }));
    row.runs.push({ x, end: x + it.width, str: it.str });
  }
  return rows
    .sort((a, b) => b.y - a.y)
    .map((r) => r.runs.sort((a, b) => a.x - b.x).reduce((line, run, i, all) => {
      const gap = i ? run.x - all[i - 1].end : 0;
      return line + (i && gap > 5 ? "  |  " : i && gap > 0.8 ? " " : "") + run.str;
    }, "").trim())
    .join("\n");
}

function renderThumbs() {
  $("thumbs").replaceChildren(
    ...pages.map(({ url }, i) =>
      el("li", {}, el("img", { src: url, alt: `Page ${i + 1}` }), el("span", { text: `Page ${i + 1}` }),
        el("button", { type: "button", "aria-label": `Remove page ${i + 1}`, text: "✕", onclick: () => { pages.splice(i, 1); renderThumbs(); } }))),
  );
  updateVisionNote();
}

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

$("go").onclick = async () => {
  const usePhoto = $("tab-photo").getAttribute("aria-selected") === "true";
  // A PDF with a text layer is sent as its exact text: no photo reading needed. Any photo or scanned page means photos.
  const allText = pages.length && pages.every((p) => p.text);
  const body = !usePhoto ? { text: $("text").value }
    : allText ? { text: pages.map((p) => p.text).join("\f") } // a form feed starts a new page for the scanner
    : { images: pages.map((p) => p.url) };
  hideError();
  if (usePhoto ? !pages.length : !body.text.trim()) return showError(usePhoto ? "Add a photo or PDF of at least one page." : "Paste the text of your papers, or pick an example.");
  const go = $("go");
  const label = go.innerHTML;
  go.disabled = true;
  go.replaceChildren(el("span", { class: "spinner", "aria-hidden": "true" }), "Starting…");
  try { await startJob(body); }
  catch (err) { showError(err.message); }
  finally { go.disabled = false; go.innerHTML = label; }
};

async function startJob(body) {
  const res = await fetch("/api/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || "Something went wrong. Please try again.");
  location.hash = `#/job/${out.id}`;
}

function showError(msg) { const e = $("input-error"); e.hidden = true; e.textContent = msg; void e.offsetWidth; e.hidden = false; }
function hideError() { $("input-error").hidden = true; }

// ── Working on it ───────────────────────────────────────────────────────────
const NAMES = { orchestrator: "Organizer", scan: "Reader", extract: "Sorter", lookup: "Fact checker", memory: "Memory", simplify: "Writer", safety_checker: "Safety checker", qa: "Q&A", patient: "you" };
const STEP_HELP = { scan: "Reading every line of your papers", extract: "Finding medicines, visits and warning signs", lookup: "Checking drug labels and your hospital record", memory: "Comparing doses with your record", simplify: "Writing it in plain words", safety_checker: "Checking every sentence against your papers" };

function resetProgress() {
  seenMessages = 0;
  $("messages").replaceChildren(el("li", { class: "typing", "aria-label": "Waiting" }, el("i"), el("i"), el("i")));
  $("steps").replaceChildren(...[1, 2, 3, 4].map(() => el("li", {}, el("span", { class: "t-icon" }), el("div", {}, el("div", { class: "skeleton", style: "width: 60%" })))));
  $("progress-fill").style.width = "4%";
}

async function poll(id) {
  let job;
  try {
    const res = await fetch(`/api/jobs/${id}`);
    if (res.status === 404) { location.hash = "#/start"; return showError("We couldn't find that summary. Please start again."); }
    job = await res.json();
  } catch {
    pollTimer = setTimeout(() => poll(id), 2000);
    return;
  }
  if (!location.hash.includes(id)) return; // the person navigated away
  renderSteps(job);
  renderMessages($("messages"), job.messages, job.status === "running");
  if (job.status === "running") { pollTimer = setTimeout(() => poll(id), 1000); return; }
  if (job.status === "done") {
    $("progress-fill").style.width = "100%";
    pollTimer = setTimeout(() => renderResult(job), reducedMotion() ? 0 : 500);
    return;
  }
  location.hash = "#/start";
  setTimeout(() => showError(job.status === "needs_rescan"
    ? `Please take the photo again: ${job.rescan.map((r) => `page ${r.page} (${r.problem})`).join("; ")}.`
    : job.error || "Something went wrong. Please try again."), 50);
}

function renderSteps(job) {
  const total = job.steps.length || 1;
  const done = job.steps.filter((s) => s.status === "done" || s.status === "skipped").length;
  const running = job.steps.some((s) => s.status === "running") ? 0.5 : 0;
  const pct = Math.max(4, Math.round(((done + running) / total) * 100));
  $("progress-fill").style.width = `${pct}%`;
  document.querySelector(".progressbar").setAttribute("aria-valuenow", String(pct));
  $("steps").replaceChildren(
    ...job.steps.map((s) => {
      const icon = s.status === "running" ? el("span", { class: "mini-spin" }) : s.status === "done" ? svg(ICONS.done) : s.status === "failed" ? "✕" : s.status === "skipped" ? "–" : "";
      return el("li", { class: s.status },
        el("span", { class: "t-icon", "aria-hidden": "true" }, icon),
        el("div", {}, el("div", { class: "t-label", text: s.label }), el("div", { class: "t-detail", text: s.status === "running" ? s.detail || STEP_HELP[s.agent] || "Working…" : s.detail || (s.status === "waiting" ? "Waiting" : STEP_HELP[s.agent] || "") })));
    }),
  );
}

function renderMessages(list, messages, running) {
  if (messages.length < seenMessages || list.querySelector(".typing") && seenMessages === 0) list.replaceChildren();
  for (const m of messages.slice(seenMessages)) {
    const kind = /pass/i.test(m.text) && m.from === "safety_checker" ? "ok" : m.kind;
    list.append(el("li", { class: `msg ${kind}` }, el("span", { class: "who", text: `${NAMES[m.from] || m.from} → ${NAMES[m.to] || m.to}` }), m.text));
  }
  seenMessages = messages.length;
  list.querySelector(".typing")?.remove();
  if (running) list.append(el("li", { class: "typing", "aria-label": "Working" }, el("i"), el("i"), el("i")));
  list.scrollTop = list.scrollHeight;
}

// ── Your summary ────────────────────────────────────────────────────────────
const CHANGE = { new: "New", changed: "Dose changed", stopped: "Stopped", continued: "Same as before", not_on_record: "Not in hospital record", not_on_paper: "Ask your doctor" };

function renderResult(job) {
  currentJob = job;
  const o = job.output;
  show("result");
  window.scrollTo({ top: 0 });
  const lineMap = new Map(o.scan.pages.flatMap((p) => p.lines.map((l) => [l.id, l.text])));
  const ctx = { o, lineMap };

  // Header
  const name = o.record.patient?.name || (o.record.matched_patient ? titleCase(o.record.matched_patient.label.replace(/\s*\(.*\)$/, "")) : null);
  $("patient-name").textContent = name || "Your summary";
  // replaceChildren would print a null as "null", so leave out what doesn't apply. No graded sections, no reading level.
  const graded = Object.keys(o.check.reading_level_by_section ?? {}).length > 0;
  $("badges").replaceChildren(...[
    el("span", { class: `badge ${o.check.pass ? "badge-ok" : "badge-warn"}`, text: o.check.pass ? "Safety check passed" : "Partly checked" }),
    graded && el("span", { class: "badge", text: `Reading level: grade ${o.check.reading_level}` }),
    status?.sampleMode && el("span", { class: "badge", text: "Example" }),
  ].filter(Boolean));

  // Alerts: dose conflicts first, then the safety result.
  const alerts = [];
  for (const c of o.record.conflicts) {
    const plain = o.summary.sections.flatMap((s) => s.bullets).find((b) => b.sources.includes(`conflict:${c.id}`) || b.sources.some((x) => x.startsWith("conflict:") && x.includes(c.id)));
    alerts.push(el("section", { class: "alert-card red", role: "alert" }, svg(ICONS.alert),
      el("div", {}, el("h2", { text: `Check ${c.drug} before your next dose` }), el("p", { text: plain ? plain.text : c.detail }))));
  }
  if (o.check.pass) alerts.push(el("section", { class: "alert-card green" }, svg(ICONS.check), el("div", {}, el("h2", { text: "Safety check passed" }), el("p", { text: "Every line below traces back to your papers, a drug label or your hospital record." }))));
  else alerts.push(el("section", { class: "alert-card amber" }, svg(ICONS.info), el("div", {}, el("h2", { text: "Some parts couldn't be checked" }), el("p", { text: `For ${o.fallback_sections.map((f) => f.title).join(", ") || "some parts"}, we show your papers' own words. Ask your care team about those parts.` }))));
  $("alerts").replaceChildren(...alerts);

  // Main column
  const main = [];
  main.push(...emergencyCards(o, ctx));
  const reminder = reminderCard(job, o);
  if (reminder) main.push(reminder);
  for (const s of o.summary.sections) {
    const fb = o.fallback_sections.find((f) => f.title === s.title);
    main.push(fb ? fallbackCard(fb) : sectionCard(s, ctx));
  }
  for (const fb of o.fallback_sections) if (fb.title !== "Call 911 if" && !o.summary.sections.some((s) => s.title === fb.title)) main.push(fallbackCard(fb));
  if (o.summary.med_schedule.length) main.push(scheduleCard(o.summary.med_schedule));
  main.push(compareCard(o.record));
  $("result-main").replaceChildren(...main);

  // Side column
  $("result-side").replaceChildren(questionsCard(o), qaCard(job, ctx), evidenceCard(o, job), conversationCard(job));

  [...$("result-main").children, ...$("result-side").children].forEach((n, i) => { n.classList.add("reveal"); n.style.setProperty("--d", String(Math.min(i, 6))); });
  watchReveals($("view-result"));
  $("patient-name").focus({ preventScroll: true });
}

function titleCase(s) { return s.replace(/\b\w/g, (c) => c.toUpperCase()); }

function cardHead(title, sub, id) {
  return el("div", {}, el("h2", { class: "h3", id, text: title }), sub ? el("p", { class: "card-sub", text: sub }) : null);
}

function emergencyCards(o, ctx) {
  const fb = o.fallback_sections.find((f) => f.title === "Call 911 if");
  // Never an empty box: without rewritten items, list the warning signs from the papers as written.
  // The source lines, not Extract's text, so a heading like "Call your doctor same day for:" stays with its signs.
  const asWritten = (src) => sourceLines(src, ctx).filter(Boolean).join(" ");
  const items = o.summary.call_911_if.length ? o.summary.call_911_if : (o.record.warning_signs ?? []).map((w, i) => ({ id: `w${i + 1}`, text: asWritten(w.source) || w.text, sources: [w.source] }));
  // Signs the papers send to a doctor or nurse ("Call your doctor same day if…") get their own card,
  // not a "Call 911" heading. Anything unclear stays in the 911 box.
  const urgent = fb ? items : items.filter((b) => !callsSomeoneElse(b, ctx));
  const doctor = fb ? [] : items.filter((b) => callsSomeoneElse(b, ctx));
  const list = fb
    ? el("div", { class: "orig mono", text: fb.original.map((l) => l.text).join("\n") })
    : bulletList(urgent, ctx, { plainDots: true });
  const cards = [];
  if (fb || urgent.length || !doctor.length) {
    cards.push(el("section", { class: "card card-danger emergency", "aria-labelledby": "h-911" },
      el("div", { class: "stack", style: "gap: 10px" }, el("h2", { class: "h3", id: "h-911", text: "Call 911 or go to the ER if you have:" }), list),
      el("a", { class: "call-911", href: "tel:911" }, svg(ICONS.phone), "Call 911")));
  }
  if (doctor.length) cards.push(el("section", { class: "card card-amber" }, cardHead("Call your doctor if you have:", "Not an emergency, but don't wait. Each line says who to call and how soon."), bulletList(doctor, ctx, { plainDots: true })));
  return cards;
}

/**
 * Does this warning sign send the patient to someone other than 911 or the ER ("Call PCP same day for: …")?
 * Read from the bullet and the lines it cites, since the rewritten bullet may leave out who to call.
 * Any mention of 911, the ER or an emergency keeps it in the 911 box, and so does anything unclear.
 */
function callsSomeoneElse(b, ctx) {
  const texts = [b.text, ...b.sources.flatMap((s) => sourceLines(s, ctx))];
  if (texts.some((t) => /\b(911|ER|ED|emergency|ambulance)\b/i.test(t))) return false;
  return texts.some((t) => /\b(call|contact|phone|tell|see)\b[^.]*\b(doctor|pcp|surgeon|nurse|clinic|provider|care team|office)\b/i.test(t));
}

/** The text of each line a source cites: "p2:L14", "p2:L14-16" or "p2:L14-L16". Anything else (drug:…, term:…) has none. */
function sourceLines(src, ctx) {
  const m = String(src).match(/^(p\d+):L(\d+)(?:-L?(\d+))?$/);
  if (!m) return [];
  const out = [];
  for (let n = Number(m[2]); n <= Number(m[3] ?? m[2]); n++) out.push(ctx.lineMap.get(`${m[1]}:L${n}`) ?? "");
  return out;
}

function reminderCard(job, o) {
  const sched = o.summary.med_schedule;
  if (!sched.length) return null;
  const conflictDrugs = new Set(o.record.conflicts.map((c) => c.drug.toLowerCase()));
  const slots = [["morning", "Morning"], ["midday", "Midday"], ["evening", "Evening"], ["night", "Bedtime"]]
    .map(([k, label]) => ({ k, label, meds: sched.filter((m) => m[k]) })).filter((s) => s.meds.length);
  const day = new Date().toISOString().slice(0, 10);
  const key = `dayone.taken.${job.id}.${day}`;
  const taken = new Set(store.get(key, []));
  const total = slots.reduce((n, s) => n + s.meds.length, 0);
  const progressText = el("span");
  const fill = el("span");
  const update = () => { progressText.textContent = `${taken.size} of ${total} doses taken today`; fill.style.width = `${(taken.size / total) * 100}%`; };

  const cols = slots.map((s) => el("div", {}, el("h3", { text: s.label }), el("ul", { class: "doses" },
    s.meds.map((m) => {
      const id = `${s.k}:${m.drug}`;
      const btn = el("button", { class: "dose", type: "button", "aria-pressed": String(taken.has(id)) },
        el("span", { class: "box", "aria-hidden": "true" }, svg(ICONS.tick)),
        el("span", { class: "name", text: `${m.drug} ${m.dose}${m.note ? ` · ${m.note}` : ""}` }),
        conflictDrugs.has(m.drug.toLowerCase()) ? el("span", { class: "warn", text: "Check dose" }) : null);
      btn.onclick = () => {
        taken.has(id) ? taken.delete(id) : taken.add(id);
        btn.setAttribute("aria-pressed", String(taken.has(id)));
        store.set(key, [...taken]);
        update();
        if (taken.size === total) toast("All of today's doses are checked off.");
      };
      return el("li", {}, btn);
    }))));
  const asNeeded = sched.filter((m) => m.as_needed);
  update();
  const next = nextVisit(o);
  return el("section", { class: "reminder", "aria-labelledby": "h-remind" }, svg(ICONS.clipboard),
    el("div", { class: "reminder-body" },
      cardHead("Today's medicines", "Tap each one when you take it. This stays on this device only.", "h-remind"),
      el("div", { class: "reminder-cols" }, cols),
      asNeeded.length ? el("p", { class: "card-sub", text: `Only if needed: ${asNeeded.map((m) => `${m.drug} ${m.dose}${m.note ? ` (${m.note})` : ""}`).join(", ")}` }) : null,
      el("div", { class: "reminder-progress" }, el("span", { class: "bar" }, fill), progressText),
      next ? el("div", { class: "next-visit" }, svg(ICONS.calendar), el("div", {}, el("span", { class: "card-sub", text: "Your next visit" }), el("strong", { text: next }))) : null));
}

function nextVisit(o) {
  const days = (w) => { const m = String(w).match(/(\d+)\s*(day|week|month)/i); if (!m) return 999; return +m[1] * ({ day: 1, week: 7, month: 30 })[m[2].toLowerCase()]; };
  const fu = [...o.record.follow_ups].sort((a, b) => days(a.when) - days(b.when))[0];
  if (!fu) return null;
  const visits = o.summary.sections.find((s) => /follow|visit|appointment/i.test(s.title));
  const plain = visits?.bullets.find((b) => b.sources.includes(fu.source));
  return plain ? plain.text : `${fu.who}, ${fu.when}`;
}

function sectionCard(s, ctx) {
  const isMeds = /medicine|medication/i.test(s.title);
  return el("section", { class: "card" }, cardHead(s.title), bulletList(s.bullets, ctx, { tags: isMeds }));
}

function fallbackCard(fb) {
  return el("section", { class: "card fallback" }, cardHead(fb.title, "Ask your care team about this part. We couldn't simplify it safely, so here are your papers' own words:"),
    el("div", { class: "orig", text: fb.original.map((l) => l.text).join("\n") || "(no original lines)" }));
}

function medStatus(b, o) {
  const conflict = b.sources.some((s) => s.startsWith("conflict:"));
  if (conflict) return "conflict";
  const drugIds = b.sources.filter((s) => s.startsWith("drug:")).map((s) => s.slice(5).toLowerCase());
  const recordIds = b.sources.filter((s) => s.startsWith("record:"));
  const diff = o.record.hospital_record_diff.find((d) => drugIds.includes(d.drug.toLowerCase()) || drugIds.includes(d.drug.toLowerCase().replace(/\s+/g, "_")) || recordIds.includes(d.source));
  if (diff?.conflict) return "conflict";
  return diff ? diff.change : null;
}

function bulletList(bullets, ctx, opts = {}) {
  return el("ul", { class: "bullets" }, bullets.map((b) => {
    const words = b.text.split(/(\s+)/).map((w) => (w.trim() ? el("span", { class: "word", text: w }) : w));
    const st = opts.tags ? medStatus(b, ctx.o) : null;
    const tag = st ? el("span", { class: `tag tag-${st}`, text: st === "conflict" ? "Check dose" : CHANGE[st] || st }) : null;
    const box = el("div", { class: "collapse" }, el("div", {}, el("div", { class: "sources" }, b.sources.map((s) => sourceRow(s, ctx)))));
    const btn = b.sources.length ? el("button", { class: "src-toggle", type: "button", "aria-expanded": "false", text: "Where does this come from?" }) : null;
    if (btn) btn.onclick = () => toggleCollapse(btn, box);
    return el("li", { class: `bullet${st === "conflict" ? " conflict" : ""}`, "data-text": b.text },
      el("div", { class: "bullet-row" }, el("div", { class: "text" }, opts.plainDots ? "• " : null, words), tag), btn, box);
  }));
}

function sourceRow(s, { o, lineMap }) {
  let label, body, mono = false;
  if (/^p\d+:L\d/.test(s)) {
    const [page, range] = s.split(":L");
    const [from, to] = range.split("-").map(Number);
    const ids = [];
    for (let n = from; n <= (to || from); n++) ids.push(`${page}:L${n}`);
    label = `Your papers · page ${page.slice(1)}, line ${range}`;
    body = ids.map((i) => lineMap.get(i)).filter(Boolean).join(" ");
    mono = true;
  } else if (s.startsWith("drug:")) {
    const d = o.record.lookups.drugs.find((x) => x.id === s);
    label = "FDA drug label";
    body = d ? `${titleCase(d.generic)} is ${d.plain_purpose}.${d.common_side_effects?.length ? ` Common side effects: ${d.common_side_effects.join(", ")}.` : ""}${d.key_warning ? ` Warning: ${d.key_warning}.` : ""}` : s;
  } else if (s.startsWith("term:")) {
    const t = o.record.lookups.terms.find((x) => x.id === s);
    label = "Medical term";
    body = t ? `${t.term} means “${t.plain}”` : s;
  } else if (s.startsWith("record:")) {
    const d = o.record.hospital_record_diff.find((x) => x.source === s);
    label = "Your hospital record";
    body = d ? `${d.drug} ${d.record ?? ""}`.trim() : "Medicine history";
  } else if (s.startsWith("conflict:")) {
    const c = o.record.conflicts.find((x) => s.includes(x.id));
    label = "These don't match";
    body = c ? c.detail : "Two sources disagree.";
  } else { label = "Source"; body = s; }
  return el("div", { class: "source" }, el("b", { text: label }), el("span", { class: mono ? "mono" : "", text: body }));
}

function scheduleCard(rows) {
  const tick = (b) => el("td", { class: "tick" }, b ? el("span", { class: "tick-dot", "aria-label": "yes" }) : el("span", { class: "sr-only", text: "no" }));
  return el("section", { class: "card" }, cardHead("Daily medicine schedule"),
    el("div", { class: "tbl-wrap" }, el("table", {},
      el("thead", {}, el("tr", {}, ["Medicine", "Morning", "Midday", "Evening", "Bedtime", "If needed"].map((h) => el("th", { scope: "col", text: h })))),
      el("tbody", {}, rows.map((r) => el("tr", {},
        el("td", {}, el("strong", { text: r.drug }), ` ${r.dose}`, r.note ? el("div", { class: "card-sub", text: r.note }) : null),
        tick(r.morning), tick(r.midday), tick(r.evening), tick(r.night), tick(r.as_needed)))))));
}

function compareCard(record) {
  const rows = record.hospital_record_diff;
  if (!record.matched_patient || !rows.length) return el("section", { class: "card" }, cardHead("Compared with your hospital record", "We couldn't find a hospital record to compare with."));
  return el("section", { class: "card" }, cardHead("Compared with your hospital record", `Matched by ${record.matched_patient.how}.`),
    el("div", { class: "tbl-wrap" }, el("table", {},
      el("thead", {}, el("tr", {}, ["Medicine", "Your papers", "Hospital record", ""].map((h) => el("th", { scope: "col", text: h })))),
      el("tbody", {}, rows.map((d) => el("tr", { class: d.conflict ? "row-conflict" : "" },
        el("td", {}, el("strong", { text: titleCase(d.drug) })),
        el("td", { text: d.paper ?? "—" }),
        el("td", { text: d.record ?? "—" }),
        el("td", {}, el("span", { class: `tag tag-${d.conflict ? "conflict" : d.change}`, text: d.conflict ? "Check with care team" : CHANGE[d.change] || d.change }))))))));
}

function questionsCard(o) {
  const qs = o.summary.questions_for_your_doctor;
  return el("section", { class: "card" }, cardHead("Questions for your doctor"),
    qs.length ? el("ol", { style: "margin: 0; padding-left: 22px; display: flex; flex-direction: column; gap: 6px" }, qs.map((q) => el("li", { text: q }))) : el("p", { class: "card-sub", text: "None." }));
}

// ── Q&A ─────────────────────────────────────────────────────────────────────
function qaCard(job, ctx) {
  const thread = el("ol", { class: "qa-thread", "aria-live": "polite" }, (job.qa || []).flatMap((a) => qaPair(a, ctx)));
  const input = el("input", { type: "text", id: "qa-input", placeholder: "Type your question", autocomplete: "off", "aria-label": "Your question" });
  const ask = el("button", { class: "btn btn-primary", type: "submit", text: "Ask" });
  const send = async (question) => {
    question = question.trim();
    if (!question) return input.focus();
    ask.disabled = true;
    input.value = "";
    thread.append(el("li", { class: "bubble-q", text: question }));
    const dots = el("li", { class: "typing", "aria-label": "Checking your papers" }, el("i"), el("i"), el("i"));
    thread.append(dots);
    try {
      const res = await fetch(`/api/jobs/${job.id}/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question }) });
      const out = await res.json();
      dots.replaceWith(res.ok ? qaAnswer(out, ctx) : el("li", { class: "bubble-a unanswered", text: out.error || "Something went wrong." }));
    } catch {
      dots.replaceWith(el("li", { class: "bubble-a unanswered", text: "Couldn't reach Day One. Is it still running?" }));
    } finally { ask.disabled = false; }
  };
  const form = el("form", { class: "qa-form", onsubmit: (e) => { e.preventDefault(); send(input.value); } }, input, ask);
  const chips = el("div", { class: "qa-chips" }, ["Can I shower?", "When is my next appointment?", "Can I drink alcohol?"].map((q) => el("button", { class: "chip", type: "button", text: q, onclick: () => send(q) })));
  return el("section", { class: "card qa-card" }, cardHead("Ask about your papers", "Answers come only from your papers. Anything else goes to your care team."), chips, thread, form);
}
function qaPair(a, ctx) { return [el("li", { class: "bubble-q", text: a.question }), qaAnswer(a, ctx)]; }
function qaAnswer(a, ctx) {
  const box = el("div", { class: "collapse" }, el("div", {}, el("div", { class: "sources" }, a.sources.map((s) => sourceRow(s, ctx)))));
  const btn = a.sources.length ? el("button", { class: "src-toggle", type: "button", "aria-expanded": "false", text: "Where does this come from?" }) : null;
  if (btn) btn.onclick = () => toggleCollapse(btn, box);
  return el("li", { class: `bubble-a${a.answered ? "" : " unanswered"}` }, el("span", { text: a.answer }), btn, btn ? box : null);
}

function evidenceCard(o, job) {
  const byAgent = new Map();
  for (const m of o.models) byAgent.set(m.agent, [...(byAgent.get(m.agent) || []), m]);
  const models = [...new Set(o.models.map((m) => m.model).filter(Boolean))];
  return el("details", { class: "card evidence" }, el("summary", { text: "How we made this" }),
    el("h3", { text: "AI models (via Meterless Nightshift)" }),
    el("p", { text: `${models.join(", ") || "Recorded sample answers"} · ${o.models.length} calls, each with a signed receipt.` }),
    el("h3", { text: "Data checked (via Zetaris)" }),
    el("p", { text: `${o.record.lookups.drugs.length} FDA drug labels, ${o.record.lookups.terms.length} medical terms. Hospital record: ${o.record.matched_patient ? `matched by ${o.record.matched_patient.how}` : "no match"}.` }),
    el("h3", { text: "Patient memory (H-MEM)" }),
    el("p", { text: o.record.conflicts.length ? o.record.conflicts.map((c) => c.detail).join(" · ") : "No unexplained differences between your papers and your hospital record." }),
    el("h3", { text: "Reading level by section" }),
    el("p", { text: Object.entries(o.check.reading_level_by_section).map(([k, v]) => `${k}: grade ${v}`).join(" · ") }),
    el("p", { class: "mono", style: "font-size: 0.8rem", text: `Job ${job.id}` }));
}

function conversationCard(job) {
  const list = el("ol", { class: "messages", style: "max-height: 420px" });
  const prev = seenMessages;
  seenMessages = 0;
  renderMessages(list, job.messages, false);
  seenMessages = prev;
  return el("details", { class: "card" }, el("summary", { text: "What the helpers said to each other" }), list);
}

$("print").onclick = () => window.print();
$("again").addEventListener("click", () => { $("text").value = ""; pages = []; renderThumbs(); document.querySelectorAll(".sample.picked").forEach((n) => n.classList.remove("picked")); });

// ── Read aloud ──────────────────────────────────────────────────────────────
const RATES = [[0.9, "Normal speed"], [0.75, "Slower"], [1.05, "Faster"]];
let rateIdx = store.get("dayone.rate", 0);
let queue = [];
let qi = 0;
let speaking = false;

function speak(text, { onend, onerror, onboundary } = {}) {
  if (!("speechSynthesis" in window)) { toast("This browser can't read aloud."); (onerror || onend)?.(); return; }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text.replace(/\bmg\b/g, "milligrams"));
  u.rate = RATES[rateIdx][0];
  u.onend = () => onend?.();
  // "interrupted"/"canceled" mean we stopped it on purpose (Stop, Next, Prev); anything else is a real failure.
  u.onerror = (e) => { if (e.error === "interrupted" || e.error === "canceled") return; (onerror || onend)?.(e); };
  if (onboundary) u.onboundary = onboundary;
  speechSynthesis.speak(u);
}

$("speak").onclick = () => {
  queue = [...document.querySelectorAll("#view-result .bullet")];
  if (!queue.length) return;
  speaking = true;
  qi = 0;
  $("player").hidden = false;
  document.body.classList.add("playing");
  readCurrent();
};

function readCurrent() {
  document.querySelectorAll(".bullet.speaking, .word.on").forEach((n) => n.classList.remove("speaking", "on"));
  if (!speaking) return;
  if (qi >= queue.length) { stopSpeaking(); toast("Finished reading your summary."); return; }
  const li = queue[qi];
  const text = li.dataset.text;
  const words = [...li.querySelectorAll(".word")];
  li.classList.add("speaking");
  li.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
  $("player-count").textContent = `Reading ${qi + 1} of ${queue.length}`;
  $("player-line").textContent = text;
  const spoken = text.replace(/\bmg\b/g, "milligrams");
  const starts = [];
  let pos = 0;
  for (const w of words) { const word = w.textContent.replace(/\bmg\b/g, "milligrams"); pos = spoken.indexOf(word, pos); starts.push(pos); pos += word.length; }
  const mine = qi;
  speak(text, {
    onend: () => { if (speaking && mine === qi) { qi++; readCurrent(); } },
    onerror: () => { stopSpeaking(); toast("Reading aloud isn't working in this browser."); },
    onboundary: (e) => {
      if (e.name && e.name !== "word") return;
      const k = starts.findIndex((s, j) => e.charIndex >= s && (j === starts.length - 1 || e.charIndex < starts[j + 1]));
      words.forEach((w, j) => w.classList.toggle("on", j === k));
    },
  });
}

function stopSpeaking() {
  speaking = false;
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  document.querySelectorAll(".bullet.speaking, .word.on").forEach((n) => n.classList.remove("speaking", "on"));
  $("player").hidden = true;
  document.body.classList.remove("playing");
}
$("player-stop").onclick = stopSpeaking;
$("player-next").onclick = () => { qi = Math.min(queue.length, qi + 1); readCurrent(); };
$("player-prev").onclick = () => { qi = Math.max(0, qi - 1); readCurrent(); };
const rateBtn = $("player-rate");
rateBtn.textContent = RATES[rateIdx][1];
rateBtn.onclick = () => {
  rateIdx = (rateIdx + 1) % RATES.length;
  store.set("dayone.rate", rateIdx);
  rateBtn.textContent = RATES[rateIdx][1];
  if (speaking) readCurrent();
};
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && speaking) stopSpeaking(); });

// ── Start ───────────────────────────────────────────────────────────────────
loadStatus();
loadSamples();
// Old links like /?job=<id> still work.
const legacy = new URLSearchParams(location.search).get("job");
if (legacy) { history.replaceState(null, "", `/#/job/${legacy}`); }
route();
