const API_BASE = "https://zzesku.github.io/zzesku-IOT_meteorologicka_stanica/";

const API_URL = `${API_BASE}/api/latest`;
const HISTORY_URL = `${API_BASE}/api/history`;
const EVENTS_URL = `${API_BASE}/api/events`;
const CLEAR_URL = `${API_BASE}/api/admin/clear_db`;


const POLL_MS = 5000;
const EVENTS_POLL_MS = 6000;

// ===== DOM =====
const skTimeEl = document.getElementById("skTime");

const inTemp  = document.getElementById("inTemp");
const inHum   = document.getElementById("inHum");
const inPres  = document.getElementById("inPres");
const inLight = document.getElementById("inLight");

const outTemp = document.getElementById("outTemp");
const outHum  = document.getElementById("outHum");
const outPres = document.getElementById("outPres");
const outLight = document.getElementById("outLight");

const windowState = document.getElementById("windowState");
const windowMeta = document.getElementById("windowMeta");
const indoorStatus = document.getElementById("indoorStatus");
const outdoorStatus = document.getElementById("outdoorStatus");

const aiFreshness = document.getElementById("aiFreshness");
const aiSummaryEl = document.getElementById("aiSummary");
const aiRecsEl = document.getElementById("aiRecs");
const aiAlertsEl = document.getElementById("aiAlerts");
const aiComfort = document.getElementById("aiComfort");
const aiVent = document.getElementById("aiVent");
const aiHumidity = document.getElementById("aiHumidity");

const notifList = document.getElementById("notifList");

const rangeSel = document.getElementById("historyRange");
const loadHistoryBtn = document.getElementById("loadHistoryBtn");
const clearDbBtn = document.getElementById("clearDbBtn");

// ===== CHARTS =====
const tempCtx = document.getElementById("tempChart").getContext("2d");
const tempChart = new Chart(tempCtx, {
  type: "line",
  data: {
    labels: [],
    datasets: [
      { label: "Indoor Temp", data: [], borderColor: "#ffffff", backgroundColor: "rgba(255,255,255,0.05)", tension: 0.35 },
      { label: "Outdoor Temp", data: [], borderColor: "#c4161c", backgroundColor: "rgba(196,22,28,0.10)", tension: 0.35 },
    ],
  },
  options: {
    animation: false,
    plugins: { legend: { labels: { color: "#ccc" } } },
    scales: { x: { ticks: { color: "#888" } }, y: { ticks: { color: "#888" } } },
  },
});

const histCtx = document.getElementById("historyChart").getContext("2d");
const historyChart = new Chart(histCtx, {
  type: "line",
  data: {
    labels: [],
    datasets: [
      { label: "Indoor Temp", data: [], borderColor: "#ffffff", backgroundColor: "rgba(255,255,255,0.05)", tension: 0.35 },
      { label: "Outdoor Temp", data: [], borderColor: "#c4161c", backgroundColor: "rgba(196,22,28,0.10)", tension: 0.35 },
    ],
  },
  options: {
    animation: false,
    plugins: { legend: { labels: { color: "#ccc" } } },
    scales: { x: { ticks: { color: "#888" } }, y: { ticks: { color: "#888" } } },
  },
});

// ===== STATE =====
let seenEventIds = new Set();

// ===== HELPERS =====
function format(val, digits = 1) {
  if (val === null || val === undefined || Number.isNaN(Number(val))) return "--";
  return Number(val).toFixed(digits);
}
function parseServerIsoToNice(iso) {
  if (!iso) return "--";
  return iso.replace("T", " ").slice(0, 19);
}

function setWindowState(open) {
  if (open === null || open === undefined) {
    windowState.textContent = "--";
    windowState.style.color = "";
    return;
  }
  windowState.textContent = open ? "OPEN" : "CLOSED";
  windowState.style.color = open ? "#4caf50" : "#ff4d4d";
}

function setStatusPill(el, online, ageSec) {
  if (!el) return;
  if (online === null || online === undefined) {
    el.textContent = "—";
    return;
  }
  const age = (ageSec === null || ageSec === undefined) ? "--" : `${ageSec}s`;
  el.textContent = `${online ? "Online" : "Offline"} • age ${age}`;
  el.style.borderColor = online ? "rgba(76,175,80,0.35)" : "rgba(255,77,77,0.35)";
}

function pushLiveChart(label, inT, outT) {
  tempChart.data.labels.push(label || "--");
  tempChart.data.datasets[0].data.push(inT ?? null);
  tempChart.data.datasets[1].data.push(outT ?? null);

  const maxPoints = 60;
  if (tempChart.data.labels.length > maxPoints) {
    tempChart.data.labels.shift();
    tempChart.data.datasets[0].data.shift();
    tempChart.data.datasets[1].data.shift();
  }
  tempChart.update();
}

