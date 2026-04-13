import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { getFirestore, doc, onSnapshot, getDoc, setDoc, updateDoc, increment } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

// See .env.example for required Firebase configuration values
const firebaseConfig = {
    apiKey: "YOUR_FIREBASE_API_KEY",
    authDomain: "YOUR_APP.firebaseapp.com",
    projectId: "YOUR_PROJECT_ID",
    storageBucket: "YOUR_APP.firebasestorage.app",
    messagingSenderId: "YOUR_SENDER_ID",
    appId: "YOUR_APP_ID"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// --- CORE HELPERS ---
const getTodayStr = () => new Date().toLocaleDateString('en-CA');

// --- NAVIGATION ---
let currentEffScore = "0%";
if (window.electronAPI) {
    window.electronAPI.onShowAssistant(() => {
        switchPage('pulse');
        setTimeout(() => document.getElementById('chat-input').focus(), 100);
    });
}

const pages = ['pulse', 'internships', 'tasks', 'calendar', 'settings'];
pages.forEach(p => {
    document.getElementById(`btn-${p}`).addEventListener('click', () => switchPage(p));
});

function switchPage(pageId) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(`page-${pageId}`).classList.add('active');
    document.getElementById(`btn-${pageId}`).classList.add('active');
    if (pageId === 'tasks') {
        // Show cached immediately, refresh in background
        if (cachedTasks.length) { renderTasks(); loadTasks(); }
        else loadTasks();
    }
    if (pageId === 'internships') loadInternships();
    if (pageId === 'calendar') initCalendar();
    if (pageId === 'settings') loadSettings();
    if (pageId === 'pulse') {
        if (typeof renderTimeBudgetDonuts === 'function') renderTimeBudgetDonuts();
        if (typeof updateActivityTimerDisplay === 'function') updateActivityTimerDisplay();
        if (typeof renderCategoryTasks === 'function') renderCategoryTasks();
    }
}

// Ensure today's logs doc exists so background trackers can PATCH (they fail on non-existent docs)
getDoc(doc(db, "logs", getTodayStr())).then(snap => {
    if (!snap.exists()) setDoc(doc(db, "logs", getTodayStr()), {}).catch(() => {});
}).catch(() => {});

// Preload data in background on startup
setTimeout(() => {
    loadTasks();
    loadInternships();
    loadChatHistory();
    initCalendar();
}, 1000);

// --- CORE LOGIC ---
let lastLogsData = {};

// --- TIME BUDGET (must be defined before listeners that call renderTimeBudgetDonuts) ---
const allocationExpandedRows = new Set();
const ACTIVITY_KEYS = ['academic', 'professional', 'ejEducation', 'vpSustainability', 'ejCampaign'];
const ACTIVITY_LABELS = { ejEducation: 'EJ Education', ejCampaign: 'EJ Campaign', vpSustainability: 'VP Sustainability', professional: 'Professional', academic: 'Academic' };
const ACTIVITY_COLORS = { ejEducation: '#43b581', ejCampaign: '#F04747', vpSustainability: '#FAA61A', professional: '#9ca3af', academic: '#5865F2' };
const ACTIVITY_LOG_FIELDS = { ejEducation: 'EJEducation', ejCampaign: 'EJCampaign', vpSustainability: 'VPSustainability', professional: 'Professional', academic: 'Academic' };
const ACTIVITY_TAG_MAP = {
    academic: ['Environmental Law 2', 'Principles of Microeconomics', 'Power Justice and the Environment', 'Modern Political Theory'],
    vpSustainability: ['Student Senate'],
    ejEducation: ['EJ Education'],
    ejCampaign: ['EJ Campaign'],
    professional: ['Internship/Study Abroad', 'Personal']
};
function defaultMinutesPerDay() { const o = {}; for (let d = 0; d < 7; d++) o[d] = 60; return o; }
function defaultActivityRules() { const o = {}; ACTIVITY_KEYS.forEach(k => { o[k] = { domains: [], keywords: [], apps: [] }; }); return o; }
const defaultTimeBudget = {
    activities: {},
    currentFocus: 'none',
    freeTimePerDay: { 0: 480, 1: 420, 2: 450, 3: 450, 4: 450, 5: 480, 6: 480 },
    sleepPerDay: { 0: 480, 1: 480, 2: 480, 3: 480, 4: 480, 5: 480, 6: 480 },
    useCalendarForMeetings: true,
    calendarSources: { iCalUrl: '', gcalNames: ['Extracurriculars', 'Work'], manualMinutesPerDay: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 } },
    activityRules: defaultActivityRules()
};
ACTIVITY_KEYS.forEach(k => { defaultTimeBudget.activities[k] = { color: ACTIVITY_COLORS[k], minutesPerDay: defaultMinutesPerDay() }; });
let localTimeBudget = JSON.parse(JSON.stringify(defaultTimeBudget));
function mergeTimeBudget(defaults, data) {
    const out = JSON.parse(JSON.stringify(defaults));
    if (data?.activities && typeof data.activities === 'object') {
        ACTIVITY_KEYS.forEach(k => {
            if (data.activities[k]) {
                out.activities[k] = { ...out.activities[k], ...data.activities[k] };
                if (data.activities[k].minutesPerDay) out.activities[k].minutesPerDay = { ...out.activities[k].minutesPerDay, ...data.activities[k].minutesPerDay };
            }
        });
    }
    if (data?.currentFocus != null) out.currentFocus = data.currentFocus;
    if (data?.freeTimePerDay) out.freeTimePerDay = { ...out.freeTimePerDay, ...data.freeTimePerDay };
    if (data?.sleepPerDay) out.sleepPerDay = { ...out.sleepPerDay, ...data.sleepPerDay };
    if (data?.useCalendarForMeetings != null) out.useCalendarForMeetings = data.useCalendarForMeetings;
    if (data?.calendarSources) {
        if (data.calendarSources.iCalUrl != null) out.calendarSources.iCalUrl = data.calendarSources.iCalUrl;
        if (Array.isArray(data.calendarSources.gcalNames)) out.calendarSources.gcalNames = data.calendarSources.gcalNames;
        if (data.calendarSources.manualMinutesPerDay) out.calendarSources.manualMinutesPerDay = { ...out.calendarSources.manualMinutesPerDay, ...data.calendarSources.manualMinutesPerDay };
    }
    if (data?.activityRules) {
        ACTIVITY_KEYS.forEach(k => {
            if (data.activityRules[k]) out.activityRules[k] = { domains: data.activityRules[k].domains || [], keywords: data.activityRules[k].keywords || [], apps: data.activityRules[k].apps || [] };
        });
    }
    return out;
}

// Subscribe to today's log document — simple flat { Productive: X, Unproductive: Y } + per-category
try {
    onSnapshot(doc(db, "logs", getTodayStr()), (snapshot) => {
        try {
            let prod = 0, unprod = 0;
            const data = snapshot.exists() ? snapshot.data() : {};
            lastLogsData = data;
            prod = Math.round(Number(data.Productive) || 0);
            unprod = Math.round(Number(data.Unproductive) || 0);
            const total = prod + unprod;
            const eff = total > 0 ? Math.round((prod / total) * 100) : 0;

            const totProdEl = document.getElementById('tot-prod');
            const totDistEl = document.getElementById('tot-dist');
            const effEl = document.getElementById('efficiency-score');
            if (totProdEl) totProdEl.innerText = `${prod}m`;
            if (totDistEl) totDistEl.innerText = `${unprod}m`;
            if (effEl) effEl.innerText = `${eff}%`;

            const donut = document.getElementById('donut');
            if (donut) donut.style.background = total > 0
                ? `conic-gradient(#43b581 0% ${eff}%, #F04747 ${eff}% 100%)`
                : '#313244';

            currentEffScore = `${eff}%`;
            if (typeof activityTimerInterval === 'undefined' || !activityTimerInterval) {
                if (typeof updateActivityTimerDisplay === 'function') updateActivityTimerDisplay();
            }

            if (typeof renderTimeBudgetDonuts === 'function') renderTimeBudgetDonuts();
            if (typeof updateActivityTimerDisplay === 'function') updateActivityTimerDisplay();
        } catch (e) { console.error("Logs callback error:", e); }
    }, (err) => console.warn("Logs listener error:", err));
} catch (e) { console.warn("Could not attach logs listener:", e); }

// Subscribe to time budget config
try {
    onSnapshot(doc(db, "config", "timeBudget"), (snapshot) => {
        try {
            if (snapshot.exists() && typeof mergeTimeBudget === 'function') {
                localTimeBudget = mergeTimeBudget(defaultTimeBudget, snapshot.data());
            }
            if (typeof renderTimeBudgetDonuts === 'function') renderTimeBudgetDonuts();
            if (typeof updateActivityTimerDisplay === 'function') updateActivityTimerDisplay();
        } catch (e) { console.error("TimeBudget callback error:", e); }
    }, (err) => console.warn("TimeBudget listener error:", err));
} catch (e) { console.warn("Could not attach timeBudget listener:", e); }

// Deferred initial render in case Firestore is slow
setTimeout(() => {
    if (typeof renderTimeBudgetDonuts === 'function') renderTimeBudgetDonuts();
    if (typeof updateActivityTimerDisplay === 'function') updateActivityTimerDisplay();
    if (typeof renderCategoryTasks === 'function') renderCategoryTasks();
}, 300);

function renderTimeBudgetDonuts() {
    const container = document.getElementById('time-budget-donuts');
    if (!container) return;
    const dayOfWeek = new Date().getDay();
    const tb = localTimeBudget;
    container.innerHTML = '';
    const act = document.getElementById('activity-timer-select')?.value;
    const sessionBonus = (activityTimerState.running && !activityTimerState.isBreak && act) ? activityTimerState.workElapsed / 60 : 0;

    ACTIVITY_KEYS.forEach(k => {
        if (k === act) return;
        const allocated = tb.activities?.[k]?.minutesPerDay?.[dayOfWeek] ?? 60;
        const logField = ACTIVITY_LOG_FIELDS[k];
        let spent = Number(lastLogsData[logField]) || 0;
        const overtime = spent > allocated ? spent - allocated : 0;
        const color = ACTIVITY_COLORS[k];
        const donut = document.createElement('div');
        donut.className = 'chart-container';
        donut.style.cssText = 'width: 150px; height: 150px; background: #313244; border-radius: 50%; display: flex; align-items: center; justify-content: center; position: relative; margin: 0;';
        const inner = document.createElement('div');
        inner.style.cssText = 'width: 104px; height: 104px; background: #0f0f13; border-radius: 50%; display: flex; flex-direction: column; align-items: center; justify-content: center; z-index: 1;';
        inner.innerHTML = overtime > 0
            ? `<span style="font-size: 22px; font-weight: 800; color: #FAA61A;">+${Math.round(overtime)}m</span><span style="font-size: 11px; color: #949ba4;">${ACTIVITY_LABELS[k]}</span>`
            : `<span style="font-size: 22px; font-weight: 800;">${Math.max(0, Math.round(allocated - spent))}m</span><span style="font-size: 10px; color: #949ba4;">left</span><span style="font-size: 10px; color: #949ba4;">${ACTIVITY_LABELS[k]}</span>`;
        donut.appendChild(inner);
        const pctRemaining = allocated > 0 ? Math.max(0, 100 - (spent / allocated) * 100) : 100;
        donut.style.background = allocated > 0
            ? `conic-gradient(${color} 0% ${pctRemaining}%, #313244 ${pctRemaining}% 100%)`
            : '#313244';
        container.appendChild(donut);
    });
}

// --- CATEGORY TASKS PANEL ---
function renderCategoryTasks() {
    const act = document.getElementById('activity-timer-select')?.value;
    const list = document.getElementById('category-tasks-list');
    const addDiv = document.getElementById('category-tasks-add');
    const titleEl = document.getElementById('category-tasks-title');
    const countEl = document.getElementById('category-tasks-count');
    if (!list) return;

    if (!act) {
        if (titleEl) titleEl.textContent = 'TASKS';
        if (countEl) countEl.textContent = '';
        list.innerHTML = '<div style="color: #949ba4; text-align: center; padding: 60px 0; font-size: 14px;">Select an activity to see tasks</div>';
        if (addDiv) addDiv.style.display = 'none';
        return;
    }

    const tags = ACTIVITY_TAG_MAP[act] || [];
    const label = ACTIVITY_LABELS[act];
    if (titleEl) titleEl.textContent = `${label.toUpperCase()} TASKS`;

    const filtered = cachedTasks.filter(t =>
        t.tags && t.tags.some(tag => tags.some(mt => tag.toLowerCase() === mt.toLowerCase()))
    );

    if (countEl) countEl.textContent = `${filtered.length} task${filtered.length !== 1 ? 's' : ''}`;

    if (filtered.length === 0) {
        list.innerHTML = `<div style="color: #949ba4; text-align: center; padding: 40px 0; font-size: 14px;">No tasks for ${label}</div>`;
    } else {
        list.innerHTML = '';
        const sorted = [...filtered].sort((a, b) => {
            if (!a.dueDate && !b.dueDate) return 0;
            if (!a.dueDate) return 1;
            if (!b.dueDate) return -1;
            return a.dueDate.localeCompare(b.dueDate);
        });
        sorted.forEach(t => list.appendChild(createCategoryTaskCard(t)));
    }

    if (addDiv) addDiv.style.display = 'block';
    const tagSelect = document.getElementById('category-task-tag');
    if (tagSelect) {
        tagSelect.innerHTML = '';
        tags.forEach(tag => {
            const opt = document.createElement('option');
            opt.value = tag;
            opt.textContent = tag;
            tagSelect.appendChild(opt);
        });
    }
}

