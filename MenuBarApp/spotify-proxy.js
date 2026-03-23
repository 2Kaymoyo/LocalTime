const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');
const url = require('url');

class SpotifyProxy {
    constructor() {
        this.port = 4004;
        this.tokenFile = path.join(__dirname, '.spotify-token.json');
        this.credentialsFile = path.join(__dirname, 'spotify-credentials.json');

        this.clientId = null;
        this.clientSecret = null;
        this.redirectUri = `http://127.0.0.1:${this.port}/callback`;
    }

    loadCredentials() {
        if (fs.existsSync(this.credentialsFile)) {
            try {
                const creds = JSON.parse(fs.readFileSync(this.credentialsFile, 'utf8'));
                this.clientId = creds.clientId;
                this.clientSecret = creds.clientSecret;
                return true;
            } catch (error) {
                console.error('Error loading Spotify credentials:', error);
                return false;
            }
        }
        return false;
    }

    getTokens() {
        if (fs.existsSync(this.tokenFile)) {
            try {
                return JSON.parse(fs.readFileSync(this.tokenFile, 'utf8'));
            } catch (e) {
                return null;
            }
        }
        return null;
    }

    saveTokens(tokens) {
        // Add expiration time
        if (tokens.expires_in) {
            tokens.expiry_date = Date.now() + (tokens.expires_in * 1000);
        }
        fs.writeFileSync(this.tokenFile, JSON.stringify(tokens, null, 2));
    }

    async refreshAccessToken(refreshToken) {
        return new Promise((resolve, reject) => {
            if (!this.clientId || !this.clientSecret) {
                reject(new Error('Missing credentials'));
                return;
            }

            const data = new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: refreshToken
            }).toString();

            const options = {
                hostname: 'accounts.spotify.com',
                port: 443,
                path: '/api/token',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Authorization': 'Basic ' + Buffer.from(this.clientId + ':' + this.clientSecret).toString('base64'),
                    'Content-Length': Buffer.byteLength(data)
                }
            };

