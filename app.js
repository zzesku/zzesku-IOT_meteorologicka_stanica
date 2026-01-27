// app.js — realtime data + recommendations/events from your Flask API
const API_URL = "http://192.168.0.96:5000/api/latest";
const POLL_MS = 5000;

// ====== DOM ======
const inTemp  = document.getElementById("inTemp");
const inHum   = document.getElementById("inHum");
const inPres  = document.getElementById("inPres");

const outTemp = document.getElementById("outTemp");
const outHum  = document.getElementById("outHum");
const outPres = document.getElementById("outPres");

const lightSingle = document.getElementById("light");     // старый вариант (один lux)
const inLight = document.getElementById("inLight");       // если добавишь в HTML
const outLight = document.getElementById("outLight");     // если добавишь в HTML

const windowState = document.getElementById("windowState");
const adviceList = document.getElementById("adviceList");
const eventsList = document.getElementById("eventsList");

// ====== STATE ======
let shownAdvice = {};
let shownEvents = {};
let prevWindow = null;
let prevIndoorTemp = null;
let prevOutdoorTemp = null;

// ====== CHART ======
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

// ====== HELPERS ======
function format(val, digits = 1) {
  if (val === null || val === undefined || Number.isNaN(Number(val))) return "--";
  return Number(val).toFixed(digits);
}

function getStamp(indoor, outdoor) {
  const t = indoor?.time_local || outdoor?.time_local;
  if (!t) return new Date().toLocaleTimeString();
  const parts = String(t).trim().split(" ");
  return parts.length === 2 ? parts[1] : t;
}

function updateFade(listId) {
  const items = document.querySelectorAll(`#${listId} li`);
  items.forEach((item, idx) => {
    if (idx >= 5) item.classList.add("fade-old");
    else item.classList.remove("fade-old");
  });
}

function toggleOld(listId, btn) {
  const list = document.getElementById(listId);
  list.classList.toggle("expanded");
  if (list.classList.contains("expanded")) {
    document.querySelectorAll(`#${listId} li`).forEach(li => li.classList.remove("fade-old"));
    btn.textContent = "Hide older messages";
  } else {
    updateFade(listId);
    btn.textContent = "Show older messages";
  }
}

function addEvent(text, key, stamp) {
  if (shownEvents[key]) return;
  shownEvents[key] = true;

  const li = document.createElement("li");
  li.innerHTML = `${text} <span class="timestamp">${stamp}</span>`;
  eventsList.prepend(li);
  updateFade("eventsList");
}

function addAdvice(text, key, stamp) {
  if (shownAdvice[key]) return;
  shownAdvice[key] = true;

  const li = document.createElement("li");
  li.innerHTML = `${text} <span class="timestamp">${stamp}</span>`;
  adviceList.prepend(li);
  updateFade("adviceList");
}

function clearAdvice() {
  adviceList.innerHTML = "";
  shownAdvice = {};
}
function clearEvents() {
  eventsList.innerHTML = "";
  shownEvents = {};
}

// делаем функции глобальными (кнопки в HTML вызывают по имени)
window.clearAdvice = clearAdvice;
window.clearEvents = clearEvents;
window.toggleOld = toggleOld;

// ====== UI UPDATE ======
function setText(el, val) {
  if (!el) return;
  el.textContent = val;
}

function setWindowState(open) {
  if (!windowState) return;
  if (open === null || open === undefined) {
    windowState.textContent = "--";
    windowState.style.color = "";
    return;
  }
  windowState.textContent = open ? "OPEN" : "CLOSED";
  windowState.style.color = open ? "#4caf50" : "#ff4d4d";
}