function categoryLinkify(text) {
    if (!text) return { display: '', obsidianUrl: null };
    const match = text.match(/(obsidian:\/\/[^\s"'<]+)/);
    const obsidianUrl = match ? match[1] : null;
    const display = text.replace(/(obsidian:\/\/[^\s"'<]+)/g, '').trim() || 'Untitled';
    const escaped = display.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return { display: escaped, obsidianUrl };
}

function createCategoryTaskCard(t) {
    const statusClass = t.status === 'In Progress' ? 'in-progress' : 'todo';
    const due = t.dueDate ? `<span style="font-size: 11px; color: #949ba4;">📅 ${t.dueDate}</span>` : '';
    const tagsHtml = (t.tags || []).map(tag =>
        `<span style="background:rgba(88,101,242,0.15);color:#7b83eb;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:bold;">${tag}</span>`
    ).join('');

    const { display: nameHtml, obsidianUrl } = categoryLinkify(t.name);
    const obsidianBtn = obsidianUrl
        ? `<a href="${obsidianUrl}" class="obsidian-link" style="color:#A882FF; text-decoration:none; font-weight:bold; background:rgba(168,130,255,0.15); padding:1px 6px; border-radius:3px; font-size:10px; cursor:pointer;">🔮 Obsidian</a>`
        : '';

    const card = document.createElement('div');
    card.style.cssText = 'background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; padding: 10px 12px; display: flex; align-items: center; gap: 10px; transition: all 0.2s; overflow: hidden;';

    card.innerHTML = `
        <div class="task-check" data-id="${t.id}" style="width: 20px; height: 20px; min-width: 20px;">
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none" style="display:none">
                <path d="M2 6l3 3 5-5" stroke="white" stroke-width="2" stroke-linecap="round"/>
            </svg>
        </div>
        <div style="flex: 1; min-width: 0; overflow: hidden;">
            <div style="font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${nameHtml}</div>
            <div style="display: flex; gap: 6px; align-items: center; margin-top: 3px; flex-wrap: wrap;">
                <span class="task-badge ${statusClass}" style="font-size: 10px; padding: 1px 6px;">${t.status}</span>
                ${due}
                ${tagsHtml}
                ${obsidianBtn}
            </div>
        </div>
        <button class="task-status-btn" data-editid="${t.id}" style="font-size: 10px; padding: 3px 8px;">✎</button>
    `;

    const check = card.querySelector('.task-check');
    check.addEventListener('click', async () => {
        check.classList.add('checked');
        check.querySelector('svg').style.display = 'block';
        card.style.opacity = '0.4';
        try {
            await fetch(`${PROXY}/tasks/complete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: t.id })
            });
        } catch (e) { console.error('Complete task error:', e); }
        setTimeout(async () => { await loadTasks(); renderCategoryTasks(); }, 800);
    });

    card.querySelector('[data-editid]').addEventListener('click', () => {
        window.openEditTask(t.id);
    });

    return card;
}

document.getElementById('category-task-add-btn')?.addEventListener('click', async () => {
    const input = document.getElementById('category-task-input');
    const name = input?.value?.trim();
    if (!name) { input?.focus(); return; }
    const act = document.getElementById('activity-timer-select')?.value;
    if (!act) return;

    const tagSelect = document.getElementById('category-task-tag');
    const selectedTag = tagSelect?.value;
    const btn = document.getElementById('category-task-add-btn');
    btn.disabled = true;
    try {
        await fetch(`${PROXY}/tasks/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name,
                status: 'To Do',
                taskTypes: selectedTag ? [selectedTag] : null,
            })
        });
        input.value = '';
        await loadTasks();
        renderCategoryTasks();
    } catch (e) { console.error('Create category task error:', e); }
    btn.disabled = false;
});

document.getElementById('category-task-input')?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') document.getElementById('category-task-add-btn')?.click();
});

// --- ACTIVITY WORK SESSION TIMER ---
const WORK_PERIOD = 25 * 60;
const BREAK_PERIOD = 5 * 60;
let activityTimerInterval = null;
let activityTimerState = { running: false, isBreak: false, workElapsed: 0, breakElapsed: 0, startRemaining: 0 };
let pausedRemainingByActivity = {};

function getActivityRemainingSeconds() {
    const act = document.getElementById('activity-timer-select')?.value;
    if (!act) return 0;
    const dayOfWeek = new Date().getDay();
    const allocated = localTimeBudget.activities?.[act]?.minutesPerDay?.[dayOfWeek] ?? 60;
    const logField = ACTIVITY_LOG_FIELDS[act];
    const spent = Number(lastLogsData[logField]) || 0;
    return Math.max(0, Math.round((allocated - spent) * 60));
}

function updateActivityTimerDisplay() {
    const act = document.getElementById('activity-timer-select')?.value;
    const pomoDonut = document.getElementById('pomo-donut');
    const pomoTime = document.getElementById('pomo-time');
    const pomoLabel = document.getElementById('pomo-label');
    const btn = document.getElementById('pomo-start');
    if (!pomoDonut || !pomoTime || !pomoLabel) return;

    function fmtTime(totalSec) {
        const h = Math.floor(totalSec / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = Math.floor(totalSec % 60);
        const sp = s.toString().padStart(2, '0');
        if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${sp}`;
        return `${m}:${sp}`;
    }

    if (!act) {
        pomoLabel.textContent = '—';
        pomoTime.textContent = '—:——';
        pomoDonut.style.background = '#313244';
        if (btn) btn.disabled = true;
        document.getElementById('activity-timer-select').disabled = false;
        document.title = '--:--';
        return;
    }
    if (btn) btn.disabled = false;

    const color = ACTIVITY_COLORS[act];
    const label = ACTIVITY_LABELS[act];

    document.getElementById('activity-timer-select').disabled = activityTimerState.running;

    if (activityTimerState.running) {
        if (activityTimerState.isBreak) {
            const left = BREAK_PERIOD - activityTimerState.breakElapsed;
            const display = fmtTime(left);
            pomoLabel.textContent = 'Break';
            pomoTime.textContent = display;
            const pct = (left / BREAK_PERIOD) * 100;
            pomoDonut.style.background = `conic-gradient(#FAA61A 0% ${pct}%, #313244 ${pct}% 100%)`;
            document.title = `Break ${display}`;
        } else {
            const remaining = activityTimerState.startRemaining - activityTimerState.workElapsed;
            if (remaining <= 0) {
                const over = Math.abs(remaining);
                const display = `+${fmtTime(over)}`;
                pomoLabel.textContent = label;
                pomoTime.textContent = display;
                pomoTime.style.color = '#FAA61A';
                pomoDonut.style.background = `conic-gradient(${color} 0% 100%)`;
                document.title = `${display} ${label}`;
            } else {
                const display = fmtTime(remaining);
                pomoLabel.textContent = label;
                pomoTime.textContent = display;
                pomoTime.style.color = '';
                const dayOfWeek = new Date().getDay();
                const allocated = localTimeBudget.activities?.[act]?.minutesPerDay?.[dayOfWeek] ?? 60;
                const pct = allocated > 0 ? Math.min(100, (remaining / 60 / allocated) * 100) : 100;
                pomoDonut.style.background = `conic-gradient(${color} 0% ${pct}%, #313244 ${pct}% 100%)`;
                document.title = display;
            }
        }
    } else {
        const dayOfWeek = new Date().getDay();
        const allocated = localTimeBudget.activities?.[act]?.minutesPerDay?.[dayOfWeek] ?? 60;
        const logField = ACTIVITY_LOG_FIELDS[act];
        const spent = Number(lastLogsData[logField]) || 0;
        let remainingSec;
        if (pausedRemainingByActivity[act] != null) {
            remainingSec = pausedRemainingByActivity[act];
        } else {
            remainingSec = Math.max(0, (allocated - spent) * 60);
        }
        pomoLabel.textContent = label;
        if (remainingSec <= 0) {
            const overSec = Math.abs(remainingSec);
            const display = `+${fmtTime(overSec)}`;
            pomoTime.textContent = display;
            pomoTime.style.color = '#FAA61A';
            document.title = display;
        } else {
            const display = fmtTime(remainingSec);
            pomoTime.textContent = display;
            pomoTime.style.color = '';
            document.title = display;
        }
        const remainingMin = remainingSec / 60;
        const pctRemaining = allocated > 0 ? Math.max(0, (remainingMin / allocated) * 100) : 0;
        pomoDonut.style.background = allocated > 0
            ? `conic-gradient(${color} 0% ${pctRemaining}%, #313244 ${pctRemaining}% 100%)`
            : '#313244';
    }
}

function playNotificationSound() {
    new Audio('https://cdn.pixabay.com/download/audio/2021/08/04/audio_33cd426d9c.mp3?filename=notification-sound-7062.mp3').play().catch(() => { });
}

document.getElementById('activity-timer-select')?.addEventListener('change', () => {
    if (!activityTimerState.running) updateActivityTimerDisplay();
    renderCategoryTasks();
    renderTimeBudgetDonuts();
});

document.getElementById('pomo-start')?.addEventListener('click', async () => {
    const btn = document.getElementById('pomo-start');
    const act = document.getElementById('activity-timer-select')?.value;
    if (!act) return;

    if (activityTimerState.running) {
        clearInterval(activityTimerInterval);
        activityTimerInterval = null;
        const remainingSec = activityTimerState.startRemaining - activityTimerState.workElapsed;
        pausedRemainingByActivity[act] = remainingSec;
        try {
            const workMinutes = activityTimerState.workElapsed / 60;
            if (workMinutes > 0) {
                const logField = ACTIVITY_LOG_FIELDS[act];
                const logRef = doc(db, "logs", getTodayStr());
                try {
                    await updateDoc(logRef, { [logField]: increment(workMinutes) });
                } catch (updateErr) {
                    const snap = await getDoc(logRef);
                    const data = snap.exists() ? snap.data() : {};
                    await setDoc(logRef, {
                        [logField]: (data[logField] || 0) + workMinutes
                    }, { merge: true });
                }
            }
        } catch (e) { console.warn("Failed to save session time", e); }
        activityTimerState.running = false;
        btn.innerText = 'Start';
        btn.style.background = '#5865F2';
        updateActivityTimerDisplay();
    } else {
        const startFrom = pausedRemainingByActivity[act] ?? getActivityRemainingSeconds();
        delete pausedRemainingByActivity[act];
        activityTimerState = {
            running: true,
            isBreak: false,
            workElapsed: 0,
            breakElapsed: 0,
            startRemaining: startFrom
        };
        btn.innerText = 'Pause';
        btn.style.background = '#F04747';
        activityTimerInterval = setInterval(() => {
            if (activityTimerState.isBreak) {
                activityTimerState.breakElapsed++;
                if (activityTimerState.breakElapsed >= BREAK_PERIOD) {
                    activityTimerState.isBreak = false;
                    activityTimerState.breakElapsed = 0;
                }
            } else {
                activityTimerState.workElapsed++;
                if (activityTimerState.workElapsed >= WORK_PERIOD) {
                    playNotificationSound();
                    activityTimerState.isBreak = true;
                    activityTimerState.workElapsed = WORK_PERIOD;
                }
            }
            updateActivityTimerDisplay();
            renderTimeBudgetDonuts();
        }, 1000);
    }
    updateActivityTimerDisplay();
});

// --- SETTINGS ---
let localRules = { domains: [], keywords: [], apps: [] };
const defaultRules = { domains: ["docs.google.com", "drive.google.com", "mail.google.com"], keywords: ["internship"], apps: ["Code", "Terminal", "Zoom", "Notes", "Preview"] };

async function loadSettings() {
    try {
        const snap = await getDoc(doc(db, "config", "rules"));
        if (snap.exists()) {
            const data = snap.data();
            // Validate format: must have domains and keywords as arrays
            if (Array.isArray(data.domains) && Array.isArray(data.keywords)) {
                localRules = data;
                if (!Array.isArray(localRules.apps)) localRules.apps = [];
            } else {
                // Old or corrupt format — overwrite with defaults
                console.warn("Rules doc has wrong format, resetting to defaults");
                localRules = JSON.parse(JSON.stringify(defaultRules));
                try { await setDoc(doc(db, "config", "rules"), localRules); } catch (e2) { }
            }
        } else {
            localRules = JSON.parse(JSON.stringify(defaultRules));
            try { await setDoc(doc(db, "config", "rules"), localRules); } catch (e2) { }
        }
    } catch (e) {
        console.warn("Using default rules", e);
        localRules = JSON.parse(JSON.stringify(defaultRules));
    }

    // Load time budget config
    try {
        const tbSnap = await getDoc(doc(db, "config", "timeBudget"));
        if (tbSnap.exists()) {
            const data = tbSnap.data();
            localTimeBudget = mergeTimeBudget(defaultTimeBudget, data);
        } else {
            localTimeBudget = JSON.parse(JSON.stringify(defaultTimeBudget));
            try { await setDoc(doc(db, "config", "timeBudget"), serializeTimeBudgetForFirestore(localTimeBudget)); } catch (e2) { }
        }
    } catch (e) {
        console.warn("Using default time budget", e);
        localTimeBudget = JSON.parse(JSON.stringify(defaultTimeBudget));
    }
    if (typeof renderTimeBudgetSettings === 'function') renderTimeBudgetSettings();

    if (window.electronAPI) {
        try {
            const startupActive = await window.electronAPI.getLoginItemSettings();
            document.getElementById('toggle-startup').checked = startupActive;
        } catch (e) { console.warn("Failed to get startup settings", e); }
    }

    renderRules();
    loadRecommendationsConfig();
    loadAccountManager();
}

// --- ACCOUNT CONNECTION MANAGER ---
const SPOTIFY_PROXY = 'http://127.0.0.1:4004';
const NOTION_PROXY = 'http://127.0.0.1:19876';

async function loadAccountManager() {
    try {
        const [gcalStatus, gcalInfo, spotifyInfo, notionInfo] = await Promise.all([
            fetch(`${GCAL}/gcal/status`).then(r => r.json()).catch(() => ({})),
            fetch(`${GCAL}/gcal/account-info`).then(r => r.json()).catch(() => ({})),
            fetch(`${SPOTIFY_PROXY}/account-info`).then(r => r.json()).catch(() => ({ connected: false })),
            fetch(`${NOTION_PROXY}/account-info`).then(r => r.json()).catch(() => ({ connected: false }))
        ]);

        // Google accounts
        for (const acc of [1, 2]) {
            const emailEl = document.getElementById(`acct-email-${acc}`);
            const actionEl = document.getElementById(`acct-action-${acc}`);
            if (!emailEl || !actionEl) continue;
            const connected = gcalStatus[`account${acc}`];
            if (connected) {
                const email = gcalInfo[`account${acc}`]?.email || 'Connected';
                emailEl.textContent = email;
                emailEl.style.color = '#43b581';
                actionEl.innerHTML = `<button class="save-btn" style="margin:0;padding:6px 14px;font-size:12px;width:auto;background:#F04747;" onclick="window.disconnectGoogleAccount(${acc})">Disconnect</button>`;
            } else {
                emailEl.textContent = 'Not connected';
                emailEl.style.color = '#949ba4';
                actionEl.innerHTML = `<button class="save-btn" style="margin:0;padding:6px 14px;font-size:12px;width:auto;background:#5865F2;" onclick="window.connectAccountFromSettings(${acc})">Connect</button>`;
            }
        }

        // Spotify
        const spotifyInfoEl = document.getElementById('acct-spotify-info');
        const spotifyActionEl = document.getElementById('acct-spotify-action');
        if (spotifyInfoEl && spotifyActionEl) {
            if (spotifyInfo.connected) {
                const label = spotifyInfo.displayName || spotifyInfo.email || 'Connected';
                spotifyInfoEl.textContent = label;
                spotifyInfoEl.style.color = '#1DB954';
                spotifyActionEl.innerHTML = `<button class="save-btn" style="margin:0;padding:6px 14px;font-size:12px;width:auto;background:#F04747;" onclick="window.disconnectSpotifyFromSettings()">Disconnect</button>`;
            } else {
                spotifyInfoEl.textContent = 'Not connected';
                spotifyInfoEl.style.color = '#949ba4';
                spotifyActionEl.innerHTML = `<button class="save-btn" style="margin:0;padding:6px 14px;font-size:12px;width:auto;background:#1DB954;" onclick="window.connectSpotifyFromSettings()">Connect</button>`;
            }
        }

        // Notion
        const notionInfoEl = document.getElementById('acct-notion-info');
        const notionActionEl = document.getElementById('acct-notion-action');
        if (notionInfoEl) {
            if (notionInfo.connected) {
                const label = notionInfo.workspaceName || notionInfo.name || 'Connected';
                notionInfoEl.textContent = label;
                notionInfoEl.style.color = '#43b581';
                if (notionActionEl) notionActionEl.innerHTML = `<span style="color:#43b581;font-size:12px;font-weight:700;">Connected</span>`;
            } else {
                notionInfoEl.textContent = 'Not configured';
                notionInfoEl.style.color = '#949ba4';
                if (notionActionEl) notionActionEl.innerHTML = `<span style="color:#949ba4;font-size:11px;">Set NOTION_TOKEN in .env</span>`;
            }
        }
    } catch (e) {
        console.error('Account manager load error:', e);
    }
}

window.connectAccountFromSettings = async function (account) {
    const actionEl = document.getElementById(`acct-action-${account}`);
    const emailEl = document.getElementById(`acct-email-${account}`);
    if (actionEl) actionEl.innerHTML = `<span style="color:#949ba4;font-size:12px;">Waiting for browser...</span>`;
    if (emailEl) emailEl.textContent = 'Authorizing...';
    try {
        await fetch(`${GCAL}/gcal/auth?account=${account}`);
        const poll = setInterval(async () => {
            const res = await fetch(`${GCAL}/gcal/status`);
            const data = await res.json();
            if (data[`account${account}`]) {
                clearInterval(poll);
                loadAccountManager();
                if (typeof initCalendar === 'function') initCalendar();
            }
        }, 2000);
    } catch (e) {
        console.error('Connect error:', e);
        if (emailEl) emailEl.textContent = 'Connection failed';
        if (actionEl) actionEl.innerHTML = `<button class="save-btn" style="margin:0;padding:6px 14px;font-size:12px;width:auto;background:#5865F2;" onclick="window.connectAccountFromSettings(${account})">Retry</button>`;
    }
};

window.disconnectGoogleAccount = async function (account) {
    const actionEl = document.getElementById(`acct-action-${account}`);
    if (actionEl) {
        actionEl.innerHTML = `<span style="color:#F04747;font-size:12px;cursor:pointer;font-weight:700;" onclick="window.confirmDisconnectGoogle(${account})">Confirm?</span> <span style="color:#949ba4;font-size:12px;cursor:pointer;margin-left:8px;" onclick="loadAccountManager()">Cancel</span>`;
    }
};

window.confirmDisconnectGoogle = async function (account) {
    const emailEl = document.getElementById(`acct-email-${account}`);
    if (emailEl) emailEl.textContent = 'Disconnecting...';
    try {
        await fetch(`${GCAL}/gcal/disconnect`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ account })
        });
    } catch (e) { console.error('Disconnect error:', e); }
    loadAccountManager();
    if (typeof initCalendar === 'function') initCalendar();
};

