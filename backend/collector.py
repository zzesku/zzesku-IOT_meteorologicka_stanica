import json
import sqlite3
import time
import paho.mqtt.client as mqtt

DB_PATH = "meteo.db"
MQTT_HOST = "localhost"
MQTT_PORT = 1883
MQTT_TOPIC = "gw/meteo/+/data"

# ---------- DB ----------
conn = sqlite3.connect(DB_PATH, check_same_thread=False)
cur = conn.cursor()

cur.execute("""
CREATE TABLE IF NOT EXISTS measurements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device TEXT,
    time_local TEXT,
    temp_c REAL,
    humidity_pct REAL,
    pressure_hpa REAL,
    lux REAL,
    window_open INTEGER,
    rssi_dbm INTEGER,
    created_at INTEGER
)
""")
conn.commit()

# ---------- MQTT ----------
def on_connect(client, userdata, flags, rc):
    print("MQTT connected:", rc)
    client.subscribe(MQTT_TOPIC)

def on_message(client, userdata, msg):
    try:
        data = json.loads(msg.payload.decode())
        cur.execute("""
            INSERT INTO measurements (
                device, time_local, temp_c, humidity_pct,
                pressure_hpa, lux, window_open, rssi_dbm, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            data.get("device"),
            data.get("time_local"),
            data.get("temp_c"),
            data.get("humidity_pct"),
            data.get("pressure_hpa"),
            data.get("lux"),
            int(data.get("window_open", 0)),
            data.get("rssi_dbm"),
            int(time.time())
        ))
        conn.commit()
        print("Saved:", data["device"])
    except Exception as e:
        print("Error:", e)

client = mqtt.Client()
client.on_connect = on_connect
client.on_message = on_message

client.connect(MQTT_HOST, MQTT_PORT, 60)
client.loop_forever()
