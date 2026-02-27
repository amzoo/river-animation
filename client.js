'use strict';

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const overlayCanvas = document.getElementById('overlay');
const overlayCtx = overlayCanvas.getContext('2d');
const statusEl = document.getElementById('status');
const hintEl = document.getElementById('hint');
const fpsEl = document.getElementById('fps');
let hintVisible = true;

// Track server-side toggle states (mirrored client-side for hint display)
let capillaryDiversion = false;
let mixSources = true; // default on in sim-core.js

function setHintActive(id, active) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('active', active);
}

function updateHint() {
    setHintActive('hint-T', transparentParticles);
    setHintActive('hint-C', sourceColorParticles);
    setHintActive('hint-W', wetnessOverlay);
    setHintActive('hint-E', erosionOverlay);
    setHintActive('hint-B', capillaryDiversion);
    setHintActive('hint-M', mixSources);
}

let width, height;

function resizeCanvas() {
    width = canvas.width = overlayCanvas.width = window.innerWidth;
    height = canvas.height = overlayCanvas.height = window.innerHeight;
}
resizeCanvas();
window.addEventListener('resize', resizeCanvas);

// Parse server address from URL param: ?server=192.168.x.x:8080
const params = new URLSearchParams(window.location.search);
const serverAddr = params.get('server') || (window.location.hostname + ':8080');
const wsUrl = `ws://${serverAddr}`;

// Particle render data (unpacked from binary frames)
let particles = [];

// Local rendering toggles
let transparentParticles = false;
let sourceColorParticles = false;
let wetnessOverlay = false;
let erosionOverlay = false;

// Rendering constants (must match script.js / sim-core.js)
const MIN_DRAW_OPACITY = 0.0;
const TRANSPARENT_OPACITY = 0.1;
const FADE_HOLD_THRESHOLD = 190;
const FADE_SLOW_AMOUNT = 1;
const FADE_FAST_AMOUNT = 6;
const TRAIL_BLUR_RADIUS = 0.8;
const TRAIL_BLUR_ALPHA = 0.5;
const HEATMAP_WETNESS_ALPHA = 0.5;
const HEATMAP_EROSION_ALPHA = 0.6;
const HEATMAP_LOW_BREAK = 0.33;
const HEATMAP_HIGH_BREAK = 0.66;
const EROSION_MID_BREAK = 0.5;
const EROSION_BASE_R = 128;
const EROSION_RANGE_R = 127;
const EROSION_BASE_G_HIGH = 165;
const EROSION_RANGE_G_HIGH = 90;
const EROSION_BASE_B = 200;
const OVERLAY_FONT_SIZE = 12;

const RIVER_COLORS = [
    [253, 189, 165],  // Coral
    [130, 253, 209],  // Mint
    [32,  128, 208],  // Blue
    [191, 157, 220],  // Lilac
    [45,  187, 105],  // Green
    [160, 216, 255],  // Light Blue
    [200, 255, 232],  // Light Mint
];

// ---- WebSocket ----

let ws = null;
let connected = false;
let statusHideTimer = null;

// Frame counter for "every other frame" fade logic
let fadeToggle = false;

// FPS tracking
let smoothFPS = 0;
let lastFrameTime = performance.now();
let serverFPS = null;
let awaitingReset = false;

// Last received frame number
let frameNum = 0;

// Fade-in after connect: ramp particle opacity from 0→1 over this many RAF frames
const CONNECT_FADE_IN_FRAMES = 180; // ~3 seconds at 60fps
let connectFadeFrame = 0;

// Latest grid data received from server
let wetnessGrid = null; // { cols, rows, maxVal, data: Uint8Array }
let erosionGrid = null;

function showStatus(msg, autoHide) {
    statusEl.textContent = msg;
    statusEl.classList.remove('hidden');
    if (statusHideTimer) clearTimeout(statusHideTimer);
    if (autoHide) {
        statusHideTimer = setTimeout(() => { statusEl.classList.add('hidden'); }, 3000);
    }
}