window.connectSpotifyFromSettings = async function () {
    const actionEl = document.getElementById('acct-spotify-action');
    const infoEl = document.getElementById('acct-spotify-info');
    if (actionEl) actionEl.innerHTML = `<span style="color:#949ba4;font-size:12px;">Waiting for browser...</span>`;
    if (infoEl) infoEl.textContent = 'Authorizing...';
    try {
        window.open(`${SPOTIFY_PROXY}/auth`, '_blank');
        const poll = setInterval(async () => {
            const res = await fetch(`${SPOTIFY_PROXY}/status`);
            const data = await res.json();
            if (data.isAuthenticated) {
                clearInterval(poll);
                loadAccountManager();
            }
        }, 2000);
    } catch (e) {
        console.error('Spotify connect error:', e);
        if (infoEl) infoEl.textContent = 'Connection failed';
    }
};

window.disconnectSpotifyFromSettings = async function () {
    const actionEl = document.getElementById('acct-spotify-action');
    if (actionEl) {
        actionEl.innerHTML = `<span style="color:#F04747;font-size:12px;cursor:pointer;font-weight:700;" onclick="window.confirmDisconnectSpotify()">Confirm?</span> <span style="color:#949ba4;font-size:12px;cursor:pointer;margin-left:8px;" onclick="loadAccountManager()">Cancel</span>`;
    }
};

window.confirmDisconnectSpotify = async function () {
    const infoEl = document.getElementById('acct-spotify-info');
    if (infoEl) infoEl.textContent = 'Disconnecting...';
    try {
        await fetch(`${SPOTIFY_PROXY}/disconnect`, { method: 'POST' });
    } catch (e) { console.error('Spotify disconnect error:', e); }
    loadAccountManager();
};

function serializeTimeBudgetForFirestore(tb) {
    return tb; // Firestore accepts plain objects; numbers/arrays fine
}

function renderTimeBudgetSettings() {
    const tb = localTimeBudget;
    const useCal = document.getElementById('timebudget-use-calendars');
    if (useCal) useCal.checked = tb.useCalendarForMeetings !== false;

    for (let d = 0; d < 7; d++) {
        const s = document.getElementById(`tb-sleep-${d}`);
        if (s) s.value = tb.sleepPerDay?.[d] ?? 480;
        const m = document.getElementById(`tb-manual-${d}`);
        if (m) m.value = tb.calendarSources?.manualMinutesPerDay?.[d] ?? 0;
    }
    const ical = document.getElementById('tb-ical-url');
    if (ical) ical.value = tb.calendarSources?.iCalUrl || '';
    const gcal = document.getElementById('tb-gcal-names');
    if (gcal) gcal.value = (tb.calendarSources?.gcalNames || ['Extracurriculars', 'Work']).join(', ');

    // Allocation table: rows = activities, collapsed to Weekday/Weekend by default
    if (document.getElementById('tb-allocation-table')) {
        renderAllocationTable(tb);
    }

    // Activity rules (collapsible per activity)
    const rulesDiv = document.getElementById('tb-activity-rules');
    if (rulesDiv) {
        let html = '';
        ACTIVITY_KEYS.forEach(k => {
            const r = tb.activityRules?.[k] || { domains: [], keywords: [], apps: [] };
            html += `<div class="rule-section" style="margin-bottom:20px; padding:20px; background:rgba(0,0,0,0.2); border-radius:8px;">`;
            html += `<div style="font-weight:bold; margin-bottom:8px;"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${ACTIVITY_COLORS[k]};margin-right:8px;"></span>${ACTIVITY_LABELS[k]}</div>`;
            html += `<div style="font-size:12px; color:#949ba4; margin-bottom:12px;">Domains: <input type="text" id="tb-ar-domains-${k}" placeholder="docs.google.com, ..." value="${(r.domains || []).join(', ')}" style="width:80%; padding:8px;"></div>`;
            html += `<div style="font-size:12px; color:#949ba4; margin-bottom:12px;">Keywords: <input type="text" id="tb-ar-keywords-${k}" placeholder="economics, ..." value="${(r.keywords || []).join(', ')}" style="width:80%; padding:8px;"></div>`;
            html += `<div style="font-size:12px; color:#949ba4; margin-bottom:8px;">Apps: <input type="text" id="tb-ar-apps-${k}" placeholder="Code, Terminal, ..." value="${(r.apps || []).join(', ')}" style="width:80%; padding:8px;"></div>`;
            html += '</div>';
        });
        rulesDiv.innerHTML = html;
    }
}

function collectTimeBudgetFromForm() {
    const tb = JSON.parse(JSON.stringify(localTimeBudget));
    tb.useCalendarForMeetings = document.getElementById('timebudget-use-calendars')?.checked !== false;
    for (let d = 0; d < 7; d++) {
        const v = parseInt(document.getElementById(`tb-sleep-${d}`)?.value, 10);
        tb.sleepPerDay[d] = isNaN(v) ? 480 : Math.max(0, Math.min(1440, v));
        const m = parseInt(document.getElementById(`tb-manual-${d}`)?.value, 10);
        tb.calendarSources.manualMinutesPerDay[d] = isNaN(m) ? 0 : Math.max(0, m);
    }
    tb.calendarSources.iCalUrl = document.getElementById('tb-ical-url')?.value?.trim() || '';
    const gcalStr = document.getElementById('tb-gcal-names')?.value?.trim() || '';
    tb.calendarSources.gcalNames = gcalStr ? gcalStr.split(',').map(s => s.trim()).filter(Boolean) : [];

    ACTIVITY_KEYS.forEach(k => {
        if (document.getElementById(`tb-alloc-${k}-0`)) {
            // expanded: read all 7 days
            for (let d = 0; d < 7; d++) {
                const v = parseInt(document.getElementById(`tb-alloc-${k}-${d}`)?.value, 10);
                tb.activities[k].minutesPerDay[d] = isNaN(v) ? 60 : Math.max(0, v);
            }
        } else {
            // collapsed: apply weekday value to Mon–Fri, weekend to Sat/Sun
            const wd = parseInt(document.getElementById(`tb-alloc-${k}-wd`)?.value, 10);
            const we = parseInt(document.getElementById(`tb-alloc-${k}-we`)?.value, 10);
            const wdVal = isNaN(wd) ? 60 : Math.max(0, wd);
            const weVal = isNaN(we) ? 60 : Math.max(0, we);
            tb.activities[k].minutesPerDay[0] = weVal;
            for (let d = 1; d <= 5; d++) tb.activities[k].minutesPerDay[d] = wdVal;
            tb.activities[k].minutesPerDay[6] = weVal;
        }
        const domainsStr = document.getElementById(`tb-ar-domains-${k}`)?.value?.trim() || '';
        const keywordsStr = document.getElementById(`tb-ar-keywords-${k}`)?.value?.trim() || '';
        const appsStr = document.getElementById(`tb-ar-apps-${k}`)?.value?.trim() || '';
        tb.activityRules[k] = {
            domains: domainsStr ? domainsStr.split(',').map(s => s.trim()).filter(Boolean) : [],
            keywords: keywordsStr ? keywordsStr.split(',').map(s => s.trim()).filter(Boolean) : [],
            apps: appsStr ? appsStr.split(',').map(s => s.trim()).filter(Boolean) : []
        };
    });
    return tb;
}

