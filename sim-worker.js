'use strict';

// Worker thread: runs the river simulation loop independently of the
// WebSocket event loop.  Frame data is written into a SharedArrayBuffer
// triple-buffer so the main thread can poll without serialization overhead.
// Commands (key, reset, mouse, overlay) arrive from the main thread.

const { parentPort, workerData } = require('worker_threads');
const sim = require('./sim-core.js');
const { SIM_WIDTH, SIM_HEIGHT, TARGET_FPS, GRID_SEND_EVERY } = require('./shared-state.js');

const SLOT_SIZE = 512 * 1024;
const { sab } = workerData;
const ctrl = new Int32Array(sab, 0, 4);
const slots = Array.from({ length: 3 }, (_, i) => new Uint8Array(sab, 16 + i * SLOT_SIZE, SLOT_SIZE));

sim.resize(SIM_WIDTH, SIM_HEIGHT);

// Apply saved state before init
const savedToggles = workerData.toggles || {};
if (savedToggles.b) sim.handleKey('b');
if (!savedToggles.m) sim.handleKey('m'); // m defaults on in sim; toggle off if saved as false

sim.init();

let frameCount = 0;
let wetnessOverlay = false;
let erosionOverlay = false;
let running = true;

parentPort.on('message', (msg) => {
    if (msg.type === 'pause') {
        running = false;
    } else if (msg.type === 'resume') {
        running = true;
    } else if (msg.type === 'key') {
        sim.handleKey(msg.key);
        // Report updated speed after speed-change keys so main thread can broadcast it
        if (msg.key === 'ArrowUp' || msg.key === 'ArrowDown') {
            parentPort.postMessage({ type: 'speed', speed: sim.getSimSpeed() });
        }
    } else if (msg.type === 'reset') {
        sim.reset();
        parentPort.postMessage({ type: 'reset_ack' });
    } else if (msg.type === 'mouse') {
        sim.handleMouse(msg.data);
    } else if (msg.type === 'overlay') {
        if (msg.grid === 'wetness') wetnessOverlay = !wetnessOverlay;
        if (msg.grid === 'erosion') erosionOverlay  = !erosionOverlay;
    }
});

setInterval(() => {
    if (!running) return;
    sim.tick();

    // Write frame into back slot of the SharedArrayBuffer triple-buffer
    const frameData = sim.getFrameData();
    const frameLen = frameData.byteLength;
    const backSlot = ctrl[0];
    new DataView(sab, 16 + backSlot * SLOT_SIZE, 4).setUint32(0, frameLen, true);
    slots[backSlot].set(frameData, 4);
    // Publish: swap back/spare, set dirty bit
    const newSpare = (backSlot << 1) | 1;
    const prev = Atomics.exchange(ctrl, 1, newSpare);
    ctrl[0] = prev >> 1; // new back slot = old spare slot index

    // Grid overlays at reduced rate (still sent via postMessage)
    if (frameCount % GRID_SEND_EVERY === 0) {
        if (wetnessOverlay) {
            const wb = sim.getWetnessData();
            const wab = wb.buffer.slice(wb.byteOffset, wb.byteOffset + wb.byteLength);
            parentPort.postMessage({ type: 'grid', buf: wab }, [wab]);
        }
        if (erosionOverlay) {
            const eb = sim.getErosionData();
            const eab = eb.buffer.slice(eb.byteOffset, eb.byteOffset + eb.byteLength);
            parentPort.postMessage({ type: 'grid', buf: eab }, [eab]);
        }
    }

    frameCount++;
}, Math.round(1000 / TARGET_FPS));

parentPort.postMessage({ type: 'ready', speed: sim.getSimSpeed() });