            const req = https.request(options, (res) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        try {
                            const tokens = JSON.parse(body);
                            resolve(tokens);
                        } catch (e) {
                            reject(e);
                        }
                    } else {
                        reject(new Error(`Failed to refresh token: ${res.statusCode} ${body}`));
                    }
                });
            });

            req.on('error', reject);
            req.write(data);
            req.end();
        });
    }

    async makeSpotifyRequest(endpoint, method = 'GET', body = null) {
        let tokens = this.getTokens();
        if (!tokens || !tokens.access_token) {
            throw new Error('Not authenticated');
        }

        // Check if token expired (with 1 minute buffer)
        if (tokens.expiry_date && Date.now() > tokens.expiry_date - 60000) {
            if (tokens.refresh_token) {
                console.log('Refreshing Spotify access token...');
                try {
                    const newTokens = await this.refreshAccessToken(tokens.refresh_token);
                    // Keep the old refresh token if a new one wasn't provided
                    if (!newTokens.refresh_token) {
                        newTokens.refresh_token = tokens.refresh_token;
                    }
                    this.saveTokens(newTokens);
                    tokens = newTokens;
                } catch (error) {
                    throw new Error(`Failed to refresh token: ${error.message}`);
                }
            } else {
                throw new Error('Token expired and no refresh token available');
            }
        }

        return new Promise((resolve, reject) => {
            const options = {
                hostname: 'api.spotify.com',
                port: 443,
                path: `/v1${endpoint}`,
                method: method,
                headers: {
                    'Authorization': `Bearer ${tokens.access_token}`,
                    'Accept': 'application/json'
                }
            };

            let reqBody = '';
            if (body) {
                reqBody = JSON.stringify(body);
                options.headers['Content-Type'] = 'application/json';
                options.headers['Content-Length'] = Buffer.byteLength(reqBody);
            }

            const req = https.request(options, (res) => {
                let resBody = '';
                res.on('data', chunk => resBody += chunk);
                res.on('end', () => {
                    // 204 No Content
                    if (res.statusCode === 204) {
                        resolve({ success: true });
                        return;
                    }

                    let parsed = null;
                    if (resBody) {
                        try {
                            parsed = JSON.parse(resBody);
                        } catch (e) {
                            console.error('Failed to parse Spotify response:', resBody);
                        }
                    }

                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(parsed);
                    } else {
                        console.error(`Spotify API error ${res.statusCode}:`, resBody);
                        reject(new Error(`Spotify API error: ${res.statusCode}`));
                    }
                });
            });

            req.on('error', reject);
            if (reqBody) {
                req.write(reqBody);
            }
            req.end();
        });
    }

    getCorsOrigin(req) {
        const ALLOWED_ORIGINS = ['http://127.0.0.1', 'http://localhost', 'file://'];
        const origin = req.headers.origin || '';
        if (ALLOWED_ORIGINS.some(allowed => origin.startsWith(allowed))) return origin;
        return ALLOWED_ORIGINS[0];
    }

    async handleRequest(req, res) {
        // CORS Headers
        res.setHeader('Access-Control-Allow-Origin', this.getCorsOrigin(req));
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
            res.writeHead(200);
            res.end();
            return;
        }

        const parsedUrl = url.parse(req.url, true);
        const pathname = parsedUrl.pathname;
        const query = parsedUrl.query;

        // Collect body for POST/PUT if needed
        let body = '';
        await new Promise((resolve) => {
            req.on('data', chunk => body += chunk);
            req.on('end', resolve);
        });

        const sendJson = (status, data) => {
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(data));
        };

        const sendHtml = (status, html) => {
            res.writeHead(status, { 'Content-Type': 'text/html' });
            res.end(html);
        };

        if (pathname === '/status' && req.method === 'GET') {
            const hasCreds = this.loadCredentials();
            const tokens = this.getTokens();
            sendJson(200, {
                hasCredentials: hasCreds,
                isAuthenticated: !!tokens && !!tokens.access_token
            });
        }
        else if (pathname === '/auth' && req.method === 'GET') {
            if (!this.loadCredentials()) {
                res.writeHead(400); res.end('Missing credentials file');
                return;
            }

            const scopes = [
                'user-read-playback-state',
                'user-modify-playback-state',
                'user-read-currently-playing',
                'playlist-read-private',
                'playlist-read-collaborative'
            ].join(' ');

            const params = new URLSearchParams({
                response_type: 'code',
                client_id: this.clientId,
                scope: scopes,
                redirect_uri: this.redirectUri
            });

            res.writeHead(302, { 'Location': `https://accounts.spotify.com/authorize?${params.toString()}` });
            res.end();
        }
        else if (pathname === '/callback' && req.method === 'GET') {
            const code = query.code;
            if (!code) {
                sendHtml(400, '<html><body><h1>Authentication Failed</h1><p>No code provided.</p></body></html>');
                return;
            }

            const data = new URLSearchParams({
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: this.redirectUri
            }).toString();

            const options = {
                hostname: 'accounts.spotify.com',
                port: 443,
                path: '/api/token',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Authorization': 'Basic ' + Buffer.from(this.clientId + ':' + this.clientSecret).toString('base64'),
                    'Content-Length': Buffer.byteLength(data)
                }
            };

            const tokenReq = https.request(options, (tokenRes) => {
                let tokenBody = '';
                tokenRes.on('data', chunk => tokenBody += chunk);
                tokenRes.on('end', () => {
                    if (tokenRes.statusCode >= 200 && tokenRes.statusCode < 300) {
                        try {
                            const tokens = JSON.parse(tokenBody);
                            this.saveTokens(tokens);
                            sendHtml(200, `
                                <html>
                                    <body style="font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; background: #121212; color: #fff; margin: 0;">
                                        <div style="text-align: center; background: #282828; padding: 40px; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.5);">
                                            <svg height="64" width="64" viewBox="0 0 24 24" fill="#1DB954" style="margin-bottom: 20px;">
                                                <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.84.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-.96-.12-1.08-.6-.12-.48.12-.96.6-1.08 4.32-1.32 9.72-.66 13.38 1.56.42.24.6.84.301 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.6.18-1.2.72-1.38 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/>
                                            </svg>
                                            <h2 style="margin: 0 0 10px 0;">Authentication Successful</h2>
                                            <p style="color: #b3b3b3; margin: 0;">You can close this window and return to LocalTime.</p>
                                        </div>
                                        <script>setTimeout(() => window.close(), 3000);</script>
                                    </body>
                                </html>
                            `);
                        } catch (e) {
                            res.writeHead(500); res.end('Failed to parse token response: ' + e.message);
                        }
                    } else {
                        res.writeHead(tokenRes.statusCode); res.end('Failed to get token: ' + tokenBody);
                    }
                });
            });

            tokenReq.on('error', (e) => {
                res.writeHead(500); res.end('Request error: ' + e.message);
            });
            tokenReq.write(data);
            tokenReq.end();
        }
        else if (pathname === '/api/player' && req.method === 'GET') {
            try {
                const data = await this.makeSpotifyRequest('/me/player');
                sendJson(200, data || { is_playing: false });
            } catch (error) {
                sendJson(error.message === 'Not authenticated' ? 401 : 500, { error: error.message });
            }
        }
        else if (pathname === '/api/player/play' && req.method === 'PUT') {
            try {
                await this.makeSpotifyRequest('/me/player/play', 'PUT');
                sendJson(200, { success: true });
            } catch (error) {
                sendJson(500, { error: error.message });
            }
        }
        else if (pathname === '/api/player/pause' && req.method === 'PUT') {
            try {
                await this.makeSpotifyRequest('/me/player/pause', 'PUT');
                sendJson(200, { success: true });
            } catch (error) {
                sendJson(500, { error: error.message });
            }
        }
        else if (pathname === '/api/player/next' && req.method === 'POST') {
            try {
                await this.makeSpotifyRequest('/me/player/next', 'POST');
                sendJson(200, { success: true });
            } catch (error) {
                sendJson(500, { error: error.message });
            }
        }
        else if (pathname === '/api/player/previous' && req.method === 'POST') {
            try {
                await this.makeSpotifyRequest('/me/player/previous', 'POST');
                sendJson(200, { success: true });
            } catch (error) {
                sendJson(500, { error: error.message });
            }
        }
        else if (pathname === '/api/search-and-play' && req.method === 'POST') {
            try {
                const requestBody = JSON.parse(body || '{}');
                const query = requestBody.query;

                if (!query) {
                    sendJson(400, { error: 'Missing query parameter' });
                    return;
                }

                let playBody = {};
                let foundName = '';

                // Determine user intent from query
                const lowerQuery = query.toLowerCase();
                const wantsPlaylist = lowerQuery.includes('playlist');
                const wantsAlbum = lowerQuery.includes('album');

                if (wantsPlaylist) {
                    // Try to find it in the user's personal playlists first
                    try {
                        const myPlaylists = await this.makeSpotifyRequest('/me/playlists?limit=50');
                        if (myPlaylists && myPlaylists.items) {
                            // Extract just the core search terms from the query
                            const cleanQuery = lowerQuery
                                .replace(/\b(shuffle|play|my|playlist|called|the)\b/g, '')
                                .replace(/\s+/g, ' ')
                                .trim();

                            const matchedPlaylist = myPlaylists.items.find(p =>
                                p.name.toLowerCase().includes(cleanQuery)
                            );

                            if (matchedPlaylist) {
                                playBody.context_uri = matchedPlaylist.uri;
                                foundName = matchedPlaylist.name;
                            }
                        }
                    } catch (e) {
                        console.error("Failed to fetch user playlists", e);
                    }
                }

                // If not found in personal playlists, fallback to global search
                if (!foundName) {
                    const searchParams = new URLSearchParams({
                        q: query,
                        type: 'track,playlist,album',
                        limit: 1
                    });

                    const searchResults = await this.makeSpotifyRequest(`/search?${searchParams.toString()}`);

                    if (!searchResults) {
                        sendJson(404, { error: 'No results found' });
                        return;
                    }

                    const hasTracks = searchResults.tracks && searchResults.tracks.items && searchResults.tracks.items.length > 0;
                    const hasPlaylists = searchResults.playlists && searchResults.playlists.items && searchResults.playlists.items.length > 0;
                    const hasAlbums = searchResults.albums && searchResults.albums.items && searchResults.albums.items.length > 0;

                    // Priority logic based on intent
                    if (wantsPlaylist && hasPlaylists) {
                        playBody.context_uri = searchResults.playlists.items[0].uri;
                        foundName = searchResults.playlists.items[0].name;
                    } else if (wantsAlbum && hasAlbums) {
                        playBody.context_uri = searchResults.albums.items[0].uri;
                        foundName = searchResults.albums.items[0].name;
                    } else if (!wantsPlaylist && !wantsAlbum && hasTracks) {
                        // Default to track if no specific type requested
                        playBody.uris = [searchResults.tracks.items[0].uri];
                        foundName = searchResults.tracks.items[0].name;
                    } else if (hasPlaylists) {
                        // Fallbacks if primary intent failed
                        playBody.context_uri = searchResults.playlists.items[0].uri;
                        foundName = searchResults.playlists.items[0].name;
                    } else if (hasAlbums) {
                        playBody.context_uri = searchResults.albums.items[0].uri;
                        foundName = searchResults.albums.items[0].name;
                    } else if (hasTracks) {
                        playBody.uris = [searchResults.tracks.items[0].uri];
                        foundName = searchResults.tracks.items[0].name;
                    } else {
                        sendJson(404, { error: 'No playable results found for query' });
                        return;
                    }
                }


                // Check for shuffle intent
                const wantsShuffle = lowerQuery.includes('shuffle');
                if (wantsShuffle) {
                    try {
                        await this.makeSpotifyRequest('/me/player/shuffle?state=true', 'PUT');
                    } catch (e) {
                        console.error('Failed to enable shuffle:', e.message);
                    }
                }

                // 2. Play the found URI
                await this.makeSpotifyRequest('/me/player/play', 'PUT', playBody);
                sendJson(200, { success: true, played: foundName });

            } catch (error) {
                sendJson(500, { error: error.message });
            }
        }
        else {
            res.writeHead(404);
            res.end('Not found');
        }
    }

    start() {
        return new Promise((resolve) => {
            const server = http.createServer((req, res) => {
                this.handleRequest(req, res).catch(err => {
                    console.error('Unhandled request error:', err);
                    if (!res.headersSent) {
                        res.writeHead(500);
                        res.end('Internal Server Error');
                    }
                });
            });

            server.listen(this.port, '127.0.0.1', () => {
                console.log(`Spotify proxy running on http://127.0.0.1:${this.port}`);
                resolve();
            }).on('error', (err) => {
                if (err.code === 'EADDRINUSE') {
                    console.log(`Port ${this.port} is already in use. Spotify proxy might already be running.`);
                    resolve();
                } else {
                    console.error('Spotify proxy server error:', err);
                }
            });
        });
    }
}

const proxy = new SpotifyProxy();

module.exports = {
    start: () => proxy.start()
};
