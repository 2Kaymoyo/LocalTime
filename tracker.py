import atexit, json, logging, os, subprocess, threading, time
from http.server import BaseHTTPRequestHandler, HTTPServer
from datetime import datetime
from categorization import categorize_activity, get_categories

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

PORT = 5050
LOG_FILE = "time_data.json"
SESSIONS_FILE = "session_history.json"
TODO_FILE = "todos.json"
ALLOWED_ORIGINS = ("http://127.0.0.1", "http://localhost")
CATEGORIES = get_categories()
data_lock = threading.Lock()
BROWSERS = ["Google Chrome", "Brave Browser"]

class SessionManager:
    def __init__(self):
        self.is_active = False
        self.start_time = None
        self.data = {cat: 0.0 for cat in CATEGORIES}

    def start(self):
        self.is_active = True
        self.start_time = datetime.now()
        self.data = {cat: 0.0 for cat in CATEGORIES}
        close_distractions()

    def stop(self):
        if not self.is_active: return
        self.is_active = False
        end_time = datetime.now()
        total = sum(self.data.values())
        prod = self.data.get("Productive (School & Career)", 0) + self.data.get("Environmental Justice Work", 0)
        efficiency = int((prod / total) * 100) if total > 0 else 0
        
        session_entry = {
            "date": self.start_time.strftime("%Y-%m-%d"),
            "start": self.start_time.strftime("%H:%M"),
            "end": end_time.strftime("%H:%M"),
            "duration_min": int(total),
            "efficiency": efficiency
        }
        
        history = []
        if os.path.exists(SESSIONS_FILE):
            with open(SESSIONS_FILE, "r") as f:
                try: history = json.load(f)
                except json.JSONDecodeError:
                    logger.warning("Failed to parse %s, starting fresh", SESSIONS_FILE)
                    history = []
        history.append(session_entry)
        with open(SESSIONS_FILE, "w") as f: json.dump(history, f, indent=4)

session = SessionManager()

def close_distractions():
    print(">>> Focus Mode Active: Closing distractions...")
    script = '''
    tell application "Google Chrome"
        repeat with w in windows
            set i to 1
            repeat while i <= (count tabs of w)
                set t to tab i of w
                if (URL of t contains "youtube.com") or (URL of t contains "instagram.com") or (URL of t contains "youtu.be") then
                    close t
                else
                    set i to i + 1
                end if
            end repeat
        end repeat
    end tell
    '''
    try: subprocess.run(['osascript', '-e', script], capture_output=True)
    except Exception as e: logger.warning("Failed to close distractions: %s", e)

def get_frontmost_app():
    script = 'tell application "System Events" to get the name of the first process whose frontmost is true'
    try:
        result = subprocess.run(['osascript', '-e', script], capture_output=True, text=True)
        return result.stdout.strip()
    except Exception as e:
        logger.warning("Failed to get frontmost app: %s", e)
        return None


# --- In-memory data store with periodic flush ---
_db_cache = {}
_db_dirty = False
FLUSH_INTERVAL = 60  # seconds


def _load_db():
    """Load the database from disk into memory."""
    global _db_cache
    if os.path.exists(LOG_FILE):
        with open(LOG_FILE, "r") as f:
            try:
                _db_cache = json.load(f)
            except json.JSONDecodeError:
                logger.warning("Failed to parse %s, starting fresh", LOG_FILE)
                _db_cache = {}
    else:
        _db_cache = {}


def _flush_db():
    """Write in-memory data to disk if dirty."""
    global _db_dirty
    with data_lock:
        if _db_dirty:
            with open(LOG_FILE, "w") as f:
                json.dump(_db_cache, f, indent=4)
            _db_dirty = False


def _periodic_flush():
    """Background thread that flushes data to disk every FLUSH_INTERVAL seconds."""
    while True:
        time.sleep(FLUSH_INTERVAL)
        _flush_db()


