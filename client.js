'use strict';

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const statusEl = document.getElementById('status');
const hintEl = document.getElementById('hint');

let width, height;

function resizeCanvas() {
    width = canvas.width = window.innerWidth;
    height = canvas.height = window.innerHeight;
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

// Rendering constants (must match script.js / sim-core.js)
const MIN_DRAW_OPACITY = 0.0;
const TRANSPARENT_OPACITY = 0.1;
const FADE_HOLD_THRESHOLD = 190;
const FADE_SLOW_AMOUNT = 1;
const FADE_FAST_AMOUNT = 6;
const TRAIL_BLUR_RADIUS = 0.8;
const TRAIL_BLUR_ALPHA = 0.5;

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

// Last received frame number (for FPS tracking)
let lastFrameNum = 0;
let frameNum = 0;

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
        showStatus('Connected', true);
    };

    ws.onmessage = (e) => {
        if (e.data instanceof ArrayBuffer) {
            unpackFrame(e.data);
        }
    };

    ws.onclose = () => {
        connected = false;
        showStatus('Disconnected — reconnecting…');
        setTimeout(connect, 2000);
    };

    ws.onerror = () => {
        // onclose fires after onerror
        ws.close();
    };
}

// Unpack binary frame from server.
// Header (8 bytes): frameNum (uint32LE), particleCount (uint32LE)
// Per particle (8 bytes): x (uint16), y (uint16), opacity (uint8),
//   radius (uint8, / 10), sourceIdx (uint8), flags (uint8: bit0=isCapillary)
function unpackFrame(buf) {
    const view = new DataView(buf);
    frameNum = view.getUint32(0, true);
    const count = view.getUint32(4, true);

    // Grow or shrink particles array to match
    while (particles.length < count) particles.push({});
    particles.length = count;

    let offset = 8;
    for (let i = 0; i < count; i++) {
        const p = particles[i];
        const xEnc = view.getUint16(offset, true); offset += 2;
        const yEnc = view.getUint16(offset, true); offset += 2;
        // Scale normalized coords to current client canvas dimensions
        p.x = xEnc / 65535 * width;
        p.y = yEnc / 65535 * height;
        p.opacity    = view.getUint8(offset++) / 255;
        p.radius     = view.getUint8(offset++) / 10;
        p.sourceIdx  = view.getUint8(offset++);
        const flags  = view.getUint8(offset++);
        p.isCapillary = (flags & 1) !== 0;
    }
}

// ---- Render loop ----

function animate() {
    requestAnimationFrame(animate);

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

        // Subtle blur pass to soften trail edges
        ctx.save();
        ctx.filter = `blur(${TRAIL_BLUR_RADIUS}px)`;
        ctx.globalAlpha = TRAIL_BLUR_ALPHA;
        ctx.drawImage(canvas, 0, 0);
        ctx.restore();
    }

    if (particles.length === 0) return;

    // Single-pass particle drawing
    ctx.fillStyle = '#fff';
    for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        if (p.opacity <= MIN_DRAW_OPACITY) continue;

        const opacity = transparentParticles ? p.opacity * TRANSPARENT_OPACITY : p.opacity;
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

window.addEventListener('keydown', (e) => {
    // Local rendering toggles — handled on client, not forwarded
    if (e.key === 't' || e.key === 'T') {
        transparentParticles = !transparentParticles;
        return;
    }
    if (e.key === 'c' || e.key === 'C') {
        sourceColorParticles = !sourceColorParticles;
        return;
    }

    // All other keys are forwarded to server for simulation control
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
