'use strict';

// Unit 3: Zstd frame compression — compress every binary frame before broadcast.
// Unit 4: Worker thread isolation — sim runs in sim-worker.js; this file only
//         handles WebSocket connections and message routing.

const { WebSocketServer } = require('ws');
const { Worker }           = require('worker_threads');
const zlib                 = require('node:zlib');
const fs                   = require('fs');
const path                 = require('path');

const { SIM_WIDTH, TARGET_FPS, GRID_SEND_EVERY } = require('./shared-state.js');

const STATE_FILE = path.join(__dirname, 'state.json');
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;

// ---- Persisted state ----

const DEFAULT_TRANSFORM = {
    insetTop: 0, insetBottom: 0, insetLeft: 0, insetRight: 0,
    shiftTop: 0, shiftBottom: 0, shiftLeft: 0, shiftRight: 0,
    fadeTop: 0, fadeBottom: 0, fadeLeft: 0, fadeRight: 0,
};
const DEFAULT_TOGGLES = { t: false, c: false, w: false, e: false, h: false, b: false, m: true };

function loadState() {
    try {
        const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        return {
            transform: { ...DEFAULT_TRANSFORM, ...saved.transform },
            toggles:   { ...DEFAULT_TOGGLES,   ...saved.toggles },
        };
    } catch (e) {
        return { transform: { ...DEFAULT_TRANSFORM }, toggles: { ...DEFAULT_TOGGLES } };
    }
}

let saveTimer = null;
function saveState() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        fs.writeFile(STATE_FILE, JSON.stringify({ transform: currentDisplayTransform, toggles: clientToggles }, null, 2), () => {});
    }, 500);
}

const { transform: savedTransform, toggles: savedToggles } = loadState();
let currentDisplayTransform = savedTransform;
const clientToggles = savedToggles;
console.log('State loaded from', STATE_FILE);

// ---- Simulation worker ----

const worker = new Worker(path.join(__dirname, 'sim-worker.js'), {
    workerData: { toggles: clientToggles },
});

let simSpeed = 1;

worker.on('message', (msg) => {
    if (msg.type === 'ready') {
        simSpeed = msg.speed;
        console.log(`Sim worker ready. WS listening on :${PORT}`);
        return;
    }
    if (msg.type === 'speed') {
        simSpeed = msg.speed;
        const speedMsg = JSON.stringify({ type: 'sim_speed', speed: simSpeed });
        for (const c of clients) if (c.readyState === c.OPEN) c.send(speedMsg);
        return;
    }
    if (msg.type === 'reset_ack') {
        const ack = JSON.stringify({ type: 'reset_ack' });
        for (const c of clients) if (c.readyState === c.OPEN) c.send(ack);
        return;
    }
    if (clients.size === 0) return;
    if (msg.type === 'frame') fpsFrameCount++;
    if (msg.type === 'frame' || msg.type === 'grid') {
        // Compress with Zstd level-1 (Node 22+ native) before broadcast
        const raw = Buffer.from(msg.buf);
        broadcastBinary(zlib.zstdCompressSync
            ? zlib.zstdCompressSync(raw, { level: 1 })
            : raw); // fallback: send uncompressed if Zstd unavailable
    }
});

worker.on('error', (err) => console.error('Sim worker error:', err));
worker.on('exit', (code) => { if (code !== 0) console.error('Sim worker exited with code', code); });

// ---- WebSocket server ----

const wss = new WebSocketServer({ port: PORT });
const clients = new Set();
let projectorWs = null;

// FPS accounting (from worker frame messages)
let fpsFrameCount = 0;
let fpsStart = Date.now();

// Re-use the same FPS interval for reporting
setInterval(() => {
    const now = Date.now();
    if (now - fpsStart >= 1000) {
        const fps = (fpsFrameCount / ((now - fpsStart) / 1000)).toFixed(1);
        if (clients.size > 0) {
            const msg = JSON.stringify({ type: 'fps', fps: parseFloat(fps) });
            for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(msg);
        }
        fpsFrameCount = 0;
        fpsStart = now;
        console.log(`FPS: ${fps}  Clients: ${clients.size}`);
    }
}, Math.round(1000 / TARGET_FPS));