function fillList(ul, items, emptyText) {
  if (!ul) return;
  ul.innerHTML = "";
  if (!Array.isArray(items) || items.length === 0) {
    const li = document.createElement("li");
    li.textContent = emptyText;
    ul.appendChild(li);
    return;
  }
  items.forEach((txt) => {
    const li = document.createElement("li");
    li.textContent = txt;
    ul.appendChild(li);
  });
}

// ===== AI RENDER =====
function deriveBadges(indoor) {
  const inT = indoor?.temp_c;
  const inH = indoor?.humidity_pct;
  const win = indoor?.window_open;

  let comfort = "--";
  if (inT != null) {
    if (inT < 18) comfort = "Cold";
    else if (inT <= 24) comfort = "Comfortable";
    else comfort = "Warm";
  }

  let vent = "--";
  if (win !== null && win !== undefined) vent = win ? "Window open" : "Window closed";

  let hum = "--";
  if (inH != null) {
    if (inH < 30) hum = "Dry";
    else if (inH <= 60) hum = "OK";
    else hum = "Humid";
  }
  return { comfort, vent, hum };
}

function renderAI(ai, meta, indoor) {
  const summary = ai?.summary || "AI is analyzing environment...";
  const recs = Array.isArray(ai?.recommendations) ? ai.recommendations : [];
  const alerts = Array.isArray(ai?.alerts) ? ai.alerts : [];

  if (aiSummaryEl) aiSummaryEl.textContent = summary;
  fillList(aiRecsEl, recs, "No recommendations yet.");
  fillList(aiAlertsEl, alerts, "No alerts.");

  if (aiFreshness) {
    const age = meta?.age_sec ?? "--";
    const run = meta?.running ? "running" : "ready";
    aiFreshness.textContent = `AI: ${run} • age ${age}s`;
  }

  const badges = deriveBadges(indoor);
  if (aiComfort) aiComfort.textContent = badges.comfort;
  if (aiVent) aiVent.textContent = badges.vent;
  if (aiHumidity) aiHumidity.textContent = badges.hum;
}

window.clearAiRecs = () => fillList(aiRecsEl, [], "No recommendations yet.");
window.clearAiAlerts = () => fillList(aiAlertsEl, [], "No alerts.");

// ===== Notifications UI =====
function addNotif({ type, text, stamp }) {
  if (!notifList) return;

  const li = document.createElement("li");

  const left = document.createElement("div");
  left.className = "left";

  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = type;

  const msg = document.createElement("div");
  msg.textContent = text;

  left.appendChild(badge);
  left.appendChild(msg);

  const time = document.createElement("span");
  time.className = "timestamp";
  time.textContent = stamp || "--";

  li.appendChild(left);
  li.appendChild(time);

  notifList.prepend(li);
  updateFade("notifList", 10);
}

function updateFade(listId, maxVisible = 10) {
  const list = document.getElementById(listId);
  const expanded = list?.classList.contains("expanded");

  const items = document.querySelectorAll(`#${listId} li`);
  items.forEach((item, idx) => {
    const isOld = idx >= maxVisible;
    if (expanded) item.classList.remove("hidden-old");
    else item.classList.toggle("hidden-old", isOld);

    item.classList.toggle("fade-old", isOld && expanded);
  });
}

window.toggleOld = (listId, btn) => {
  const list = document.getElementById(listId);
  list.classList.toggle("expanded");
  const expanded = list.classList.contains("expanded");
  btn.textContent = expanded ? "Hide older" : "Show older";
  updateFade(listId, 10);
};

window.clearNotifications = () => {
  if (notifList) notifList.innerHTML = "";
  seenEventIds = new Set();
};

// ===== Events polling (timeline stored in DB) =====
async function fetchEvents(hours = 6) {
  try {
    const res = await fetch(`${EVENTS_URL}?hours=${hours}&limit=200`, { cache: "no-store" });
    if (!res.ok) throw new Error(`Events error: ${res.status}`);
    const data = await res.json();
    const events = data?.events || [];

    // events are newest->oldest; to display nicely, add from oldest to newest
    const reversed = [...events].reverse();

    reversed.forEach(ev => {
      if (seenEventIds.has(ev.id)) return;
      seenEventIds.add(ev.id);
      const stamp = (ev.time_sk || "--").slice(11, 19); // HH:MM:SS
      addNotif({ type: ev.type, text: ev.message, stamp });
    });

    updateFade("notifList", 10);
  } catch (e) {
    // no spam if backend down
    console.error(e);
  }
}

