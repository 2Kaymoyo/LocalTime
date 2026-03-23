const http = require('http');
const fs = require('fs');
const path = require('path');

// Configuration
const PORT = 19879;
const GCAL_PROXY = 'http://127.0.0.1:19878';
const NOTION_PROXY = 'http://127.0.0.1:19876';

const OBSIDIAN_VAULT_PATH = '/Users/wilbmoffitt/Library/Mobile Documents/iCloud~md~obsidian/Documents/Main Vault';
const OBSIDIAN_VAULT_NAME = 'Main Vault';

const INTERNSHIPS_FILE = path.join(__dirname, 'internships.json');
const CHAT_HISTORY_FILE = path.join(__dirname, 'chat-history.json');
const MEMORY_FILE = path.join(__dirname, 'memory.json');
const CHAT_HISTORY_CAP = 100;

function readInternships() {
    try {
        const raw = fs.readFileSync(INTERNSHIPS_FILE, 'utf8');
        return JSON.parse(raw);
    } catch (e) {
        if (e.code === 'ENOENT') return [];
        return [];
    }
}

function writeInternships(data) {
    fs.writeFileSync(INTERNSHIPS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function readChatHistory() {
    try {
        const raw = fs.readFileSync(CHAT_HISTORY_FILE, 'utf8');
        const data = JSON.parse(raw);
        const messages = data.messages || [];
        return messages.slice(-CHAT_HISTORY_CAP);
    } catch (e) {
        if (e.code === 'ENOENT') return [];
        return [];
    }
}

function writeChatHistory(contents) {
    const capped = contents.slice(-CHAT_HISTORY_CAP);
    fs.writeFileSync(CHAT_HISTORY_FILE, JSON.stringify({
        messages: capped,
        updatedAt: new Date().toISOString()
    }, null, 2), 'utf8');
}

function readMemory() {
    try {
        const raw = fs.readFileSync(MEMORY_FILE, 'utf8');
        const data = JSON.parse(raw);
        return data.facts || [];
    } catch (e) {
        if (e.code === 'ENOENT') return [];
        return [];
    }
}

function writeMemory(facts) {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify({ facts }, null, 2), 'utf8');
}

// Load API Key from environment variable (fallback to file for migration)
let API_KEY = process.env.GEMINI_API_KEY || '';
if (!API_KEY) {
    try {
        API_KEY = fs.readFileSync(path.join(__dirname, 'gemini-api-key.txt'), 'utf8').trim();
    } catch (e) {
        console.error('GEMINI_API_KEY not set and gemini-api-key.txt not found. Chat feature will not work.');
    }
}

// Ensure local time is sent correctly
const getLocalISOString = () => new Date().toISOString();

// Define Tools
const TOOLS = [{
    functionDeclarations: [
        {
            name: "create_calendar_event",
            description: "Schedule a new event on the user's primary Google Calendar.",
            parameters: {
                type: "OBJECT",
                properties: {
                    title: { type: "STRING", description: "Title of the event" },
                    startTime: { type: "STRING", description: "ISO 8601 string for event start local time" },
                    endTime: { type: "STRING", description: "ISO 8601 string for event end local time" },
                    location: { type: "STRING", description: "Optional location" }
                },
                required: ["title", "startTime", "endTime"]
            }
        },
        {
            name: "create_notion_task",
            description: "Add a new task to the user's Notion to-do list.",
            parameters: {
                type: "OBJECT",
                properties: {
                    name: { type: "STRING", description: "Name of the task" },
                    dueDate: { type: "STRING", description: "Optional ISO 8601 string for due date" },
                    priority: { type: "STRING", description: "Must be EXACTLY one of: High, Medium, Low (Title Case)" },
                    tags: { type: "ARRAY", items: { type: "STRING" }, description: "Optional array of string tags" }
                },
                required: ["name"]
            }
        },
        {
            name: "fetch_agenda",
            description: "Fetch the user's current Google Calendar events and open Notion tasks.",
        },
        {
            name: "fetch_my_context",
            description: "Fetch a concise summary of the user's current context: upcoming calendar events, open Notion tasks, internship applications and next deadlines, and recent Gmail highlights. Use when the user asks 'what do I have going on?', 'what should I focus on?', or at the start of a conversation to ground responses.",
        },
        {
            name: "remember_that",
            description: "Store a fact or preference about the user for future reference. Use when the user asks you to remember something or states a preference.",
            parameters: {
                type: "OBJECT",
                properties: {
                    fact: { type: "STRING", description: "The fact or preference to remember" },
                    key: { type: "STRING", description: "Optional category (e.g. preferences, habits, constraints)" }
                },
                required: ["fact"]
            }
        },
        {
            name: "recall",
            description: "Search stored facts about the user. Use when you need prior context about the user's preferences or habits.",
            parameters: {
                type: "OBJECT",
                properties: {
                    query: { type: "STRING", description: "Optional keyword to search for in stored facts; if empty, returns recent facts" }
                },
                required: []
            }
        },
        {
            name: "get_current_time",
            description: "Get the current local time to help with resolving relative times like 'tomorrow' or 'next week'."
        },
        {
            name: "check_gmail_inboxes",
            description: "Check the user's unread and important emails from their primary and secondary connected Gmail accounts."
        },
        {
            name: "search_obsidian_notes",
            description: "Search the user's local Obsidian vault for notes matching a query.",
            parameters: {
                type: "OBJECT",
                properties: {
                    query: { type: "STRING", description: "Search query for note content or title" }
                },
                required: ["query"]
            }
        },
        {
            name: "play_music",
            description: "Search for a song, artist, album, or playlist to play on the user's Spotify.",
            parameters: {
                type: "OBJECT",
                properties: {
                    query: { type: "STRING", description: "The music to search for and play" }
                },
                required: ["query"]
            }
        },
        {
            name: "list_internships",
            description: "List the user's tracked internship applications. Use when the user asks about their internships, application status, or what they're applying to."
        },
        {
            name: "create_internship",
            description: "Add a new internship application to the user's Internship Tracker.",
            parameters: {
                type: "OBJECT",
                properties: {
                    name: { type: "STRING", description: "Internship name, e.g. 'Company Name - Role' or 'Goldman Sachs - Summer Analyst'" },
                    period: { type: "STRING", description: "Application period, e.g. 'Summer 2026', 'Fall 2026', 'Spring 2027'" },
                    applicationUrl: { type: "STRING", description: "URL of the application page, e.g. https://company.com/careers/apply" },
                    officialDueDate: { type: "STRING", description: "Official application deadline in YYYY-MM-DD format" },
                    personalDueDate: { type: "STRING", description: "User's personal target submit-by date in YYYY-MM-DD format" },
                    instructions: { type: "STRING", description: "Optional application instructions or requirements" }
                },
                required: ["name"]
            }
        }
    ]
}];

// --- Tool Execution Logic ---
async function executeTool(call) {
    const { name, args } = call;
    try {
        if (name === 'get_current_time') {
            return { time: new Date().toString() };
        }
        else if (name === 'create_calendar_event') {
            const body = JSON.stringify(args);
            const res = await fetch(`${GCAL_PROXY}/gcal/events/create`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body
            });
            return await res.json();
        }
        else if (name === 'create_notion_task') {
            if (args.tags) {
                args.taskTypes = args.tags;
                delete args.tags;
            }
            const body = JSON.stringify(args);
            const res = await fetch(`${NOTION_PROXY}/tasks/create`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body
            });
            return await res.json();
        }
        else if (name === 'check_gmail_inboxes') {
            const [acc1Res, acc2Res] = await Promise.all([
                fetch(`${GCAL_PROXY}/gmail/inbox?account=1`).then(r => r.json()).catch(() => ([])),
                fetch(`${GCAL_PROXY}/gmail/inbox?account=2`).then(r => r.json()).catch(() => ([]))
            ]);
            return { account1: acc1Res, account2: acc2Res };
        }
        else if (name === 'search_obsidian_notes') {
            return await searchObsidianVault(args.query);
        }
        else if (name === 'play_music') {
            const res = await fetch('http://127.0.0.1:4004/api/search-and-play', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: args.query })
            });
            return await res.json();
        }
        else if (name === 'fetch_agenda') {
            const [tasksRes, calRes] = await Promise.all([
                fetch(`${NOTION_PROXY}/tasks`).then(r => r.json()).catch(() => ({ error: 'Failed to fetch tasks' })),
                fetch(`${GCAL_PROXY}/gcal/events`).then(r => r.json()).catch(() => ({ error: 'Failed to fetch calendar' }))
            ]);
            return { tasks: tasksRes, calendar: calRes };
        }
        else if (name === 'fetch_my_context') {
            const [tasksRes, calRes, internships, acc1Res, acc2Res] = await Promise.all([
                fetch(`${NOTION_PROXY}/tasks`).then(r => r.json()).catch(() => ({ error: 'Failed to fetch tasks' })),
                fetch(`${GCAL_PROXY}/gcal/events`).then(r => r.json()).catch(() => ({ error: 'Failed to fetch calendar' })),
                Promise.resolve(readInternships()),
                fetch(`${GCAL_PROXY}/gmail/inbox?account=1`).then(r => r.json()).catch(() => []),
                fetch(`${GCAL_PROXY}/gmail/inbox?account=2`).then(r => r.json()).catch(() => [])
            ]);
            return {
                tasks: tasksRes,
                calendar: calRes,
                internships,
                gmail: { account1: acc1Res, account2: acc2Res }
            };
        }
        else if (name === 'remember_that') {
            const facts = readMemory();
            const id = require('crypto').randomUUID();
            const entry = {
                id,
                fact: args.fact || '',
                key: args.key || null,
                createdAt: new Date().toISOString()
            };
            facts.push(entry);
            writeMemory(facts);
            return { success: true, id, message: 'Stored that for future reference.' };
        }
        else if (name === 'recall') {
            const facts = readMemory();
            const query = (args.query || '').trim().toLowerCase();
            let filtered = facts;
            if (query) {
                filtered = facts.filter(f => (f.fact || '').toLowerCase().includes(query));
            }
            filtered = filtered.slice(-10).reverse();
            return { facts: filtered };
        }
        else if (name === 'list_internships') {
            const internships = readInternships();
            return { internships };
        }
        else if (name === 'create_internship') {
            const internships = readInternships();
            const id = require('crypto').randomUUID();
            const newInternship = {
                id,
                name: args.name || 'Untitled',
                period: args.period || null,
                applicationUrl: args.applicationUrl || null,
                officialDueDate: args.officialDueDate || null,
                personalDueDate: args.personalDueDate || null,
                contacts: [],
                instructions: args.instructions || ''
            };
            internships.push(newInternship);
            writeInternships(internships);
            if (newInternship.personalDueDate) {
                try {
                    await fetch(`${NOTION_PROXY}/tasks/create`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            name: `${newInternship.name} DEADLINE`,
                            dueDate: newInternship.personalDueDate,
                            priority: 'High',
                            taskTypes: ['Internship/Study Abroad'],
                            description: `Internship Tracker: ${newInternship.name}${newInternship.period ? ' (' + newInternship.period + ')' : ''}${newInternship.applicationUrl ? '\n' + newInternship.applicationUrl : ''}\nOpen LocalTime → Internship Tracker to view details (Ctrl+Shift+T)`
                        })
                    });
                } catch (e) { console.warn('Failed to create Notion deadline task:', e); }
            }
            return { success: true, id, message: `Added "${newInternship.name}" to your Internship Tracker.` };
        }
    } catch (e) {
        return { error: e.message };
    }
    return { error: 'Unknown function' };
}

