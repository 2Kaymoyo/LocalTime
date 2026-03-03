#!/usr/bin/env python3
"""LocalTime Desktop Agent — tracks frontmost macOS app and logs to Firestore via curl."""
import time, json, subprocess
from datetime import datetime

PROJECT_ID = "YOUR_PROJECT_ID"
API_KEY = "YOUR_FIREBASE_API_KEY"
BASE_URL = f"https://firestore.googleapis.com/v1/projects/{PROJECT_ID}/databases/(default)/documents"

BROWSERS = ["Google Chrome", "Brave Browser", "Safari", "Arc", "Microsoft Edge", "Firefox"]

cached_rules = None
last_rules_fetch = 0

def curl_get(url):
    """GET via curl, returns parsed JSON or None."""
    try:
        result = subprocess.run(['curl', '-s', url], capture_output=True, text=True, timeout=10)
        if result.returncode == 0 and result.stdout.strip():
            return json.loads(result.stdout)
    except Exception:
        pass
    return None

def curl_patch(url, payload):
    """PATCH via curl."""
    try:
        subprocess.run(
            ['curl', '-s', '-X', 'PATCH', url, '-H', 'Content-Type: application/json', '-d', json.dumps(payload)],
            capture_output=True, text=True, timeout=10
        )
    except Exception:
        pass

def get_frontmost_app():
    script = 'tell application "System Events" to get the name of the first process whose frontmost is true'
    try:
        result = subprocess.run(['osascript', '-e', script], capture_output=True, text=True, timeout=5)
        return result.stdout.strip()
    except Exception:
        return None

def fetch_rules():
    global cached_rules, last_rules_fetch
    now = time.time()
    if cached_rules and now - last_rules_fetch < 300:
        return cached_rules

    data = curl_get(f"{BASE_URL}/config/rules?key={API_KEY}")
    if data and "fields" in data:
        rules = {"domains": [], "keywords": []}
        if "domains" in data["fields"]:
            av = data["fields"]["domains"].get("arrayValue", {})
            rules["domains"] = [v["stringValue"] for v in av.get("values", [])]
        if "keywords" in data["fields"]:
            av = data["fields"]["keywords"].get("arrayValue", {})
            rules["keywords"] = [v["stringValue"] for v in av.get("values", [])]
        cached_rules = rules
        last_rules_fetch = now

    if not cached_rules:
        cached_rules = {"domains": [], "keywords": ["code", "terminal", "zoom", "notes", "word", "pages", "keynote", "preview", "obsidian"]}
    return cached_rules

def categorize_app(app_name):
    rules = fetch_rules()
    lower = app_name.lower()
    if any(k.lower() in lower for k in rules.get("keywords", [])):
        return "Productive"
    return "Unproductive"

def log_time(category):
    today = datetime.now().strftime("%Y-%m-%d")
    doc_url = f"{BASE_URL}/logs/{today}?key={API_KEY}"
    inc = 5.0 / 60.0

    # Read current value
    current_val = 0.0
    data = curl_get(doc_url)
    if data and "fields" in data and category in data["fields"]:
        current_val = data["fields"][category].get("doubleValue", 0.0)

    # Write incremented value
    new_val = current_val + inc
    patch_url = f"{doc_url}&updateMask.fieldPaths={category}"
    curl_patch(patch_url, {"fields": {category: {"doubleValue": new_val}}})

def main():
    print("LocalTime Desktop Agent starting...")
    while True:
        app_name = get_frontmost_app()
        if app_name and app_name not in BROWSERS:
            cat = categorize_app(app_name)
            log_time(cat)
        time.sleep(5)

if __name__ == "__main__":
    main()