function connect() {
    showStatus(`Connecting to ${wsUrl}…`);
    ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
        connected = true;
        connectFadeFrame = 0; // restart fade-in
        showStatus('Connected', true);
    };

    ws.onmessage = (e) => {
        if (typeof e.data === 'string') {
            const msg = JSON.parse(e.data);
            if (msg.type === 'fps') serverFPS = msg.fps;
            if (msg.type === 'client_key') handleClientKey(msg.key);
            if (msg.type === 'reset_ack') {
                awaitingReset = false;
                particles = [];
                connectFadeFrame = 0;
            }
            return;
        }
        const view = new DataView(e.data);
        const type = view.getUint8(0);
        if (type === 0x00) unpackParticles(view);
        else if (type === 0x01) unpackGrid(view, 'wetness');
        else if (type === 0x02) unpackGrid(view, 'erosion');
    };

    ws.onclose = () => {
        connected = false;
        showStatus('Disconnected — reconnecting…');
        setTimeout(connect, 2000);
    };

    ws.onerror = () => {
        ws.close();
    };
}

// Byte 0: type 0x00
// Bytes 1-4: frameNum (uint32LE), bytes 5-8: count (uint32LE)
// Per particle (8 bytes): x, y (uint16), opacity, radius (uint8), sourceIdx, flags (uint8)
function unpackParticles(view) {
    frameNum = view.getUint32(1, true);
    const count = view.getUint32(5, true);

    while (particles.length < count) particles.push({});
    particles.length = count;

    let offset = 9;
    for (let i = 0; i < count; i++) {
        const p = particles[i];
        const xEnc = view.getUint16(offset, true); offset += 2;
        const yEnc = view.getUint16(offset, true); offset += 2;
        p.x = xEnc / 65535 * width;
        p.y = yEnc / 65535 * height;
        p.opacity    = view.getUint8(offset++) / 255;
        p.radius     = view.getUint8(offset++) / 10;
        p.sourceIdx  = view.getUint8(offset++);
        const flags  = view.getUint8(offset++);
        p.isCapillary = (flags & 1) !== 0;
    }
}

// Byte 0: type, bytes 1-2: cols, bytes 3-4: rows, bytes 5-8: maxVal, bytes 9+: uint8 data
function unpackGrid(view, which) {
    const cols   = view.getUint16(1, true);
    const rows   = view.getUint16(3, true);
    const maxVal = view.getFloat32(5, true);
    const data   = new Uint8Array(view.buffer, 9, cols * rows);
    if (which === 'wetness') wetnessGrid = { cols, rows, maxVal, data };
    else                     erosionGrid  = { cols, rows, maxVal, data };
}

// ---- Overlay rendering ----

function renderWetness(grid) {
    const cellW = width  / grid.cols;
    const cellH = height / grid.rows;
    overlayCtx.save();
    for (let r = 0; r < grid.rows; r++) {
        for (let c = 0; c < grid.cols; c++) {
            const v = grid.data[r * grid.cols + c];
            if (v === 0) continue;
            const t = v / 255;
            let red, green, blue;
            if (t < HEATMAP_LOW_BREAK) {
                const s = t / HEATMAP_LOW_BREAK;
                red = 0; green = Math.floor(s * 255); blue = 255;
            } else if (t < HEATMAP_HIGH_BREAK) {
                const s = (t - HEATMAP_LOW_BREAK) / HEATMAP_LOW_BREAK;
                red = Math.floor(s * 255); green = 255; blue = Math.floor((1 - s) * 255);
            } else {
                const s = (t - HEATMAP_HIGH_BREAK) / (1 - HEATMAP_HIGH_BREAK);
                red = 255; green = Math.floor((1 - s) * 255); blue = 0;
            }
            overlayCtx.fillStyle = `rgba(${red},${green},${blue},${HEATMAP_WETNESS_ALPHA})`;
            overlayCtx.fillRect(c * cellW, r * cellH, cellW, cellH);
        }
    }
    overlayCtx.font = `${OVERLAY_FONT_SIZE}px monospace`;
    overlayCtx.fillStyle = '#ffffff';
    overlayCtx.fillText(`WETNESS (max: ${grid.maxVal.toFixed(1)})`, 8, 16);
    overlayCtx.restore();
}

