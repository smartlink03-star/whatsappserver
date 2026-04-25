const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const app = express();
app.use(cors());
app.use(express.json());

const clients = {};
const qrCodes = {};
const clientStatus = {}; // renamed to avoid conflict with http status codes

// ───────────────────────────────────────────────────────────
// HELPER: Verify a path is a real executable file
// ───────────────────────────────────────────────────────────
function isRealExecutable(filePath) {
    try {
        const stat = fs.statSync(filePath);
        return stat.isFile(); // must be a real file (not a directory)
    } catch (_) {
        return false;
    }
}

// ───────────────────────────────────────────────────────────
// HELPER: Find Chromium executable on the server
// ───────────────────────────────────────────────────────────
function findChromeExecutable() {
    // 1. Check env override first
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
        if (isRealExecutable(process.env.PUPPETEER_EXECUTABLE_PATH)) {
            console.log(`[Chrome] Found via PUPPETEER_EXECUTABLE_PATH: ${process.env.PUPPETEER_EXECUTABLE_PATH}`);
            return process.env.PUPPETEER_EXECUTABLE_PATH;
        }
        console.warn(`[Chrome] PUPPETEER_EXECUTABLE_PATH set but file not found: ${process.env.PUPPETEER_EXECUTABLE_PATH}`);
    }

    // 2. System-installed Chrome/Chromium (most reliable)
    const systemPaths = [
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome',
        '/snap/bin/chromium',
    ];
    for (const p of systemPaths) {
        if (isRealExecutable(p)) {
            console.log(`[Chrome] Found system Chrome: ${p}`);
            return p;
        }
    }

    // 3. Puppeteer bundled Chrome (search common cache directories)
    const cacheDirs = [
        process.env.PUPPETEER_CACHE_DIR,
        path.join(process.env.HOME || '/root', '.cache', 'puppeteer'),
        '/home/sbx_user1051/.cache/puppeteer', // Render
        '/opt/render/.cache/puppeteer',         // Render alt
    ].filter(Boolean);

    // Try to find chrome binary inside puppeteer cache
    for (const cacheDir of cacheDirs) {
        try {
            if (!fs.existsSync(cacheDir)) continue;
            // Walk the cache directory to find a chrome binary
            const entries = fs.readdirSync(cacheDir, { recursive: true });
            for (const entry of entries) {
                const full = path.join(cacheDir, entry);
                if (entry.endsWith('chrome') && isRealExecutable(full)) {
                    console.log(`[Chrome] Found puppeteer cached Chrome: ${full}`);
                    return full;
                }
            }
        } catch (_) {
            // can't read directory, skip
        }
    }

    // 4. Last resort: try puppeteer.executablePath() but VERIFY it exists
    try {
        const puppeteer = require('puppeteer');
        if (typeof puppeteer.executablePath === 'function') {
            const bundled = puppeteer.executablePath();
            if (isRealExecutable(bundled)) {
                console.log(`[Chrome] Using puppeteer.executablePath: ${bundled}`);
                return bundled;
            }
            console.warn(`[Chrome] puppeteer.executablePath() returned non-existent path: ${bundled}`);
        }
    } catch (_) {}

    console.warn('[Chrome] ❌ No Chrome/Chromium found anywhere!');
    console.warn('[Chrome] On Render: make sure build command includes Chrome installation');
    console.warn('[Chrome] On VPS: sudo apt-get install -y chromium-browser');
    return undefined;
}

// ───────────────────────────────────────────────────────────
// HELPER: Get puppeteer launch args for headless Linux
// ───────────────────────────────────────────────────────────
function getPuppeteerArgs() {
    return [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',          // prevents crashes on small RAM
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--window-size=1920,1080',
        '--single-process',                 // reduces resource usage
        '--no-zygote',
        '--disable-extensions',
    ];
}

