'use strict';

const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');
const sim = require('./sim-core.js');

const STATE_FILE = path.join(__dirname, 'state.json');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;
const SIM_WIDTH = 1920;
const SIM_HEIGHT = 1080;
const TARGET_FPS = 30;
const GRID_SEND_EVERY = 6; // send grid data every N particle frames (~5fps)

sim.resize(SIM_WIDTH, SIM_HEIGHT);
sim.init();

const wss = new WebSocketServer({ port: PORT });

const clients = new Set();
let frameCount = 0;
let fpsStart = Date.now();
let wetnessOverlay = false;
let erosionOverlay = false;

// Projector (primary display) client
let projectorWs = null;

// Tracked display state — synced to new clients on connect
const DEFAULT_TRANSFORM = {
    insetTop: 0, insetBottom: 0, insetLeft: 0, insetRight: 0,
    shiftTop: 0, shiftBottom: 0, shiftLeft: 0, shiftRight: 0,
    fadeTop: 0, fadeBottom: 0, fadeLeft: 0, fadeRight: 0,
};
// Lowercase keys only; m starts true to match sim-core default
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
    }, 500); // debounce — wait 500ms after last change before writing
}

const { transform: savedTransform, toggles: savedToggles } = loadState();
let currentDisplayTransform = savedTransform;
const clientToggles = savedToggles;
console.log('State loaded from', STATE_FILE);

function sendCurrentState(ws) {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ type: 'display_transform', ...currentDisplayTransform }));
    ws.send(JSON.stringify({ type: 'client_state', ...clientToggles }));
    ws.send(JSON.stringify({ type: 'sim_speed', speed: sim.getSimSpeed() }));
}

wss.on('connection', (ws) => {
    clients.add(ws);
    console.log(`Client connected. Total: ${clients.size}`);

    // Send current display state so new clients are immediately in sync
    sendCurrentState(ws);

    ws.on('message', (data, isBinary) => {
        if (isBinary) return; // ignore binary from client
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
            sim.handleKey(msg.key);
            // Echo toggleable sim keys to all clients so their hint bars stay in sync
            if ('bBmM'.includes(msg.key)) {
                const k = msg.key.toLowerCase();
                clientToggles[k] = !clientToggles[k];
                saveState();
                const echo = JSON.stringify({ type: 'client_key', key: msg.key });
                for (const c of clients) {
                    if (c.readyState === c.OPEN) c.send(echo);
                }
            }
            // Broadcast updated speed after arrow key changes
            if (msg.key === 'ArrowUp' || msg.key === 'ArrowDown') {
                const speedMsg = JSON.stringify({ type: 'sim_speed', speed: sim.getSimSpeed() });
                for (const c of clients) {
                    if (c.readyState === c.OPEN) c.send(speedMsg);
                }
            }
        } else if (msg && msg.type === 'reset') {
            sim.reset();
            const ack = JSON.stringify({ type: 'reset_ack' });
            for (const c of clients) {
                if (c.readyState === c.OPEN) c.send(ack);
            }
        } else if (msg && msg.type === 'overlay') {
            if (msg.grid === 'wetness') wetnessOverlay = !wetnessOverlay;
            if (msg.grid === 'erosion') erosionOverlay = !erosionOverlay;
        } else if (msg && msg.type === 'client_key') {
            // Track toggle state
            const k = msg.key.toLowerCase();
            if (k in clientToggles) { clientToggles[k] = !clientToggles[k]; saveState(); }
            // Forward to all display clients (all except sender)
            const fwd = JSON.stringify(msg);
            for (const c of clients) {
                if (c !== ws && c.readyState === c.OPEN) c.send(fwd);
            }
        } else if (msg && msg.type === 'client_dimensions') {
            // Only forward dimensions from the registered projector client
            if (ws === projectorWs) {
                const fwd = JSON.stringify(msg);
                for (const c of clients) {
                    if (c !== ws && c.readyState === c.OPEN) c.send(fwd);
                }
            }
        } else if (msg && msg.type === 'display_transform') {
            currentDisplayTransform = { ...currentDisplayTransform, ...msg };
            delete currentDisplayTransform.type;
            saveState();
            const fwd = JSON.stringify(msg);
            for (const c of clients) {
                if (c !== ws && c.readyState === c.OPEN) c.send(fwd);
            }
        } else if (msg && msg.type === 'client_fps') {
            const fwd = JSON.stringify(msg);
            for (const c of clients) {
                if (c !== ws && c.readyState === c.OPEN) c.send(fwd);
            }
        } else if (msg && msg.type === 'mouse') {
            sim.handleMouse(msg);
        } else if (!msg) {
            sim.handleKey(str);
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

    ws.on('error', (err) => {
        console.error('WS client error:', err.message);
    });
});

wss.on('error', (err) => {
    console.error('WS server error:', err.message);
});

function broadcast(buf) {
    for (const ws of clients) {
        if (ws.readyState === ws.OPEN) ws.send(buf, { binary: true });
    }
}

setInterval(() => {
    sim.tick();

    if (clients.size === 0) return;

    broadcast(sim.getFrameData());

    // Send grid overlays at reduced rate
    if (frameCount % GRID_SEND_EVERY === 0) {
        if (wetnessOverlay) broadcast(sim.getWetnessData());
        if (erosionOverlay) broadcast(sim.getErosionData());
    }

    frameCount++;
    const now = Date.now();
    if (now - fpsStart >= 1000) {
        const fps = (frameCount / ((now - fpsStart) / 1000)).toFixed(1);
        console.log(`FPS: ${fps}  Clients: ${clients.size}`);
        if (clients.size > 0) {
            const msg = JSON.stringify({ type: 'fps', fps: parseFloat(fps) });
            for (const ws of clients) {
                if (ws.readyState === ws.OPEN) ws.send(msg);
            }
        }
        frameCount = 0;
        fpsStart = now;
    }
}, Math.round(1000 / TARGET_FPS));

console.log(`Sim ready. WS listening on :${PORT}`);
