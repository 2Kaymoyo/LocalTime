import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { getFirestore, doc, onSnapshot, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

const firebaseConfig = {
    apiKey: "YOUR_FIREBASE_API_KEY",
    authDomain: "YOUR_APP.firebaseapp.com",
    projectId: "YOUR_PROJECT_ID",
    storageBucket: "YOUR_APP.firebasestorage.app",
    messagingSenderId: "YOUR_SENDER_ID",
    appId: "1:YOUR_SENDER_ID:web:4e5e47899b69ef7c83bce5"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// --- NAVIGATION ---
const pages = ['pulse', 'timeline', 'settings'];
pages.forEach(p => {
    document.getElementById(`btn-${p}`).addEventListener('click', () => switchPage(p));
});

function switchPage(pageId) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(`page-${pageId}`).classList.add('active');
    document.getElementById(`btn-${pageId}`).classList.add('active');
    if (pageId === 'timeline') loadTimeline();
    if (pageId === 'settings') loadSettings();
}

// --- CORE LOGIC ---
const getTodayStr = () => new Date().toLocaleDateString('en-CA');

// Subscribe to today's log document — simple flat { Productive: X, Unproductive: Y }
try {
    onSnapshot(doc(db, "logs", getTodayStr()), (snapshot) => {
        let prod = 0, unprod = 0;
        if (snapshot.exists()) {
            const data = snapshot.data();
            prod = Math.round(data.Productive || 0);
            unprod = Math.round(data.Unproductive || 0);
        }
        const total = prod + unprod;
        const eff = total > 0 ? Math.round((prod / total) * 100) : 0;

        document.getElementById('tot-prod').innerText = `${prod}m`;
        document.getElementById('tot-dist').innerText = `${unprod}m`;
        document.getElementById('efficiency-score').innerText = `${eff}%`;

        const donut = document.getElementById('donut');
        donut.style.background = total > 0
            ? `conic-gradient(#5865F2 0% ${eff}%, #313244 ${eff}% 100%)`
            : '#313244';

        // Update document title for Electron tray display
        document.title = `${eff}%`;
    }, (err) => console.warn("Logs listener error:", err));
} catch (e) { console.warn("Could not attach logs listener:", e); }

// --- TIMELINE ---
async function loadTimeline() {
    const dates = [];
    for (let i = 6; i >= 0; i--) {
        let d = new Date();
        d.setDate(d.getDate() - i);
        dates.push(d.toLocaleDateString('en-CA'));
    }

    const container = document.getElementById('timeline-chart');
    container.innerHTML = `<div class="y-axis-group"><div class="y-axis-labels"><span>100%</span><span>75%</span><span>50%</span><span>25%</span><span>0%</span></div><div class="day-label" style="color:transparent;">--</div></div>`;

    for (const dStr of dates) {
        let eff = 0;
        try {
            const snap = await getDoc(doc(db, "logs", dStr));
            if (snap.exists()) {
                const data = snap.data();
                const prod = data.Productive || 0;
                const unprod = data.Unproductive || 0;
                const total = prod + unprod;
                eff = total > 0 ? Math.round((prod / total) * 100) : 0;
            }
        } catch (e) { console.error(e); }

        container.innerHTML += `
            <div class="bar-group">
                <div class="bar-container">
                    <div class="bar general" style="height: ${eff}%;" title="${eff}%"></div>
                </div>
                <div class="day-label">${dStr.slice(-5)}</div>
            </div>`;
    }
}

// --- SETTINGS ---
let localRules = { domains: [], keywords: [] };
const defaultRules = { domains: ["docs.google.com", "drive.google.com", "mail.google.com"], keywords: ["internship"] };

async function loadSettings() {
    try {
        const snap = await getDoc(doc(db, "config", "rules"));
        if (snap.exists()) {
            localRules = snap.data();
            // Ensure both fields exist
            if (!localRules.domains) localRules.domains = [];
            if (!localRules.keywords) localRules.keywords = [];
        } else {
            localRules = JSON.parse(JSON.stringify(defaultRules));
            try { await setDoc(doc(db, "config", "rules"), localRules); } catch (e2) { }
        }
    } catch (e) {
        console.warn("Using default rules", e);
        localRules = JSON.parse(JSON.stringify(defaultRules));
    }
    renderRules();
}

function renderRules() {
    // Domains
    const domainList = document.getElementById('domain-list');
    domainList.innerHTML = '';
    localRules.domains.forEach((d, i) => {
        domainList.innerHTML += `<div class="rule-tag">${d} <button onclick="removeRule('domains', ${i})">&times;</button></div>`;
    });

    // Keywords
    const keywordList = document.getElementById('keyword-list');
    keywordList.innerHTML = '';
    localRules.keywords.forEach((k, i) => {
        keywordList.innerHTML += `<div class="rule-tag">${k} <button onclick="removeRule('keywords', ${i})">&times;</button></div>`;
    });
}

window.removeRule = function (type, idx) {
    localRules[type].splice(idx, 1);
    document.getElementById('save-rules').disabled = false;
    renderRules();
}

window.addRule = function (type) {
    const input = document.getElementById(`input-${type}`);
    const val = input.value.trim().toLowerCase();
    if (val && !localRules[type].includes(val)) {
        localRules[type].push(val);
        input.value = '';
        document.getElementById('save-rules').disabled = false;
        renderRules();
    }
}

window.handleEnter = function (e, type) {
    if (e.key === 'Enter') window.addRule(type);
}

document.getElementById('save-rules').addEventListener('click', async () => {
    const btn = document.getElementById('save-rules');
    btn.innerText = "Saving...";
    btn.disabled = true;
    try {
        await setDoc(doc(db, "config", "rules"), localRules);
        btn.innerText = "Save Configuration";
        const msg = document.getElementById('save-msg');
        msg.style.display = 'block';
        setTimeout(() => msg.style.display = 'none', 3000);
    } catch (e) {
        console.error("Save error", e);
        btn.innerText = "Error — Retry";
        btn.style.background = "#F04747";
        btn.disabled = false;
    }
});