// ===== UI UPDATE =====
function updateUI(data) {
  const serverTimeNice = data?.server_time_sk ? parseServerIsoToNice(data.server_time_sk) : "--";
  if (skTimeEl) skTimeEl.textContent = serverTimeNice;

  const indoor = data?.indoor || null;
  const outdoor = data?.outdoor || null;

  const indoorOk = indoor && (indoor.online === undefined ? true : !!indoor.online);
  const outdoorOk = outdoor && (outdoor.online === undefined ? true : !!outdoor.online);

  inTemp.textContent = indoorOk ? format(indoor.temp_c) : "--";
  inHum.textContent  = indoorOk ? format(indoor.humidity_pct) : "--";
  inPres.textContent = indoorOk ? format(indoor.pressure_hpa) : "--";
  inLight.textContent = indoorOk && indoor.lux != null ? format(indoor.lux, 0) : "--";

  outTemp.textContent = outdoorOk ? format(outdoor.temp_c) : "--";
  outHum.textContent  = outdoorOk ? format(outdoor.humidity_pct) : "--";
  outPres.textContent = outdoorOk ? format(outdoor.pressure_hpa) : "--";
  outLight.textContent = outdoorOk && outdoor.lux != null ? format(outdoor.lux, 0) : "--";

  setWindowState(indoorOk ? indoor.window_open : null);
  if (windowMeta) windowMeta.textContent = indoorOk ? `data age: ${indoor.age_sec ?? "--"}s` : "no data";

  setStatusPill(indoorStatus, indoor?.online, indoor?.age_sec);
  setStatusPill(outdoorStatus, outdoor?.online, outdoor?.age_sec);

  // ✅ Slovak time label for live chart
  const skLabel = data?.server_time_sk ? parseServerIsoToNice(data.server_time_sk).slice(11, 19) : new Date().toLocaleTimeString();
  pushLiveChart(skLabel, indoorOk ? indoor.temp_c : null, outdoorOk ? outdoor.temp_c : null);

  renderAI(data.ai, data.ai_meta, indoor);
}

async function fetchAll() {
  try {
    const res = await fetch(API_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    const data = await res.json();
    updateUI(data);
  } catch (e) {
    console.error("Fetch failed:", e);
    if (aiSummaryEl) aiSummaryEl.textContent = "Data unavailable (check backend).";
  }
}

// ===== HISTORY by hours =====
function setHistoryChart(labels, inData, outData) {
  historyChart.data.labels = labels;
  historyChart.data.datasets[0].data = inData;
  historyChart.data.datasets[1].data = outData;
  historyChart.update();
}

async function loadHistory() {
  const hours = rangeSel ? Number(rangeSel.value) : 1;
  try {
    const res = await fetch(`${HISTORY_URL}?hours=${encodeURIComponent(hours)}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`History error: ${res.status}`);
    const data = await res.json();

    setHistoryChart(data.labels || [], data.indoor_temp || [], data.outdoor_temp || []);

    // also load events for same window (nice UX)
    await fetchEvents(hours);
  } catch (e) {
    console.error("History load failed:", e);
  }
}

if (loadHistoryBtn) loadHistoryBtn.addEventListener("click", loadHistory);

// ===== CLEAR DB button =====
async function clearDatabase() {
  const ok = confirm("CLEAR the database (measurements + notifications)? This cannot be undone.");
  if (!ok) return;

  const token = prompt("Enter admin token:");
  if (!token) return;

  try {
    const res = await fetch(CLEAR_URL, {
      method: "POST",
      headers: { "X-ADMIN-TOKEN": token }
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "Failed");

    // reset UI
    tempChart.data.labels = [];
    tempChart.data.datasets[0].data = [];
    tempChart.data.datasets[1].data = [];
    tempChart.update();

    historyChart.data.labels = [];
    historyChart.data.datasets[0].data = [];
    historyChart.data.datasets[1].data = [];
    historyChart.update();

    window.clearNotifications();
    addNotif({ type: "ADMIN", text: "Database cleared.", stamp: new Date().toLocaleTimeString() });

  } catch (e) {
    alert(`Clear failed: ${e.message}`);
  }
}
if (clearDbBtn) clearDbBtn.addEventListener("click", clearDatabase);

// ===== start =====
fetchAll();
setInterval(fetchAll, POLL_MS);

// pull notifications from backend timeline continuously
fetchEvents(6);
setInterval(() => fetchEvents(6), EVENTS_POLL_MS);

// initial history (1h) after small delay
setTimeout(loadHistory, 2500);

