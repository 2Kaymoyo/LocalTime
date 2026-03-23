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
        console.log("Fetching rules from:", `${BASE_URL}/config/rules?key=${API_KEY}`);
        const response = await fetch(`${BASE_URL}/config/rules?key=${API_KEY}`);
        if (!response.ok) {
            console.error("Fetch returned non-OK status:", response.status, response.statusText);
            return cachedRules || { domains: [], keywords: [] };
        }

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
        console.error("Failed to fetch rules.");
        console.error("URL:", `${BASE_URL}/config/rules?key=${API_KEY}`);
        console.error("Error Message:", err.message);
        console.error("Error Name:", err.name);
        console.error("Full Error:", err);
        return cachedRules || { domains: [], keywords: [] };
    }
}

const ACTIVITY_KEYS = ['academic', 'professional', 'ejEducation', 'vpSustainability', 'ejCampaign'];
const ACTIVITY_LOG_FIELDS = {
    ejEducation: 'EJEducation',
    ejCampaign: 'EJCampaign',
    vpSustainability: 'VPSustainability',
    professional: 'Professional',
    academic: 'Academic'
};

let cachedTimeBudgetRules = null;
let lastTimeBudgetFetch = 0;

async function fetchTimeBudgetRules() {
    const now = Date.now();
    if (cachedTimeBudgetRules && (now - lastTimeBudgetFetch < 5 * 60 * 1000)) return cachedTimeBudgetRules;
    try {
        const res = await fetch(`${BASE_URL}/config/timeBudget?key=${API_KEY}`);
        if (!res.ok) return null;
        const data = await res.json();
        const ar = data?.fields?.activityRules?.mapValue?.fields;
        if (!ar) return null;
        const out = {};
        ACTIVITY_KEYS.forEach(k => {
            const act = ar[k]?.mapValue?.fields;
            if (!act) return;
            const arr = (f) => (act[f]?.arrayValue?.values || []).map(v => v.stringValue || '');
            out[k] = { domains: arr('domains'), keywords: arr('keywords'), apps: arr('apps') };
        });
        cachedTimeBudgetRules = Object.keys(out).length ? out : null;
        lastTimeBudgetFetch = now;
        return cachedTimeBudgetRules;
    } catch (e) {
        return null;
    }
}

function categorizeUrl(url, rules) {
    const lowerUrl = url.toLowerCase();
    if (rules.domains.some(d => lowerUrl.includes(d.toLowerCase()))) return "Productive";
    if (rules.keywords.some(k => lowerUrl.includes(k.toLowerCase()))) return "Productive";
    return "Unproductive";
}

async function categorizeUrlWithActivities(url) {
    const tbRules = await fetchTimeBudgetRules();
    if (tbRules) {
        const lowerUrl = url.toLowerCase();
        for (const [actKey, r] of Object.entries(tbRules)) {
            if (r.domains?.some(d => lowerUrl.includes(d.toLowerCase()))) return ACTIVITY_LOG_FIELDS[actKey];
            if (r.keywords?.some(k => lowerUrl.includes(k.toLowerCase()))) return ACTIVITY_LOG_FIELDS[actKey];
        }
    }
    const rules = await fetchRules();
    return categorizeUrl(url, rules);
}

// --- LOGGING ---
async function logTime(category) {
    const today = new Date().toLocaleDateString('en-CA');
    const inc = 5.0 / 60.0;
    const docUrl = `${BASE_URL}/logs/${today}?key=${API_KEY}`;

    let current = {};
    try {
        const getRes = await fetch(docUrl);
        if (getRes.ok) {
            const doc = await getRes.json();
            if (doc.fields) {
                for (const [k, v] of Object.entries(doc.fields)) {
                    if (v.doubleValue != null) current[k] = v.doubleValue;
                    else if (v.integerValue != null) current[k] = parseFloat(v.integerValue);
                }
            }
        }
    } catch (e) { /* ignore */ }

    const payload = { fields: {} };
    const mask = [category];
    payload.fields[category] = { doubleValue: (current[category] || 0) + inc };

    if (Object.values(ACTIVITY_LOG_FIELDS).includes(category)) {
        payload.fields.Productive = { doubleValue: (current.Productive || 0) + inc };
        mask.push('Productive');
    } else if (category === 'Unproductive') {
        payload.fields.Unproductive = { doubleValue: (current.Unproductive || 0) + inc };
        mask.push('Unproductive');
    }

    try {
        await fetch(`${docUrl}&${mask.map(f => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join('&')}`, {
            method: 'PATCH',
            body: JSON.stringify(payload),
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (err) {
        console.error("Failed to log time", err);
    }
}

// --- TRACKING LOOP ---
setInterval(async () => {
    try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs.length > 0 && tabs[0].url) {
            const url = tabs[0].url;
            if (url.startsWith('chrome://') || url.startsWith('edge://') || url.startsWith('about:')) return;

            const category = await categorizeUrlWithActivities(url);
            await logTime(category);
        }
    } catch (e) {
        console.error("Tracker error:", e.message, e);
    }
}, 5000);