function renderAllocationTable(tb) {
    const table = document.getElementById('tb-allocation-table');
    if (!table) return;
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    let html = '<div style="display:flex; flex-direction:column; gap:10px;">';
    ACTIVITY_KEYS.forEach(k => {
        const acts = tb.activities?.[k]?.minutesPerDay || defaultMinutesPerDay();
        const wdVal = acts[1];
        const weVal = acts[0];
        const allWdSame = [1, 2, 3, 4, 5].every(d => acts[d] === wdVal);
        const allWeSame = [0, 6].every(d => acts[d] === weVal);
        // Auto-expand rows whose saved data already varies across days
        if (!allWdSame || !allWeSame) allocationExpandedRows.add(k);
        const isExpanded = allocationExpandedRows.has(k);
        html += `<div style="background:rgba(0,0,0,0.15); border-radius:8px; padding:14px 16px;">`;
        html += `<div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:12px;">`;
        html += `<div style="display:flex; align-items:center; gap:10px; font-size:13px; font-weight:600; color:#f2f3f5;">`;
        html += `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${ACTIVITY_COLORS[k]};flex-shrink:0;"></span>${ACTIVITY_LABELS[k]}`;
        html += `</div>`;
        html += `<button onclick="toggleAllocationRow('${k}')" style="background:none;border:1px solid rgba(255,255,255,0.15);color:#949ba4;border-radius:4px;padding:3px 10px;font-size:11px;cursor:pointer;">${isExpanded ? 'Collapse' : 'Per day'}</button>`;
        html += `</div>`;
        if (isExpanded) {
            html += `<div style="display:grid; grid-template-columns:repeat(7,1fr); gap:8px;">`;
            for (let d = 0; d < 7; d++) {
                html += `<div><div style="font-size:10px; color:#949ba4; text-align:center; margin-bottom:4px;">${dayNames[d]}</div>`;
                html += `<input type="number" id="tb-alloc-${k}-${d}" class="rule-input" min="0" value="${acts[d] ?? 60}" style="width:100%; padding:8px; text-align:center;"></div>`;
            }
            html += `</div>`;
        } else {
            html += `<div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">`;
            html += `<div><div style="font-size:11px; color:#949ba4; margin-bottom:6px;">Weekdays (Mon–Fri)</div>`;
            html += `<input type="number" id="tb-alloc-${k}-wd" class="rule-input" min="0" value="${wdVal ?? 60}" style="width:100%; padding:8px; text-align:center;"></div>`;
            html += `<div><div style="font-size:11px; color:#949ba4; margin-bottom:6px;">Weekend (Sat–Sun)</div>`;
            html += `<input type="number" id="tb-alloc-${k}-we" class="rule-input" min="0" value="${weVal ?? 60}" style="width:100%; padding:8px; text-align:center;"></div>`;
            html += `</div>`;
        }
        html += `</div>`;
    });
    html += '</div>';
    table.innerHTML = html;
}

window.toggleAllocationRow = function toggleAllocationRow(k) {
    // Snapshot current input values into localTimeBudget before re-rendering
    if (!localTimeBudget.activities[k]) localTimeBudget.activities[k] = { color: ACTIVITY_COLORS[k], minutesPerDay: defaultMinutesPerDay() };
    if (document.getElementById(`tb-alloc-${k}-0`)) {
        for (let d = 0; d < 7; d++) {
            const v = parseInt(document.getElementById(`tb-alloc-${k}-${d}`)?.value, 10);
            localTimeBudget.activities[k].minutesPerDay[d] = isNaN(v) ? 60 : Math.max(0, v);
        }
    } else {
        const wd = parseInt(document.getElementById(`tb-alloc-${k}-wd`)?.value, 10);
        const we = parseInt(document.getElementById(`tb-alloc-${k}-we`)?.value, 10);
        const wdVal = isNaN(wd) ? 60 : Math.max(0, wd);
        const weVal = isNaN(we) ? 60 : Math.max(0, we);
        localTimeBudget.activities[k].minutesPerDay[0] = weVal;
        for (let d = 1; d <= 5; d++) localTimeBudget.activities[k].minutesPerDay[d] = wdVal;
        localTimeBudget.activities[k].minutesPerDay[6] = weVal;
    }
    if (allocationExpandedRows.has(k)) {
        allocationExpandedRows.delete(k);
    } else {
        allocationExpandedRows.add(k);
    }
    renderAllocationTable(localTimeBudget);
}

document.getElementById('tb-sync-calendars')?.addEventListener('click', async () => {
    const icalUrl = document.getElementById('tb-ical-url')?.value?.trim() || '';
    const gcalNames = (document.getElementById('tb-gcal-names')?.value?.trim() || '').split(',').map(s => s.trim()).filter(Boolean);
    const preview = document.getElementById('tb-blocked-preview');
    if (!preview) return;
    preview.textContent = 'Fetching...';
    try {
        const qs = new URLSearchParams();
        if (icalUrl) qs.set('iCalUrl', icalUrl);
        if (gcalNames.length) qs.set('gcalNames', gcalNames.join(','));
        const res = await fetch(`http://127.0.0.1:19878/gcal/blocked-minutes?${qs}`);
        const data = await res.json();
        const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const parts = dayNames.map((d, i) => `${d}: ${data.blocked?.[i] || 0}m`);
        preview.textContent = 'Blocked this week: ' + parts.join(', ');
    } catch (e) {
        preview.textContent = 'Could not fetch (is gcal-proxy running?)';
    }
});

document.getElementById('save-timebudget')?.addEventListener('click', async () => {
    const btn = document.getElementById('save-timebudget');
    if (!btn) return;
    btn.innerText = 'Saving...';
    btn.disabled = true;
    try {
        localTimeBudget = collectTimeBudgetFromForm();
        await setDoc(doc(db, "config", "timeBudget"), serializeTimeBudgetForFirestore(localTimeBudget));
        btn.innerText = 'Save Time Budget';
        const msg = document.getElementById('save-msg');
        if (msg) { msg.style.display = 'block'; msg.textContent = 'Time budget saved!'; setTimeout(() => msg.style.display = 'none', 3000); }
    } catch (e) {
        console.error('Save time budget error', e);
        btn.innerText = 'Error — Retry';
        btn.disabled = false;
    }
    btn.disabled = false;
});