// ───────────────────────────────────────────────────────────
// HELPER: Get full puppeteer config
// ───────────────────────────────────────────────────────────
function getPuppeteerConfig() {
    const executablePath = findChromeExecutable();
    const config = {
        headless: true,  // 'new' is not supported by whatsapp-web.js 1.x
        args: getPuppeteerArgs(),
    };

    if (executablePath) {
        config.executablePath = executablePath;
    }

    return config;
}

// ───────────────────────────────────────────────────────────
// Store SSE subscribers per tenant
// ───────────────────────────────────────────────────────────
const sseSubscribers = {};

function notifySSESubscribers(tenantId, data) {
    const subs = sseSubscribers[tenantId];
    if (!subs) return;
    for (const res of subs) {
        try {
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        } catch (_) {
            // connection already closed
        }
    }
}

// ───────────────────────────────────────────────────────────
// CORE: Initialize WhatsApp client for a tenant
// ───────────────────────────────────────────────────────────
const initializeClient = (tenantId) => {
    if (clients[tenantId]) return clients[tenantId];

    console.log(`[init] Initializing client for tenant: ${tenantId}`);
    clientStatus[tenantId] = 'initializing';

    const client = new Client({
        authStrategy: new LocalAuth({ clientId: `tenant_${tenantId}` }),
        puppeteer: getPuppeteerConfig(),
    });

    // ── EVENT: QR received ──
    client.on('qr', async (qr) => {
        console.log(`[qr] QR received for ${tenantId}`);
        qrCodes[tenantId] = qr;
        clientStatus[tenantId] = 'qr_ready';

        // Convert to data URL once and cache it
        try {
            const qrDataUrl = await qrcode.toDataURL(qr);
            notifySSESubscribers(tenantId, {
                status: 'qr_ready',
                qr: qrDataUrl,
            });
        } catch (err) {
            console.error(`[qr] Failed to generate QR image for ${tenantId}:`, err);
        }
    });

    // ── EVENT: Client ready (authenticated + loaded) ──
    client.on('ready', () => {
        console.log(`[ready] Client is ready for ${tenantId}`);
        clientStatus[tenantId] = 'connected';
        delete qrCodes[tenantId];
        notifySSESubscribers(tenantId, { status: 'connected' });
    });

    // ── EVENT: Authenticated (session restored) ──
    client.on('authenticated', () => {
        console.log(`[auth] Authenticated for ${tenantId}`);
        clientStatus[tenantId] = 'authenticated';
        notifySSESubscribers(tenantId, { status: 'authenticated' });
    });

    // ── EVENT: Auth failure ──
    client.on('auth_failure', (msg) => {
        console.error(`[auth_failure] Auth failure for ${tenantId}:`, msg);
        clientStatus[tenantId] = 'auth_failure';
        notifySSESubscribers(tenantId, { status: 'auth_failure', msg: String(msg) });
    });

    // ── EVENT: Disconnected ──
    client.on('disconnected', (reason) => {
        console.log(`[disconnect] Disconnected for ${tenantId}:`, reason);
        clientStatus[tenantId] = 'disconnected';
        delete clients[tenantId];
        delete qrCodes[tenantId];
        notifySSESubscribers(tenantId, { status: 'disconnected', reason });
        // Clean up SSE subscribers
        delete sseSubscribers[tenantId];
    });

    // ── EVENT: Loading screen (WhatsApp Web is booting) ──
    client.on('loading_screen', (percent, message) => {
        console.log(`[loading] ${tenantId}: ${percent}% — ${message}`);
    });

    // ── EVENT: Change state (generic state change) ──
    client.on('change_state', (state) => {
        console.log(`[state] ${tenantId}: ${state}`);
    });

    // ── Initialize with error handling ──
    client.initialize().catch((err) => {
        console.error(`[init] FAILED to initialize client for ${tenantId}:`, err.message);
        clientStatus[tenantId] = 'init_failed';
        notifySSESubscribers(tenantId, {
            status: 'init_failed',
            error: err.message,
        });
    });

    clients[tenantId] = client;
    return client;
};

// ═══════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════

