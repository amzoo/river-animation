'use strict';

const { WebSocketServer } = require('ws');
const sim = require('./sim-core.js');

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

wss.on('connection', (ws) => {
    clients.add(ws);
    console.log(`Client connected. Total: ${clients.size}`);

    ws.on('message', (data, isBinary) => {
        if (isBinary) return; // ignore binary from client
        const str = data.toString();
        let msg = null;
        try { msg = JSON.parse(str); } catch (e) { /* not JSON */ }

        if (msg && msg.type === 'key') {
            sim.handleKey(msg.key);
            // Echo toggleable sim keys to all clients so their hint bars stay in sync
            if ('bBmM'.includes(msg.key)) {
                const echo = JSON.stringify({ type: 'client_key', key: msg.key });
                for (const c of clients) {
                    if (c.readyState === c.OPEN) c.send(echo);
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
            // Forward to all display clients (all except sender)
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
