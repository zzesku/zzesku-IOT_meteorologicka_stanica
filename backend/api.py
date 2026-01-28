from flask import Flask, jsonify, send_from_directory, request
from flask_cors import CORS
import sqlite3
import time
from pathlib import Path
import os
import json
import threading
from datetime import datetime
from zoneinfo import ZoneInfo
from openai import OpenAI

# =========================
# PATHS (ваша структура)
# =========================
BACKEND_DIR = Path(__file__).resolve().parent
PROJECT_DIR = BACKEND_DIR.parent
SITE_DIR = PROJECT_DIR / "site"
DB_PATH = BACKEND_DIR / "meteo.db"

if not (SITE_DIR / "index.html").exists():
    raise RuntimeError(f"index.html not found in {SITE_DIR}. Put index.html/app.js/style.css there.")

# =========================
# FLASK
# =========================
app = Flask(__name__, static_folder=str(SITE_DIR), static_url_path="")
CORS(app)

# =========================
# OPENAI
# =========================
client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))

DEVICE_INDOOR = "Pico2W-vnutri"
DEVICE_OUTDOOR = "Pico2W-vonku"

# =========================
# ADMIN
# =========================
CLEAR_DB_TOKEN = os.environ.get("CLEAR_DB_TOKEN", "")  # set in env

# =========================
# TIMEZONE (Slovakia)
# =========================
SK_TZ = ZoneInfo("Europe/Bratislava")

def slovak_time_iso():
    return datetime.now(SK_TZ).isoformat(timespec="seconds")

# =========================
# AI CACHE (fast)
# =========================
AI_TTL_SECONDS = 30
_ai_lock = threading.Lock()
_ai_state = {
    "ts": 0,
    "running": False,
    "data": {"summary": "AI is analyzing environment...", "recommendations": [], "alerts": []}
}