function renderErosion(grid) {
    const cellW = width  / grid.cols;
    const cellH = height / grid.rows;
    overlayCtx.save();
    for (let r = 0; r < grid.rows; r++) {
        for (let c = 0; c < grid.cols; c++) {
            const v = grid.data[r * grid.cols + c];
            if (v === 0) continue;
            const t = v / 255;
            let red, green, blue;
            if (t < EROSION_MID_BREAK) {
                const s = t / EROSION_MID_BREAK;
                red = Math.floor(EROSION_BASE_R + s * EROSION_RANGE_R);
                green = Math.floor(s * EROSION_BASE_G_HIGH);
                blue = Math.floor(EROSION_BASE_B * (1 - s));
            } else {
                const s = (t - EROSION_MID_BREAK) / EROSION_MID_BREAK;
                red = 255;
                green = Math.floor(EROSION_BASE_G_HIGH + s * EROSION_RANGE_G_HIGH);
                blue = Math.floor(s * 255);
            }
            overlayCtx.fillStyle = `rgba(${red},${green},${blue},${HEATMAP_EROSION_ALPHA})`;
            overlayCtx.fillRect(c * cellW, r * cellH, cellW, cellH);
        }
    }
    overlayCtx.font = `${OVERLAY_FONT_SIZE}px monospace`;
    overlayCtx.fillStyle = '#ffffff';
    overlayCtx.fillText(`EROSION (max: ${grid.maxVal.toFixed(1)})`, 8, wetnessOverlay ? 32 : 16);
    overlayCtx.restore();
}

// ---- Render loop ----

function animate() {
    requestAnimationFrame(animate);

    const now = performance.now();
    const dt = now - lastFrameTime;
    lastFrameTime = now;
    if (dt > 0) smoothFPS = smoothFPS * 0.95 + (1000 / dt) * 0.05;
    fpsEl.textContent = `client ${smoothFPS.toFixed(1)} fps` +
        (serverFPS !== null ? `  |  server ${serverFPS.toFixed(1)} fps` : '');

    // Canvas fade — "hold then quickly fade" effect, every other RAF call
    fadeToggle = !fadeToggle;
    if (fadeToggle) {
        const imgData = ctx.getImageData(0, 0, width, height);
        const data = imgData.data;
        for (let j = 0; j < data.length; j += 4) {
            const r = data[j];
            if (r > 0) {
                const fadeAmount = r > FADE_HOLD_THRESHOLD ? FADE_SLOW_AMOUNT : FADE_FAST_AMOUNT;
                data[j]     -= fadeAmount;
                data[j + 1] -= fadeAmount;
                data[j + 2] -= fadeAmount;
            }
        }
        ctx.putImageData(imgData, 0, 0);

        // Subtle blur pass to soften trail edges — skip during fade-in to prevent bloom
        if (connectFadeFrame >= CONNECT_FADE_IN_FRAMES) {
            ctx.save();
            ctx.filter = `blur(${TRAIL_BLUR_RADIUS}px)`;
            ctx.globalAlpha = TRAIL_BLUR_ALPHA;
            ctx.drawImage(canvas, 0, 0);
            ctx.restore();
        }
    }

    // Overlay heatmaps
    overlayCtx.clearRect(0, 0, width, height);
    if (wetnessOverlay && wetnessGrid) renderWetness(wetnessGrid);
    if (erosionOverlay  && erosionGrid)  renderErosion(erosionGrid);

    if (awaitingReset || particles.length === 0) return;

    // Ramp opacity up from 0 on first connect to avoid the "explosion" of
    // all particles appearing at once on a fresh black canvas
    const connectFade = Math.min(connectFadeFrame / CONNECT_FADE_IN_FRAMES, 1.0);
    if (connectFadeFrame < CONNECT_FADE_IN_FRAMES) connectFadeFrame++;

    // Single-pass particle drawing
    ctx.fillStyle = '#fff';
    for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        if (p.opacity <= MIN_DRAW_OPACITY) continue;

        const opacity = (transparentParticles ? p.opacity * TRANSPARENT_OPACITY : p.opacity) * connectFade;
        const radius = p.radius;
        if (radius < 0.1) continue;

        if (sourceColorParticles) {
            const clr = RIVER_COLORS[p.sourceIdx % RIVER_COLORS.length];
            ctx.fillStyle = `rgb(${clr[0]},${clr[1]},${clr[2]})`;
        } else {
            ctx.fillStyle = '#fff';
        }
        ctx.globalAlpha = opacity;

        const d = radius * 2;
        ctx.fillRect(p.x - radius, p.y - radius, d, d);
    }
    ctx.globalAlpha = 1.0;
}

