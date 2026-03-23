"""Tests for the shared categorization module."""
import pytest
from categorization import categorize_activity, get_categories


class TestGetCategories:
    def test_returns_list(self):
        cats = get_categories()
        assert isinstance(cats, list)
        assert len(cats) > 0

    def test_expected_categories(self):
        cats = get_categories()
        assert "Productive (School & Career)" in cats
        assert "Distractions" in cats


class TestCategorizeActivity:
    # --- Distraction detection ---
    def test_youtube_is_distraction(self):
        assert categorize_activity("https://youtube.com/watch?v=123") == "Distractions"

    def test_instagram_is_distraction(self):
        assert categorize_activity("https://instagram.com/feed") == "Distractions"

    def test_spotify_app_is_distraction(self):
        assert categorize_activity("Spotify", is_app=True) == "Distractions"

    def test_messages_app_is_distraction(self):
        assert categorize_activity("Messages", is_app=True) == "Distractions"

    # --- Productive detection ---
    def test_vscode_is_productive(self):
        assert categorize_activity("Code", is_app=True) == "Productive (School & Career)"

    def test_terminal_is_productive(self):
        assert categorize_activity("Terminal", is_app=True) == "Productive (School & Career)"

    def test_google_docs_is_productive(self):
        assert categorize_activity("https://docs.google.com/document/d/abc") == "Productive (School & Career)"

    def test_canvas_is_productive(self):
        assert categorize_activity("https://claremont.instructure.com/canvas") == "Productive (School & Career)"

    # --- Environmental Justice ---
    def test_epa_is_ej(self):
        assert categorize_activity("https://epa.gov/air-quality") == "Environmental Justice Work"

    def test_climate_keyword_is_ej(self):
        assert categorize_activity("https://example.com/climate-action") == "Environmental Justice Work"

    # --- Rock Climbing ---
    def test_mountainproject_is_climbing(self):
        assert categorize_activity("https://mountainproject.com/route/123") == "Rock Climbing Logistics"

    # --- Default ---
    def test_unknown_url_is_distraction(self):
        assert categorize_activity("https://twitter.com/feed") == "Distractions"

    def test_unknown_app_is_distraction(self):
        assert categorize_activity("RandomGame", is_app=True) == "Distractions"

    # --- Case insensitivity ---
    def test_case_insensitive_app(self):
        assert categorize_activity("TERMINAL", is_app=True) == "Productive (School & Career)"

    def test_case_insensitive_url(self):
        assert categorize_activity("https://YOUTUBE.COM/watch") == "Distractions"