def log_time(category, detail_str):
    global _db_dirty
    with data_lock:
        today = datetime.now().strftime("%Y-%m-%d")

        if today not in _db_cache:
            _db_cache[today] = {"general": {c: 0.0 for c in CATEGORIES}, "session": {c: 0.0 for c in CATEGORIES}}

        inc = (5.0 / 60.0)

        if session.is_active:
            _db_cache[today]["session"][category] += inc
            session.data[category] += inc
        else:
            _db_cache[today]["general"][category] += inc

        _db_dirty = True

def load_todos():
    if os.path.exists(TODO_FILE):
        with open(TODO_FILE, "r") as f:
            try: return json.load(f)
            except json.JSONDecodeError:
                logger.warning("Failed to parse %s", TODO_FILE)
    return {"academic": [], "professional": [], "personal": []}

def save_todos(data):
    with open(TODO_FILE, "w") as f: json.dump(data, f, indent=4)

def monitor_mac_apps():
    while True:
        active_app = get_frontmost_app()
        if active_app and active_app not in BROWSERS:
            log_time(categorize_activity(active_app, is_app=True), f"App: {active_app}")
        time.sleep(5)

class TrackerHandler(BaseHTTPRequestHandler):
    def _get_cors_origin(self):
        origin = self.headers.get('Origin', '')
        if any(origin.startswith(a) for a in ALLOWED_ORIGINS):
            return origin
        return ALLOWED_ORIGINS[0]

    def _send_cors(self):
        self.send_header('Access-Control-Allow-Origin', self._get_cors_origin())

    def do_OPTIONS(self):
        self.send_response(200)
        self._send_cors()
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_POST(self):
        if self.path == '/log':
            if get_frontmost_app() in BROWSERS:
                content_length = int(self.headers['Content-Length'])
                data = json.loads(self.rfile.read(content_length))
                url = data.get('url', '')
                if url: log_time(categorize_activity(url, is_app=False), f"URL: {url}")
            self.send_response(200); self._send_cors(); self.end_headers()

        elif self.path in ['/session/start', '/session/stop']:
            if self.path == '/session/start': session.start()
            else: session.stop()
            self.send_response(200); self._send_cors(); self.end_headers()

        elif self.path == '/todos':
            content_length = int(self.headers['Content-Length'])
            post_body = self.rfile.read(content_length)
            save_todos(json.loads(post_body))
            self.send_response(200); self._send_cors(); self.end_headers()

    def do_GET(self):
        if self.path == '/data':
            with data_lock:
                today = datetime.now().strftime("%Y-%m-%d")
                today_data = _db_cache.get(today, {"general": {c: 0.0 for c in CATEGORIES}, "session": {c: 0.0 for c in CATEGORIES}})
                resp = {
                    "general": today_data["general"],
                    "session_totals": today_data["session"],
                    "active_session": session.data,
                    "session_active": session.is_active
                }
            self.send_response(200); self.send_header('Content-Type', 'application/json'); self._send_cors(); self.end_headers()
            self.wfile.write(json.dumps(resp).encode('utf-8'))

        elif self.path == '/history':
            with data_lock:
                db = dict(_db_cache)
            sessions = []
            if os.path.exists(SESSIONS_FILE):
                with open(SESSIONS_FILE, "r") as f: sessions = json.load(f)
            resp = {"timeline": db, "sessions": sessions}
            self.send_response(200); self.send_header('Content-Type', 'application/json'); self._send_cors(); self.end_headers()
            self.wfile.write(json.dumps(resp).encode('utf-8'))
            
        elif self.path == '/todos':
            self.send_response(200); self.send_header('Content-Type', 'application/json'); self._send_cors(); self.end_headers()
            self.wfile.write(json.dumps(load_todos()).encode('utf-8'))

    def log_message(self, format, *args): pass 

if __name__ == "__main__":
    _load_db()
    atexit.register(_flush_db)
    threading.Thread(target=_periodic_flush, daemon=True).start()
    threading.Thread(target=monitor_mac_apps, daemon=True).start()
    logger.info("Time Engine Active with Distraction Overrides...")
    HTTPServer(('127.0.0.1', 5050), TrackerHandler).serve_forever()