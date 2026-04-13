# LocalTime

A macOS menu bar app that tracks how you spend time across desktop apps and browser tabs, categorizes your activity, and helps you stay focused.

**What you get:**
- A menu bar dashboard with daily stats, calendar, tasks, and an AI assistant
- Automatic tracking of which apps and websites you use
- A Chrome extension that categorizes your browsing in real time
- Keyboard shortcuts to pull up your dashboard instantly

---

## Prerequisites

Before you start, make sure you have these installed on your Mac:

### 1. Python 3

Open **Terminal** (search for it in Spotlight with Cmd+Space) and type:

```bash
python3 --version
```

If you see a version number (e.g. `Python 3.10.0`), you're good. If not, install it:

```bash
brew install python
```

Don't have Homebrew? Install it first by pasting this into Terminal:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

### 2. Node.js and npm

Check if you have Node:

```bash
node --version
```

If not installed:

```bash
brew install node
```

### 3. Google Chrome

Needed for the browser tracking extension. Download from [google.com/chrome](https://www.google.com/chrome/) if you don't have it.

---

## Setup (Step by Step)

### Step 1: Download the project

If you received this as a zip file, unzip it and move the folder to your Desktop. The rest of this guide assumes it's at `~/Desktop/LocalTime`.

If you're cloning from GitHub:

```bash
cd ~/Desktop
git clone <repo-url> LocalTime
cd LocalTime
```

### Step 2: Set up your API keys

LocalTime uses Firebase to store your data in the cloud. You'll need your own Firebase project.

1. Go to [console.firebase.google.com](https://console.firebase.google.com/)
2. Click **Add project** and follow the prompts
3. Once created, click the gear icon > **Project settings**
4. Scroll down to **Your apps** > click the web icon (`</>`) to add a web app
5. Copy the config values it shows you

Now set them up in two places:

**a) Create your `.env` file:**

```bash
cd ~/Desktop/LocalTime/MenuBarApp
cp ../.env.example .env
```

Open the new `.env` file in any text editor and fill in your keys:

```
FIREBASE_API_KEY=your-key-here
FIREBASE_AUTH_DOMAIN=your-app.firebaseapp.com
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_STORAGE_BUCKET=your-app.firebasestorage.app
FIREBASE_MESSAGING_SENDER_ID=your-sender-id
FIREBASE_APP_ID=your-app-id
```

You'll also need these if you want Notion, Gemini AI, or Spotify integrations (optional):

```
NOTION_TOKEN=your-notion-token
NOTION_DATABASE_ID=your-database-id
GEMINI_API_KEY=your-gemini-key
```

**b) Update the Firebase config in code:**

Open `MenuBarApp/app.js` and replace the placeholder values near the top:

```js
const firebaseConfig = {
    apiKey: "YOUR_FIREBASE_API_KEY",        // <-- paste your real values
    authDomain: "YOUR_APP.firebaseapp.com",
    projectId: "YOUR_PROJECT_ID",
    storageBucket: "YOUR_APP.firebasestorage.app",
    messagingSenderId: "YOUR_SENDER_ID",
    appId: "YOUR_APP_ID"
};
```

Do the same in `Browser_Tracker/firebase-config.js`.

### Step 3: Set up Firestore

In the Firebase console:

1. Go to **Build > Firestore Database**
2. Click **Create database**
3. Choose **Start in test mode** (you can lock it down later)
4. Select a region close to you

### Step 4: Install the menu bar app

```bash
cd ~/Desktop/LocalTime/MenuBarApp
npm install
```

### Step 5: Install the Chrome extension

1. Open Chrome and go to `chrome://extensions`
2. Turn on **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Navigate to `~/Desktop/LocalTime/Browser_Tracker` and select the folder
5. You should see "LocalTime Tracker" appear in your extensions list

### Step 6: Grant macOS permissions

LocalTime needs to know which app is in the foreground. macOS will prompt you to allow this, but you can also do it ahead of time:

1. Open **System Settings > Privacy & Security > Accessibility**
2. Click the `+` button and add **Terminal** (or whatever terminal app you use)

---

## Running LocalTime

### Start the menu bar app

```bash
cd ~/Desktop/LocalTime/MenuBarApp
npm start
```

You should see a small percentage indicator appear in your menu bar. Click it to open the dashboard.

### Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| Ctrl + Shift + T | Show/hide the dashboard |
| Ctrl + Shift + A | Open the AI assistant |

### Run the standalone overlay (optional)

If you just want the desktop overlay without the full Electron app:

```bash
cd ~/Desktop/LocalTime
python3 overlay.py
```

Toggle it with **Shift + Ctrl + T**.

---

## Auto-start on login (optional)

If you want LocalTime to track automatically every time you turn on your Mac:

```bash
cd ~/Desktop/LocalTime
bash install_agent.sh
```

This starts the background tracker and sets it to launch on reboot.

---

## Project structure

```
LocalTime/
├── MenuBarApp/          # The main Electron menu bar app
│   ├── main.js          # App entry point
│   ├── app.js           # Dashboard logic
│   ├── index.html       # Dashboard UI
│   └── package.json     # Node dependencies
├── Browser_Tracker/     # Chrome extension for tab tracking
│   ├── background.js    # Runs every 5 seconds, categorizes tabs
│   ├── firebase-config.js
│   └── manifest.json
├── tracker.py           # Local HTTP server that logs app activity
├── desktop_agent.py     # Background daemon that syncs to Firebase
├── overlay.py           # Standalone desktop overlay dashboard
├── categorization.py    # Rules for sorting apps into categories
├── categories.json      # Category definitions
├── .env.example         # Template for required API keys
└── install_agent.sh     # Sets up auto-start on login
```

---

## Troubleshooting

**"python3: command not found"**
Install Python with `brew install python`, then restart your terminal.

**"npm: command not found"**
Install Node.js with `brew install node`, then restart your terminal.

**The menu bar icon doesn't appear**
Make sure you're running `npm start` from inside the `MenuBarApp/` folder, not the root.

**Chrome extension isn't tracking**
- Check that you updated the Firebase config in `Browser_Tracker/firebase-config.js`
- Make sure the extension is enabled at `chrome://extensions`
- Check the extension's "Errors" section for any issues

**"Permission denied" or tracking doesn't work**
Go to System Settings > Privacy & Security > Accessibility and make sure your terminal app is listed and checked.

**App crashes on start**
Check that your `.env` file exists in `MenuBarApp/` and has valid API keys. Look at the terminal output for error messages.