function pushChart(label, inT, outT) {
  if (label) tempChart.data.labels.push(label);
  else tempChart.data.labels.push(new Date().toLocaleTimeString());

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

function updateUI(apiData) {
  const indoor = apiData?.indoor || null;
  const outdoor = apiData?.outdoor || null;

  // online/offline (если API проставляет online)
  const indoorOk = indoor && (indoor.online === undefined ? true : !!indoor.online);
  const outdoorOk = outdoor && (outdoor.online === undefined ? true : !!outdoor.online);

  // INDOOR
  setText(inTemp, indoorOk ? format(indoor.temp_c) : "--");
  setText(inHum,  indoorOk ? format(indoor.humidity_pct) : "--");
  setText(inPres, indoorOk ? format(indoor.pressure_hpa) : "--");

  // OUTDOOR
  setText(outTemp, outdoorOk ? format(outdoor.temp_c) : "--");
  setText(outHum,  outdoorOk ? format(outdoor.humidity_pct) : "--");
  setText(outPres, outdoorOk ? format(outdoor.pressure_hpa) : "--");

  // WINDOW (обычно с indoor pico)
  const winOpen = indoorOk ? indoor.window_open : null;
  setWindowState(winOpen);

  // LUX: раздельно (если есть элементы), иначе в один span#light
  const inLux = indoorOk ? indoor.lux : null;
  const outLux = outdoorOk ? outdoor.lux : null;

  if (inLight || outLight) {
    setText(inLight, inLux != null ? format(inLux, 0) : "--");
    setText(outLight, outLux != null ? format(outLux, 0) : "--");
  } else {
    const luxSingle = (outLux != null) ? outLux : inLux;
    setText(lightSingle, luxSingle != null ? format(luxSingle, 0) : "--");
  }

  // CHART
  const stamp = getStamp(indoor, outdoor);
  pushChart(stamp, indoorOk ? indoor.temp_c : null, outdoorOk ? outdoor.temp_c : null);

  // RULES
  runRules({
    indoor: indoorOk ? indoor : null,
    outdoor: outdoorOk ? outdoor : null,
    window: indoorOk ? !!indoor.window_open : null,
    lightIndoor: indoorOk ? indoor.lux : null,
    lightOutdoor: outdoorOk ? outdoor.lux : null,
    stamp
  });
}

// ====== RECOMMENDATIONS + EVENTS ======
function runRules(d) {
  const stamp = d.stamp || new Date().toLocaleTimeString();

  const inT = d.indoor?.temp_c;
  const inH = d.indoor?.humidity_pct;
  const inP = d.indoor?.pressure_hpa;

  const outT = d.outdoor?.temp_c;
  const outH = d.outdoor?.humidity_pct;
  const outP = d.outdoor?.pressure_hpa;

  const win = d.window; // true/false/null
  const inLux = d.lightIndoor;
  const outLux = d.lightOutdoor;

  // ---- EVENTS: window toggled ----
  if (win !== null && win !== prevWindow) {
    if (prevWindow !== null) {
      addEvent(win ? "Window opened" : "Window closed", "window_toggle_" + String(Date.now()), stamp);
    }
    prevWindow = win;
  }

  // ---- EVENTS: big temp jump ----
  if (inT != null && prevIndoorTemp != null && Math.abs(inT - prevIndoorTemp) >= 2.0) {
    addEvent("Indoor temperature changed noticeably (≥ 2°C)", "in_jump_" + String(Date.now()), stamp);
  }
  if (outT != null && prevOutdoorTemp != null && Math.abs(outT - prevOutdoorTemp) >= 2.0) {
    addEvent("Outdoor temperature changed noticeably (≥ 2°C)", "out_jump_" + String(Date.now()), stamp);
  }
  if (inT != null) prevIndoorTemp = inT;
  if (outT != null) prevOutdoorTemp = outT;

  // ---- ADVICE: cold inside + window open ----
  if (win === true && inT != null && inT < 20) {
    addAdvice("It’s cold inside and the window is open — consider closing it to keep warmth.", "cold_window", stamp);
  } else {
    delete shownAdvice["cold_window"];
  }

  // ---- ADVICE: hot inside + window closed ----
  if (win === false && inT != null && inT > 25) {
    addAdvice("Room is getting warm — opening the window for a few minutes may help.", "hot_room", stamp);
  } else {
    delete shownAdvice["hot_room"];
  }

  // ---- ADVICE: very cold outside + window open ----
  if (win === true && outT != null && outT < 5) {
    addAdvice("Very cold outside — keeping the window open may cool the room quickly.", "very_cold_outside", stamp);
  } else {
    delete shownAdvice["very_cold_outside"];
  }

  // ---- ADVICE: humidity high/low ----
  if (inH != null && inH > 70) {
    addAdvice("High humidity indoors — ventilation is recommended (mold risk).", "high_humidity", stamp);
  } else {
    delete shownAdvice["high_humidity"];
  }

  if (inH != null && inH < 30) {
    addAdvice("Air is too dry — consider a humidifier or a bowl of water near a heater.", "low_humidity", stamp);
  } else {
    delete shownAdvice["low_humidity"];
  }

  // ---- ADVICE: comfort range hint ----
  if (inT != null && inH != null) {
    const okTemp = inT >= 20 && inT <= 24;
    const okHum = inH >= 40 && inH <= 60;
    if (!okTemp || !okHum) {
      addAdvice("Comfort tip: aim for ~20–24°C and 40–60% humidity indoors.", "comfort_tip", stamp);
    } else {
      delete shownAdvice["comfort_tip"];
    }
  }

  // ---- LIGHT RULES (используем INDOOR свет для комнаты) ----
  const hour = new Date().getHours();
  if (inLux != null && inLux < 150 && hour < 22) {
    addAdvice("It’s quite dark indoors — you may want to turn on the lights.", "dark_room", stamp);
  } else {
    delete shownAdvice["dark_room"];
  }

  // ---- Strong sunlight (используем OUTDOOR свет) ----
  if (outLux != null && outLux > 800 && outT != null && outT > 25) {
    addAdvice("Strong sunlight outside — closing blinds can help keep the room cooler.", "strong_sun", stamp);
  } else {
    delete shownAdvice["strong_sun"];
  }

  // ---- EVENTS: big inside/outside difference ----
  if (inT != null && outT != null && Math.abs(inT - outT) > 10) {
    addEvent("Large temperature difference between inside and outside", "temp_difference", stamp);
  } else {
    delete shownEvents["temp_difference"];
  }

  // ---- EVENTS: very bright / very dark (по INDOOR) ----
  if (inLux != null && inLux > 900) {
    addEvent("Very bright light level indoors", "very_bright", stamp);
  } else {
    delete shownEvents["very_bright"];
  }

  if (inLux != null && inLux < 50) {
    addEvent("Very low light level indoors", "very_dark", stamp);
  } else {
    delete shownEvents["very_dark"];
  }

  // ---- Optional: pressure note (simple) ----
  if (inP != null && inP < 990) {
    addEvent("Low pressure detected — weather may become unstable", "low_pressure", stamp);
  } else {
    delete shownEvents["low_pressure"];
  }
}

// ====== FETCH LOOP ======
async function fetchData() {
  try {
    const res = await fetch(API_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    const data = await res.json();
    console.log("API DATA:", data);
    updateUI(data);
  } catch (err) {
    console.error("Fetch failed:", err);
  }
}

fetchData();
setInterval(fetchData, POLL_MS);