document.getElementById('toggle-startup').addEventListener('change', (e) => {
    if (window.electronAPI) {
        window.electronAPI.setLoginItemSettings(e.target.checked);
    }
});

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

    // Apps
    const appList = document.getElementById('app-list');
    appList.innerHTML = '';
    localRules.apps.forEach((a, i) => {
        appList.innerHTML += `<div class="rule-tag">${a} <button onclick="removeRule('apps', ${i})">&times;</button></div>`;
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

// --- TASKS (Notion) ---
const PROXY = 'http://127.0.0.1:19876';
const CHAT_PROXY = 'http://127.0.0.1:19879';
let currentSortMode = 'date';
let cachedTasks = [];

async function loadTasks() {
    const container = document.getElementById('tasks-container');
    if (!cachedTasks.length) {
        container.innerHTML = '<div class="tasks-loading">Loading tasks from Notion...</div>';
    }
    try {
        const res = await fetch(`${PROXY}/tasks`);
        cachedTasks = await res.json();
        if (!cachedTasks.length) {
            container.innerHTML = '<div class="tasks-loading">No open tasks found ✨</div>';
            if (typeof renderCategoryTasks === 'function') renderCategoryTasks();
            return;
        }
        renderTasks();
        if (typeof renderCategoryTasks === 'function') renderCategoryTasks();
    } catch (e) {
        console.error('Tasks load error:', e);
        if (!cachedTasks.length) {
            container.innerHTML = '<div class="tasks-loading">Failed to load tasks. Is the proxy running?</div>';
        }
    }
}

function renderTasks() {
    const container = document.getElementById('tasks-container');
    container.innerHTML = '';

    if (currentSortMode === 'tag') {
        // Group by tag
        const groups = {};
        const untagged = [];
        cachedTasks.forEach(t => {
            if (t.tags && t.tags.length > 0) {
                t.tags.forEach(tag => {
                    if (!groups[tag]) groups[tag] = [];
                    groups[tag].push(t);
                });
            } else {
                untagged.push(t);
            }
        });

        // Sort tags alphabetically
        const sortedTags = Object.keys(groups).sort();
        sortedTags.forEach(tag => {
            const header = document.createElement('div');
            header.className = 'tag-group-header';
            header.textContent = `🏷 ${tag}`;
            container.appendChild(header);
            groups[tag].forEach(t => container.appendChild(createTaskCard(t)));
        });
        if (untagged.length) {
            const header = document.createElement('div');
            header.className = 'tag-group-header';
            header.textContent = '📋 Untagged';
            container.appendChild(header);
            untagged.forEach(t => container.appendChild(createTaskCard(t)));
        }
    } else {
        // Sort by due date (nulls last)
        const sorted = [...cachedTasks].sort((a, b) => {
            if (!a.dueDate && !b.dueDate) return 0;
            if (!a.dueDate) return 1;
            if (!b.dueDate) return -1;
            return a.dueDate.localeCompare(b.dueDate);
        });
        sorted.forEach(t => container.appendChild(createTaskCard(t)));
    }

    // Attach event handlers
    container.querySelectorAll('.task-check').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.dataset.id;
            btn.classList.add('checked');
            btn.querySelector('svg').style.display = 'block';
            btn.closest('.task-card').classList.add('done');
            await fetch(`${PROXY}/tasks/complete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id })
            });
            setTimeout(() => loadTasks(), 800);
        });
    });

    container.querySelectorAll('.task-status-btn[data-action="start"]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.dataset.id;
            btn.innerText = '...';
            await fetch(`${PROXY}/tasks/status`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id, status: 'In Progress' })
            });
            loadTasks();
        });
    });
}

function createTaskCard(t) {
    const statusClass = t.status === 'In Progress' ? 'in-progress' : 'todo';
    const due = t.dueDate ? `📅 ${t.dueDate}` : '';
    const priority = t.priority ? `⚡ ${t.priority}` : '';
    const tagsHtml = (t.tags || []).map(tag => `<span style="background:rgba(88,101,242,0.15);color:#7b83eb;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:bold;">${tag}</span>`).join('');

    // Helper to escape HTML and linkify obsidian:// and http(s):// URLs
    const linkify = (text) => {
        if (!text) return '';
        const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return escaped
            .replace(/(obsidian:\/\/[^\s"'<)]+)/g, '<a href="$1" style="color:#A882FF; text-decoration:none; font-weight:bold; background:rgba(168,130,255,0.15); padding:2px 6px; border-radius:4px;">🔮 Open in Obsidian</a>')
            .replace(/(https?:\/\/[^\s"'<)]+)/g, '<a href="$1" style="color:#5865F2; text-decoration:none; font-weight:600; background:rgba(88,101,242,0.15); padding:2px 6px; border-radius:4px;">🔗 Open link</a>');
    };

    const taskNameHtml = linkify(t.name || 'Untitled');
    const descHtml = t.description ? `<div style="font-size: 13px; color: #949BA4; margin-top: 6px; line-height: 1.4;">${linkify(t.description)}</div>` : '';

    const card = document.createElement('div');
    card.className = 'task-card';
    card.innerHTML = `
        <div class="task-check" data-id="${t.id}" title="Mark as done">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style="display:none">
                <path d="M2 6l3 3 5-5" stroke="white" stroke-width="2" stroke-linecap="round"/>
            </svg>
        </div>
        <div class="task-info" style="flex:1; min-width:0;">
            <div class="task-name">${taskNameHtml}</div>
            ${descHtml}
            <div class="task-meta">
                <span class="task-badge ${statusClass}">${t.status}</span>
                ${due ? `<span>${due}</span>` : ''}
                ${priority ? `<span>${priority}</span>` : ''}
            </div>
            ${tagsHtml ? `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;">${tagsHtml}</div>` : ''}
        </div>
        <div style="display:flex; flex-direction:column; gap:6px;">
            ${t.status === 'To Do' ? `<button class="task-status-btn" data-id="${t.id}" data-action="start">Start</button>` : ''}
            <button class="task-status-btn" onclick="window.openEditTask('${t.id}')">✎ Edit</button>
        </div>
    `;
    return card;
}

window.refreshTasks = loadTasks;

window.toggleSortMenu = function () {
    document.getElementById('sort-menu').classList.toggle('open');
};

window.setSortMode = function (mode) {
    currentSortMode = mode;
    document.querySelectorAll('.sort-option').forEach(el => {
        el.classList.toggle('active', el.dataset.sort === mode);
    });
    document.getElementById('sort-menu').classList.remove('open');
    if (cachedTasks.length) renderTasks();
};

// --- INTERNSHIP TRACKER ---
async function loadInternships() {
    const container = document.getElementById('internships-container');
    if (!container) return;
    let data = [];
    try {
        const res = await fetch(`${CHAT_PROXY}/internships`);
        if (res.ok) data = await res.json();
        if (!Array.isArray(data)) data = [];
        // One-time migration from localStorage if proxy was empty
        if (data.length === 0) {
            try {
                const raw = localStorage.getItem('internships');
                if (raw) {
                    const legacy = JSON.parse(raw);
                    if (Array.isArray(legacy) && legacy.length > 0) {
                        await fetch(`${CHAT_PROXY}/internships`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ internships: legacy })
                        });
                        localStorage.removeItem('internships');
                        data = legacy;
                    }
                }
            } catch (_) { /* ignore migration errors */ }
        }
    } catch (e) {
        console.error('Internships load error:', e);
        data = [];
    }
    renderInternships(data);
    renderSubmitted(data);
}

window.switchInternshipTab = function (tab) {
    const activeContainer = document.getElementById('internships-container');
    const submittedContainer = document.getElementById('submitted-container');
    const recommendedContainer = document.getElementById('recommended-container');
    const activeTab = document.getElementById('intern-tab-active');
    const submittedTab = document.getElementById('intern-tab-submitted');
    const recommendedTab = document.getElementById('intern-tab-recommended');

    activeContainer.style.display = 'none';
    submittedContainer.style.display = 'none';
    if (recommendedContainer) recommendedContainer.style.display = 'none';
    activeTab.classList.remove('intern-tab-active');
    submittedTab.classList.remove('intern-tab-active');
    if (recommendedTab) recommendedTab.classList.remove('intern-tab-active');

    if (tab === 'active') {
        activeContainer.style.display = '';
        activeTab.classList.add('intern-tab-active');
    } else if (tab === 'submitted') {
        submittedContainer.style.display = '';
        submittedTab.classList.add('intern-tab-active');
    } else if (tab === 'recommended') {
        if (recommendedContainer) recommendedContainer.style.display = '';
        if (recommendedTab) recommendedTab.classList.add('intern-tab-active');
        loadRecommendations();
    }
};

async function saveInternships(data) {
    try {
        await fetch(`${CHAT_PROXY}/internships`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ internships: data })
        });
    } catch (e) {
        console.error('Internships save error:', e);
    }
}

async function getInternshipsData() {
    try {
        const res = await fetch(`${CHAT_PROXY}/internships`);
        if (res.ok) return await res.json();
        return [];
    } catch (e) {
        console.error('Internships fetch error:', e);
        return [];
    }
}

function renderInternships(data) {
    const container = document.getElementById('internships-container');
    if (!container) return;
    container.innerHTML = '';
    const active = (data || []).filter(i => !i.submittedAt);
    if (active.length === 0) {
        container.innerHTML = '<div class="internships-loading">No active applications. Add one to get started.</div>';
        return;
    }
    const sorted = [...active].sort((a, b) => {
        const da = a.personalDueDate || a.officialDueDate || '9999-99-99';
        const db = b.personalDueDate || b.officialDueDate || '9999-99-99';
        return da.localeCompare(db);
    });
    sorted.forEach(internship => container.appendChild(createInternshipCard(internship)));

    container.querySelectorAll('.internship-card-header').forEach(header => {
        header.addEventListener('click', () => {
            header.closest('.internship-card').classList.toggle('expanded');
        });
    });
    container.querySelectorAll('.internship-edit-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            window.openInternshipEdit(btn.dataset.id);
        });
    });
    container.querySelectorAll('.internship-done-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            window.markInternshipDone(btn.dataset.id);
        });
    });
    container.querySelectorAll('.internship-delete-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (confirm('Delete this internship?')) window.deleteInternship(btn.dataset.id);
        });
    });
}

function createInternshipCard(internship) {
    const today = new Date().toISOString().slice(0, 10);
    const due = internship.personalDueDate || internship.officialDueDate;
    const isOverdue = due && due < today;
    const statusClass = isOverdue ? 'overdue' : 'on-track';
    const statusLabel = isOverdue ? 'Overdue' : 'On track';

    const period = internship.period ? `Period: ${internship.period}` : '';
    const official = internship.officialDueDate ? `Official: ${internship.officialDueDate}` : '';
    const personal = internship.personalDueDate ? `Target: ${internship.personalDueDate}` : '';
    const meta = [period, official, personal].filter(Boolean).join(' • ');

    const contacts = internship.contacts || [];
    const contactsHtml = contacts.length
        ? contacts.map((c, i) => `
            <div class="contact-row" data-id="${internship.id}" data-index="${i}">
                <input type="text" value="${escapeHtml(c.name || '')}" placeholder="Name" readonly>
                <input type="text" value="${escapeHtml(c.role || '')}" placeholder="Role" readonly>
                <input type="text" value="${escapeHtml(c.email || '')}" placeholder="Email" readonly>
            </div>`).join('')
        : '<div style="color:#949ba4;font-size:13px;">No contacts</div>';

    const instructions = internship.instructions ? escapeHtml(internship.instructions) : 'No instructions added';
    const instructionsHtml = `<div class="internship-instructions-text">${instructions}</div>`;

    const url = internship.applicationUrl && internship.applicationUrl.trim();
    const isValidUrl = url && (url.startsWith('http://') || url.startsWith('https://'));
    const linkHtml = isValidUrl
        ? `<a href="${escapeHtml(url)}" class="internship-apply-link" target="_blank" rel="noopener noreferrer">🔗 Open Application</a>`
        : '';

    const card = document.createElement('div');
    card.className = 'internship-card';
    card.dataset.id = internship.id;
    card.innerHTML = `
        <div class="internship-card-header">
            <span class="internship-expand-icon">▶</span>
            <div class="internship-card-info">
                <div class="internship-card-name">${escapeHtml(internship.name || 'Untitled')}</div>
                <div class="internship-card-meta">
                    <span class="internship-status-badge ${statusClass}">${statusLabel}</span>
                    ${meta ? `<span>${meta}</span>` : ''}
                </div>
            </div>
            <div class="internship-card-actions">
                ${isValidUrl ? `<a href="${escapeHtml(url)}" class="internship-open-link" target="_blank" rel="noopener noreferrer">Open</a>` : ''}
                <button class="task-status-btn internship-done-btn" data-id="${internship.id}" style="color:#43b581;">✓ Done</button>
                <button class="task-status-btn internship-edit-btn" data-id="${internship.id}">✎ Edit</button>
                <button class="task-status-btn internship-delete-btn" data-id="${internship.id}">Delete</button>
            </div>
        </div>
        <div class="internship-card-body">
            ${linkHtml ? `
            <div class="internship-subsection">
                <div class="internship-subsection-title">APPLICATION</div>
                ${linkHtml}
            </div>
            ` : ''}
            <div class="internship-subsection">
                <div class="internship-subsection-title">CONTACTS</div>
                <div class="contact-rows">${contactsHtml}</div>
            </div>
            <div class="internship-subsection">
                <div class="internship-subsection-title">INSTRUCTIONS</div>
                ${instructionsHtml}
            </div>
        </div>`;
    return card;
}

function escapeHtml(s) {
    if (!s) return '';
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
}

window.toggleInternshipForm = function () {
    const form = document.getElementById('add-internship-form');
    if (!form) return;
    const isVisible = form.classList.contains('visible');
    if (isVisible) {
        form.classList.remove('visible');
        return;
    }
    form.classList.add('visible');
    document.getElementById('new-internship-name').value = '';
    document.getElementById('new-internship-period').value = '';
    document.getElementById('new-internship-url').value = '';
    document.getElementById('new-internship-official-due').value = '';
    document.getElementById('new-internship-personal-due').value = '';
    document.getElementById('new-internship-instructions').value = '';
    renderNewInternshipContacts([]);
};

function renderNewInternshipContacts(contacts) {
    const container = document.getElementById('new-internship-contacts');
    if (!container) return;
    container.innerHTML = '';
    (contacts.length ? contacts : [{ name: '', role: '', email: '' }]).forEach((c) => {
        const row = document.createElement('div');
        row.className = 'contact-row';
        row.innerHTML = `
            <input type="text" placeholder="Name" value="${escapeHtml(c.name || '')}">
            <input type="text" placeholder="Role" value="${escapeHtml(c.role || '')}">
            <input type="text" placeholder="Email" value="${escapeHtml(c.email || '')}">
            <button type="button" class="contact-remove" onclick="this.closest('.contact-row').remove()">×</button>`;
        container.appendChild(row);
    });
}

window.addNewContactToForm = function () {
    const container = document.getElementById('new-internship-contacts');
    if (!container) return;
    const row = document.createElement('div');
    row.className = 'contact-row';
    row.innerHTML = `
        <input type="text" placeholder="Name">
        <input type="text" placeholder="Role">
        <input type="text" placeholder="Email">
        <button type="button" class="contact-remove" onclick="this.closest('.contact-row').remove()">×</button>`;
    container.appendChild(row);
};

function collectContactsFromForm(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return [];
    const rows = container.querySelectorAll('.contact-row');
    const contacts = [];
    rows.forEach(row => {
        const inputs = row.querySelectorAll('input');
        if (inputs.length >= 3) {
            const name = (inputs[0]?.value || '').trim();
            const role = (inputs[1]?.value || '').trim();
            const email = (inputs[2]?.value || '').trim();
            if (name || role || email) contacts.push({ name, role, email });
        }
    });
    return contacts;
}

async function createInternshipDeadlineTask(internship) {
    if (!internship.personalDueDate) return;
    try {
        await fetch(`${PROXY}/tasks/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: `${internship.name} DEADLINE`,
                dueDate: internship.personalDueDate,
                priority: 'High',
                taskTypes: ['Internship/Study Abroad'],
                description: `Internship Tracker: ${internship.name}${internship.period ? ' (' + internship.period + ')' : ''}\nOpen LocalTime → Internship Tracker to view details (Ctrl+Shift+T)`
            })
        });
    } catch (e) {
        console.warn('Failed to create Notion deadline task:', e);
    }
}

window.addInternship = async function () {
    const name = document.getElementById('new-internship-name')?.value?.trim();
    if (!name) {
        document.getElementById('new-internship-name')?.focus();
        return;
    }
    const period = document.getElementById('new-internship-period')?.value?.trim() || null;
    const applicationUrl = document.getElementById('new-internship-url')?.value?.trim() || null;
    const officialDue = document.getElementById('new-internship-official-due')?.value || null;
    const personalDue = document.getElementById('new-internship-personal-due')?.value || null;
    const instructions = document.getElementById('new-internship-instructions')?.value?.trim() || '';
    const contacts = collectContactsFromForm('new-internship-contacts');

    const internship = {
        id: crypto.randomUUID(),
        name,
        period,
        applicationUrl,
        officialDueDate: officialDue,
        personalDueDate: personalDue,
        contacts,
        instructions,
    };
    const data = await getInternshipsData();
    data.push(internship);
    await saveInternships(data);
    await createInternshipDeadlineTask(internship);
    window.toggleInternshipForm();
    loadInternships();
};

window.openInternshipEdit = async function (id) {
    const data = await getInternshipsData();
    const internship = data.find(i => i.id === id);
    if (!internship) return;
    document.getElementById('edit-internship-id').value = id;
    document.getElementById('edit-internship-name').value = internship.name || '';
    document.getElementById('edit-internship-period').value = internship.period || '';
    document.getElementById('edit-internship-url').value = internship.applicationUrl || '';
    document.getElementById('edit-internship-official-due').value = internship.officialDueDate || '';
    document.getElementById('edit-internship-personal-due').value = internship.personalDueDate || '';
    document.getElementById('edit-internship-instructions').value = internship.instructions || '';
    renderEditInternshipContacts(internship.contacts || []);
    document.getElementById('internship-edit-overlay').classList.add('visible');
};

function renderEditInternshipContacts(contacts) {
    const container = document.getElementById('edit-internship-contacts');
    if (!container) return;
    container.innerHTML = '';
    (contacts.length ? contacts : [{ name: '', role: '', email: '' }]).forEach((c, i) => {
        const row = document.createElement('div');
        row.className = 'contact-row';
        row.innerHTML = `
            <input type="text" placeholder="Name" value="${escapeHtml(c.name || '')}">
            <input type="text" placeholder="Role" value="${escapeHtml(c.role || '')}">
            <input type="text" placeholder="Email" value="${escapeHtml(c.email || '')}">
            <button type="button" class="contact-remove" onclick="this.closest('.contact-row').remove()">×</button>`;
        container.appendChild(row);
    });
}

window.addEditContact = function () {
    const container = document.getElementById('edit-internship-contacts');
    if (!container) return;
    const row = document.createElement('div');
    row.className = 'contact-row';
    row.innerHTML = `
        <input type="text" placeholder="Name">
        <input type="text" placeholder="Role">
        <input type="text" placeholder="Email">
        <button type="button" class="contact-remove" onclick="this.closest('.contact-row').remove()">×</button>`;
    container.appendChild(row);
};

window.closeInternshipEditForm = function () {
    document.getElementById('internship-edit-overlay').classList.remove('visible');
};