// ── GET /qr/:tenantId (polling endpoint — backward compatible) ──
app.get('/qr/:tenantId', async (req, res) => {
    const { tenantId } = req.params;

    if (!clients[tenantId]) {
        initializeClient(tenantId);
        return res.json({
            status: 'initializing',
            msg: 'Client is starting. Poll this endpoint every 3 seconds until you receive a QR.',
        });
    }

    if (clientStatus[tenantId] === 'connected') {
        return res.json({ status: 'connected', msg: 'Already connected.' });
    }

    if (clientStatus[tenantId] === 'init_failed') {
        return res.status(500).json({
            status: 'init_failed',
            msg: 'Failed to launch Chrome. Check server logs. Run: sudo apt-get install -y chromium-browser',
        });
    }

    if (clientStatus[tenantId] === 'auth_failure') {
        return res.json({ status: 'auth_failure', msg: 'Authentication failed. Try /logout and reconnect.' });
    }

    if (qrCodes[tenantId]) {
        try {
            const qrDataUrl = await qrcode.toDataURL(qrCodes[tenantId]);
            return res.json({ status: 'qr_ready', qr: qrDataUrl });
        } catch (err) {
            return res.status(500).json({ status: 'error', msg: 'Failed to generate QR image.' });
        }
    }

    return res.json({
        status: clientStatus[tenantId] || 'initializing',
        msg: 'Still initializing... Poll again in 3 seconds.',
    });
});

// ── GET /qr-stream/:tenantId (SSE endpoint — RECOMMENDED) ──
// This is the FIX for Root Cause #1.
// Instead of polling, the frontend opens this endpoint with EventSource
// and the server PUSHES the QR the moment it's ready.
app.get('/qr-stream/:tenantId', (req, res) => {
    const { tenantId } = req.params;

    // Set up SSE headers
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no', // disable nginx buffering
    });

    // Send initial status immediately
    res.write(`data: ${JSON.stringify({ status: 'stream_connected' })}\n\n`);

    // If client doesn't exist yet, start initialization
    if (!clients[tenantId]) {
        initializeClient(tenantId);
    }

    // If QR is already ready, send it immediately
    if (qrCodes[tenantId]) {
        qrcode.toDataURL(qrCodes[tenantId]).then((qrDataUrl) => {
            res.write(`data: ${JSON.stringify({ status: 'qr_ready', qr: qrDataUrl })}\n\n`);
        }).catch(() => {});
    }

    // If already connected, notify immediately
    if (clientStatus[tenantId] === 'connected') {
        res.write(`data: ${JSON.stringify({ status: 'connected' })}\n\n`);
    }

    // Register subscriber
    if (!sseSubscribers[tenantId]) {
        sseSubscribers[tenantId] = [];
    }
    sseSubscribers[tenantId].push(res);

    // Send heartbeat every 15 seconds to keep connection alive
    const heartbeat = setInterval(() => {
        try {
            res.write(`data: ${JSON.stringify({ status: 'heartbeat' })}\n\n`);
        } catch (_) {
            clearInterval(heartbeat);
        }
    }, 15000);

    // Clean up when client disconnects
    req.on('close', () => {
        clearInterval(heartbeat);
        if (sseSubscribers[tenantId]) {
            sseSubscribers[tenantId] = sseSubscribers[tenantId].filter((r) => r !== res);
            if (sseSubscribers[tenantId].length === 0) {
                delete sseSubscribers[tenantId];
            }
        }
    });
});

// ── GET /status/:tenantId ──
app.get('/status/:tenantId', (req, res) => {
    const { tenantId } = req.params;
    if (!clients[tenantId]) {
        return res.json({ status: 'disconnected', msg: 'No active session.' });
    }
    return res.json({ status: clientStatus[tenantId] });
});

