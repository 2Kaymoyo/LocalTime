#!/usr/bin/env python3
"""LocalTime Desktop Agent — tracks frontmost macOS app and logs to Firestore via curl."""
import time, json, subprocess
from datetime import datetime

import os
PROJECT_ID = os.environ.get("FIREBASE_PROJECT_ID", "localtime-cloud-wm")
API_KEY = os.environ.get("FIREBASE_API_KEY", "")
if not API_KEY:
    raise RuntimeError("FIREBASE_API_KEY environment variable is required")
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

ACTIVITY_KEYS = ["academic", "professional", "ejEducation", "vpSustainability", "ejCampaign"]
ACTIVITY_LOG_FIELDS = {
    "ejEducation": "EJEducation",
    "ejCampaign": "EJCampaign",
    "vpSustainability": "VPSustainability",
    "professional": "Professional",
    "academic": "Academic",
}

def fetch_rules():
    global cached_rules, last_rules_fetch
    now = time.time()
    if cached_rules and now - last_rules_fetch < 300:
        return cached_rules

    data = curl_get(f"{BASE_URL}/config/rules?key={API_KEY}")
    if data and "fields" in data:
        rules = {"domains": [], "keywords": [], "apps": []}
        for field in ["domains", "keywords", "apps"]:
            if field in data["fields"]:
                av = data["fields"][field].get("arrayValue", {})
                rules[field] = [v["stringValue"] for v in av.get("values", [])]
        cached_rules = rules
        last_rules_fetch = now

    if not cached_rules:
        cached_rules = {"domains": [], "keywords": [], "apps": ["Code", "Terminal", "Zoom", "Notes", "Preview"]}
    return cached_rules

def fetch_time_budget_rules():
    """Fetch activityRules from config/timeBudget for per-category logging."""
    data = curl_get(f"{BASE_URL}/config/timeBudget?key={API_KEY}")
    if not data or "fields" not in data:
        return None
    ar = data.get("fields", {}).get("activityRules", {}).get("mapValue", {}).get("fields", {})
    if not ar:
        return None
    out = {}
    for k in ACTIVITY_KEYS:
        act = ar.get(k, {}).get("mapValue", {}).get("fields", {})
        if not act:
            continue
        def arr(field):
            return [v["stringValue"] for v in act.get(field, {}).get("arrayValue", {}).get("values", [])]
        out[k] = {"domains": arr("domains"), "keywords": arr("keywords"), "apps": arr("apps")}
    return out if out else None

def categorize_app(app_name):
    # Try time budget activity rules first (per-category)
    tb_rules = fetch_time_budget_rules()
    if tb_rules:
        lower = app_name.lower()
        for act_key, rules in tb_rules.items():
            if any((a.lower() == lower for a in rules.get("apps", []))):
                return ACTIVITY_LOG_FIELDS[act_key]
            if any((k.lower() in lower for k in rules.get("keywords", []))):
                return ACTIVITY_LOG_FIELDS[act_key]
        # domains apply to URLs, not apps; skip for desktop

    # Fallback to legacy config/rules
    rules = fetch_rules()
    lower = app_name.lower()
    if any(a.lower() == lower for a in rules.get("apps", [])):
        return "Productive"
    if any(k.lower() in lower for k in rules.get("keywords", [])):
        return "Productive"
    return "Unproductive"

def log_time(category):
    today = datetime.now().strftime("%Y-%m-%d")
    doc_url = f"{BASE_URL}/logs/{today}?key={API_KEY}"
    inc = 5.0 / 60.0

    data = curl_get(doc_url)
    fields = (data or {}).get("fields", {})

    def get_val(name):
        f = (fields or {}).get(name, {})
        if f.get("doubleValue") is not None:
            return float(f["doubleValue"])
        if f.get("integerValue") is not None:
            return float(f["integerValue"])
        return 0.0

    new_category_val = get_val(category) + inc
    payload = {"fields": {category: {"doubleValue": new_category_val}}}
    mask_parts = [category]

    # When category is one of the 5 activities, also increment Productive
    if category in ACTIVITY_LOG_FIELDS.values():
        new_prod = get_val("Productive") + inc
        payload["fields"]["Productive"] = {"doubleValue": new_prod}
        mask_parts.append("Productive")
    elif category == "Unproductive":
        new_unprod = get_val("Unproductive") + inc
        payload["fields"]["Unproductive"] = {"doubleValue": new_unprod}
        mask_parts.append("Unproductive")

    patch_url = doc_url + "&" + "&".join(f"updateMask.fieldPaths={f}" for f in mask_parts)
    curl_patch(patch_url, payload)

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