# =========================
# DB helpers
# =========================
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db()
    cur = conn.cursor()

    # events table (timeline)
    cur.execute("""
    CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at INTEGER NOT NULL,
        code TEXT NOT NULL,
        type TEXT NOT NULL,
        message TEXT NOT NULL
    );
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_events_code_created_at ON events(code, created_at);")

    conn.commit()
    conn.close()

init_db()

def insert_event(code: str, type_: str, message: str, cooldown_sec: int = 60):
    """
    Inserts event if not inserted recently (cooldown per code).
    """
    now = int(time.time())
    try:
        conn = get_db()
        cur = conn.cursor()
        cur.execute("SELECT created_at FROM events WHERE code=? ORDER BY created_at DESC LIMIT 1;", (code,))
        row = cur.fetchone()
        if row and (now - int(row["created_at"])) < cooldown_sec:
            conn.close()
            return False

        cur.execute(
            "INSERT INTO events(created_at, code, type, message) VALUES(?, ?, ?, ?);",
            (now, code, type_, message),
        )
        conn.commit()
        conn.close()
        return True
    except Exception:
        return False

def latest_for_device(device_name: str):
    conn = get_db()
    cur = conn.cursor()
    cur.execute(
        """
        SELECT *
        FROM measurements
        WHERE device = ?
        ORDER BY id DESC
        LIMIT 1
        """,
        (device_name,),
    )
    row = cur.fetchone()
    conn.close()
    if row is None:
        return None

    data = dict(row)
    try:
        data["age_sec"] = int(time.time()) - int(row["created_at"])
        data["online"] = data["age_sec"] < 20
    except Exception:
        data["age_sec"] = None
        data["online"] = True
    return data

def prev_for_device(device_name: str):
    conn = get_db()
    cur = conn.cursor()
    cur.execute(
        """
        SELECT *
        FROM measurements
        WHERE device = ?
        ORDER BY id DESC
        LIMIT 1 OFFSET 1
        """,
        (device_name,),
    )
    row = cur.fetchone()
    conn.close()
    return dict(row) if row else None

def recent_rows_for_device(device_name: str, limit: int = 12):
    conn = get_db()
    cur = conn.cursor()
    cur.execute(
        """
        SELECT *
        FROM measurements
        WHERE device = ?
        ORDER BY id DESC
        LIMIT ?
        """,
        (device_name, limit),
    )
    rows = cur.fetchall()
    conn.close()
    return [dict(r) for r in rows]

def calc_trends(rows: list):
    if not rows or len(rows) < 2:
        return {}
    newest = rows[0]
    oldest = rows[-1]

    def f(key):
        try:
            a = newest.get(key, None)
            b = oldest.get(key, None)
            if a is None or b is None:
                return None
            return float(a) - float(b)
        except Exception:
            return None

    duration_sec = None
    try:
        duration_sec = int(newest.get("created_at")) - int(oldest.get("created_at"))
        if duration_sec <= 0:
            duration_sec = None
    except Exception:
        duration_sec = None

    return {
        "duration_sec": duration_sec,
        "temp_c_delta": f("temp_c"),
        "humidity_pct_delta": f("humidity_pct"),
        "pressure_hpa_delta": f("pressure_hpa"),
        "lux_delta": f("lux"),
    }

# =========================
# Event detection (server-side, stored in DB)
# =========================
def detect_and_store_events(indoor, outdoor):
    now_iso = slovak_time_iso()  # only for composing message if you want

    # 1) window open/close (compare current and previous indoor measurement)
    prev_in = prev_for_device(DEVICE_INDOOR)
    if indoor and prev_in:
        cur_w = indoor.get("window_open")
        prev_w = prev_in.get("window_open")
        if cur_w is not None and prev_w is not None and cur_w != prev_w:
            insert_event(
                code=f"window_{cur_w}",
                type_="WINDOW",
                message=("Window opened." if cur_w else "Window closed."),
                cooldown_sec=2
            )

    # 2) online/offline (derived)
    # We store transitions by comparing current derived online with last stored event state.
    # simplest: event when age crosses 20 sec and API is being polled.
    if indoor and indoor.get("age_sec") is not None:
        if indoor["age_sec"] >= 20:
            insert_event("indoor_offline", "SENSOR", "Indoor Pico appears offline (stale data).", cooldown_sec=60)
        else:
            insert_event("indoor_online", "SENSOR", "Indoor Pico is online.", cooldown_sec=120)

    if outdoor and outdoor.get("age_sec") is not None:
        if outdoor["age_sec"] >= 20:
            insert_event("outdoor_offline", "SENSOR", "Outdoor Pico appears offline (stale data).", cooldown_sec=60)
        else:
            insert_event("outdoor_online", "SENSOR", "Outdoor Pico is online.", cooldown_sec=120)

    # 3) spikes (compare latest vs previous row)
    def spike(device, field, thr, code, label):
        prev_row = prev_for_device(device)
        if not prev_row:
            return
        try:
            cur_val = float((indoor if device == DEVICE_INDOOR else outdoor).get(field))
            prev_val = float(prev_row.get(field))
            if abs(cur_val - prev_val) >= thr:
                insert_event(code, "SPIKE", label, cooldown_sec=10)
        except Exception:
            return

    if indoor:
        spike(DEVICE_INDOOR, "temp_c", 2.0, "in_temp_spike", "Indoor temperature changed sharply (≥ 2°C).")
        spike(DEVICE_INDOOR, "humidity_pct", 10.0, "in_h_spike", "Indoor humidity changed sharply (≥ 10%).")
        spike(DEVICE_INDOOR, "pressure_hpa", 3.0, "in_p_spike", "Indoor pressure changed sharply (≥ 3 hPa).")
        spike(DEVICE_INDOOR, "lux", 400.0, "in_lux_spike", "Indoor light level changed sharply.")

    if outdoor:
        spike(DEVICE_OUTDOOR, "temp_c", 2.0, "out_temp_spike", "Outdoor temperature changed sharply (≥ 2°C).")
        spike(DEVICE_OUTDOOR, "humidity_pct", 10.0, "out_h_spike", "Outdoor humidity changed sharply (≥ 10%).")
        spike(DEVICE_OUTDOOR, "pressure_hpa", 3.0, "out_p_spike", "Outdoor pressure changed sharply (≥ 3 hPa).")
        spike(DEVICE_OUTDOOR, "lux", 800.0, "out_lux_spike", "Outdoor light level changed sharply.")

    # 4) extremes (basic)
    if indoor:
        try:
            t = float(indoor.get("temp_c"))
            if t > 28: insert_event("in_t_hi", "TEMP", "Indoor temperature is high (> 28°C).", cooldown_sec=120)
            if t < 16: insert_event("in_t_lo", "TEMP", "Indoor temperature is low (< 16°C).", cooldown_sec=120)
        except Exception:
            pass
        try:
            h = float(indoor.get("humidity_pct"))
            if h > 75: insert_event("in_h_hi", "HUMIDITY", "Indoor humidity is very high (> 75%). Mold risk — ventilate.", cooldown_sec=120)
            if h < 25: insert_event("in_h_lo", "HUMIDITY", "Indoor air is very dry (< 25%). Consider humidifying.", cooldown_sec=120)
        except Exception:
            pass

    # 5) indoor vs outdoor difference
    if indoor and outdoor:
        try:
            diff = float(indoor.get("temp_c")) - float(outdoor.get("temp_c"))
            if abs(diff) >= 8:
                insert_event("temp_diff_big", "COMPARE", f"Large indoor/outdoor temperature difference ({diff:.1f}°C).", cooldown_sec=120)
        except Exception:
            pass

# =========================
# AI
# =========================
def build_ai_payload(indoor: dict, outdoor: dict):
    indoor_recent = recent_rows_for_device(DEVICE_INDOOR, 12)
    outdoor_recent = recent_rows_for_device(DEVICE_OUTDOOR, 12)

    payload = {
        "server_time_sk": slovak_time_iso(),
        "server_ts": int(time.time()),
        "indoor": indoor,
        "outdoor": outdoor,
        "trends": {
            "indoor": calc_trends(indoor_recent),
            "outdoor": calc_trends(outdoor_recent),
        },
        "derived": {
            "temp_diff_c": (
                None if indoor.get("temp_c") is None or outdoor.get("temp_c") is None
                else float(indoor["temp_c"]) - float(outdoor["temp_c"])
            ),
            "window_open": indoor.get("window_open", None),
        },
    }
    return payload

def ask_ai(indoor: dict, outdoor: dict):
    if not client.api_key:
        return {
            "summary": "AI error: OPENAI_API_KEY is not set on the server.",
            "recommendations": [],
            "alerts": ["Server is missing OPENAI_API_KEY env var."]
        }

    system_prompt = (
        "You are an AI assistant for an IoT Environment Monitor (indoor + outdoor sensors).\n"
        "Use ONLY the provided JSON data. Be practical, concise, and user-friendly.\n\n"
        "Tasks:\n"
        "1) summary: 1–2 sentences about the current situation (indoor vs outdoor).\n"
        "2) recommendations: 4–8 actionable tips (ventilation, comfort, clothing, humidity management, light).\n"
        "   You may make cautious assumptions based on pressure/temp/humidity trends, but do NOT invent a real weather forecast.\n"
        "3) alerts: anomalies & data quality issues (offline sensors, stale data, sudden spikes, unrealistic values).\n\n"
        "Output MUST be valid JSON matching the schema."
    )

    schema = {
        "name": "meteo_advice",
        "schema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "summary": {"type": "string"},
                "recommendations": {"type": "array", "items": {"type": "string"}},
                "alerts": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["summary", "recommendations", "alerts"],
        },
    }

    data_packet = build_ai_payload(indoor, outdoor)

    resp = client.chat.completions.create(
        model="gpt-4o-mini",
        temperature=0.35,
        response_format={"type": "json_schema", "json_schema": schema},
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": json.dumps(data_packet, ensure_ascii=False)},
        ],
    )
    return json.loads(resp.choices[0].message.content)

def _ai_worker(indoor, outdoor):
    global _ai_state
    try:
        result = ask_ai(indoor, outdoor)
    except Exception as e:
        result = {"summary": f"AI error: {e}", "recommendations": [], "alerts": []}

    with _ai_lock:
        _ai_state["data"] = result
        _ai_state["ts"] = int(time.time())
        _ai_state["running"] = False

def refresh_ai_if_needed(indoor, outdoor):
    now = int(time.time())
    with _ai_lock:
        fresh = (now - _ai_state["ts"]) < AI_TTL_SECONDS
        if fresh:
            return
        if _ai_state["running"]:
            return
        _ai_state["running"] = True

    t = threading.Thread(target=_ai_worker, args=(indoor, outdoor), daemon=True)
    t.start()

# =========================
# SITE routes
# =========================
@app.route("/")
def index():
    return send_from_directory(SITE_DIR, "index.html")

@app.route("/<path:path>")
def static_files(path):
    return send_from_directory(SITE_DIR, path)

# =========================
# API routes
# =========================
@app.route("/api/latest")
def api_latest():
    indoor = latest_for_device(DEVICE_INDOOR)
    outdoor = latest_for_device(DEVICE_OUTDOOR)

    # Detect & store timeline events
    if indoor or outdoor:
        detect_and_store_events(indoor, outdoor)

    # AI refresh (in background)
    if indoor and outdoor:
        refresh_ai_if_needed(indoor, outdoor)

    with _ai_lock:
        ai_data = _ai_state["data"]
        running = _ai_state["running"]
        ai_age = int(time.time()) - _ai_state["ts"] if _ai_state["ts"] else None

    return jsonify({
        "server_time_sk": slovak_time_iso(),
        "indoor": indoor,
        "outdoor": outdoor,
        "ai": ai_data,
        "ai_meta": {"running": running, "age_sec": ai_age},
        "error": None if (indoor and outdoor) else "No sensor data yet for indoor/outdoor."
    })

@app.route("/api/history")
def api_history():
    """
    History by time window:
      hours=1|6|24  (default 1)
    Returns merged timeline labels in SK time and aligned indoor/outdoor temps.
    """
    try:
        hours = int(request.args.get("hours", "1"))
    except Exception:
        hours = 1
    hours = 1 if hours not in (1, 6, 24) else hours

    since_ts = int(time.time()) - hours * 3600

    def load(device):
        conn = get_db()
        cur = conn.cursor()
        cur.execute(
            """
            SELECT created_at, temp_c
            FROM measurements
            WHERE device = ?
              AND created_at >= ?
            ORDER BY created_at ASC
            """,
            (device, since_ts),
        )
        rows = cur.fetchall()
        conn.close()
        return rows

    in_rows = load(DEVICE_INDOOR)
    out_rows = load(DEVICE_OUTDOOR)

    # map by timestamp (rounded to 5 sec to align series)
    def round_ts(ts, step=5):
        try:
            ts = int(ts)
            return ts - (ts % step)
        except Exception:
            return None

    in_map = {}
    for r in in_rows:
        ts = round_ts(r["created_at"])
        if ts is not None:
            in_map[ts] = r["temp_c"]

    out_map = {}
    for r in out_rows:
        ts = round_ts(r["created_at"])
        if ts is not None:
            out_map[ts] = r["temp_c"]

    all_ts = sorted(set(in_map.keys()) | set(out_map.keys()))
    # limit to prevent huge payload
    if len(all_ts) > 6000:
        all_ts = all_ts[-6000:]

    def label(ts):
        dt = datetime.fromtimestamp(ts, SK_TZ)
        # for 1h we show HH:MM:SS; for 6/24h HH:MM
        return dt.strftime("%H:%M:%S") if hours == 1 else dt.strftime("%H:%M")

    labels = [label(ts) for ts in all_ts]
    indoor_temp = [in_map.get(ts, None) for ts in all_ts]
    outdoor_temp = [out_map.get(ts, None) for ts in all_ts]

    return jsonify({
        "hours": hours,
        "labels": labels,
        "indoor_temp": indoor_temp,
        "outdoor_temp": outdoor_temp,
        "points": len(all_ts)
    })

@app.route("/api/events")
def api_events():
    """
    Timeline events from DB.
    hours=1|6|24 (default 6)
    limit (default 200, max 2000)
    """
    try:
        hours = int(request.args.get("hours", "6"))
    except Exception:
        hours = 6
    hours = 6 if hours not in (1, 6, 24) else hours

    try:
        limit = int(request.args.get("limit", "200"))
    except Exception:
        limit = 200
    limit = max(10, min(limit, 2000))

    since_ts = int(time.time()) - hours * 3600

    conn = get_db()
    cur = conn.cursor()
    cur.execute(
        """
        SELECT id, created_at, code, type, message
        FROM events
        WHERE created_at >= ?
        ORDER BY created_at DESC
        LIMIT ?
        """,
        (since_ts, limit),
    )
    rows = cur.fetchall()
    conn.close()

    def to_label(ts):
        dt = datetime.fromtimestamp(int(ts), SK_TZ)
        return dt.strftime("%Y-%m-%d %H:%M:%S")

    events = []
    for r in rows:
        events.append({
            "id": r["id"],
            "created_at": r["created_at"],
            "time_sk": to_label(r["created_at"]),
            "code": r["code"],
            "type": r["type"],
            "message": r["message"]
        })

    return jsonify({"hours": hours, "events": events})

@app.route("/api/admin/clear_db", methods=["POST"])
def api_clear_db():
    token = request.headers.get("X-ADMIN-TOKEN", "")
    if not CLEAR_DB_TOKEN or token != CLEAR_DB_TOKEN:
        return jsonify({"ok": False, "error": "Unauthorized"}), 401

    try:
        conn = get_db()
        cur = conn.cursor()
        cur.execute("DELETE FROM measurements;")
        cur.execute("DELETE FROM events;")
        conn.commit()
        conn.close()

        global _ai_state
        with _ai_lock:
            _ai_state["ts"] = 0
            _ai_state["running"] = False
            _ai_state["data"] = {"summary": "AI is analyzing environment...", "recommendations": [], "alerts": []}

        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

@app.route("/api/health")
def api_health():
    return jsonify({"status": "ok"})

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