// ---- Keyboard ----

// Handle client-local keys — called from keyboard events and remote control panel
function handleClientKey(key) {
    if (key === 'h' || key === 'H') {
        hintVisible = !hintVisible;
        hintEl.classList.toggle('hidden', !hintVisible);
        fpsEl.classList.toggle('hidden', !hintVisible);
        return;
    }
    if (key === 't' || key === 'T') {
        transparentParticles = !transparentParticles;
        updateHint();
        return;
    }
    if (key === 'c' || key === 'C') {
        sourceColorParticles = !sourceColorParticles;
        updateHint();
        return;
    }
    if (key === 'w' || key === 'W') {
        wetnessOverlay = !wetnessOverlay;
        if (!wetnessOverlay) wetnessGrid = null;
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'overlay', grid: 'wetness' }));
        }
        updateHint();
        return;
    }
    if (key === 'e' || key === 'E') {
        erosionOverlay = !erosionOverlay;
        if (!erosionOverlay) erosionGrid = null;
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'overlay', grid: 'erosion' }));
        }
        updateHint();
        return;
    }
    if (key === 'b' || key === 'B') { capillaryDiversion = !capillaryDiversion; updateHint(); }
    if (key === 'm' || key === 'M') { mixSources = !mixSources; updateHint(); }
    if (key === 'reload') { window.location.reload(); }
}

window.addEventListener('keydown', (e) => {
    // Client-local keys
    if ('hHtTcCwWeE'.includes(e.key)) {
        handleClientKey(e.key);
        return;
    }

    // Reset simulation
    if (e.key === '0') {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'reset' }));
        }
        ctx.fillStyle = 'black';
        ctx.fillRect(0, 0, width, height);
        particles = [];
        awaitingReset = true;
        return;
    }

    // Forward to server for simulation control (server echoes B/M back via client_key)
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'key', key: e.key }));
    }
});

// ---- Mouse forwarding (optional) ----
// Uncomment to enable physics interaction from client mouse:
//
// let prevMouseX = 0, prevMouseY = 0, mouseLeftDown = false;
// canvas.addEventListener('mousemove', (e) => {
//     const dx = (e.clientX - prevMouseX) / width;
//     const dy = (e.clientY - prevMouseY) / height;
//     prevMouseX = e.clientX; prevMouseY = e.clientY;
//     if (ws && ws.readyState === WebSocket.OPEN) {
//         ws.send(JSON.stringify({ type: 'mouse', x: e.clientX / width, y: e.clientY / height, dx, dy, leftDown: mouseLeftDown }));
//     }
// });
// canvas.addEventListener('mousedown', (e) => { if (e.button === 0) mouseLeftDown = true; });
// canvas.addEventListener('mouseup', (e) => { if (e.button === 0) mouseLeftDown = false; });

// ---- Start ----

connect();
animate();
updateHint();