window.saveInternshipEdit = async function () {
    const id = document.getElementById('edit-internship-id')?.value;
    if (!id) return;
    const name = document.getElementById('edit-internship-name')?.value?.trim();
    if (!name) {
        document.getElementById('edit-internship-name')?.focus();
        return;
    }
    const period = document.getElementById('edit-internship-period')?.value?.trim() || null;
    const applicationUrl = document.getElementById('edit-internship-url')?.value?.trim() || null;
    const officialDue = document.getElementById('edit-internship-official-due')?.value || null;
    const personalDue = document.getElementById('edit-internship-personal-due')?.value || null;
    const instructions = document.getElementById('edit-internship-instructions')?.value?.trim() || '';
    const contacts = collectContactsFromForm('edit-internship-contacts');

    const data = await getInternshipsData();
    const idx = data.findIndex(i => i.id === id);
    if (idx < 0) return;
    const oldPersonalDue = data[idx].personalDueDate;
    data[idx] = { ...data[idx], name, period, applicationUrl, officialDueDate: officialDue, personalDueDate: personalDue, contacts, instructions };
    await saveInternships(data);
    if (personalDue && personalDue !== oldPersonalDue) {
        await createInternshipDeadlineTask(data[idx]);
    }
    window.closeInternshipEditForm();
    loadInternships();
};

window.deleteInternship = async function (id) {
    const data = (await getInternshipsData()).filter(i => i.id !== id);
    await saveInternships(data);
    loadInternships();
};

window.pullFromSheets = async function () {
    const btn = document.getElementById('pull-sheets-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Pulling...'; }
    try {
        const res = await fetch(`${GCAL}/sheets/pull`, { method: 'POST' });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'Pull failed');
        await loadInternships();
        if (btn) btn.textContent = 'Pulled!';
        setTimeout(() => { if (btn) { btn.disabled = false; btn.textContent = '↓ Pull from Sheets'; } }, 2000);
    } catch (e) {
        alert('Pull from Sheets failed: ' + e.message);
        if (btn) { btn.disabled = false; btn.textContent = '↓ Pull from Sheets'; }
    }
};

window.syncWithNotion = async function () {
    const btn = document.getElementById('notion-sync-btn');
    // Check if configured; if not, show setup overlay
    try {
        const statusRes = await fetch(`${NOTION_PROXY}/internships/status`);
        const status = await statusRes.json();
        if (!status.configured) {
            document.getElementById('notion-internship-setup-overlay').style.display = 'flex';
            return;
        }
    } catch (e) {
        document.getElementById('notion-internship-setup-overlay').style.display = 'flex';
        return;
    }
    if (btn) { btn.disabled = true; btn.textContent = 'Syncing...'; }
    try {
        const res = await fetch(`${CHAT_PROXY}/internships/notion-sync`, { method: 'POST' });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'Sync failed');
        await loadInternships();
        if (btn) btn.textContent = 'Synced!';
        setTimeout(() => { if (btn) { btn.disabled = false; btn.textContent = '⇅ Sync with Notion'; } }, 2000);
    } catch (e) {
        alert('Notion sync failed: ' + e.message);
        if (btn) { btn.disabled = false; btn.textContent = '⇅ Sync with Notion'; }
    }
};

window.setupNotionInternships = async function () {
    const input = document.getElementById('notion-parent-page-input');
    const raw = (input?.value || '').trim();
    if (!raw) { alert('Please enter a Notion page URL or ID.'); return; }
    // Extract 32-char hex ID from URL or plain ID
    const match = raw.replace(/-/g, '').match(/([a-f0-9]{32})/i);
    if (!match) { alert('Could not parse a valid Notion page ID from that input.'); return; }
    const parentPageId = match[1];
    const internships = await getInternshipsData();
    try {
        const res = await fetch(`${NOTION_PROXY}/internships/setup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ parentPageId, internships })
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || 'Setup failed');
        window.closeNotionSetup();
        alert('Internship Tracker database created in Notion and synced!');
    } catch (e) {
        alert('Notion setup failed: ' + e.message);
    }
};

window.closeNotionSetup = function () {
    const overlay = document.getElementById('notion-internship-setup-overlay');
    if (overlay) overlay.style.display = 'none';
};

window.markInternshipDone = async function (id) {
    const data = await getInternshipsData();
    const idx = data.findIndex(i => i.id === id);
    if (idx === -1) return;
    data[idx].submittedAt = new Date().toISOString().slice(0, 10);
    if (!data[idx].status) data[idx].status = 'applied';
    await saveInternships(data);
    renderInternships(data);
    renderSubmitted(data);
    window.switchInternshipTab('submitted');
};

window.updateInternshipStatus = async function (id, status) {
    const data = await getInternshipsData();
    const idx = data.findIndex(i => i.id === id);
    if (idx === -1) return;
    data[idx].status = status;
    await saveInternships(data);
    renderSubmitted(data);
};

window.unmarkInternshipDone = async function (id) {
    const data = await getInternshipsData();
    const idx = data.findIndex(i => i.id === id);
    if (idx === -1) return;
    delete data[idx].submittedAt;
    await saveInternships(data);
    renderInternships(data);
    renderSubmitted(data);
    window.switchInternshipTab('active');
};

async function loadSubmitted() {
    const data = await getInternshipsData();
    renderSubmitted(data);
}

function renderSubmitted(data) {
    const container = document.getElementById('submitted-container');
    if (!container) return;
    container.innerHTML = '';
    const done = (data || []).filter(i => i.submittedAt);
    if (done.length === 0) {
        container.innerHTML = '<div class="internships-loading">No submitted applications yet. Mark one as done from the Internship Tracker.</div>';
        return;
    }
    const sorted = [...done].sort((a, b) => (b.submittedAt || '').localeCompare(a.submittedAt || ''));
    sorted.forEach(internship => {
        const url = internship.applicationUrl && internship.applicationUrl.trim();
        const isValidUrl = url && (url.startsWith('http://') || url.startsWith('https://'));
        const card = document.createElement('div');
        card.className = 'internship-card';
        card.dataset.id = internship.id;
        const currentStatus = internship.status || 'applied';
        const statusLabels = { applied: 'Applied', interview: 'Interview', offer: 'Offer', rejected: 'Rejected' };
        const pillsHtml = Object.entries(statusLabels).map(([val, label]) =>
            `<button class="app-status-pill ${currentStatus === val ? `active-pill-${val}` : ''}" data-id="${internship.id}" data-status="${val}">${label}</button>`
        ).join('');
        card.innerHTML = `
            <div class="internship-card-header">
                <span class="internship-expand-icon">▶</span>
                <div class="internship-card-info">
                    <div class="internship-card-name">${escapeHtml(internship.name || 'Untitled')}</div>
                    <div class="internship-card-meta">
                        ${internship.period ? `<span>Period: ${escapeHtml(internship.period)}</span>` : ''}
                        ${internship.submittedAt ? `<span>Submitted: ${internship.submittedAt}</span>` : ''}
                    </div>
                </div>
                <div class="app-status-pills">${pillsHtml}</div>
                <div class="internship-card-actions">
                    ${isValidUrl ? `<a href="${escapeHtml(url)}" class="internship-open-link" target="_blank" rel="noopener noreferrer">Open</a>` : ''}
                    <button class="task-status-btn submitted-undo-btn" data-id="${internship.id}" style="color:#949ba4;">↩ Undo</button>
                </div>
            </div>
            <div class="internship-card-body">
                ${internship.officialDueDate || internship.personalDueDate ? `
                <div class="internship-subsection">
                    <div class="internship-subsection-title">DEADLINES</div>
                    <div style="font-size:13px;color:#949ba4;">
                        ${internship.officialDueDate ? `Official: ${internship.officialDueDate}` : ''}
                        ${internship.officialDueDate && internship.personalDueDate ? ' • ' : ''}
                        ${internship.personalDueDate ? `Target: ${internship.personalDueDate}` : ''}
                    </div>
                </div>` : ''}
                ${(internship.contacts || []).length ? `
                <div class="internship-subsection">
                    <div class="internship-subsection-title">CONTACTS</div>
                    <div class="contact-rows">${(internship.contacts || []).map(c => `
                        <div class="contact-row">
                            <input type="text" value="${escapeHtml(c.name || '')}" placeholder="Name" readonly>
                            <input type="text" value="${escapeHtml(c.role || '')}" placeholder="Role" readonly>
                            <input type="text" value="${escapeHtml(c.email || '')}" placeholder="Email" readonly>
                        </div>`).join('')}
                    </div>
                </div>` : ''}
            </div>`;
        container.appendChild(card);
    });

    container.querySelectorAll('.internship-card-header').forEach(header => {
        header.addEventListener('click', () => header.closest('.internship-card').classList.toggle('expanded'));
    });
    container.querySelectorAll('.submitted-undo-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            window.unmarkInternshipDone(btn.dataset.id);
        });
    });
    container.querySelectorAll('.app-status-pill').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            window.updateInternshipStatus(btn.dataset.id, btn.dataset.status);
        });
    });
}

// --- RECOMMENDED INTERNSHIPS ---
async function loadRecommendations() {
    const container = document.getElementById('recommended-items');
    if (!container) return;
    try {
        const res = await fetch(`${CHAT_PROXY}/recommendations`);
        const data = await res.json();
        renderRecommendations(data);
    } catch (e) {
        console.error('Recommendations load error:', e);
        container.innerHTML = '<div class="internships-loading">Failed to load recommendations.</div>';
    }
}

function renderRecommendations(data) {
    const container = document.getElementById('recommended-items');
    const lastFetchedEl = document.getElementById('recommended-last-fetched');
    if (!container) return;

    if (lastFetchedEl && data.lastFetched) {
        const d = new Date(data.lastFetched);
        lastFetchedEl.textContent = `Last updated: ${d.toLocaleDateString()} ${d.toLocaleTimeString()}${data.stale ? ' (stale)' : ''}`;
    } else if (lastFetchedEl) {
        lastFetchedEl.textContent = '';
    }

    const items = data.items || [];
    if (items.length === 0) {
        if (!data.lastFetched) {
            container.innerHTML = '<div class="internships-loading">Configure your mailing list email in Settings, then click Refresh.</div>';
        } else {
            container.innerHTML = '<div class="internships-loading">No opportunities found in recent emails. Try clicking Refresh.</div>';
        }
        return;
    }

    container.innerHTML = '';
    items.forEach((item, idx) => {
        const card = document.createElement('div');
        card.className = 'internship-card';
        const deadlineHtml = item.deadline
            ? `<span class="internship-status-badge on-track">${item.deadline}</span>`
            : '';
        const url = item.applicationUrl && item.applicationUrl.trim();
        const isValidUrl = url && (url.startsWith('http://') || url.startsWith('https://'));
        card.innerHTML = `
            <div class="internship-card-header">
                <div class="internship-card-info" style="flex:1;">
                    <div class="internship-card-name">${escapeHtml(item.name || 'Untitled')}</div>
                    <div class="internship-card-meta">
                        ${item.company ? `<span>${escapeHtml(item.company)}</span>` : ''}
                        ${deadlineHtml}
                    </div>
                    ${item.description ? `<div style="color:#949ba4; font-size:12px; margin-top:4px;">${escapeHtml(item.description)}</div>` : ''}
                </div>
                <div class="internship-card-actions">
                    ${isValidUrl ? `<a href="${escapeHtml(url)}" class="internship-open-link" target="_blank" rel="noopener noreferrer">View</a>` : ''}
                    <button class="task-status-btn rec-add-btn" data-idx="${idx}" style="color:#43b581;">+ Add to Tracker</button>
                </div>
            </div>`;
        container.appendChild(card);
    });

    container.querySelectorAll('.rec-add-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt(btn.dataset.idx);
            addRecommendedToTracker(items[idx]);
        });
    });
}

window.refreshRecommendations = async function () {
    const btn = document.getElementById('refresh-recommendations-btn');
    const container = document.getElementById('recommended-items');
    if (btn) btn.textContent = 'Refreshing...';
    if (btn) btn.disabled = true;
    try {
        const res = await fetch(`${CHAT_PROXY}/recommendations/refresh`, { method: 'POST' });
        const data = await res.json();
        if (data.error) {
            container.innerHTML = `<div class="internships-loading">${escapeHtml(data.error)}</div>`;
        } else {
            renderRecommendations(data);
        }
    } catch (e) {
        console.error('Recommendations refresh error:', e);
        container.innerHTML = '<div class="internships-loading">Failed to refresh. Check if proxies are running.</div>';
    }
    if (btn) { btn.textContent = 'Refresh'; btn.disabled = false; }
};

function addRecommendedToTracker(item) {
    window.switchInternshipTab('active');
    const form = document.getElementById('add-internship-form');
    if (!form.classList.contains('visible')) form.classList.add('visible');
    document.getElementById('new-internship-name').value = item.company
        ? `${item.company} - ${item.name}`
        : item.name || '';
    document.getElementById('new-internship-url').value = item.applicationUrl || '';
    document.getElementById('new-internship-official-due').value = item.deadline || '';
    document.getElementById('new-internship-personal-due').value = '';
    document.getElementById('new-internship-period').value = '';
    const instructionsEl = document.getElementById('new-internship-instructions');
    if (instructionsEl) instructionsEl.value = item.description || '';
}

window.saveRecommendationsConfig = async function () {
    const sender = document.getElementById('rec-sender-email')?.value?.trim() || '';
    const account = parseInt(document.getElementById('rec-account')?.value) || 1;
    try {
        await fetch(`${CHAT_PROXY}/recommendations/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sender, account })
        });
        const msg = document.getElementById('rec-save-msg');
        if (msg) { msg.style.display = ''; setTimeout(() => msg.style.display = 'none', 2000); }
    } catch (e) {
        console.error('Failed to save recommendations config:', e);
    }
};

