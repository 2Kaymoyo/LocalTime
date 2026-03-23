/**
 * Local Google Calendar and Gmail API proxy.
 * Handles OAuth 2.0 auth flow and routes all API calls
 * through curl --insecure to bypass Cisco Umbrella SSL.
 */
const http = require('http');
const { execFileSync, exec } = require('child_process');
const ical = require('node-ical');
const fs = require('fs');
const path = require('path');
const url = require('url');

const CREDS_PATH = path.join(__dirname, 'google-credentials.json');
const SCOPES = 'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/gmail.readonly';

let creds = null;
let tokens = { 1: null, 2: null };

function getTokenPath(account) {
    return path.join(__dirname, `google-token-${account}.json`);
}

function loadCreds() {
    if (fs.existsSync(CREDS_PATH)) {
        const raw = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
        creds = raw.installed || raw.web;
    }
}

function loadTokens() {
    let loadedAny = false;
    for (const acc of [1, 2]) {
        const p = getTokenPath(acc);
        if (fs.existsSync(p)) {
            tokens[acc] = JSON.parse(fs.readFileSync(p, 'utf8'));
            loadedAny = true;
        } else if (acc === 1 && fs.existsSync(path.join(__dirname, 'google-token.json'))) {
            // Migrate legacy token
            tokens[1] = JSON.parse(fs.readFileSync(path.join(__dirname, 'google-token.json'), 'utf8'));
            saveTokens(1, tokens[1]);
            loadedAny = true;
        }
    }
    return loadedAny;
}

function saveTokens(acc, t) {
    tokens[acc] = t;
    fs.writeFileSync(getTokenPath(acc), JSON.stringify(t, null, 2));
}

function curlPost(reqUrl, body) {
    const args = [
        '-s', '--insecure', '-X', 'POST', reqUrl,
        '-H', 'Content-Type: application/x-www-form-urlencoded',
        '-d', body
    ];
    const result = execFileSync('curl', args, { timeout: 15000 });
    return JSON.parse(result.toString());
}

function apiCurl(account, method, fullUrl, body) {
    const t = tokens[account];
    if (t && t.expiry_date && Date.now() >= t.expiry_date) {
        refreshAccessToken(account);
    }
    if (!t || !t.access_token) return { error: true, message: `Account ${account} not authenticated` };

    const args = [
        '-s', '--insecure', '-X', method, fullUrl,
        '-H', `Authorization: Bearer ${t.access_token}`,
        '-H', 'Content-Type: application/json',
    ];
    if (body) args.push('-d', JSON.stringify(body));
    try {
        const result = execFileSync('curl', args, { timeout: 15000 });
        return JSON.parse(result.toString());
    } catch (e) {
        return { error: true, message: e.message };
    }
}

function refreshAccessToken(account) {
    const t = tokens[account];
    if (!t || !t.refresh_token) return;
    const body = [
        `client_id=${creds.client_id}`,
        `client_secret=${creds.client_secret}`,
        `refresh_token=${t.refresh_token}`,
        'grant_type=refresh_token'
    ].join('&');
    const data = curlPost(creds.token_uri, body);
    if (data.access_token) {
        t.access_token = data.access_token;
        t.expiry_date = Date.now() + (data.expires_in * 1000);
        saveTokens(account, t);
    }
}

function exchangeCodeForTokens(account, code, redirectUri) {
    const body = [
        `code=${encodeURIComponent(code)}`,
        `client_id=${creds.client_id}`,
        `client_secret=${creds.client_secret}`,
        `redirect_uri=${encodeURIComponent(redirectUri)}`,
        'grant_type=authorization_code'
    ].join('&');
    const data = curlPost(creds.token_uri, body);
    if (data.access_token) {
        data.expiry_date = Date.now() + (data.expires_in * 1000);
        saveTokens(account, data);
        return true;
    }
    return false;
}

function startAuthCallbackServer(account) {
    return new Promise((resolve) => {
        const srv = http.createServer((req, res) => {
            const parsed = url.parse(req.url, true);
            if (parsed.pathname === '/callback' && parsed.query.code) {
                const acc = parseInt(parsed.query.account) || account;
                const ok = exchangeCodeForTokens(acc, parsed.query.code, `http://localhost:19877/callback?account=${acc}`);
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(ok
                    ? `<html><body style="background:#1a1a2e;color:#f2f3f5;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><h1>✅ LocalTime Account ${acc} authorized! You can close this tab.</h1></body></html>`
                    : '<html><body style="background:#1a1a2e;color:#F04747;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><h1>❌ Authorization failed. Try again.</h1></body></html>'
                );
                srv.close();
                resolve(ok);
            } else {
                res.writeHead(404);
                res.end('Not found');
            }
        });
        srv.listen(19877, '127.0.0.1', () => {
            console.log('OAuth callback server on http://127.0.0.1:19877');
        });
    });
}

