/**
 * Local Notion API proxy — runs inside the Electron main process.
 * Routes all Notion API calls through curl --insecure to bypass Cisco Umbrella SSL issues.
 */
const http = require('http');
const { execFileSync } = require('child_process');

const NOTION_TOKEN = process.env.NOTION_TOKEN || '';
const DATABASE_ID = process.env.NOTION_DATABASE_ID || '';
const NOTION_VERSION = '2022-06-28';

function notionCurl(method, endpoint, body) {
    const apiUrl = `https://api.notion.com/v1${endpoint}`;
    const args = [
        '-s', '--insecure', '-X', method, apiUrl,
        '-H', `Authorization: Bearer ${NOTION_TOKEN}`,
        '-H', `Notion-Version: ${NOTION_VERSION}`,
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

const ALLOWED_ORIGINS = ['http://127.0.0.1', 'http://localhost', 'file://'];

function getCorsOrigin(req) {
    const origin = req.headers.origin || '';
    if (ALLOWED_ORIGINS.some(allowed => origin.startsWith(allowed))) return origin;
    return ALLOWED_ORIGINS[0];
}

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', getCorsOrigin(req));
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
        const parsed = body ? JSON.parse(body) : {};

        // GET /tasks — fetch all incomplete tasks
        if (req.url === '/tasks' && req.method === 'GET') {
            const data = notionCurl('POST', `/databases/${DATABASE_ID}/query`, {
                filter: {
                    and: [
                        { property: 'Status', status: { does_not_equal: 'Done' } }
                    ]
                },
                sorts: [
                    { property: 'Due date', direction: 'ascending' }
                ]
            });

            if (data.error) { res.writeHead(500); res.end(JSON.stringify(data)); return; }

            const tasks = (data.results || []).map(p => ({
                id: p.id,
                name: (p.properties['Task name']?.title || []).map(t => t.plain_text).join(''),
                status: p.properties['Status']?.status?.name || 'To Do',
                dueDate: p.properties['Due date']?.date?.start || null,
                priority: p.properties['Priority']?.select?.name || null,
                description: (p.properties['Description']?.rich_text || []).map(t => t.plain_text).join(''),
                tags: (p.properties['Tags']?.multi_select || []).map(t => t.name),
            }));

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(tasks));
        }

        // POST /tasks/complete — mark a task as Done
        else if (req.url === '/tasks/complete' && req.method === 'POST') {
            const { id } = parsed;
            const data = notionCurl('PATCH', `/pages/${id}`, {
                properties: { Status: { status: { name: 'Done' } } }
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: !data.error }));
        }

        // POST /tasks/status — update task status (To Do, In Progress, Done)
        else if (req.url === '/tasks/status' && req.method === 'POST') {
            const { id, status } = parsed;
            const data = notionCurl('PATCH', `/pages/${id}`, {
                properties: { Status: { status: { name: status } } }
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: !data.error }));
        }

        // GET /schema — fetch database property options for dropdowns
        else if (req.url === '/schema' && req.method === 'GET') {
            const data = notionCurl('GET', `/databases/${DATABASE_ID}`, null);
            if (data.error) { res.writeHead(500); res.end(JSON.stringify(data)); return; }

            const props = data.properties || {};
            const schema = {
                status: (props['Status']?.status?.options || []).map(o => o.name),
                priority: (props['Priority']?.select?.options || []).map(o => o.name),
                taskType: (props['Tags']?.multi_select?.options || []).map(o => o.name),
                effortLevel: (props['Effort level']?.select?.options || []).map(o => o.name),
            };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(schema));
        }

        // POST /tasks/create — create a new task
        else if (req.url === '/tasks/create' && req.method === 'POST') {
            const { name, status, dueDate, priority, taskTypes, description } = parsed;
            const properties = {
                'Task name': { title: [{ text: { content: name || 'Untitled' } }] },
            };
            if (status) properties['Status'] = { status: { name: status } };
            if (priority) properties['Priority'] = { select: { name: priority } };
            if (dueDate) properties['Due date'] = { date: { start: dueDate } };
            if (taskTypes && taskTypes.length > 0) {
                properties['Tags'] = { multi_select: taskTypes.map(t => ({ name: t })) };
            }
            if (description) {
                properties['Description'] = { rich_text: [{ text: { content: description } }] };
            }
            // Assign to user so it appears in "My Tasks" view
            // The People column has an empty name — reference by property ID
            properties['hflT'] = { people: [{ id: '317d872b-594c-817b-8a0c-000277645ef6' }] };

            const data = notionCurl('POST', '/pages', {
                parent: { database_id: DATABASE_ID },
                properties
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: !data.error, id: data.id }));
        }

        // POST /tasks/update — update a task
        else if (req.url === '/tasks/update' && req.method === 'POST') {
            const { id, name, status, dueDate, priority, taskTypes, description } = parsed;
            const properties = {};
            if (name !== undefined) properties['Task name'] = { title: [{ text: { content: name || 'Untitled' } }] };
            if (status !== undefined) properties['Status'] = { status: { name: status } };
            if (priority !== undefined) properties['Priority'] = priority ? { select: { name: priority } } : { select: null };
            if (dueDate !== undefined) properties['Due date'] = dueDate ? { date: { start: dueDate } } : { date: null };
            if (taskTypes !== undefined) {
                properties['Tags'] = taskTypes && taskTypes.length > 0 ? { multi_select: taskTypes.map(t => ({ name: t })) } : { multi_select: [] };
            }
            if (description !== undefined) {
                properties['Description'] = description ? { rich_text: [{ text: { content: description } }] } : { rich_text: [] };
            }

            const data = notionCurl('PATCH', `/pages/${id}`, { properties });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: !data.error }));
        }

        else {
            res.writeHead(404);
            res.end('Not found');
        }
    });
});

function start(port = 19876) {
    return new Promise((resolve) => {
        server.listen(port, '127.0.0.1', () => {
            console.log(`Notion proxy running on http://127.0.0.1:${port}`);
            resolve(port);
        });
    });
}

module.exports = { start };