async function loadRecommendationsConfig() {
    try {
        const res = await fetch(`${CHAT_PROXY}/recommendations/config`);
        const cfg = await res.json();
        const senderEl = document.getElementById('rec-sender-email');
        const accountEl = document.getElementById('rec-account');
        if (senderEl && cfg.sender) senderEl.value = cfg.sender;
        if (accountEl && cfg.account) accountEl.value = cfg.account;
    } catch (e) { }
}

// --- ADD TASK FORM ---
let schemaLoaded = false;
let selectedTags = [];

window.toggleAddForm = async function () {
    const form = document.getElementById('add-task-form');
    const isVisible = form.classList.contains('visible');
    if (isVisible) {
        form.classList.remove('visible');
        return;
    }
    form.classList.add('visible');
    if (!schemaLoaded) {
        try {
            const res = await fetch(`${PROXY}/schema`);
            const schema = await res.json();

            // Populate Priority dropdown
            const prioSelect = document.getElementById('new-task-priority');
            schema.priority.forEach(p => {
                const opt = document.createElement('option');
                opt.value = p; opt.textContent = p;
                prioSelect.appendChild(opt);
            });

            // Populate Tags as clickable chips
            const tagsContainer = document.getElementById('new-task-tags');
            tagsContainer.innerHTML = '';
            schema.taskType.forEach(tag => {
                const chip = document.createElement('div');
                chip.className = 'tag-option';
                chip.textContent = tag;
                chip.addEventListener('click', () => {
                    chip.classList.toggle('selected');
                    if (chip.classList.contains('selected')) {
                        selectedTags.push(tag);
                    } else {
                        selectedTags = selectedTags.filter(t => t !== tag);
                    }
                });
                tagsContainer.appendChild(chip);
            });

            schemaLoaded = true;
        } catch (e) {
            console.error('Schema load error:', e);
        }
    }
};

window.createTask = async function () {
    const name = document.getElementById('new-task-name').value.trim();
    if (!name) { document.getElementById('new-task-name').focus(); return; }

    const btn = document.getElementById('create-task-btn');
    btn.disabled = true;
    btn.innerText = 'Creating...';

    const payload = {
        name,
        status: 'To Do',
        dueDate: document.getElementById('new-task-due').value || null,
        priority: document.getElementById('new-task-priority').value || null,
        taskTypes: selectedTags.length ? selectedTags : null,
        description: document.getElementById('new-task-desc').value.trim() || null,
    };

    try {
        await fetch(`${PROXY}/tasks/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        // Reset form
        document.getElementById('new-task-name').value = '';
        document.getElementById('new-task-desc').value = '';
        document.getElementById('new-task-due').value = '';
        document.getElementById('new-task-priority').value = '';
        selectedTags = [];
        document.querySelectorAll('#new-task-tags .tag-option').forEach(c => c.classList.remove('selected'));

        btn.innerText = 'Create Task';
        btn.disabled = false;
        document.getElementById('add-task-form').classList.remove('visible');
        loadTasks();
    } catch (e) {
        console.error('Create task error:', e);
        btn.innerText = 'Error — Retry';
        btn.disabled = false;
    }
};

// --- EDIT TASK ---
let editSelectedTags = [];

window.openEditTask = async function (id) {
    const task = cachedTasks.find(t => t.id === id);
    if (!task) return;

    if (!schemaLoaded) {
        await window.toggleAddForm(); // Helper to load schema first
        document.getElementById('add-task-form').classList.remove('visible'); // Hide the add form itself
    }

    document.getElementById('edit-task-id').value = task.id;
    document.getElementById('edit-task-name').value = task.name || '';
    document.getElementById('edit-task-desc').value = task.description || '';
    document.getElementById('edit-task-due').value = task.dueDate || '';

    // Setup Priority dropdown
    const prioSelect = document.getElementById('edit-task-priority');
    prioSelect.innerHTML = '<option value="">None</option>';
    try {
        const res = await fetch(`${PROXY}/schema`);
        const schema = await res.json();
        schema.priority.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p; opt.textContent = p;
            prioSelect.appendChild(opt);
        });
    } catch (e) { }
    prioSelect.value = task.priority || '';

    // Setup Tags
    editSelectedTags = [...(task.tags || [])];
    const tagsContainer = document.getElementById('edit-task-tags');
    tagsContainer.innerHTML = '';
    try {
        const res = await fetch(`${PROXY}/schema`);
        const schema = await res.json();
        schema.taskType.forEach(tag => {
            const chip = document.createElement('div');
            chip.className = 'tag-option' + (editSelectedTags.includes(tag) ? ' selected' : '');
            chip.textContent = tag;
            chip.addEventListener('click', () => {
                chip.classList.toggle('selected');
                if (chip.classList.contains('selected')) {
                    editSelectedTags.push(tag);
                } else {
                    editSelectedTags = editSelectedTags.filter(t => t !== tag);
                }
            });
            tagsContainer.appendChild(chip);
        });
    } catch (e) { }

    document.getElementById('task-edit-overlay').classList.add('visible');
};

window.closeEditTaskForm = function () {
    document.getElementById('task-edit-overlay').classList.remove('visible');
};

window.saveTaskEdit = async function () {
    const id = document.getElementById('edit-task-id').value;
    const btn = document.getElementById('edit-task-save');
    btn.disabled = true;
    btn.innerText = 'Saving...';

    const payload = {
        id,
        name: document.getElementById('edit-task-name').value.trim(),
        description: document.getElementById('edit-task-desc').value.trim() || "", // Send empty string instead of null if empty
        dueDate: document.getElementById('edit-task-due').value || null,
        priority: document.getElementById('edit-task-priority').value || null,
        taskTypes: editSelectedTags
    };

    try {
        await fetch(`${PROXY}/tasks/update`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        btn.innerText = 'Save Changes';
        btn.disabled = false;
        window.closeEditTaskForm();
        loadTasks();
    } catch (e) {
        console.error('Save task error:', e);
        btn.innerText = 'Error — Retry';
        btn.disabled = false;
    }
};

// --- GOOGLE CALENDAR ---
const GCAL = 'http://127.0.0.1:19878';
let cachedCalEvents = {};

let calAuthenticated = null;
let calListLoaded = false;

async function initCalendar() {
    try {
        const res = await fetch(`${GCAL}/gcal/status`);
        const data = await res.json();

        const hasAuth = data.account1 || data.account2;
        calAuthenticated = hasAuth;

        if (hasAuth) {
            document.getElementById('cal-auth').style.display = 'none';
            document.getElementById('cal-events').style.display = 'block';

            document.getElementById('hdr-auth-btn-1').style.display = data.account1 ? 'none' : 'inline-block';
            document.getElementById('hdr-auth-btn-2').style.display = data.account2 ? 'none' : 'inline-block';

            if (!calListLoaded) {
                if (currentCalView === 'list') loadCalEvents();
                else loadCalWeek();
            }
        } else {
            document.getElementById('cal-auth').style.display = 'block';
            document.getElementById('cal-events').style.display = 'none';
        }
    } catch (e) {
        console.error('Calendar init error:', e);
    }
}

window.startCalAuth = async function (account) {
    try {
        // Trigger browser opening for consent
        await fetch(`${GCAL}/gcal/auth?account=${account}`);

        // Poll for auth completion
        const poll = setInterval(async () => {
            const res = await fetch(`${GCAL}/gcal/status`);
            const data = await res.json();
            if (data[`account${account}`]) {
                clearInterval(poll);
                initCalendar();
            }
        }, 2000);
    } catch (e) {
        console.error('Auth error:', e);
    }
};

async function loadCalEvents() {
    const list = document.getElementById('cal-list');
    list.innerHTML = '<div class="tasks-loading">Loading events...</div>';
    try {
        const res = await fetch(`${GCAL}/gcal/events`);
        const events = await res.json();
        if (!events.length) {
            list.innerHTML = '<div class="tasks-loading">No upcoming events \u2728</div>';
            return;
        }
        list.innerHTML = '';

        // Group by day
        const days = {};
        events.forEach(ev => {
            const d = ev.allDay ? ev.start : ev.start.split('T')[0];
            if (!days[d]) days[d] = [];
            days[d].push(ev);
        });

        const today = new Date().toISOString().split('T')[0];
        const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];

        Object.keys(days).sort().forEach(day => {
            const header = document.createElement('div');
            header.className = 'cal-day-header';
            if (day === today) header.textContent = '\ud83d\udfe2 TODAY';
            else if (day === tomorrow) header.textContent = '\ud83d\udfe1 TOMORROW';
            else header.textContent = day;
            list.appendChild(header);

            days[day].forEach(ev => {
                cachedCalEvents[ev.id] = ev;
                const card = document.createElement('div');
                card.className = 'cal-event';
                if (ev.color) card.style.borderLeftColor = ev.color;
                let timeStr = '';
                if (!ev.allDay) {
                    const start = new Date(ev.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
                    const end = new Date(ev.end).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
                    timeStr = `${start} \u2013 ${end}`;
                } else {
                    timeStr = 'All day';
                }
                card.innerHTML = `
                    <div class="ev-time">${timeStr}</div>
                    <div class="ev-title">${ev.title}</div>
                    ${ev.location ? `<div class="ev-loc">\ud83d\udccd ${ev.location}</div>` : ''}
                    <div class="cal-event-actions">
                        <button onclick="window.openEditEvent('${ev.id}')">\u270f Edit</button>
                        <button class="del" onclick="window.deleteCalEvent('${ev.id}')">\ud83d\uddd1 Delete</button>
                    </div>
                `;
                list.appendChild(card);
            });
        });
        calListLoaded = true;
    } catch (e) {
        console.error('Events load error:', e);
        list.innerHTML = '<div class="tasks-loading">Failed to load events</div>';
    }
}

window.loadCalEvents = loadCalEvents;

let currentCalView = 'list';

window.setCalView = function (view) {
    currentCalView = view;
    document.querySelectorAll('.cal-view-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.view === view);
    });
    document.getElementById('cal-list').style.display = view === 'list' ? 'block' : 'none';
    document.getElementById('cal-week').style.display = view === 'week' ? 'block' : 'none';
    if (view === 'list') loadCalEvents();
    else loadCalWeek();
};

window.refreshCalView = function () {
    if (currentCalView === 'list') loadCalEvents();
    else loadCalWeek();
};

async function loadCalWeek() {
    const container = document.getElementById('cal-week');
    container.innerHTML = '<div class="tasks-loading">Loading week...</div>';
    try {
        const res = await fetch(`${GCAL}/gcal/events/week`);
        const { events, weekStart } = await res.json();
        const monday = new Date(weekStart);
        const todayStr = new Date().toISOString().split('T')[0];
        const dayNames = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

        // Build day buckets
        const days = [];
        for (let i = 0; i < 7; i++) {
            const d = new Date(monday.getTime() + i * 86400000);
            const dateStr = d.toISOString().split('T')[0];
            days.push({
                name: dayNames[i],
                num: d.getDate(),
                dateStr,
                isToday: dateStr === todayStr,
                events: []
            });
        }

        // Sort events into days
        events.forEach(ev => {
            const evDate = ev.allDay ? ev.start : ev.start.split('T')[0];
            const day = days.find(d => d.dateStr === evDate);
            if (day) day.events.push(ev);
        });

        container.innerHTML = '';
        const grid = document.createElement('div');
        grid.className = 'week-grid';

        days.forEach(day => {
            const col = document.createElement('div');
            col.className = 'week-col' + (day.isToday ? ' today' : '');
            col.innerHTML = `<div class="week-day-header">${day.name}<span class="day-num">${day.num}</span></div>`;

            day.events.forEach(ev => {
                cachedCalEvents[ev.id] = ev;
                const card = document.createElement('div');
                card.className = 'week-ev';
                card.style.cursor = 'pointer';
                card.onclick = () => window.openEditEvent(ev.id);
                if (ev.color) {
                    card.style.borderLeftColor = ev.color;
                    card.style.background = ev.color + '33';
                }
                let timeStr = 'All day';
                if (!ev.allDay) {
                    timeStr = new Date(ev.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
                }
                card.innerHTML = `<div class="we-time">${timeStr}</div><div class="we-title">${ev.title}</div>`;
                col.appendChild(card);
            });

            grid.appendChild(col);
        });

        container.appendChild(grid);
        calListLoaded = true;
    } catch (e) {
        console.error('Week load error:', e);
        container.innerHTML = '<div class="tasks-loading">Failed to load week</div>';
    }
}

window.toggleCalForm = function () {
    const form = document.getElementById('cal-add-form');
    form.classList.toggle('visible');
    if (form.classList.contains('visible')) {
        // Default start to next hour, end to +1 hour
        const now = new Date();
        now.setMinutes(0, 0, 0);
        now.setHours(now.getHours() + 1);
        const end = new Date(now.getTime() + 3600000);
        document.getElementById('cal-ev-start').value = toLocalISO(now);
        document.getElementById('cal-ev-end').value = toLocalISO(end);
    }
};

function toLocalISO(d) {
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

window.createCalEvent = async function () {
    const title = document.getElementById('cal-ev-title').value.trim();
    if (!title) { document.getElementById('cal-ev-title').focus(); return; }
    const btn = document.getElementById('cal-create-btn');
    btn.disabled = true;
    btn.innerText = 'Creating...';

    const startLocal = document.getElementById('cal-ev-start').value;
    const endLocal = document.getElementById('cal-ev-end').value;
    const startTime = new Date(startLocal).toISOString();
    const endTime = new Date(endLocal).toISOString();
    const location = document.getElementById('cal-ev-loc').value.trim() || null;

    try {
        await fetch(`${GCAL}/gcal/events/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title, startTime, endTime, location })
        });
        document.getElementById('cal-ev-title').value = '';
        document.getElementById('cal-ev-loc').value = '';
        document.getElementById('cal-add-form').classList.remove('visible');
        btn.innerText = 'Create Event';
        btn.disabled = false;
        loadCalEvents();
    } catch (e) {
        btn.innerText = 'Error — Retry';
        btn.disabled = false;
    }
};

