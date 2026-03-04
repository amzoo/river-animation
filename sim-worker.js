'use strict';

// Worker thread: runs the river simulation loop independently of the
// WebSocket event loop.  Frame data is transferred to the main thread via
// postMessage (using transferable ArrayBuffers for zero-copy semantics).
// Commands (key, reset, mouse, overlay) arrive from the main thread.

const { parentPort, workerData } = require('worker_threads');
const sim = require('./sim-core.js');
const { SIM_WIDTH, SIM_HEIGHT, TARGET_FPS, GRID_SEND_EVERY } = require('./shared-state.js');

sim.resize(SIM_WIDTH, SIM_HEIGHT);

// Apply saved state before init
const savedToggles = workerData.toggles || {};
if (savedToggles.b) sim.handleKey('b');
if (!savedToggles.m) sim.handleKey('m'); // m defaults on in sim; toggle off if saved as false

sim.init();

let frameCount = 0;
let wetnessOverlay = false;
let erosionOverlay = false;

parentPort.on('message', (msg) => {
    if (msg.type === 'key') {
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
    sim.tick();

    // Transfer particle frame (zero-copy: transfer the underlying ArrayBuffer)
    const frameBuf = sim.getFrameData(); // Node Buffer
    // Slice to its own ArrayBuffer so transfer doesn't clobber the pool
    const ab = frameBuf.buffer.slice(frameBuf.byteOffset, frameBuf.byteOffset + frameBuf.byteLength);
    parentPort.postMessage({ type: 'frame', buf: ab }, [ab]);

    // Grid overlays at reduced rate
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
