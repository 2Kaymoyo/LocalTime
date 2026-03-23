"""Shared categorization logic for LocalTime tracking."""
import json
import os

_config = None
_config_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "categories.json")


def _load_config():
    global _config
    if _config is None:
        with open(_config_path, "r") as f:
            _config = json.load(f)
    return _config


def get_categories():
    """Return the list of category names."""
    return _load_config()["categories"]


def categorize_activity(item, is_app=False):
    """Categorize an app name or URL into one of the configured categories.

    Args:
        item: App name or URL string.
        is_app: True if item is an app name, False if it's a URL.

    Returns:
        Category string.
    """
    cfg = _load_config()
    lower = item.lower()

    # 1. Distraction override (highest priority)
    if is_app:
        if any(k in lower for k in cfg["distraction_apps"]):
            return "Distractions"
    else:
        if any(k in lower for k in cfg["distraction_urls"]):
            return "Distractions"

    # 2. Productivity checks
    if is_app:
        if any(k in lower for k in cfg["productive_apps"]):
            return "Productive (School & Career)"
    else:
        if any(k in lower for k in cfg["productive_urls"]):
            return "Productive (School & Career)"
        elif any(k in lower for k in cfg["ej_urls"]):
            return "Environmental Justice Work"
        elif any(k in lower for k in cfg["climbing_urls"]):
            return "Rock Climbing Logistics"

    return "Distractions"