function fetchAllCalendarEvents(timeMin, timeMax) {
    const allEvents = [];
    for (const acc of [1, 2]) {
        if (!tokens[acc]) continue;

        const calList = apiCurl(acc, 'GET', 'https://www.googleapis.com/calendar/v3/users/me/calendarList', null);
        if (calList.error || !calList.items) continue;

        calList.items.forEach(cal => {
            const calId = encodeURIComponent(cal.id);
            const qs = [
                `timeMin=${encodeURIComponent(timeMin.toISOString())}`,
                `timeMax=${encodeURIComponent(timeMax.toISOString())}`,
                'singleEvents=true',
                'orderBy=startTime',
                'maxResults=100'
            ].join('&');

            const data = apiCurl(acc, 'GET', `https://www.googleapis.com/calendar/v3/calendars/${calId}/events?${qs}`, null);
            if (data.error || !data.items) return;

            data.items.forEach(e => {
                allEvents.push({
                    id: e.id,
                    account: acc,
                    calendarId: cal.id,
                    calendarName: cal.summary || '',
                    title: e.summary || 'Untitled Event',
                    start: e.start?.dateTime || e.start?.date || '',
                    end: e.end?.dateTime || e.end?.date || '',
                    allDay: !!e.start?.date,
                    location: e.location || '',
                    description: e.description || '',
                    color: cal.backgroundColor || null,
                });
            });
        });
    }
    return allEvents;
}

function fetchIcalFromUrl(icalUrl) {
    try {
        const result = execFileSync('curl', ['-s', '-L', icalUrl], { encoding: 'utf8', timeout: 10000 });
        return result;
    } catch (e) {
        return null;
    }
}

function parseIcalEventsForWeek(icalUrl, monday, sunday) {
    const raw = fetchIcalFromUrl(icalUrl);
    if (!raw) return [];
    let parsed;
    try {
        parsed = ical.parseICS(raw);
    } catch (e) {
        return [];
    }
    const events = [];
    for (const k of Object.keys(parsed || {})) {
        const ev = parsed[k];
        if (!ev || ev.type !== 'VEVENT') continue;
        const start = ev.start ? new Date(ev.start) : null;
        const end = ev.end ? new Date(ev.end) : null;
        if (!start || !end) continue;
        const durMs = end - start;
        const rrule = ev.rrule;
        let added = false;
        if (rrule && typeof rrule.between === 'function') {
            try {
                const instances = rrule.between(monday, sunday, true);
                instances.forEach(inst => {
                    const instEnd = new Date(inst.getTime() + durMs);
                    events.push({ start: inst.toISOString(), end: instEnd.toISOString() });
                    added = true;
                });
            } catch (e2) { }
        }
        if (!added && start < sunday && end > monday) {
            events.push({ start: start.toISOString(), end: end.toISOString() });
        }
    }
    return events;
}

function computeBlockedMinutesByDay(eventList) {
    const minutes = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
    eventList.forEach(ev => {
        const s = new Date(ev.start);
        const e = new Date(ev.end);
        const mins = Math.round((e - s) / (60 * 1000));
        const dayIdx = s.getDay();
        minutes[dayIdx] = (minutes[dayIdx] || 0) + mins;
    });
    return minutes;
}

const ALLOWED_ORIGINS = ['http://127.0.0.1', 'http://localhost', 'file://'];