function broadcastBinary(buf) {
    for (const ws of clients) {
        if (ws.readyState === ws.OPEN) ws.send(buf, { binary: true });
    }
}

function sendCurrentState(ws) {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ type: 'display_transform', ...currentDisplayTransform }));
    ws.send(JSON.stringify({ type: 'client_state', ...clientToggles }));
    ws.send(JSON.stringify({ type: 'sim_speed', speed: simSpeed }));
    // Signal Zstd capability so client can enable decompression
    ws.send(JSON.stringify({ type: 'encoding', compression: 'zstd' }));
}

wss.on('connection', (ws) => {
    clients.add(ws);
    console.log(`Client connected. Total: ${clients.size}`);
    sendCurrentState(ws);

    ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        const str = data.toString();
        let msg = null;
        try { msg = JSON.parse(str); } catch (e) { /* not JSON */ }

        if (msg && msg.type === 'register') {
            if (msg.role === 'projector') {
                if (projectorWs && projectorWs.readyState === projectorWs.OPEN) {
                    ws.send(JSON.stringify({ type: 'error', reason: 'projector_taken' }));
                    ws.close();
                    console.log('Rejected duplicate projector registration.');
                } else {
                    projectorWs = ws;
                    ws.send(JSON.stringify({ type: 'registered', role: 'projector' }));
                    console.log('Projector client registered.');
                }
            }
        } else if (msg && msg.type === 'key') {
            worker.postMessage({ type: 'key', key: msg.key });
            if ('bBmM'.includes(msg.key)) {
                const k = msg.key.toLowerCase();
                clientToggles[k] = !clientToggles[k];
                saveState();
                const echo = JSON.stringify({ type: 'client_key', key: msg.key });
                for (const c of clients) if (c.readyState === c.OPEN) c.send(echo);
            }
            // Speed updates are reported by the worker via the 'speed' message
        } else if (msg && msg.type === 'reset') {
            worker.postMessage({ type: 'reset' });
        } else if (msg && msg.type === 'overlay') {
            worker.postMessage({ type: 'overlay', grid: msg.grid });
            if (msg.grid === 'wetness') clientToggles.w = !clientToggles.w;
            if (msg.grid === 'erosion') clientToggles.e = !clientToggles.e;
        } else if (msg && msg.type === 'client_key') {
            const k = msg.key.toLowerCase();
            if (k in clientToggles) { clientToggles[k] = !clientToggles[k]; saveState(); }
            const fwd = JSON.stringify(msg);
            for (const c of clients) if (c !== ws && c.readyState === c.OPEN) c.send(fwd);
        } else if (msg && msg.type === 'client_dimensions') {
            if (ws === projectorWs) {
                const fwd = JSON.stringify(msg);
                for (const c of clients) if (c !== ws && c.readyState === c.OPEN) c.send(fwd);
            }
        } else if (msg && msg.type === 'display_transform') {
            currentDisplayTransform = { ...currentDisplayTransform, ...msg };
            delete currentDisplayTransform.type;
            saveState();
            const fwd = JSON.stringify(msg);
            for (const c of clients) if (c !== ws && c.readyState === c.OPEN) c.send(fwd);
        } else if (msg && msg.type === 'client_fps') {
            const fwd = JSON.stringify(msg);
            for (const c of clients) if (c !== ws && c.readyState === c.OPEN) c.send(fwd);
        } else if (msg && msg.type === 'mouse') {
            worker.postMessage({ type: 'mouse', data: msg });
        } else if (!msg) {
            worker.postMessage({ type: 'key', key: str });
        }
    });

    ws.on('close', () => {
        if (ws === projectorWs) {
            projectorWs = null;
            console.log('Projector client disconnected.');
        }
        clients.delete(ws);
        console.log(`Client disconnected. Total: ${clients.size}`);
    });

    ws.on('error', (err) => console.error('WS client error:', err.message));
});

wss.on('error', (err) => console.error('WS server error:', err.message));
