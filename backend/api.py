from flask import Flask, jsonify, send_from_directory
from flask_cors import CORS
import sqlite3
import time
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
SITE_DIR = BASE_DIR.parent / "site"
DB_PATH = BASE_DIR / "meteo.db"

app = Flask(
    __name__,
    static_folder=str(SITE_DIR),
    static_url_path=""
)
CORS(app)


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def latest_for_device(device_name):
    conn = get_db()
    cur = conn.cursor()
    cur.execute("""
        SELECT *
        FROM measurements
        WHERE device = ?
        ORDER BY id DESC
        LIMIT 1
    """, (device_name,))
    row = cur.fetchone()
    conn.close()

    if row is None:
        return None

    data = dict(row)
    data["online"] = (int(time.time()) - int(row["created_at"])) < 20
    return data


# ===== SITE =====
@app.route("/")
def index():
    return send_from_directory(SITE_DIR, "index.html")


# ===== API =====
@app.route("/api/latest")
def api_latest():
    return jsonify({
        "indoor": latest_for_device("Pico2W-vnutri"),
        "outdoor": latest_for_device("Pico2W-vonku")
    })


@app.route("/api/health")
def api_health():
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