function getCorsOrigin(req) {
    const origin = req.headers.origin || '';
    if (ALLOWED_ORIGINS.some(allowed => origin.startsWith(allowed))) return origin;
    return ALLOWED_ORIGINS[0];
}

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', getCorsOrigin(req));
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;
    const query = parsedUrl.query;

    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
        const parsed = body ? JSON.parse(body) : {};

        if (pathname === '/gcal/status' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                account1: !!(tokens[1] && tokens[1].access_token),
                account2: !!(tokens[2] && tokens[2].access_token)
            }));
        }

        else if (pathname === '/gcal/auth' && req.method === 'GET') {
            const account = parseInt(query.account) || 1;
            const redirectUri = `http://localhost:19877/callback?account=${account}`;
            const authUrl = `${creds.auth_uri}?` + [
                `client_id=${creds.client_id}`,
                `redirect_uri=${encodeURIComponent(redirectUri)}`,
                'response_type=code',
                `scope=${encodeURIComponent(SCOPES)}`,
                'access_type=offline',
                'prompt=consent'
            ].join('&');

            const authPromise = startAuthCallbackServer(account);
            exec(`open "${authUrl}"`);

            authPromise.then(ok => { });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ authUrl, message: `Browser opened for authorization for Account ${account}` }));
        }

        else if (pathname === '/gcal/events' && req.method === 'GET') {
            const now = new Date();
            const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            const endOfTomorrow = new Date(startOfDay.getTime() + 2 * 24 * 60 * 60 * 1000);
            const events = fetchAllCalendarEvents(startOfDay, endOfTomorrow);
            events.sort((a, b) => (a.start || '').localeCompare(b.start || ''));

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(events));
        }

        else if (pathname === '/gcal/events/week' && req.method === 'GET') {
            const now = new Date();
            const dayOfWeek = now.getDay();
            const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((dayOfWeek + 6) % 7));
            const sunday = new Date(monday.getTime() + 7 * 24 * 60 * 60 * 1000);
            const events = fetchAllCalendarEvents(monday, sunday);
            events.sort((a, b) => (a.start || '').localeCompare(b.start || ''));

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ events, weekStart: monday.toISOString() }));
        }

        else if (pathname === '/gcal/blocked-minutes' && req.method === 'GET') {
            const icalUrl = query.iCalUrl || '';
            const gcalNamesStr = query.gcalNames || '';
            const gcalNames = gcalNamesStr ? gcalNamesStr.split(',').map(s => s.trim()).filter(Boolean) : [];

            const now = new Date();
            const dayOfWeek = now.getDay();
            const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((dayOfWeek + 6) % 7));
            const sunday = new Date(monday.getTime() + 7 * 24 * 60 * 60 * 1000);

            const blocked = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };

            if (icalUrl) {
                const icalEvents = parseIcalEventsForWeek(icalUrl, monday, sunday);
                const icalByDay = computeBlockedMinutesByDay(icalEvents);
                for (let d = 0; d < 7; d++) blocked[d] += icalByDay[d] || 0;
            }

            if (gcalNames.length) {
                const gcalEvents = fetchAllCalendarEvents(monday, sunday);
                const filtered = gcalEvents.filter(e => gcalNames.some(n => (e.calendarName || '').trim() === n.trim()));
                const gcalByDay = computeBlockedMinutesByDay(filtered.map(e => ({ start: e.start, end: e.end })));
                for (let d = 0; d < 7; d++) blocked[d] += gcalByDay[d] || 0;
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ blocked, weekStart: monday.toISOString() }));
        }

        else if (pathname === '/gmail/inbox' && req.method === 'GET') {
            const account = parseInt(query.account) || 1;
            const q = encodeURIComponent('is:unread in:inbox category:primary');
            const listRes = apiCurl(account, 'GET', `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}`, null);
            if (listRes.error || !listRes.messages) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify([]));
            }

            const messages = listRes.messages.slice(0, 5);
            const emails = [];
            for (const msg of messages) {
                const msgData = apiCurl(account, 'GET', `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`, null);
                if (!msgData.error && msgData.payload && msgData.payload.headers) {
                    const subject = msgData.payload.headers.find(h => h.name === 'Subject')?.value || 'No Subject';
                    const from = msgData.payload.headers.find(h => h.name === 'From')?.value || 'Unknown';
                    const snippet = msgData.snippet || '';
                    emails.push({ id: msg.id, subject, from, snippet });
                }
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(emails));
        }

        else if (pathname === '/gcal/events/create' && req.method === 'POST') {
            const { title, startTime, endTime, description, location, account = 1 } = parsed;
            const event = {
                summary: title,
                start: { dateTime: startTime, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
                end: { dateTime: endTime, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
            };
            if (description) event.description = description;
            if (location) event.location = location;

            const data = apiCurl(account, 'POST', 'https://www.googleapis.com/calendar/v3/calendars/primary/events', event);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: !data.error, id: data.id }));
        }

        else if (pathname === '/gcal/events/update' && req.method === 'POST') {
            const { id, title, startTime, endTime, description, location, account = 1 } = parsed;
            const event = {};
            if (title) event.summary = title;
            if (startTime) event.start = { dateTime: startTime, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
            if (endTime) event.end = { dateTime: endTime, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
            if (description !== undefined) event.description = description;
            if (location !== undefined) event.location = location;

            const data = apiCurl(account, 'PATCH', `https://www.googleapis.com/calendar/v3/calendars/primary/events/${id}`, event);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: !data.error }));
        }

        else if (pathname === '/gcal/events/delete' && req.method === 'POST') {
            const { id, account = 1 } = parsed;
            const t = tokens[account];
            if (!t) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ ok: false }));
            }
            const args = [
                '-s', '--insecure', '-X', 'DELETE',
                `https://www.googleapis.com/calendar/v3/calendars/primary/events/${id}`,
                '-H', `Authorization: Bearer ${t.access_token}`,
                '-w', '%{http_code}'
            ];
            try {
                const result = execFileSync('curl', args, { timeout: 15000 });
                const statusCode = result.toString().trim().replace(/"/g, '');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: statusCode === '204' || statusCode === '200' }));
            } catch (e) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false }));
            }
        }

        else {
            res.writeHead(404);
            res.end('Not found');
        }
    });
});

function start(port = 19878) {
    loadCreds();
    loadTokens();
    return new Promise((resolve) => {
        server.listen(port, '127.0.0.1', () => {
            console.log(`GCal Proxy running on http://127.0.0.1:${port}`);
            resolve(port);
        });
    });
}

module.exports = { start };