// --- Cached Notion Tags ---
let cachedTags = [];
let lastTagsFetch = 0;

async function getNotionTags() {
    if (Date.now() - lastTagsFetch < 1000 * 60 * 5) return cachedTags; // 5 min cache
    try {
        const res = await fetch(`${NOTION_PROXY}/schema`);
        const schema = await res.json();
        if (schema.taskType) {
            cachedTags = schema.taskType;
            lastTagsFetch = Date.now();
        }
    } catch (e) {
        console.error('Error fetching Notion schema config:', e);
    }
    return cachedTags;
}

// --- Obsidian Search ---
async function searchObsidianVault(query) {
    try {
        const results = [];
        const lowerCaseQuery = query.toLowerCase();

        async function walk(dir) {
            const files = await fs.promises.readdir(dir, { withFileTypes: true });
            for (const file of files) {
                if (file.name.startsWith('.') || file.name === 'node_modules') continue;
                const fullPath = path.join(dir, file.name);
                if (file.isDirectory()) {
                    await walk(fullPath);
                } else if (file.name.endsWith('.md')) {
                    const titleMatch = file.name.toLowerCase().includes(lowerCaseQuery);
                    let contentMatch = false;
                    let snippet = "Title match";

                    if (!titleMatch) {
                        try {
                            const content = await fs.promises.readFile(fullPath, 'utf8');
                            if (content.toLowerCase().includes(lowerCaseQuery)) {
                                contentMatch = true;
                                const idx = content.toLowerCase().indexOf(lowerCaseQuery);
                                const start = Math.max(0, idx - 40);
                                const end = Math.min(content.length, idx + query.length + 40);
                                snippet = "..." + content.substring(start, end).replace(/\n/g, ' ') + "...";
                            }
                        } catch (e) { }
                    }

                    if (titleMatch || contentMatch) {
                        // Use relative path from vault root to properly format Obsidian URI
                        const relativePath = path.relative(OBSIDIAN_VAULT_PATH, fullPath);
                        // Obsidian file paths in URIs shouldn't include the .md extension
                        const fileUriPath = encodeURIComponent(relativePath.replace(/\.md$/, ''));

                        results.push({
                            title: file.name.replace('.md', ''),
                            uri: `obsidian://open?vault=${encodeURIComponent(OBSIDIAN_VAULT_NAME)}&file=${fileUriPath}`,
                            snippet,
                            fullPath
                        });
                    }
                }
            }
        }

        await walk(OBSIDIAN_VAULT_PATH);
        // limit to top 10 results
        return { results: results.slice(0, 10) };
    } catch (e) {
        console.error("Obsidian search error:", e);
        return { error: 'Failed to search Obsidian vault' };
    }
}

