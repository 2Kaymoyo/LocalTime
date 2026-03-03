import { firebaseConfig } from './firebase-config.js';

const PROJECT_ID = firebaseConfig.projectId;
const API_KEY = firebaseConfig.apiKey;
const BASE_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

let cachedRules = null;
let lastRulesFetch = 0;

// --- RULES ---
async function fetchRules() {
    const now = Date.now();
    if (cachedRules && (now - lastRulesFetch < 5 * 60 * 1000)) return cachedRules;

    try {
        const response = await fetch(`${BASE_URL}/config/rules?key=${API_KEY}`);
        if (!response.ok) return cachedRules || { domains: [], keywords: [] };

        const data = await response.json();
        const rules = { domains: [], keywords: [] };

        if (data.fields) {
            if (data.fields.domains?.arrayValue?.values) {
                rules.domains = data.fields.domains.arrayValue.values.map(v => v.stringValue);
            }
            if (data.fields.keywords?.arrayValue?.values) {
                rules.keywords = data.fields.keywords.arrayValue.values.map(v => v.stringValue);
            }
        }
        cachedRules = rules;
        lastRulesFetch = now;
        return rules;
    } catch (err) {
        console.error("Failed to fetch rules", err);
        return cachedRules || { domains: [], keywords: [] };
    }
}

function categorizeUrl(url, rules) {
    const lowerUrl = url.toLowerCase();

    // Check domains
    if (rules.domains.some(d => lowerUrl.includes(d.toLowerCase()))) return "Productive";
    // Check keywords
    if (rules.keywords.some(k => lowerUrl.includes(k.toLowerCase()))) return "Productive";

    return "Unproductive";
}

// --- LOGGING ---
async function logTime(category) {
    const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD
    const incrementAmount = 5.0 / 60.0; // 5 seconds in minutes

    // We write a simple flat document: { Productive: X, Unproductive: Y }
    // Using Firestore REST API PATCH with updateMask to increment
    const docUrl = `${BASE_URL}/logs/${today}?key=${API_KEY}`;

    // First, try to read the current doc
    let currentVal = 0;
    try {
        const getRes = await fetch(docUrl);
        if (getRes.ok) {
            const doc = await getRes.json();
            if (doc.fields && doc.fields[category]) {
                currentVal = doc.fields[category].doubleValue || 0;
            }
        }
    } catch (e) { /* doc doesn't exist yet, that's fine */ }

    // Write the incremented value
    const newVal = currentVal + incrementAmount;
    const patchBody = {
        fields: {
            [category]: { doubleValue: newVal }
        }
    };

    try {
        await fetch(`${docUrl}&updateMask.fieldPaths=${category}`, {
            method: 'PATCH',
            body: JSON.stringify(patchBody),
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (err) {
        console.error("Failed to log time", err);
    }
}

// --- TRACKING LOOP ---
// chrome.alarms minimum is 1 minute; we use setInterval for 5-second precision
setInterval(async () => {
    try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs.length > 0 && tabs[0].url) {
            const url = tabs[0].url;
            if (url.startsWith('chrome://') || url.startsWith('edge://') || url.startsWith('about:')) return;

            const rules = await fetchRules();
            const category = categorizeUrl(url, rules);
            await logTime(category);
        }
    } catch (e) {
        console.error("Tracker error:", e);
    }
}, 5000);