window.deleteCalEvent = async function (id) {
    try {
        await fetch(`${GCAL}/gcal/events/delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id })
        });
        window.refreshCalView();
    } catch (e) {
        console.error('Delete error:', e);
    }
};

// --- EDIT EVENT ---
window.openEditEvent = function (id) {
    const ev = cachedCalEvents[id];
    if (!ev) return;
    document.getElementById('edit-ev-id').value = ev.id;
    document.getElementById('edit-ev-calid').value = ev.calendarId || 'primary';
    document.getElementById('edit-ev-title').value = ev.title;
    document.getElementById('edit-ev-loc').value = ev.location || '';
    if (!ev.allDay && ev.start) {
        document.getElementById('edit-ev-start').value = toLocalISO(new Date(ev.start));
        document.getElementById('edit-ev-end').value = toLocalISO(new Date(ev.end));
    }
    document.getElementById('cal-edit-overlay').classList.add('visible');
};

window.closeEditForm = function () {
    document.getElementById('cal-edit-overlay').classList.remove('visible');
};

window.saveEventEdit = async function () {
    const id = document.getElementById('edit-ev-id').value;
    const btn = document.getElementById('edit-ev-save');
    btn.disabled = true;
    btn.innerText = 'Saving...';

    const title = document.getElementById('edit-ev-title').value.trim();
    const startLocal = document.getElementById('edit-ev-start').value;
    const endLocal = document.getElementById('edit-ev-end').value;
    const location = document.getElementById('edit-ev-loc').value.trim();

    const payload = { id };
    if (title) payload.title = title;
    if (startLocal) payload.startTime = new Date(startLocal).toISOString();
    if (endLocal) payload.endTime = new Date(endLocal).toISOString();
    payload.location = location;

    try {
        await fetch(`${GCAL}/gcal/events/update`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        btn.innerText = 'Save Changes';
        btn.disabled = false;
        window.closeEditForm();
        window.refreshCalView();
    } catch (e) {
        btn.innerText = 'Error \u2014 Retry';
        btn.disabled = false;
    }
};

// --- CHAT ASSISTANT ---
let chatHistory = [];

async function loadChatHistory() {
    try {
        const res = await fetch(`${CHAT_PROXY}/chat/history`);
        const data = await res.json();
        if (!data.history || !Array.isArray(data.history)) return;
        chatHistory = data.history;
        const historyDiv = document.getElementById('chat-history');
        if (!historyDiv) return;
        historyDiv.innerHTML = '';
        for (const item of chatHistory) {
            const role = item.role;
            const parts = item.parts || [];
            for (const p of parts) {
                if (p.text) {
                    const isUser = role === 'user';
                    const msgDiv = document.createElement('div');
                    msgDiv.className = `chat-msg ${isUser ? 'user' : 'ai'}`;
                    let text = p.text;
                    text = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
                    text = text.replace(/\n/g, '<br>');
                    msgDiv.innerHTML = text;
                    historyDiv.appendChild(msgDiv);
                }
            }
        }
        historyDiv.scrollTop = historyDiv.scrollHeight;
    } catch (e) {
        console.error('Failed to load chat history:', e);
    }
}

function addChatMsg(text, isUser) {
    const historyDiv = document.getElementById('chat-history');
    const msgDiv = document.createElement('div');
    msgDiv.className = `chat-msg ${isUser ? 'user' : 'ai'}`;

    // Convert basic markdown-like bolding and newlines if needed
    text = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/\n/g, '<br>');

    msgDiv.innerHTML = text;
    historyDiv.appendChild(msgDiv);
    historyDiv.scrollTop = historyDiv.scrollHeight;
    return msgDiv;
}

async function sendChatMessageCore(message, opts = {}) {
    const { playTTS = false } = opts;
    const input = document.getElementById('chat-input');
    const btn = document.getElementById('chat-send');
    const micBtn = document.getElementById('chat-mic');

    if (!message) return;

    input.value = '';
    btn.disabled = true;
    if (micBtn) micBtn.disabled = true;

    addChatMsg(message, true);
    const thinkingMsg = addChatMsg('Thinking', false);
    let dotCount = 0;
    const thinkingInterval = setInterval(() => {
        dotCount = (dotCount % 3) + 1;
        thinkingMsg.innerText = 'Thinking' + '.'.repeat(dotCount);
    }, 400);

    try {
        const res = await fetch(`${CHAT_PROXY}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message, history: chatHistory })
        });
        const data = await res.json();

        if (data.error) throw new Error(data.error);

        chatHistory = data.history;
        thinkingMsg.innerHTML = data.text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');

        if (playTTS && data.text && window.speechSynthesis) {
            const u = new SpeechSynthesisUtterance(data.text);
            u.rate = 1;
            u.pitch = 1;
            speechSynthesis.speak(u);
        }

        setTimeout(() => {
            loadTasks();
            loadInternships();
            if (calAuthenticated) window.refreshCalView();
        }, 500);

    } catch (e) {
        console.error('Chat error:', e);
        if (e.message && e.message.includes('RATE_LIMIT')) {
            thinkingMsg.innerText = 'Gemini API free tier limit reached. Please wait a minute and try again.';
        } else {
            thinkingMsg.innerText = 'Sorry, I ran into an error connecting to my brain.';
        }
    } finally {
        clearInterval(thinkingInterval);
        btn.disabled = false;
        if (micBtn) micBtn.disabled = false;
        document.getElementById('chat-history').scrollTop = document.getElementById('chat-history').scrollHeight;
    }
}

window.sendChatMessage = async function () {
    const message = document.getElementById('chat-input')?.value?.trim();
    if (!message) return;
    await sendChatMessageCore(message, { playTTS: false });
};

// --- VOICE INPUT ---
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let voiceRecognition = null;
let isListening = false;
let voiceTranscript = '';

window.toggleVoiceInput = function () {
    if (!SpeechRecognition) {
        console.warn('Speech recognition not supported in this browser.');
        return;
    }
    const micBtn = document.getElementById('chat-mic');
    const sendBtn = document.getElementById('chat-send');

    if (isListening) {
        if (voiceRecognition) voiceRecognition.stop();
        return;
    }

    voiceTranscript = '';
    voiceRecognition = voiceRecognition || new SpeechRecognition();
    voiceRecognition.continuous = true;
    voiceRecognition.interimResults = false;
    voiceRecognition.lang = 'en-US';

    voiceRecognition.onstart = () => {
        isListening = true;
        micBtn?.classList.add('listening');
        sendBtn.disabled = true;
    };

    voiceRecognition.onend = () => {
        isListening = false;
        micBtn?.classList.remove('listening');
        sendBtn.disabled = false;
        if (voiceTranscript.trim()) {
            sendChatMessageCore(voiceTranscript.trim(), { playTTS: true });
        }
    };

    voiceRecognition.onresult = (e) => {
        for (let i = 0; i < e.results.length; i++) {
            if (e.results[i].isFinal) {
                voiceTranscript += e.results[i][0].transcript + ' ';
            }
        }
    };

    voiceRecognition.onerror = (e) => {
        if (e.error !== 'aborted') console.warn('Speech recognition error:', e.error);
    };

    voiceRecognition.start();
};

// Add enter key listener for chat input
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('chat-input').addEventListener('keypress', function (e) {
        if (e.key === 'Enter') {
            window.sendChatMessage();
        }
    });
});

// Global click handler for external links (obsidian://, http://, https://)
document.addEventListener('click', (e) => {
    const link = e.target.closest('a[href^="obsidian://"], a[href^="http://"], a[href^="https://"]');
    if (link) {
        e.preventDefault();
        e.stopPropagation();
        const url = link.getAttribute('href');
        if (window.electronAPI && window.electronAPI.openExternal) {
            window.electronAPI.openExternal(url);
        } else {
            window.open(url, '_blank');
        }
    }
});

// --- SPOTIFY PLAYER ---
let spotifyPollingInterval = null;

async function initSpotify() {
    if (!window.spotifyAPI) return;

    const status = await window.spotifyAPI.getStatus();

    // If not authenticated, the UI defaults to "Not Connected"
    if (status && status.isAuthenticated) {
        document.getElementById('spotify-connect-btn').style.display = 'none';
        document.getElementById('spotify-controls').style.display = 'flex';

        // Start polling for current playback
        updateSpotifyPlayer();
        spotifyPollingInterval = setInterval(updateSpotifyPlayer, 5000);
    } else {
        document.getElementById('spotify-connect-btn').style.display = 'block';
        document.getElementById('spotify-controls').style.display = 'none';
        document.getElementById('spotify-title').innerText = 'Not Connected';
        document.getElementById('spotify-artist').innerText = 'Click to link your Spotify account';
        document.getElementById('spotify-art').innerHTML = `
            <svg width="24" height="24" viewBox="0 0 24 24" fill="#666">
                <path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm0 18c-4.411 0-8-3.589-8-8s3.589-8 8-8 8 3.589 8 8-3.589 8-8 8z"/>
                <path d="M12 6c-3.309 0-6 2.691-6 6s2.691 6 6 6 6-2.691 6-6-2.691-6-6-6zm0 10c-2.206 0-4-1.794-4-4s1.794-4 4-4 4 1.794 4 4-1.794 4-4 4z"/>
                <path d="M12 9c-1.654 0-3 1.346-3 3s1.346 3 3 3 3-1.346 3-3-1.346-3-3-3z"/>
            </svg>
        `;
    }
}

async function updateSpotifyPlayer() {
    try {
        const player = await window.spotifyAPI.getPlayer();

        if (!player || !player.item) {
            document.getElementById('spotify-title').innerText = 'Nothing playing';
            document.getElementById('spotify-artist').innerText = 'Open Spotify and hit play';
            document.getElementById('spotify-art').innerHTML = `
                <svg width="24" height="24" viewBox="0 0 24 24" fill="#666">
                    <path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm0 18c-4.411 0-8-3.589-8-8s3.589-8 8-8 8 3.589 8 8-3.589 8-8 8z"/>
                    <path d="M12 6c-3.309 0-6 2.691-6 6s2.691 6 6 6 6-2.691 6-6-2.691-6-6-6zm0 10c-2.206 0-4-1.794-4-4s1.794-4 4-4 4 1.794 4 4-1.794 4-4 4z"/>
                    <path d="M12 9c-1.654 0-3 1.346-3 3s1.346 3 3 3 3-1.346 3-3-1.346-3-3-3z"/>
                </svg>
            `;
            return;
        }

        const track = player.item;
        document.getElementById('spotify-title').innerText = track.name;
        document.getElementById('spotify-artist').innerText = track.artists.map(a => a.name).join(', ');

        if (track.album && track.album.images && track.album.images.length > 0) {
            const artUrl = track.album.images[0].url;
            document.getElementById('spotify-art').innerHTML = `<img src="${artUrl}" class="spotify-art" alt="Album Art">`;
        }

        // Update Play/Pause button
        const playBtn = document.getElementById('spotify-play-pause');
        if (player.is_playing) {
            playBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';
            playBtn.dataset.playing = 'true';
        } else {
            playBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
            playBtn.dataset.playing = 'false';
        }

    } catch (e) {
        console.error('Failed to update Spotify player:', e);
    }
}

window.connectSpotify = function () {
    window.spotifyAPI.login();
    // Poll for auth completion
    const poll = setInterval(async () => {
        const status = await window.spotifyAPI.getStatus();
        if (status && status.isAuthenticated) {
            clearInterval(poll);
            initSpotify();
        }
    }, 2000);
};

window.spotifyAction = async function (action) {
    try {
        if (action === 'toggle') {
            const playBtn = document.getElementById('spotify-play-pause');
            const isPlaying = playBtn.dataset.playing === 'true';

            // Optimistic UI update
            if (isPlaying) {
                playBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
                playBtn.dataset.playing = 'false';
                await window.spotifyAPI.pause();
            } else {
                playBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';
                playBtn.dataset.playing = 'true';
                await window.spotifyAPI.play();
            }
        } else if (action === 'next') {
            await window.spotifyAPI.next();
        } else if (action === 'previous') {
            await window.spotifyAPI.previous();
        }

        // Force an update shortly after the action
        setTimeout(updateSpotifyPlayer, 500);

    } catch (e) {
        console.error(`Spotify action ${action} failed:`, e);
    }
};

// Initialize on load
setTimeout(initSpotify, 1500);
