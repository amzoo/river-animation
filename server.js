'use strict';

const { WebSocketServer } = require('ws');
const sim = require('./sim-core.js');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;
const SIM_WIDTH = 1920;
const SIM_HEIGHT = 1080;
const TARGET_FPS = 30;

sim.resize(SIM_WIDTH, SIM_HEIGHT);
sim.init();

const wss = new WebSocketServer({ port: PORT });

const clients = new Set();
let frameCount = 0;
let fpsStart = Date.now();

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
        } else if (msg && msg.type === 'mouse') {
            sim.handleMouse(msg);
        } else if (!msg) {
            // Plain string — treat as key
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

setInterval(() => {
    sim.tick();

    if (clients.size === 0) return;

    const buf = sim.getFrameData();
    for (const ws of clients) {
        if (ws.readyState === ws.OPEN) {
            ws.send(buf, { binary: true });
        }
    }

    frameCount++;
    const now = Date.now();
    if (now - fpsStart >= 5000) {
        const fps = (frameCount / ((now - fpsStart) / 1000)).toFixed(1);
        console.log(`FPS: ${fps}  Clients: ${clients.size}`);
        frameCount = 0;
        fpsStart = now;
    }
}, Math.round(1000 / TARGET_FPS));

console.log(`Sim ready. WS listening on :${PORT}`);