// ── POST /send ──
app.post('/send', async (req, res) => {
    const { tenantId, number, message, mediaUrl } = req.body;

    if (!tenantId || !number) {
        return res.status(400).json({ success: false, error: 'tenantId and number are required.' });
    }

    const client = clients[tenantId];
    if (!client || clientStatus[tenantId] !== 'connected') {
        return res.status(400).json({ success: false, error: 'Client is not connected. Please scan QR first.' });
    }

    // Format number: remove +, spaces, dashes, add @c.us
    let formattedNumber = number.replace(/[^0-9]/g, '');
    if (!formattedNumber.endsWith('@c.us')) {
        formattedNumber += '@c.us';
    }

    try {
        let media = null;
        if (mediaUrl) {
            media = await MessageMedia.fromUrl(mediaUrl);
        }

        if (media) {
            await client.sendMessage(formattedNumber, media, { caption: message });
        } else if (message) {
            await client.sendMessage(formattedNumber, message);
        }

        return res.json({ success: true, msg: 'Message sent successfully.' });
    } catch (err) {
        console.error('[send] Error:', err);
        return res.status(500).json({ success: false, error: 'Failed to send message: ' + err.message });
    }
});

// ── POST /logout/:tenantId ──
app.post('/logout/:tenantId', async (req, res) => {
    const { tenantId } = req.params;
    const client = clients[tenantId];
    if (client) {
        try {
            await client.logout();
        } catch (_) {}
        try {
            await client.destroy();
        } catch (_) {}
        delete clients[tenantId];
        delete qrCodes[tenantId];
        clientStatus[tenantId] = 'disconnected';
        // Close all SSE subscribers for this tenant
        if (sseSubscribers[tenantId]) {
            for (const sub of sseSubscribers[tenantId]) {
                try { sub.end(); } catch (_) {}
            }
            delete sseSubscribers[tenantId];
        }
    }
    return res.json({ success: true, msg: 'Logged out successfully.' });
});

// ── GET /health (server health check) ──
// Cache the chrome path at startup (don't re-scan on every health check)
let cachedChromePath = null;

app.get('/health', (req, res) => {
    if (!cachedChromePath) {
        cachedChromePath = findChromeExecutable();
    }
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        chromePath: cachedChromePath || 'NOT FOUND',
        chromeVerified: !!cachedChromePath,
        activeClients: Object.keys(clients).length,
        env: {
            PUPPETEER_EXECUTABLE_PATH: process.env.PUPPETEER_EXECUTABLE_PATH || 'not set',
            PUPPETEER_CACHE_DIR: process.env.PUPPETEER_CACHE_DIR || 'not set',
            HOME: process.env.HOME || 'not set',
        },
    });
});

// ═══════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
    console.log(`\n╔══════════════════════════════════════════════╗`);
    console.log(`║   WhatsApp Service running on port ${PORT}       ║`);
    console.log(`╠══════════════════════════════════════════════╣`);
    console.log(`║   Endpoints:                                 ║`);
    console.log(`║   GET  /qr/:tenantId        → Poll for QR    ║`);
    console.log(`║   GET  /qr-stream/:tenantId → SSE stream ✅   ║`);
    console.log(`║   GET  /status/:tenantId     → Connection     ║`);
    console.log(`║   POST /send                  → Send message  ║`);
    console.log(`║   POST /logout/:tenantId      → Disconnect    ║`);
    console.log(`║   GET  /health                → Health check  ║`);
    console.log(`╚══════════════════════════════════════════════╝\n`);

    // Detect and cache Chrome path at startup
    cachedChromePath = findChromeExecutable();
    if (cachedChromePath) {
        console.log(`[Chrome] ✅ Verified at: ${cachedChromePath}`);
        // Verify it actually launches
        try {
            const { execSync } = require('child_process');
            const version = execSync(`"${cachedChromePath}" --version`).toString().trim();
            console.log(`[Chrome] ✅ Version: ${version}`);
        } catch (e) {
            console.warn(`[Chrome] ⚠️  File exists but failed to run: ${e.message}`);
            cachedChromePath = null; // don't use a broken binary
        }
    }
    if (!cachedChromePath) {
        console.error(`[Chrome] ❌ No working Chrome found! WhatsApp will NOT work.`);
        console.error(`[Chrome] Fix: Add this build command on Render:`);
        console.error(`[Chrome]   npm install puppeteer && npx puppeteer browsers install chrome`);
    }
});