// --- Gemini API Call ---
async function callGemini(contents) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${API_KEY}`;

    const tags = await getNotionTags();
    const tagsContext = tags.length > 0 ? ` Available tags: [${tags.join(', ')}]. Map User intent to these tags exactly if relevant. ` : ` `;

    const systemInstruction = {
        parts: [{
            text: "You are LocalTime, a formal, concise AI assistant for managing the user's schedule and tasks. " +
                "Maintain a formal, professional tone. Use 'you' and 'your' but avoid casual slang, emojis, or unnecessary filler. Be direct and structured. Use bullet points or short lists when listing items. " +
                "CRITICAL ROUTING RULES: " +
                "1. If the user says 'Remind me', 'task', or asks to create a task, ALWAYS use create_notion_task. If the user asks you to remember a preference or fact about them, use remember_that instead. " +
                "2. If the user says 'Schedule', 'event', 'meeting', or provides a specific duration, ALWAYS use create_calendar_event. " +
                "3. If the user asks about notes or projects, use search_obsidian_notes to find relevant info. " +
                "4. When creating Notion tasks that relate to a note, you MUST include the note's Obsidian URI (e.g. obsidian://open?vault=...) in the Notion task description field. " +
                "5. If the user asks about their emails, messages, or what is important, use check_gmail_inboxes to summarize their latest emails. " +
                "6. If the user asks to play music, shuffle a playlist, or mentions a song, ALWAYS use the play_music tool. If play_music returns success: true, confirm playback to the user. " +
                "7. If the user asks about their internships, applications, or what they're applying to, use list_internships. " +
                "8. If the user wants to add an internship, track an application, or says 'add X to my internship tracker', use create_internship. Include period (e.g. Summer 2026), due dates, and applicationUrl when the user provides them. " +
                "9. If the user asks 'what do I have going on?', 'what should I focus on?', or about their day/workload, use fetch_my_context to ground your response. Use fetch_my_context when relevant to reference calendar, tasks, and internship deadlines. Proactively suggest next steps (e.g. 'You have an internship due Friday. Should I block time?') when the user asks open-ended questions. " +
                "10. If the user asks you to remember something or states a preference, use remember_that. If you need prior context about the user's preferences or habits, use recall. " +
                "If you need the current time, call get_current_time. When creating Notion tasks, priority must be 'High', 'Medium', or 'Low'." + tagsContext +
                "Stay concise; avoid filler. Prefer actionable, structured responses."
        }]
    };

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents,
            tools: TOOLS,
            systemInstruction
        })
    });

    if (!res.ok) {
        const errorText = await res.text();
        if (res.status === 429) {
            throw new Error("RATE_LIMIT");
        }
        throw new Error(`Gemini API Error: ${errorText}`);
    }
    return await res.json();
}

// --- Main Server ---
const server = http.createServer();

const ALLOWED_ORIGINS = ['http://127.0.0.1', 'http://localhost', 'file://'];

function getCorsOrigin(req) {
    const origin = req.headers.origin || '';
    if (ALLOWED_ORIGINS.some(allowed => origin.startsWith(allowed))) return origin;
    return ALLOWED_ORIGINS[0];
}

server.on('request', async (req, res) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', getCorsOrigin(req));
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (req.url === '/internships' && req.method === 'GET') {
        try {
            const internships = readInternships();
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(internships));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }
    if (req.url === '/chat/history' && req.method === 'GET') {
        try {
            const contents = readChatHistory();
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ history: contents }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    if (req.url === '/internships' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
            try {
                const { internships } = JSON.parse(body);
                if (!Array.isArray(internships)) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'internships must be an array' }));
                }
                writeInternships(internships);
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ success: true }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    if (req.url === '/chat' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', async () => {
            try {
                const { message, history = [] } = JSON.parse(body);

                // Reconstruct contents for Gemini
                const contents = [...history, { role: 'user', parts: [{ text: message }] }];

                // First turn
                let data = await callGemini(contents);
                let firstCandidate = data.candidates && data.candidates[0];

                if (!firstCandidate) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'No response from Gemini' }));
                }

                // Append the model's response to contents
                contents.push(firstCandidate.content);

                // Handle tool calls in a loop (up to 5 turns)
                let parts = firstCandidate.content.parts || [];
                let functionCalls = parts.filter(p => p.functionCall).map(p => p.functionCall);
                let turnCount = 0;

                while (functionCalls.length > 0 && turnCount < 2) {
                    turnCount++;
                    const functionResponses = [];
                    for (const call of functionCalls) {
                        const result = await executeTool(call);
                        functionResponses.push({
                            functionResponse: {
                                name: call.name,
                                response: result
                            }
                        });
                    }

                    // Add function responses to content
                    contents.push({ role: 'user', parts: functionResponses });

                    // Next turn: send results back to Gemini
                    data = await callGemini(contents);
                    firstCandidate = data.candidates && data.candidates[0];
                    if (firstCandidate) {
                        contents.push(firstCandidate.content);
                        parts = firstCandidate.content.parts || [];
                        functionCalls = parts.filter(p => p.functionCall).map(p => p.functionCall);
                    } else {
                        break;
                    }
                }

                // Find final text response
                const finalContent = firstCandidate && firstCandidate.content;
                const textPart = finalContent && finalContent.parts && finalContent.parts.find(p => p.text);
                const finalMessage = textPart ? textPart.text : 'Done.';

                writeChatHistory(contents);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    text: finalMessage,
                    history: contents
                }));

            } catch (err) {
                console.error(err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
            }
        });
    } else {
        res.writeHead(404);
        res.end();
    }
});

module.exports = {
    start: () => {
        return new Promise((resolve) => {
            server.listen(PORT, () => {
                console.log(`LLM Proxy running on port ${PORT}`);
                resolve();
            });
            server.on('error', (err) => {
                console.error(`LLM Proxy error: ${err}`);
                resolve(); // resolve anyway so app continues
            });
        });
    }
};
