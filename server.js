'use strict';

// Unit 3: Zstd frame compression — compress every binary frame before broadcast.
// Unit 4: Worker thread isolation — sim runs in sim-worker.js; this file only
//         handles WebSocket connections and message routing.

const uWS                  = require('uWebSockets.js');
const { Worker }           = require('worker_threads');
const zlib                 = require('node:zlib');
const fs                   = require('fs');
const path                 = require('path');

const { SIM_WIDTH, TARGET_FPS, GRID_SEND_EVERY } = require('./shared-state.js');

const USE_ZSTD = typeof zlib.zstdCompressSync === 'function';

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
        broadcastText(JSON.stringify({ type: 'sim_speed', speed: simSpeed }));
        return;
    }
    if (msg.type === 'reset_ack') {
        broadcastText(JSON.stringify({ type: 'reset_ack' }));
        return;
    }
    if (openSockets.size === 0) return;
    if (msg.type === 'frame') fpsFrameCount++;
    if (msg.type === 'frame' || msg.type === 'grid') {
        const raw = Buffer.from(msg.buf);
        broadcastFrame(USE_ZSTD ? zlib.zstdCompressSync(raw, { level: 1 }) : raw);
    }
});

worker.on('error', (err) => console.error('Sim worker error:', err));
worker.on('exit', (code) => { if (code !== 0) console.error('Sim worker exited with code', code); });

// ---- WebSocket server ----

const openSockets = new Set();
let projectorWs = null;

// FPS accounting (from worker frame messages)
let fpsFrameCount = 0;
let fpsStart = Date.now();

setInterval(() => {
    const now = Date.now();
    if (now - fpsStart >= 1000) {
        const fps = (fpsFrameCount / ((now - fpsStart) / 1000)).toFixed(1);
        if (openSockets.size > 0) {
            broadcastText(JSON.stringify({ type: 'fps', fps: parseFloat(fps) }));
        }
        fpsFrameCount = 0;
        fpsStart = now;
        console.log(`FPS: ${fps}  Clients: ${openSockets.size}`);
    }
}, Math.round(1000 / TARGET_FPS));

function broadcastFrame(buf) {
    openSockets.forEach(ws => {
        const ud = ws.getUserData();
        ud.frameCount++;
        if (ud.frameCount % ud.frameSkip !== 0) return;
        if (ws.getBufferedAmount() > 0) return; // backpressure: drop frame
        ws.send(buf, true); // binary=true
    });
}

function broadcastText(str) {
    openSockets.forEach(ws => ws.send(str, false));
}

function sendCurrentState(ws) {
    ws.send(JSON.stringify({ type: 'display_transform', ...currentDisplayTransform }), false);
    ws.send(JSON.stringify({ type: 'client_state', ...clientToggles }), false);
    ws.send(JSON.stringify({ type: 'sim_speed', speed: simSpeed }), false);
    // Signal Zstd only if server is actually compressing
    if (USE_ZSTD) ws.send(JSON.stringify({ type: 'encoding', compression: 'zstd' }), false);
}

const app = uWS.App();

app.ws('/*', {
    compression: uWS.DISABLED,
    maxPayloadLength: 16 * 1024 * 1024,
    idleTimeout: 60,

    upgrade: (res, req, context) => {
        const url = req.getUrl();
        const query = req.getQuery();
        // Detect projector role from URL query param for initial frameSkip
        const isProjectorUrl = /(?:^|&)role=projector(?:&|$)/.test(query);
        res.upgrade(
            { role: isProjectorUrl ? 'projector' : 'control', frameSkip: isProjectorUrl ? 1 : 6, frameCount: 0, isProjector: isProjectorUrl },
            req.getHeader('sec-websocket-key'),
            req.getHeader('sec-websocket-protocol'),
            req.getHeader('sec-websocket-extensions'),
            context
        );
    },

    open: (ws) => {
        openSockets.add(ws);
        console.log(`Client connected. Total: ${openSockets.size}`);
        sendCurrentState(ws);
    },

    message: (ws, message, isBinary) => {
        if (isBinary) return;
        const str = Buffer.from(message).toString();
        let msg = null;
        try { msg = JSON.parse(str); } catch (e) { /* not JSON */ }

        if (msg && msg.type === 'register') {
            if (msg.role === 'projector') {
                if (projectorWs && openSockets.has(projectorWs)) {
                    ws.send(JSON.stringify({ type: 'error', reason: 'projector_taken' }), false);
                    ws.close();
                    console.log('Rejected duplicate projector registration.');
                } else {
                    projectorWs = ws;
                    const ud = ws.getUserData();
                    ud.role = 'projector';
                    ud.frameSkip = 1;
                    ws.send(JSON.stringify({ type: 'registered', role: 'projector' }), false);
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
                openSockets.forEach(c => c.send(echo, false));
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
            openSockets.forEach(c => { if (c !== ws) c.send(fwd, false); });
        } else if (msg && msg.type === 'client_dimensions') {
            if (ws === projectorWs) {
                const fwd = JSON.stringify(msg);
                openSockets.forEach(c => { if (c !== ws) c.send(fwd, false); });
            }
        } else if (msg && msg.type === 'display_transform') {
            currentDisplayTransform = { ...currentDisplayTransform, ...msg };
            delete currentDisplayTransform.type;
            saveState();
            const fwd = JSON.stringify(msg);
            openSockets.forEach(c => { if (c !== ws) c.send(fwd, false); });
        } else if (msg && msg.type === 'client_fps') {
            const fwd = JSON.stringify(msg);
            openSockets.forEach(c => { if (c !== ws) c.send(fwd, false); });
        } else if (msg && msg.type === 'mouse') {
            worker.postMessage({ type: 'mouse', data: msg });
        } else if (!msg) {
            worker.postMessage({ type: 'key', key: str });
        }
    },

    drain: (ws) => {
        // socket drained — backpressure cleared
    },

    close: (ws, code, message) => {
        if (ws === projectorWs) {
            projectorWs = null;
            console.log('Projector client disconnected.');
        }
        openSockets.delete(ws);
        console.log(`Client disconnected. Total: ${openSockets.size}`);
    },
});

app.listen(PORT, (token) => {
    if (token) console.log(`WS listening on :${PORT}`);
    else console.error('Failed to listen on port', PORT);
});
