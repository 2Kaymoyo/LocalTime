# LocalTime

A productivity tracking suite for macOS that monitors your time across desktop apps and the browser, with a real-time overlay dashboard and menu bar widget.

## Project Structure

```
LocalTime/
├── Browser_Tracker/     # Chrome extension — logs active tab activity to Firestore
├── Dashboard_App/       # Electron desktop dashboard app
├── MenuBarApp/          # macOS menu bar tray app (shows efficiency %)
├── public/              # Firebase-hosted web dashboard
├── overlay.py           # Always-on-top tkinter overlay dashboard
├── tracker.py           # Core tracking engine & local HTTP API (port 5050)
├── desktop_agent.py     # Background agent — logs frontmost app to Firestore
├── app.py               # PyWebView launcher (tracker + dashboard in one window)
├── install_agent.sh     # One-line installer for the desktop agent
├── com.localtime.agent.plist  # macOS LaunchAgent for auto-start
├── firebase.json        # Firebase project config
└── firestore.rules      # Firestore security rules
```

---

## Quick Start — Running the Overlay

The overlay is a floating, always-on-top dashboard that shows your productivity stats in real time. It requires two things running: the **tracking engine** and the **overlay window**.

### 1. Install Dependencies

```bash
pip3 install pynput
```

> **Note:** The overlay uses `tkinter` (included with macOS Python) and `pynput` for the global hotkey.

### 2. Start the Tracking Engine

The tracker runs a local HTTP server on port **5050** that monitors your frontmost app and categorizes time:

```bash
cd /Users/wilbmoffitt/Desktop/LocalTime
python3 tracker.py
```

You should see: `Time Engine Active with Distraction Overrides...`

### 3. Launch the Overlay

In a **separate terminal window**:

```bash
cd /Users/wilbmoffitt/Desktop/LocalTime
python3 overlay.py
```

The overlay window will appear with three pages:
- **Pulse** — Live focus/distraction timers, category breakdown bars, and efficiency donut chart
- **Trends** — 7-day stacked bar chart of activity by category
- **Timeline** — Day-over-day comparison and recent session history

### 4. Toggle Visibility

Press **Shift + Ctrl + T** to hide/show the overlay at any time. The tracking engine continues running in the background.

### 5. Sessions

Click **START SESSION** on the Pulse page to begin a tracked focus session. Click **STOP SESSION** to end it. Session data (duration, efficiency) is saved and visible on the Timeline page.

---

## Running the Desktop Agent (Firestore Logging)

The desktop agent runs independently and logs your active app to **Firestore** every 5 seconds, enabling the web and menu bar dashboards.

### Quick Start

```bash
cd /Users/wilbmoffitt/Desktop/LocalTime
bash install_agent.sh
```

This will:
- Kill any existing agent process
- Start `desktop_agent.py` in the background
- Add it to your crontab so it auto-starts on reboot

### Manual Start

```bash
python3 desktop_agent.py
```

### Auto-Start via LaunchAgent (alternative)

```bash
cp com.localtime.agent.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.localtime.agent.plist
```

---

## Browser Extension (Chrome)

1. Open `chrome://extensions/` and enable **Developer mode**
2. Click **Load unpacked** and select the `Browser_Tracker/` folder
3. The extension will automatically log your active tab to Firestore

---

## Menu Bar App

```bash
cd MenuBarApp
npm install
npm start
```

Shows your real-time efficiency percentage in the macOS menu bar.

---

## Dashboard App (Electron)

```bash
cd Dashboard_App
npm install
npm start
```

Full desktop dashboard window with analytics.

---

## Web Dashboard

Deployed to Firebase Hosting. The source files are in `public/`.

```bash
firebase deploy --only hosting
```

---

## Activity Categories

The tracker categorizes your time into:
- **Productive (School & Career)** — Code editors, terminals, Zoom, documents
- **Environmental Justice Work** — Specialized project apps
- **Rock Climbing Logistics** — Planning/logistics tools
- **Distractions** — Everything else

Categories are configured in `tracker.py`. The Firestore-based agent (`desktop_agent.py`) fetches categorization rules from a `config/rules` document in Firestore, with a 5-minute cache.
