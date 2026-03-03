# LocalTime

A productivity tracking suite that monitors your time usage across desktop and browser, with a real-time dashboard and menu bar app.

## Project Structure

```
LocalTime/
├── Browser_Tracker/    # Chrome extension for tracking browser activity
├── Dashboard_App/      # Electron desktop dashboard app
├── MenuBarApp/         # macOS menu bar app (shows efficiency %)
├── public/             # Firebase-hosted web dashboard
├── functions/          # Firebase Cloud Functions
├── desktop_agent.py    # Desktop activity tracking agent
├── tracker.py          # Core time tracking logic
├── overlay.py          # Desktop overlay UI
├── app.py              # Flask API server
├── firebase.json       # Firebase project config
├── firestore.rules     # Firestore security rules
└── install_agent.sh    # Agent installation script
```

## Components

- **Browser Tracker** — Chrome extension that logs active tab URLs and time spent to Firestore
- **Dashboard App** — Electron app displaying time usage analytics
- **Menu Bar App** — macOS tray app showing real-time efficiency percentage
- **Desktop Agent** — Python background service tracking active application usage
- **Web Dashboard** — Firebase-hosted dashboard accessible from any browser
