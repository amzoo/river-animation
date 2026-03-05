'use strict';

// Node.js shim for performance.now()
const _perf = globalThis.performance ?? { now: () => Date.now() };

const SimplexNoise = require('simplex-noise');
const noiseGrid = require('./noise-grid.js');

// Stage 3a: pre-computed noise grid dimensions (1/4-resolution relative to 3px sim grid)
const NOISE_CELL_SIZE = 12; // pixels per noise-grid cell
const GRID_COLS = Math.ceil(1920 / NOISE_CELL_SIZE); // 160
const GRID_ROWS = Math.ceil(1080 / NOISE_CELL_SIZE); // 90

// Bilinear lookup into a flat Float32Array grid of size (gridCols × gridRows).
// x/y are pixel-space coordinates; returns clamped interpolated value.
function bilinearLookup(grid, gridCols, gridRows, x, y) {
    let gc = x / NOISE_CELL_SIZE;
    let gr = y / NOISE_CELL_SIZE;
    if (gc < 0) gc = 0;
    if (gr < 0) gr = 0;
    let c0 = gc | 0;
    let r0 = gr | 0;
    if (c0 > gridCols - 2) c0 = gridCols - 2;
    if (r0 > gridRows - 2) r0 = gridRows - 2;
    const fc  = gc - c0;
    const fr  = gr - r0;
    const ifc = 1.0 - fc;
    const ifr = 1.0 - fr;
    const i00 = c0     + r0       * gridCols;
    const i10 = c0 + 1 + r0       * gridCols;
    const i01 = c0     + (r0 + 1) * gridCols;
    const i11 = c0 + 1 + (r0 + 1) * gridCols;
    return grid[i00] * ifc * ifr + grid[i10] * fc * ifr +
           grid[i01] * ifc * fr  + grid[i11] * fc * fr;
}

// ==========================================
// CONFIGURATION & TUNING VARIABLES
// (copied verbatim from script.js)
// ==========================================

// --- Overall Simulation ---
const NUM_PARTICLES = 30000;
const BURST_COUNT = 200;
const SOURCE_PARTICLE_COUNT = 4000;

// --- Flow Field & Noise ---
const NOISE_SCALE = 0.0008;
const NOISE_EVOLUTION_SPEED = 0.0003;
const NOISE_EPSILON = 0.1;

// --- Fluid & Wetness Grid ---
const GRID_SIZE = 3;
const EVAPORATION_RATE = 0.995;
const WETNESS_DEPOSIT = 0.2;
const WETNESS_DRY_THRESHOLD = 3.0;

// --- Erosion ---
const EROSION_DEPOSIT = 0.05;
const EROSION_DECAY = 0.9999;
const EROSION_MAX = 25.0;
const EROSION_SPREAD_STRENGTH = 0.35;

// --- Particle Physics ---
const PARTICLE_SPEED_BASE = 0.4;
const PARTICLE_SPEED_VAR = 0.8;

const PARTICLE_WEIGHT_BASE = 0.3;
const PARTICLE_WEIGHT_VAR = 0.7;

const PARTICLE_GRAVITY_BASE = 0.1;
const PARTICLE_GRAVITY_VAR = 1.5;

const PARTICLE_LIFE_BASE = 400;
const PARTICLE_LIFE_VAR = 1200;

const FRICTION = 0.85;

// --- Visuals & Fading ---
const MIN_DRAW_OPACITY = 0.0;
const MAX_DRAW_OPACITY = 0.20;

const FADE_HOLD_THRESHOLD = 190;
const FADE_SLOW_AMOUNT = 1;
const FADE_FAST_AMOUNT = 6;

// --- Capillary Ants ---
const CAPILLARY_LATERAL_FORCE = 1.2;
const CAPILLARY_GRAVITY = 0.1;
const CAPILLARY_MAX_OPACITY = 0.8;
const CAPILLARY_MAX_RADIUS = 1.4;
const CAPILLARY_WIGGLE_STRENGTH = 0.01;

// --- Capillary Wetness/Erosion (isolated grids) ---
const CAP_WETNESS_DEPOSIT    = 0.15;
const CAP_EROSION_DEPOSIT    = 0.03;
const CAP_EROSION_MAX        = 15.0;
const CAP_EVAPORATION_RATE   = 0.985;
const CAP_EROSION_DECAY      = 0.999;
const CAP_SCAN_RADIUS        = 30;
const CAP_EROSION_SPREAD     = 0.02;
const CAP_ATTRACT_SCALE      = 1.0;

// --- Zone Boundaries ---
const DELTA_ZONE_END = 0.30;
const TRANSITION_ZONE_END = 0.40;
const RIVER_CELL_SIZE = 3;

// --- Push Arc ---
const PUSH_ARC_RADIUS = 300;
const PUSH_ARC_SPAN   = 1.0;
const PUSH_PILL_RADIUS = 10;

const RIVER_REPULSE_STRENGTH = 60.0;

// --- Sources & Spawning ---
const NUM_SOURCES = 7;
const SOURCE_MARGIN_RATIO = 0.1;
const DELTA_SPAWN_WIDTH = 120;
const SOURCE_SPAWN_HEIGHT = 30;

// --- Capillary Heights ---
const CAP_HEIGHT_START_EVEN = 0.10;
const CAP_HEIGHT_START_ODD  = 0.05;
const CAP_HEIGHT_SPACING     = 0.20;
const CAP_HEIGHT_SPACING_VAR = 0.10;

// --- Stream Convergence ---
const CONVERGENCE_RAMP_RATIO = 0.10;
const STREAM_SCAN_RADIUS     = 40;
const EROSION_WEIGHT         = 3;
const PULL_MIN_THRESHOLD     = 0.01;
const PULL_FORCE_SCALE       = 0.1;
const PULL_FORCE_MAX         = 2.0;
const STAGNATION_BOOST_RATE  = 0.05;

// --- Lateral Spread ---
const WETNESS_SPREAD_THRESHOLD = 15;
const WETNESS_SPREAD_SCALE     = 0.005;
const WETNESS_SPREAD_MAX       = 0.3;

// --- Edge & Top Forces ---
const TOP_PUSH_FORCE    = 2.0;
const EDGE_MARGIN_RATIO = 0.05;

// --- Velocity & Stagnation ---
const FORCE_TO_VELOCITY    = 0.2;
const UPWARD_VELOCITY_DAMP = 0.1;
const STAGNATION_THRESHOLD = 0.3;
const STAGNATION_MAX       = 60;

const STAGNATION_DECAY     = 0.95;

// --- Particle Sleep/Wake (Stage 4) ---
const SLEEP_THRESHOLD_VEL = 0.3; // speed below which a particle is a sleep candidate
const WAKE_THRESHOLD_VEL  = 0.8; // noise magnitude that wakes a sleeping particle
const SLEEP_FRAMES        = 5;   // frames below threshold before sleeping

// --- Particle Aging & Opacity ---
const STRAY_AGE_ACCEL       = 2;
const STRAY_FADE_RATIO      = 0.3;
const STRAY_OPACITY_FACTOR  = 0.15;
const BASE_AGE_RATE         = 0.10;
const TRANSITION_AGE_BASE   = 0.20;
const TRANSITION_AGE_RAMP   = 3.8;
const DELTA_FADE_RATIO      = 0.5;
const DELTA_FADE_STRENGTH   = 0.7;
const OOB_MARGIN            = 50;

// --- Capillary Diversion ---
const CAPILLARY_DIVERSION_THRESHOLD = 10000;
const CAPILLARY_DIVERSIONS_PER_FRAME = 3;

// --- Capillary Physics ---
const CAP_WIGGLE_FREQ_BASE   = 0.04;
const CAP_WIGGLE_FREQ_VAR    = 0.06;
const CAP_LATERAL_SCALE      = 0.4;
const CAP_LATERAL_DECAY_DIST = 400;
const CAP_VERTICAL_SCAN      = 4;
const CAP_CHANNEL_THRESHOLD  = 0.1;
const CAP_FRICTION           = 0.85;
const CAP_MAX_SPEED          = 3.0;
const CAP_FADE_IN_FRAMES     = 20;
const MAX_RECYCLED_CAPILLARIES = 8000;

// --- Capillary Origin Cleanup ---
const CAP_ORIGIN_FADE_BAND     = 20;
const CAP_ACCEL_WETNESS_DECAY  = 0.90;
const CAP_ACCEL_EROSION_DECAY  = 0.95;
const CAP_CLEANUP_THRESHOLD    = 0.01;

// --- River Detection ---
const MIN_RIVER_CELLS      = 100;
const RIVER_GRID_THROTTLE  = 3;
const RIVER_RUN_MERGE_GAP  = 3;
const RIVER_RUN_MIN_WIDTH  = 3;
const BRIGHTNESS_BUCKET_1  = 15;
const BRIGHTNESS_BUCKET_2  = 50;
const BRIGHTNESS_BUCKET_3  = 128;

// --- Controls: Mouse Push ---
const MOUSE_PUSH_SCALE      = 3;
const MOUSE_PUSH_VELOCITY   = 0.9;
const PUSH_ANGLE_LERP_FAST  = 0.5;
const PUSH_ANGLE_LERP_SLOW  = 0.08;

// --- Controls: Burst ---
const BURST_MAX_MULTIPLIER = 4;
const BURST_MIN_RADIUS = 50;
const BURST_MAX_RADIUS = 300;
const BURST_CHARGE_TIME = 2000;

// --- Rendering: Particle Sizing ---
const CAP_THICKNESS_DIVISOR  = 6.0;
const CAP_MIN_RADIUS         = 0.8;
const PARTICLE_RADIUS_SCALE  = 1.5;
const DELTA_MIN_RADIUS       = 1.5;

const RIVER_WETNESS_THRESHOLD = 8.0;
const RIVER_PARTICLE_THRESHOLD = 1;
const RIVER_CELL_TIMEOUT = 5000;

// ==========================================

// Sim speed controls
const SIM_SPEED_STEPS = [0.1, 0.25, 0.5, 1, 2, 3, 4, 5];
let simSpeedIndex = 3;
let simSpeed = SIM_SPEED_STEPS[simSpeedIndex];
let simSpeedAccum = 0;

// Mouse state — always inactive on server; can be updated via handleMouse()
let mouse = {
    x: 0, y: 0, prevX: 0, prevY: 0,
    frameDX: 0, frameDY: 0,
    speed: 0, active: false, leftDown: false,
    lastTime: 0, pushAngle: 0
};

let zOff = 0;
let width, height;
let cols, rows;
let wetnessGrid;
let erosionGrid;
let dirtyFlags; // Stage 3b: Uint8Array, one flag per wetnessGrid/erosionGrid cell
let capWetnessGrid;
let capErosionGrid;
let capOwnerGrid;
let capOwnerStr;
let capFadeMask;
let sourceOwnerGrid;
let riverGrid = null;
let riverLabels = null;
let riverCellLastSeen = null;
let riverGridCols = 0;
let riverGridRows = 0;
let numRiverComponents = 0;
let riverComponentColors = [];
let capillaryHeights = [];
let capillaryOrigins = [];
let sourceCentroids = [];
let prevCapillaryOriginKeys = new Set();
let recycledCapillaryCount = 0;
let sourcePoints = [];
let deltaParticleCount = 0;
let riverZoneParticleCount = 0;
let frameDiversions = 0;
let capillaryDiversion = false;
let mixSources = true;
let frameNum = 0;

// ==========================================
// Structure-of-Arrays (SoA) particle storage
// ==========================================
// Float32 arrays for continuous properties
let px_arr;       // x position
let py_arr;       // y position
let vx_arr;       // x velocity
let vy_arr;       // y velocity
let speed_arr;    // per-particle speed scalar
let weight_arr;   // per-particle weight
let gravity_arr;  // per-particle gravity
let life_arr;     // particle lifetime
let age_arr;      // current age
let opacity_arr;  // drawOpacity
let stagnation_arr; // stagnation counter
// Capillary-specific float arrays
let capOriginX_arr;     // capillaryOriginX
let capOriginY_arr;     // capillaryOriginY
let capAngle_arr;       // capillaryAngle
let capWiggleSeed_arr;  // capillaryWiggleSeed
let capWiggleFreq_arr;  // capillaryWiggleFreq

// Uint8 arrays for small integer / flag properties
let sourceIdx_arr; // source index (0..NUM_SOURCES-1)
// flags byte: bit0=isCapillary, bit1=isSource, bit2=inDelta, bit3=_recycled
let flags_arr;
// capillaryDir: stored as Uint8, 0=dir<0 (-1), 1=dir>=0 (+1)
let capDir_arr;
// streamId: small integer (0..NUM_SOURCES*2+1)
let streamId_arr;
// sleepCounter: frames spent below SLEEP_THRESHOLD_VEL; >= SLEEP_FRAMES means sleeping
let sleepCounter_arr;

// flag bit masks
const FLAG_IS_CAPILLARY = 0x01;
const FLAG_IS_SOURCE    = 0x02;
const FLAG_IN_DELTA     = 0x04;
const FLAG_RECYCLED     = 0x08;

// --- Pre-allocated buffers for getFrameData() (reused every frame, no per-call alloc) ---
// activeMask: one bit per particle; bit set when opacity > MIN_DRAW_OPACITY
const activeMask = new Uint32Array(Math.ceil(NUM_PARTICLES / 32));
// frameDataBuf: worst-case output buffer (all particles active)
const frameDataBuf = new Uint8Array(NUM_PARTICLES * 8 + 9);

const simplex = new SimplexNoise();

function fbm(x, y, z) {
    let value = 0;
    let amplitude = 1;
    let frequency = 1;
    let max = 0;
    for (let i = 0; i < 4; i++) {
        value += simplex.noise3D(x * frequency, y * frequency, z) * amplitude;
        max += amplitude;
        amplitude *= 0.5;
        frequency *= 2.0;
    }
    return value / max;
}

function resize(w, h) {
    width = w;
    height = h;

    noiseGrid.resize(width, height);
    cols = Math.ceil(width / GRID_SIZE);
    rows = Math.ceil(height / GRID_SIZE);
    wetnessGrid = new Float32Array(cols * rows);
    erosionGrid = new Float32Array(cols * rows);
    dirtyFlags  = new Uint8Array(cols * rows); // Stage 3b: dirty region tracking
    capWetnessGrid = new Float32Array(cols * rows);
    capErosionGrid = new Float32Array(cols * rows);
    capOwnerGrid = new Int8Array(cols * rows);
    capOwnerStr  = new Float32Array(cols * rows);
    capFadeMask  = new Uint8Array(cols * rows);
    sourceOwnerGrid = new Int8Array(cols * rows).fill(-1);

    let rzYStart = Math.floor(height * TRANSITION_ZONE_END);
    riverGridCols = Math.ceil(width / RIVER_CELL_SIZE);
    riverGridRows = Math.ceil((height - rzYStart) / RIVER_CELL_SIZE);
    riverGrid = new Uint8Array(riverGridCols * riverGridRows);
    riverLabels = new Int32Array(riverGridCols * riverGridRows);
    riverCellLastSeen = new Float64Array(riverGridCols * riverGridRows);

    // Generate fixed source points across the top edge
    sourcePoints = [];
    const margin = width * SOURCE_MARGIN_RATIO;
    const spacing = (width - 2 * margin) / (NUM_SOURCES - 1);
    for (let i = 0; i < NUM_SOURCES; i++) {
        sourcePoints.push(margin + i * spacing);
    }

    // Generate fixed capillary origin heights for each source
    capillaryHeights = [];
    for (let s = 0; s < sourcePoints.length; s++) {
        let startY = height * (TRANSITION_ZONE_END + (s % 2 === 1 ? CAP_HEIGHT_START_EVEN : CAP_HEIGHT_START_ODD));
        let y = startY;
        while (y < height) {
            capillaryHeights.push({ y: y, sourceIdx: s });
            y += height * (CAP_HEIGHT_SPACING + Math.random() * CAP_HEIGHT_SPACING_VAR);
        }
    }
}

// Allocate all SoA arrays for N particles
function _allocArrays(n) {
    px_arr           = new Float32Array(n);
    py_arr           = new Float32Array(n);
    vx_arr           = new Float32Array(n);
    vy_arr           = new Float32Array(n);
    speed_arr        = new Float32Array(n);
    weight_arr       = new Float32Array(n);
    gravity_arr      = new Float32Array(n);
    life_arr         = new Float32Array(n);
    age_arr          = new Float32Array(n);
    opacity_arr      = new Float32Array(n);
    stagnation_arr   = new Float32Array(n);
    capOriginX_arr   = new Float32Array(n);
    capOriginY_arr   = new Float32Array(n);
    capAngle_arr     = new Float32Array(n);
    capWiggleSeed_arr = new Float32Array(n);
    capWiggleFreq_arr = new Float32Array(n);
    sourceIdx_arr    = new Uint8Array(n);
    flags_arr        = new Uint8Array(n);
    capDir_arr       = new Uint8Array(n);
    streamId_arr     = new Uint8Array(n);
    sleepCounter_arr = new Uint8Array(n);
}

// Reset particle i to a new river-zone particle (non-capillary, non-source reset)
function _resetParticle(i) {
    const srcI = Math.floor(Math.random() * sourcePoints.length);
    const src = sourcePoints[srcI];
    sourceIdx_arr[i] = srcI;
    px_arr[i] = src + (Math.random() - 0.5) * DELTA_SPAWN_WIDTH;
    py_arr[i] = -Math.random() * SOURCE_SPAWN_HEIGHT;
    vx_arr[i] = 0;
    vy_arr[i] = 0;
    speed_arr[i]   = Math.random() * PARTICLE_SPEED_VAR + PARTICLE_SPEED_BASE;
    weight_arr[i]  = Math.random() * PARTICLE_WEIGHT_VAR + PARTICLE_WEIGHT_BASE;
    gravity_arr[i] = Math.random() * PARTICLE_GRAVITY_VAR + PARTICLE_GRAVITY_BASE;
    life_arr[i]    = Math.random() * PARTICLE_LIFE_VAR + PARTICLE_LIFE_BASE;
    age_arr[i]     = 0;
    opacity_arr[i] = 0;
    stagnation_arr[i] = 0;
    sleepCounter_arr[i] = 0;
    // preserve isSource / isCapillary flags; clear inDelta and recycled
    flags_arr[i] &= (FLAG_IS_SOURCE | FLAG_IS_CAPILLARY);
    flags_arr[i] &= ~FLAG_IN_DELTA;
}

function init() {
    _allocArrays(NUM_PARTICLES);
    const SOURCE_COUNT = SOURCE_PARTICLE_COUNT;
    for (let i = 0; i < NUM_PARTICLES; i++) {
        flags_arr[i] = 0;
        if (i < SOURCE_COUNT) flags_arr[i] |= FLAG_IS_SOURCE;
        _resetParticle(i);
        // Spread initial particles vertically so they don't all bunch at the top
        py_arr[i] = -Math.random() * height * DELTA_ZONE_END;
    }
}

// Distance from point (ppx,ppy) to the push arc pill shape
function pushArcDist(ppx, ppy) {
    let angle = mouse.pushAngle;
    let dirX = Math.cos(angle);
    let dirY = Math.sin(angle);
    let acx = mouse.x - dirX * PUSH_ARC_RADIUS;
    let acy = mouse.y - dirY * PUSH_ARC_RADIUS;
    let dx = ppx - acx;
    let dy = ppy - acy;
    let ptAngle = Math.atan2(dy, dx);
    let midAngle = Math.atan2(dirY, dirX);
    let half = PUSH_ARC_SPAN * 0.5;
    let diff = ptAngle - midAngle;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    if (diff < -half) diff = -half;
    if (diff >  half) diff =  half;
    let clampedAngle = midAngle + diff;
    let nearX = acx + PUSH_ARC_RADIUS * Math.cos(clampedAngle);
    let nearY = acy + PUSH_ARC_RADIUS * Math.sin(clampedAngle);
    let ndx = ppx - nearX;
    let ndy = ppy - nearY;
    return Math.sqrt(ndx * ndx + ndy * ndy);
}

// Recycle a capillary particle (find nearest origin or revert to river particle)
function _recycleCapillary(i) {
    const isRecycled = (flags_arr[i] & FLAG_RECYCLED) !== 0;
    if (isRecycled) recycledCapillaryCount--;

    let bestDist2 = Infinity, bestOrigin = null;
    const mySrcIdx = sourceIdx_arr[i];
    const myOriginX = capOriginX_arr[i];
    const myOriginY = capOriginY_arr[i];
    for (let o of capillaryOrigins) {
        if (o.sourceIdx !== mySrcIdx) continue;
        let dx = o.x - myOriginX;
        let dy = o.y - myOriginY;
        let d2 = dx * dx + dy * dy;
        if (d2 < bestDist2) { bestDist2 = d2; bestOrigin = o; }
    }
    if (!bestOrigin || recycledCapillaryCount >= MAX_RECYCLED_CAPILLARIES) {
        flags_arr[i] &= ~(FLAG_IS_CAPILLARY | FLAG_RECYCLED);
        _resetParticle(i);
        return;
    }
    recycledCapillaryCount++;
    flags_arr[i] |= FLAG_RECYCLED;
    px_arr[i] = bestOrigin.x;
    py_arr[i] = bestOrigin.y;
    capOriginX_arr[i] = bestOrigin.x;
    capOriginY_arr[i] = bestOrigin.y;
    capAngle_arr[i] = bestOrigin.targetAngle;
    capDir_arr[i] = Math.cos(bestOrigin.targetAngle) >= 0 ? 1 : 0;
    age_arr[i] = 0;
    capWiggleSeed_arr[i] = Math.random() * Math.PI * 2;
    opacity_arr[i] = 0;

    let oc = Math.floor(bestOrigin.x / GRID_SIZE);
    let or_ = Math.floor(bestOrigin.y / GRID_SIZE);
    let dir = capDir_arr[i] === 1 ? 1 : -1;
    let bestPull = 0, bestDr = 0;
    if (oc >= 0 && oc < cols && or_ >= 0 && or_ < rows) {
        for (let s = 1; s <= CAP_SCAN_RADIUS; s++) {
            let sc = oc + dir * s;
            if (sc < 0 || sc >= cols) break;
            for (let dr = -CAP_VERTICAL_SCAN; dr <= CAP_VERTICAL_SCAN; dr++) {
                let sr = or_ + dr;
                if (sr < 0 || sr >= rows) continue;
                let w = capWetnessGrid[sc + sr * cols] + capErosionGrid[sc + sr * cols] * EROSION_WEIGHT;
                if (w > bestPull) { bestPull = w; bestDr = dr; }
            }
        }
    }
    if (bestPull > CAP_CHANNEL_THRESHOLD) {
        let outX = Math.cos(bestOrigin.targetAngle);
        let outY = Math.sin(bestOrigin.targetAngle);
        vx_arr[i] = outX * CAPILLARY_LATERAL_FORCE * CAP_LATERAL_SCALE;
        vy_arr[i] = outY * CAPILLARY_LATERAL_FORCE * CAP_LATERAL_SCALE + bestDr * CAP_ATTRACT_SCALE;
    } else {
        vx_arr[i] = 0;
        vy_arr[i] = 0;
    }
}

// Update a capillary particle (inline of former _updateCapillary method)
function _updateCapillary(i) {
    age_arr[i]++;
    const age = age_arr[i];

    let wiggle = Math.sin(age * capWiggleFreq_arr[i] + capWiggleSeed_arr[i]) * CAPILLARY_WIGGLE_STRENGTH;
    let spd2 = vx_arr[i] * vx_arr[i] + vy_arr[i] * vy_arr[i];
    if (spd2 > 0.01) {
        let inv = 1.0 / Math.sqrt(spd2);
        let perpX = -vy_arr[i] * inv;
        let perpY =  vx_arr[i] * inv;
        vx_arr[i] += perpX * wiggle;
        vy_arr[i] += perpY * wiggle;
    } else {
        vy_arr[i] += wiggle;
    }

    let dx0 = px_arr[i] - capOriginX_arr[i];
    let dy0 = py_arr[i] - capOriginY_arr[i];
    let dist = Math.sqrt(dx0 * dx0 + dy0 * dy0);
    let lateralFactor = Math.exp(-dist / CAP_LATERAL_DECAY_DIST);
    let outX = Math.cos(capAngle_arr[i]);
    let outY = Math.sin(capAngle_arr[i]);
    vx_arr[i] += outX * CAPILLARY_LATERAL_FORCE * CAP_LATERAL_SCALE * lateralFactor;
    vy_arr[i] += outY * CAPILLARY_LATERAL_FORCE * CAP_LATERAL_SCALE * lateralFactor;

    vy_arr[i] += CAPILLARY_GRAVITY;

    let c = Math.floor(px_arr[i] / GRID_SIZE);
    let r = Math.floor(py_arr[i] / GRID_SIZE);
    if (c >= 0 && c < cols && r >= 0 && r < rows) {
        let idx = c + r * cols;

        capWetnessGrid[idx] += CAP_WETNESS_DEPOSIT;
        if (capErosionGrid[idx] < CAP_EROSION_MAX) {
            capErosionGrid[idx] += CAP_EROSION_DEPOSIT;
        }

        let deposit = CAP_WETNESS_DEPOSIT + CAP_EROSION_DEPOSIT;
        let sid = streamId_arr[i];
        if (capOwnerStr[idx] < deposit || capOwnerGrid[idx] === sid) {
            capOwnerGrid[idx] = sid;
            capOwnerStr[idx] += deposit;
        } else if (capOwnerGrid[idx] !== sid) {
            capOwnerStr[idx] -= deposit * 0.5;
            if (capOwnerStr[idx] <= 0) {
                capOwnerGrid[idx] = sid;
                capOwnerStr[idx] = deposit;
            }
        }
        let cellCapErosion = capErosionGrid[idx];

        let pullY = 0;
        let dir = capDir_arr[i] === 1 ? 1 : -1;
        for (let s = 1; s <= CAP_SCAN_RADIUS; s++) {
            let sc = c + dir * s;
            if (sc < 0 || sc >= cols) break;
            for (let dr = -CAP_VERTICAL_SCAN; dr <= CAP_VERTICAL_SCAN; dr++) {
                let sr = r + dr;
                if (sr < 0 || sr >= rows) continue;
                let scanIdx = sc + sr * cols;
                let w = capWetnessGrid[scanIdx] + capErosionGrid[scanIdx] * EROSION_WEIGHT;
                if (w > CAP_CHANNEL_THRESHOLD) {
                    let owner = capOwnerGrid[scanIdx];
                    if (owner === 0 || owner === sid) {
                        pullY += dr * w * CAP_ATTRACT_SCALE / (s * s);
                    }
                }
            }
        }
        vy_arr[i] += pullY;

        let erosionSpread = cellCapErosion * CAP_EROSION_SPREAD;
        vx_arr[i] += (Math.random() - 0.5) * erosionSpread;
    }

    vx_arr[i] *= CAP_FRICTION;
    vy_arr[i] *= CAP_FRICTION;
    let spd = Math.sqrt(vx_arr[i] * vx_arr[i] + vy_arr[i] * vy_arr[i]);
    if (spd > CAP_MAX_SPEED) {
        vx_arr[i] = (vx_arr[i] / spd) * CAP_MAX_SPEED;
        vy_arr[i] = (vy_arr[i] / spd) * CAP_MAX_SPEED;
    }

    px_arr[i] += vx_arr[i];
    py_arr[i] += vy_arr[i];

    // Mouse arc pill displacement (only active when server receives mouse events)
    if (mouse.active && mouse.leftDown && (mouse.frameDX !== 0 || mouse.frameDY !== 0)) {
        let mdist = pushArcDist(px_arr[i], py_arr[i]);
        if (mdist < PUSH_PILL_RADIUS) {
            let falloff = 1.0 - mdist / PUSH_PILL_RADIUS;
            px_arr[i] += mouse.frameDX * falloff * MOUSE_PUSH_SCALE;
            py_arr[i] += mouse.frameDY * falloff * MOUSE_PUSH_SCALE;
        }
    }

    let fadeIn = Math.min(age / CAP_FADE_IN_FRAMES, 1.0);
    opacity_arr[i] = CAPILLARY_MAX_OPACITY * fadeIn;

    if (age > CAP_FADE_IN_FRAMES) {
        let rzYStart = Math.floor(height * TRANSITION_ZONE_END);
        let rr = Math.floor((py_arr[i] - rzYStart) / RIVER_CELL_SIZE);
        let rc = Math.floor(px_arr[i] / RIVER_CELL_SIZE);
        if (rr >= 0 && rr < riverGridRows && rc >= 0 && rc < riverGridCols) {
            let lbl = riverLabels[rr * riverGridCols + rc];
            if (lbl > 0) {
                _recycleCapillary(i);
                return;
            }
        }
    }

    if (px_arr[i] < -OOB_MARGIN || px_arr[i] > width + OOB_MARGIN ||
        py_arr[i] < -OOB_MARGIN || py_arr[i] > height + OOB_MARGIN) {
        _recycleCapillary(i);
    }
}

// Update a river/delta particle (inline of former update method)
function _updateRiver(i) {
    const [forceX0, forceY0] = noiseGrid.sample(px_arr[i], py_arr[i]);
    let forceX = forceX0;
    let forceY = forceY0;

    let gradLen = Math.sqrt(forceX * forceX + forceY * forceY) || 1;
    forceX /= gradLen;
    forceY /= gradLen;

    let c = Math.floor(px_arr[i] / GRID_SIZE);
    let r = Math.floor(py_arr[i] / GRID_SIZE);
    let cellWetness = 0;

    if (c >= 0 && c < cols && r >= 0 && r < rows) {
        let idx = c + r * cols;
        wetnessGrid[idx] += WETNESS_DEPOSIT;
        sourceOwnerGrid[idx] = sourceIdx_arr[i];
        cellWetness = wetnessGrid[idx];

        if (erosionGrid[idx] < EROSION_MAX) {
            erosionGrid[idx] += EROSION_DEPOSIT;
        }
        let cellErosion = erosionGrid[idx];

        // Stage 3b: mark cell and 8 neighbors dirty for diffusion/decay pass
        for (let dr = -1; dr <= 1; dr++) {
            const nr = r + dr;
            if (nr < 0 || nr >= rows) continue;
            for (let dc = -1; dc <= 1; dc++) {
                const nc = c + dc;
                if (nc < 0 || nc >= cols) continue;
                dirtyFlags[nc + nr * cols] = 1;
            }
        }

        let convergeFactor = Math.min(py_arr[i] / (height * CONVERGENCE_RAMP_RATIO), 1.0);
        if (convergeFactor < 0) convergeFactor = 0;

        if (convergeFactor > 0) {
            let attractLeft = 0, attractRight = 0;
            let repulseLeft = 0, repulseRight = 0;
            let inPostTransition = py_arr[i] >= height * CONVERGENCE_RAMP_RATIO;

            for (let s = 1; s <= STREAM_SCAN_RADIUS; s++) {
                if (c - s < 0) break;
                let w = wetnessGrid[idx - s] + erosionGrid[idx - s] * EROSION_WEIGHT;
                let distFalloff = 1.0 / (s * s);
                if (inPostTransition && sourceOwnerGrid[idx - s] >= 0
                    && sourceOwnerGrid[idx - s] !== sourceIdx_arr[i]) {
                    repulseLeft += w * distFalloff;
                } else {
                    attractLeft += w * distFalloff;
                }
            }

            for (let s = 1; s <= STREAM_SCAN_RADIUS; s++) {
                if (c + s >= cols) break;
                let w = wetnessGrid[idx + s] + erosionGrid[idx + s] * EROSION_WEIGHT;
                let distFalloff = 1.0 / (s * s);
                if (inPostTransition && sourceOwnerGrid[idx + s] >= 0
                    && sourceOwnerGrid[idx + s] !== sourceIdx_arr[i]) {
                    repulseRight += w * distFalloff;
                } else {
                    attractRight += w * distFalloff;
                }
            }

            let pullX = (attractRight - attractLeft);
            let repulseX = mixSources ? 0 : (repulseLeft - repulseRight) * RIVER_REPULSE_STRENGTH;
            let netX = pullX + repulseX;

            let pullAbs = Math.abs(netX);
            if (pullAbs > PULL_MIN_THRESHOLD) {
                let sign = netX > 0 ? 1 : -1;
                let attractStrength = Math.min(pullAbs * PULL_FORCE_SCALE, PULL_FORCE_MAX) * convergeFactor;
                let stagnationBoost = 1.0 + stagnation_arr[i] * STAGNATION_BOOST_RATE;
                attractStrength *= stagnationBoost;
                forceX += sign * attractStrength;
            }
        }

        let erosionSpread = erosionGrid[idx] * EROSION_SPREAD_STRENGTH;
        forceX += (Math.random() - 0.5) * erosionSpread;

        if (cellWetness > WETNESS_SPREAD_THRESHOLD) {
            forceX += (Math.random() - 0.5) * Math.min(cellWetness * WETNESS_SPREAD_SCALE, WETNESS_SPREAD_MAX);
        }
    }

    forceY += gravity_arr[i] + stagnation_arr[i] * 0.02;

    if (py_arr[i] < height * CONVERGENCE_RAMP_RATIO) {
        let topFactor = 1.0 - (py_arr[i] / (height * CONVERGENCE_RAMP_RATIO));
        forceY += topFactor * TOP_PUSH_FORCE;
    }

    let edgeMargin = width * EDGE_MARGIN_RATIO;
    if (px_arr[i] < edgeMargin) {
        let edgeFactor = 1.0 - (px_arr[i] / edgeMargin);
        forceX += edgeFactor * TOP_PUSH_FORCE;
    } else if (px_arr[i] > width - edgeMargin) {
        let edgeFactor = 1.0 - ((width - px_arr[i]) / edgeMargin);
        forceX += -edgeFactor * TOP_PUSH_FORCE;
    }

    let length = Math.sqrt(forceX * forceX + forceY * forceY) || 1;
    forceX /= length;
    forceY /= length;

    vx_arr[i] += forceX * FORCE_TO_VELOCITY * speed_arr[i];
    vy_arr[i] += forceY * FORCE_TO_VELOCITY * speed_arr[i];

    vx_arr[i] *= FRICTION;
    vy_arr[i] *= FRICTION;

    if (vy_arr[i] < 0) vy_arr[i] *= UPWARD_VELOCITY_DAMP;

    let spd = Math.sqrt(vx_arr[i] * vx_arr[i] + vy_arr[i] * vy_arr[i]);
    if (spd < STAGNATION_THRESHOLD) {
        stagnation_arr[i] = Math.min(stagnation_arr[i] + 1, STAGNATION_MAX);
    } else {
        stagnation_arr[i] *= STAGNATION_DECAY;
    }

    px_arr[i] += vx_arr[i];
    py_arr[i] += vy_arr[i];

    // Mouse arc pill displacement (only active when server receives mouse events)
    if (mouse.active && mouse.leftDown && (mouse.frameDX !== 0 || mouse.frameDY !== 0)) {
        let mdist = pushArcDist(px_arr[i], py_arr[i]);
        if (mdist < PUSH_PILL_RADIUS) {
            let falloff = 1.0 - mdist / PUSH_PILL_RADIUS;
            px_arr[i] += mouse.frameDX * falloff * MOUSE_PUSH_SCALE;
            py_arr[i] += mouse.frameDY * falloff * MOUSE_PUSH_SCALE;
            vx_arr[i] += mouse.frameDX * falloff * MOUSE_PUSH_VELOCITY;
            vy_arr[i] += mouse.frameDY * falloff * MOUSE_PUSH_VELOCITY;
        }
    }

    const isSource = (flags_arr[i] & FLAG_IS_SOURCE) !== 0;
    if (isSource && py_arr[i] > height * DELTA_ZONE_END) {
        _resetParticle(i);
        return;
    }

    let inDelta = py_arr[i] > 0 && py_arr[i] < height * DELTA_ZONE_END;
    let inTransition = !inDelta && py_arr[i] >= height * DELTA_ZONE_END && py_arr[i] < height * TRANSITION_ZONE_END;
    let transitionT = inTransition ? (py_arr[i] - height * DELTA_ZONE_END) / (height * (TRANSITION_ZONE_END - DELTA_ZONE_END)) : 1.0;
    let inStream = cellWetness >= WETNESS_DRY_THRESHOLD;

    if (!inStream && !inDelta && !inTransition && !isSource) {
        age_arr[i] += STRAY_AGE_ACCEL;
        let ageFade = 1.0 - Math.min(age_arr[i] / (life_arr[i] * STRAY_FADE_RATIO), 1.0);
        opacity_arr[i] = MAX_DRAW_OPACITY * STRAY_OPACITY_FACTOR * ageFade;
    } else {
        let ageRate = BASE_AGE_RATE;
        if (inTransition && !inStream) {
            ageRate = TRANSITION_AGE_BASE + transitionT * TRANSITION_AGE_RAMP;
        }
        age_arr[i] += ageRate;

        let baseOpacity = Math.min(MAX_DRAW_OPACITY, cellWetness / 100);
        if (inDelta) {
            let deltaAge = Math.min(age_arr[i] / (life_arr[i] * DELTA_FADE_RATIO), 1.0);
            let deltaFade = 1.0 - deltaAge * DELTA_FADE_STRENGTH;
            baseOpacity = Math.max(baseOpacity, MAX_DRAW_OPACITY * deltaFade);
        } else if (inTransition && !inStream) {
            let deltaAge = Math.min(age_arr[i] / (life_arr[i] * DELTA_FADE_RATIO), 1.0);
            let deltaFade = 1.0 - deltaAge * DELTA_FADE_STRENGTH;
            let deltaOpacity = MAX_DRAW_OPACITY * deltaFade;
            baseOpacity = Math.max(baseOpacity, deltaOpacity * (1.0 - transitionT));
        }
        opacity_arr[i] = baseOpacity;
    }

    // Update inDelta flag bit
    if (inDelta || inTransition) {
        flags_arr[i] |= FLAG_IN_DELTA;
    } else {
        flags_arr[i] &= ~FLAG_IN_DELTA;
    }

    if (px_arr[i] < -OOB_MARGIN || px_arr[i] > width + OOB_MARGIN || py_arr[i] > height + OOB_MARGIN || age_arr[i] > life_arr[i]) {
        _resetParticle(i);
    }
}

let riverGridFrame = 0;
function updateRiverGrid() {
    riverGridFrame++;
    if (riverGridFrame % RIVER_GRID_THROTTLE !== 0) return;

    let rzYStart = Math.floor(height * TRANSITION_ZONE_END);
    let zoneH = height - rzYStart;
    if (zoneH <= 0 || riverGridCols === 0 || riverGridRows === 0) return;

    let cellCounts = new Uint16Array(riverGridCols * riverGridRows);
    for (let i = 0; i < NUM_PARTICLES; i++) {
        if ((flags_arr[i] & FLAG_IS_CAPILLARY) !== 0 || py_arr[i] < rzYStart) continue;
        let rr = Math.floor((py_arr[i] - rzYStart) / RIVER_CELL_SIZE);
        let rc = Math.floor(px_arr[i] / RIVER_CELL_SIZE);
        if (rr >= 0 && rr < riverGridRows && rc >= 0 && rc < riverGridCols) {
            cellCounts[rr * riverGridCols + rc]++;
        }
    }

    let now = _perf.now();
    riverGrid.fill(0);
    for (let r = 0; r < riverGridRows; r++) {
        let pyStart = rzYStart + r * RIVER_CELL_SIZE;
        let pyEnd = Math.min(pyStart + RIVER_CELL_SIZE, height);
        let wRowStart = Math.floor(pyStart / GRID_SIZE);
        let wRowEnd = Math.min(Math.ceil(pyEnd / GRID_SIZE), rows);
        for (let c = 0; c < riverGridCols; c++) {
            let idx = r * riverGridCols + c;
            let pxStart = c * RIVER_CELL_SIZE;
            let pxEnd = Math.min(pxStart + RIVER_CELL_SIZE, width);
            let wColStart = Math.floor(pxStart / GRID_SIZE);
            let wColEnd = Math.min(Math.ceil(pxEnd / GRID_SIZE), cols);
            let maxW = 0;
            for (let wr = wRowStart; wr < wRowEnd; wr++) {
                for (let wc = wColStart; wc < wColEnd; wc++) {
                    let w = wetnessGrid[wr * cols + wc];
                    if (w > maxW) maxW = w;
                }
            }
            if (maxW >= RIVER_WETNESS_THRESHOLD && cellCounts[idx] >= RIVER_PARTICLE_THRESHOLD) {
                riverCellLastSeen[idx] = now;
                riverGrid[idx] = 1;
            } else if (riverCellLastSeen[idx] > 0 && now - riverCellLastSeen[idx] < RIVER_CELL_TIMEOUT) {
                riverGrid[idx] = 1;
            }
        }
    }

    riverLabels.fill(0);
    let label = 0;
    let labelMinRow = [0];
    let labelSize = [0];

    for (let r = 0; r < riverGridRows; r++) {
        let runs = [];
        let inRun = false, runStart = 0;
        for (let c = 0; c <= riverGridCols; c++) {
            let active = c < riverGridCols && riverGrid[r * riverGridCols + c] === 1;
            if (active && !inRun) { inRun = true; runStart = c; }
            if (!active && inRun) { runs.push([runStart, c - 1]); inRun = false; }
        }

        for (let [startC, endC] of runs) {
            let aboveLabels = new Set();
            if (r > 0) {
                let cMin = Math.max(0, startC - 1);
                let cMax = Math.min(riverGridCols - 1, endC + 1);
                for (let c = cMin; c <= cMax; c++) {
                    let lbl = riverLabels[(r - 1) * riverGridCols + c];
                    if (lbl > 0) aboveLabels.add(lbl);
                }
            }

            let assignLabel;
            if (aboveLabels.size === 0) {
                assignLabel = ++label;
                labelMinRow.push(r);
                labelSize.push(0);
            } else if (aboveLabels.size === 1) {
                assignLabel = aboveLabels.values().next().value;
            } else {
                assignLabel = Math.min(...aboveLabels);
            }

            let runLen = endC - startC + 1;
            labelSize[assignLabel] += runLen;
            for (let c = startC; c <= endC; c++) {
                riverLabels[r * riverGridCols + c] = assignLabel;
            }
        }
    }
    numRiverComponents = label;

    let comps = new Array(label);
    for (let i = 0; i < label; i++) comps[i] = { minRow: riverGridRows, sumC: 0, count: 0, cols: new Set() };
    for (let r = 0; r < riverGridRows; r++) {
        for (let c = 0; c < riverGridCols; c++) {
            let lbl = riverLabels[r * riverGridCols + c];
            if (lbl > 0) {
                let ci = comps[lbl - 1];
                if (r < ci.minRow) ci.minRow = r;
                ci.sumC += c;
                ci.count++;
                ci.cols.add(c);
            }
        }
    }

    for (let i = 0; i < label; i++) {
        if (comps[i].count < MIN_RIVER_CELLS) {
            let lbl = i + 1;
            for (let r = 0; r < riverGridRows; r++) {
                for (let c = 0; c < riverGridCols; c++) {
                    if (riverLabels[r * riverGridCols + c] === lbl) {
                        riverLabels[r * riverGridCols + c] = 0;
                    }
                }
            }
            comps[i].count = 0;
            comps[i].cols.clear();
        }
    }

    let compSourceCounts = new Array(label);
    for (let i = 0; i < label; i++) compSourceCounts[i] = {};

    for (let i = 0; i < NUM_PARTICLES; i++) {
        let pr = Math.floor((py_arr[i] - rzYStart) / RIVER_CELL_SIZE);
        let pc = Math.floor(px_arr[i] / RIVER_CELL_SIZE);
        if (pr < 0 || pr >= riverGridRows || pc < 0 || pc >= riverGridCols) continue;
        let lbl = riverLabels[pr * riverGridCols + pc];
        if (lbl > 0) {
            let counts = compSourceCounts[lbl - 1];
            let sidx = sourceIdx_arr[i];
            counts[sidx] = (counts[sidx] || 0) + 1;
        }
    }

    riverComponentColors = new Array(label).fill(-1);
    for (let i = 0; i < label; i++) {
        let counts = compSourceCounts[i];
        let bestSrc = -1, bestCnt = 0;
        for (let s in counts) {
            if (counts[s] > bestCnt) { bestCnt = counts[s]; bestSrc = +s; }
        }
        if (bestSrc >= 0) riverComponentColors[i] = bestSrc;
    }
    for (let i = 0; i < label; i++) {
        if (riverComponentColors[i] === -1) riverComponentColors[i] = 0;
    }

    capillaryOrigins = [];

    let sourceToComp = new Array(sourcePoints.length).fill(-1);
    let sourceToCompSize = new Array(sourcePoints.length).fill(0);
    for (let i = 0; i < label; i++) {
        let majorSrc = riverComponentColors[i];
        if (majorSrc >= 0 && comps[i].count > sourceToCompSize[majorSrc]) {
            sourceToComp[majorSrc] = i;
            sourceToCompSize[majorSrc] = comps[i].count;
        }
    }

    let rzYStart_px = Math.floor(height * TRANSITION_ZONE_END);
    sourceCentroids = new Array(sourcePoints.length).fill(null);
    for (let s = 0; s < sourcePoints.length; s++) {
        let ci = sourceToComp[s];
        if (ci === -1) continue;
        let compLabel = ci + 1;
        let rowCentroids = {};
        for (let r = 0; r < riverGridRows; r++) {
            let sumC = 0, cnt = 0;
            for (let c = 0; c < riverGridCols; c++) {
                if (riverLabels[r * riverGridCols + c] === compLabel) {
                    sumC += c;
                    cnt++;
                }
            }
            if (cnt > 0) rowCentroids[r] = (sumC / cnt + 0.5) * RIVER_CELL_SIZE;
        }
        sourceCentroids[s] = rowCentroids;
    }

    let allOrigins = [];
    for (let h of capillaryHeights) {
        let centroids = sourceCentroids[h.sourceIdx];
        if (!centroids) continue;
        let r = Math.floor((h.y - rzYStart_px) / RIVER_CELL_SIZE);
        if (r >= 0 && r < riverGridRows && centroids[r] !== undefined) {
            allOrigins.push({ x: centroids[r], y: h.y, sourceIdx: h.sourceIdx });
        }
    }

    let evenOrigins = {};
    for (let o of allOrigins) {
        if (o.sourceIdx % 2 === 0) {
            if (!evenOrigins[o.sourceIdx]) evenOrigins[o.sourceIdx] = [];
            evenOrigins[o.sourceIdx].push(o);
        }
    }

    for (let o of allOrigins) {
        if (o.sourceIdx % 2 !== 1) continue;
        let s = o.sourceIdx;

        let neighbors = [];
        if (s > 0 && sourceToComp[s - 1] !== -1) neighbors.push(s - 1);
        if (s < sourcePoints.length - 1 && sourceToComp[s + 1] !== -1) neighbors.push(s + 1);

        for (let ni of neighbors) {
            let targets = evenOrigins[ni];
            if (!targets || targets.length === 0) continue;

            let bestDY = Infinity, bestTarget = null;
            for (let t of targets) {
                let dy = Math.abs(t.y - o.y);
                if (dy < bestDY) { bestDY = dy; bestTarget = t; }
            }
            if (!bestTarget) continue;

            let targetY = o.y + (Math.random() - 0.5) * 30;
            let targetAngle = Math.atan2(targetY - o.y, bestTarget.x - o.x);
            capillaryOrigins.push({
                x: o.x, y: o.y, sourceIdx: s,
                neighborIdx: ni, targetAngle: targetAngle
            });
        }
    }

    let currentKeys = new Set();
    for (let o of capillaryOrigins) {
        currentKeys.add(o.sourceIdx * 1000000 + o.neighborIdx * 100000 + Math.round(o.y));
    }
    for (let key of prevCapillaryOriginKeys) {
        if (!currentKeys.has(key)) {
            let originY = key % 100000;
            let rCenter = Math.floor(originY / GRID_SIZE);
            let rMin = Math.max(0, rCenter - CAP_ORIGIN_FADE_BAND);
            let rMax = Math.min(rows - 1, rCenter + CAP_ORIGIN_FADE_BAND);
            for (let gr = rMin; gr <= rMax; gr++) {
                let rowOff = gr * cols;
                for (let gc = 0; gc < cols; gc++) {
                    capFadeMask[rowOff + gc] = 1;
                }
            }
        }
    }
    prevCapillaryOriginKeys = currentKeys;
}

// One simulation step (called from server setInterval)
function tick() {
    simSpeedAccum += simSpeed;
    let ticksThisFrame = Math.floor(simSpeedAccum);
    simSpeedAccum -= ticksThisFrame;

    for (let t = 0; t < ticksThisFrame; t++) {
        // Evaporate wetness and erosion grids.
        // Split into two tight loops so V8 can vectorise the float multiply pass
        // without being blocked by the mixed conditional capillary logic.

        // Loop 1: main grids — Stage 3b: only process dirty cells
        // dirtyFlags is set by _updateRiver() when a particle deposits into a cell.
        // Cells that haven't been written this tick are unchanged, so skip them.
        const gridLen = wetnessGrid.length;
        for (let k = 0; k < gridLen; k++) {
            if (dirtyFlags[k] === 0) continue;
            if ((wetnessGrid[k] *= EVAPORATION_RATE) < 0.1) sourceOwnerGrid[k] = -1;
            erosionGrid[k] *= EROSION_DECAY;
        }
        dirtyFlags.fill(0); // reset for next tick

        // Loop 2: capillary grids (conditional, but most cells are zero)
        for (let k = 0; k < gridLen; k++) {
            if (capFadeMask[k]) {
                capWetnessGrid[k] *= CAP_ACCEL_WETNESS_DECAY;
                capErosionGrid[k] *= CAP_ACCEL_EROSION_DECAY;
                capOwnerStr[k] *= CAP_ACCEL_WETNESS_DECAY;
                if (capWetnessGrid[k] < CAP_CLEANUP_THRESHOLD && capErosionGrid[k] < CAP_CLEANUP_THRESHOLD) {
                    capFadeMask[k] = 0;
                    capOwnerGrid[k] = 0;
                    capOwnerStr[k] = 0;
                }
            } else {
                capWetnessGrid[k] *= CAP_EVAPORATION_RATE;
                capErosionGrid[k] *= CAP_EROSION_DECAY;
                capOwnerStr[k] *= CAP_EVAPORATION_RATE;
            }
            if (capOwnerStr[k] < CAP_CLEANUP_THRESHOLD) { capOwnerGrid[k] = 0; capOwnerStr[k] = 0; }
        }

        // Count particles by zone
        let deltaEnd = height * DELTA_ZONE_END;
        deltaParticleCount = 0;
        riverZoneParticleCount = 0;
        for (let i = 0; i < NUM_PARTICLES; i++) {
            if (py_arr[i] >= 0 && py_arr[i] < deltaEnd) deltaParticleCount++;
            if ((flags_arr[i] & FLAG_IS_SOURCE) === 0 && py_arr[i] >= height * TRANSITION_ZONE_END) riverZoneParticleCount++;
        }

        updateRiverGrid();

        frameDiversions = 0;

        // Delta-zone capillary diversion
        if (capillaryDiversion && capillaryOrigins.length > 0 &&
            riverZoneParticleCount > CAPILLARY_DIVERSION_THRESHOLD) {
            for (let d = 0; d < CAPILLARY_DIVERSIONS_PER_FRAME; d++) {
                let idx = Math.floor(Math.random() * NUM_PARTICLES);
                let f = flags_arr[idx];
                if ((f & FLAG_IS_SOURCE) !== 0 || (f & FLAG_IS_CAPILLARY) !== 0 ||
                    py_arr[idx] < 0 || py_arr[idx] >= deltaEnd) continue;

                let o = capillaryOrigins[Math.floor(Math.random() * capillaryOrigins.length)];
                flags_arr[idx] |= FLAG_IS_CAPILLARY;
                flags_arr[idx] &= ~FLAG_RECYCLED;
                px_arr[idx] = o.x;
                py_arr[idx] = o.y;
                capDir_arr[idx] = Math.cos(o.targetAngle) >= 0 ? 1 : 0;
                let dir = capDir_arr[idx] === 1 ? 1 : -1;
                streamId_arr[idx] = (o.sourceIdx * 2 + (dir > 0 ? 1 : 0) + 1) & 0xFF;
                capOriginX_arr[idx] = o.x;
                capOriginY_arr[idx] = o.y;
                capAngle_arr[idx] = o.targetAngle;
                sourceIdx_arr[idx] = o.sourceIdx;
                age_arr[idx] = 0;
                capWiggleSeed_arr[idx] = Math.random() * Math.PI * 2;
                capWiggleFreq_arr[idx] = CAP_WIGGLE_FREQ_BASE + Math.random() * CAP_WIGGLE_FREQ_VAR;
                opacity_arr[idx] = CAPILLARY_MAX_OPACITY;

                let oc = Math.floor(o.x / GRID_SIZE);
                let or_ = Math.floor(o.y / GRID_SIZE);
                let bestPull = 0, bestDr = 0;
                if (oc >= 0 && oc < cols && or_ >= 0 && or_ < rows) {
                    for (let s = 1; s <= CAP_SCAN_RADIUS; s++) {
                        let sc = oc + dir * s;
                        if (sc < 0 || sc >= cols) break;
                        for (let dr = -CAP_VERTICAL_SCAN; dr <= CAP_VERTICAL_SCAN; dr++) {
                            let sr = or_ + dr;
                            if (sr < 0 || sr >= rows) continue;
                            let w = capWetnessGrid[sc + sr * cols] + capErosionGrid[sc + sr * cols] * EROSION_WEIGHT;
                            if (w > bestPull) { bestPull = w; bestDr = dr; }
                        }
                    }
                }
                if (bestPull > CAP_CHANNEL_THRESHOLD) {
                    let outX = Math.cos(o.targetAngle);
                    let outY = Math.sin(o.targetAngle);
                    vx_arr[idx] = outX * CAPILLARY_LATERAL_FORCE * CAP_LATERAL_SCALE;
                    vy_arr[idx] = outY * CAPILLARY_LATERAL_FORCE * CAP_LATERAL_SCALE + bestDr * CAP_ATTRACT_SCALE;
                } else {
                    vx_arr[idx] = 0;
                    vy_arr[idx] = 0;
                }
            }
        }

        // Rebuild curl-noise grid once per tick; particle updates bilinearly
        // interpolate from it instead of calling fbm() 3× per particle.
        noiseGrid.build(fbm, NOISE_SCALE, NOISE_EPSILON, zOff);

        for (let i = 0; i < NUM_PARTICLES; i++) {
            // Stage 4: sleep/wake system
            if (sleepCounter_arr[i] >= SLEEP_FRAMES) {
                // Particle is sleeping — check if noise field at its position has woken up
                const [nx, ny] = noiseGrid.sample(px_arr[i], py_arr[i]);
                const nmag = Math.sqrt(nx * nx + ny * ny);
                if (nmag > WAKE_THRESHOLD_VEL) {
                    sleepCounter_arr[i] = 0; // wake
                } else {
                    continue; // stay asleep, skip physics
                }
            }

            if ((flags_arr[i] & FLAG_IS_CAPILLARY) !== 0) {
                _updateCapillary(i);
            } else {
                _updateRiver(i);
            }

            // Update sleep counter based on post-update speed
            const spd = Math.sqrt(vx_arr[i] * vx_arr[i] + vy_arr[i] * vy_arr[i]);
            if (spd < SLEEP_THRESHOLD_VEL) {
                // Cap at 255 (Uint8 max); SLEEP_FRAMES is 5, so well within range
                if (sleepCounter_arr[i] < 255) sleepCounter_arr[i]++;
            } else {
                sleepCounter_arr[i] = 0;
            }
        }

        // Stage 4: log sleeping vs awake stats every 300 frames
        if (frameNum % 300 === 0) {
            let sleeping = 0;
            for (let i = 0; i < NUM_PARTICLES; i++) {
                if (sleepCounter_arr[i] >= SLEEP_FRAMES) sleeping++;
            }
            console.log(`[sleep] frame=${frameNum} sleeping=${sleeping} awake=${NUM_PARTICLES - sleeping} (${(sleeping / NUM_PARTICLES * 100).toFixed(1)}% asleep)`);
        }
    }

    // Reset per-frame mouse displacement accumulators
    mouse.frameDX = 0;
    mouse.frameDY = 0;

    // Slowly evolve the noise for shifting rivers
    zOff += NOISE_EVOLUTION_SPEED;
    frameNum++;
}

// All server→client binary messages begin with a type byte:
//   0x03 = delta particle frame (columnar zigzag varint)
//   0x01 = wetness grid
//   0x02 = erosion grid

// --- Delta frame state ---
const _prevX = new Int32Array(NUM_PARTICLES);
const _prevY = new Int32Array(NUM_PARTICLES);

// Pre-allocated column buffers (worst-case 5 bytes per varint for X/Y columns)
const _colX      = new Uint8Array(NUM_PARTICLES * 5);
const _colY      = new Uint8Array(NUM_PARTICLES * 5);
// 4 uint8 scalars per particle: opacity, radius, sourceIdx, flags
const _colScalar = new Uint8Array(NUM_PARTICLES * 4);
// Output frame buffer: 9-byte header + worst-case full columns
const _frameBuf  = new Uint8Array(9 + NUM_PARTICLES * (5 + 5 + 4));

function zigzagEncode(n) {
    return (n << 1) ^ (n >> 31);
}

function writeVarint(value, buf, offset) {
    while (value > 0x7F) {
        buf[offset++] = (value & 0x7F) | 0x80;
        value >>>= 7;
    }
    buf[offset++] = value & 0x7F;
    return offset;
}

// Pack all visible particle render data into a compact binary Buffer.
// Byte 0: type 0x03 (delta frame)
// Bytes 1-4: frameNum (uint32LE), bytes 5-8: activeCount (uint32LE)
// Then columnar sections: X deltas (zigzag varint), Y deltas (zigzag varint),
//   opacity (uint8), radius (uint8), sourceIdx (uint8), flags (uint8)
// Uses SoA arrays; reuses module-level activeMask bitmask to skip invisible particles.
function getFrameData() {
    const nWords = Math.ceil(NUM_PARTICLES / 32);

    // Pass 1: build activeMask
    let activeCount = 0;
    for (let w = 0; w < nWords; w++) {
        let word = 0;
        const base = w << 5;
        const end = Math.min(base + 32, NUM_PARTICLES);
        for (let i = base; i < end; i++) {
            if (opacity_arr[i] > MIN_DRAW_OPACITY) {
                word |= (1 << (i - base));
                activeCount++;
            }
        }
        activeMask[w] = word;
    }

    let xOff = 0, yOff = 0, sOff = 0;

    // Pass 2: iterate active particles via bitmask, build columns
    for (let w = 0; w < nWords; w++) {
        let bits = activeMask[w];
        if (bits === 0) continue;
        const base = w << 5;
        while (bits !== 0) {
            const lsb = bits & (-bits);
            const bitPos = 31 - Math.clz32(lsb);
            bits &= bits - 1;

            const i = base + bitPos;

            const ix = Math.max(0, Math.min(65535, Math.round(px_arr[i] / width  * 65535)));
            const iy = Math.max(0, Math.min(65535, Math.round(py_arr[i] / height * 65535)));
            const dx = ix - _prevX[i];
            const dy = iy - _prevY[i];
            _prevX[i] = ix;
            _prevY[i] = iy;

            xOff = writeVarint(zigzagEncode(dx), _colX, xOff);
            yOff = writeVarint(zigzagEncode(dy), _colY, yOff);

            _colScalar[sOff++] = Math.max(0, Math.min(255, Math.round(opacity_arr[i] * 255)));

            let radius;
            const isCapillary = (flags_arr[i] & FLAG_IS_CAPILLARY) !== 0;
            if (isCapillary) {
                const c = Math.floor(px_arr[i] / GRID_SIZE);
                const r = Math.floor(py_arr[i] / GRID_SIZE);
                const capW = (c >= 0 && c < cols && r >= 0 && r < rows) ? capWetnessGrid[c + r * cols] : 0;
                const thickness = Math.min(capW / CAP_THICKNESS_DIVISOR, 1.0);
                radius = CAP_MIN_RADIUS + thickness * (CAPILLARY_MAX_RADIUS - CAP_MIN_RADIUS);
            } else {
                radius = weight_arr[i] * PARTICLE_RADIUS_SCALE * Math.sin((age_arr[i] / life_arr[i]) * Math.PI);
                if ((flags_arr[i] & FLAG_IN_DELTA) !== 0) radius = Math.max(radius, DELTA_MIN_RADIUS);
            }
            _colScalar[sOff++] = Math.max(0, Math.min(255, Math.round(radius * 10)));

            _colScalar[sOff++] = sourceIdx_arr[i] & 0xFF;
            _colScalar[sOff++] = isCapillary ? 1 : 0;
        }
    }

    // Write 9-byte header
    _frameBuf[0] = 0x03;
    _frameBuf[1] =  frameNum        & 0xFF;
    _frameBuf[2] = (frameNum >>> 8)  & 0xFF;
    _frameBuf[3] = (frameNum >>> 16) & 0xFF;
    _frameBuf[4] = (frameNum >>> 24) & 0xFF;
    _frameBuf[5] =  activeCount        & 0xFF;
    _frameBuf[6] = (activeCount >>> 8)  & 0xFF;
    _frameBuf[7] = (activeCount >>> 16) & 0xFF;
    _frameBuf[8] = (activeCount >>> 24) & 0xFF;

    // Copy columns sequentially after header
    let out = 9;
    _frameBuf.set(_colX.subarray(0, xOff), out);      out += xOff;
    _frameBuf.set(_colY.subarray(0, yOff), out);      out += yOff;
    _frameBuf.set(_colScalar.subarray(0, sOff), out); out += sOff;

    return Buffer.from(_frameBuf.buffer, _frameBuf.byteOffset, out);
}

// Pack a wetness or erosion grid into a compact binary Buffer.
// Byte 0: type (0x01=wetness, 0x02=erosion)
// Bytes 1-2: cols (uint16LE), bytes 3-4: rows (uint16LE)
// Bytes 5-8: maxVal (float32LE, for display label)
// Bytes 9+: uint8 per cell (value / maxVal * 255)
function getWetnessData() {
    let maxW = 0;
    for (let i = 0; i < wetnessGrid.length; i++) if (wetnessGrid[i] > maxW) maxW = wetnessGrid[i];
    if (maxW < 1) maxW = 1;
    const buf = Buffer.allocUnsafe(9 + cols * rows);
    buf.writeUInt8(0x01, 0);
    buf.writeUInt16LE(cols, 1);
    buf.writeUInt16LE(rows, 3);
    buf.writeFloatLE(maxW, 5);
    for (let i = 0; i < cols * rows; i++) {
        buf.writeUInt8(Math.min(255, Math.round(wetnessGrid[i] / maxW * 255)), 9 + i);
    }
    return buf;
}

function getErosionData() {
    let maxE = 0;
    for (let i = 0; i < erosionGrid.length; i++) if (erosionGrid[i] > maxE) maxE = erosionGrid[i];
    if (maxE < 0.01) maxE = 0.01;
    const buf = Buffer.allocUnsafe(9 + cols * rows);
    buf.writeUInt8(0x02, 0);
    buf.writeUInt16LE(cols, 1);
    buf.writeUInt16LE(rows, 3);
    buf.writeFloatLE(maxE, 5);
    for (let i = 0; i < cols * rows; i++) {
        buf.writeUInt8(Math.min(255, Math.round(erosionGrid[i] / maxE * 255)), 9 + i);
    }
    return buf;
}

// Apply a key command (from client keyboard forwarding)
function handleKey(key) {
    if (key === 'b' || key === 'B') capillaryDiversion = !capillaryDiversion;
    if (key === 'm' || key === 'M') mixSources = !mixSources;
    if (key === 'ArrowUp') {
        simSpeedIndex = Math.min(simSpeedIndex + 1, SIM_SPEED_STEPS.length - 1);
        simSpeed = SIM_SPEED_STEPS[simSpeedIndex];
    }
    if (key === 'ArrowDown') {
        simSpeedIndex = Math.max(simSpeedIndex - 1, 0);
        simSpeed = SIM_SPEED_STEPS[simSpeedIndex];
    }
}

// Apply a mouse event from client (optional — for physics interaction)
function handleMouse(data) {
    // data: { x, y, dx, dy, leftDown }
    // x/y are normalized 0–1 from client, scale to sim dimensions
    mouse.x = data.x * width;
    mouse.y = data.y * height;
    mouse.frameDX = data.dx * width;
    mouse.frameDY = data.dy * height;
    mouse.leftDown = data.leftDown;
    mouse.active = true;
    // Update push angle from mouse motion
    if (mouse.frameDX !== 0 || mouse.frameDY !== 0) {
        let target = Math.atan2(mouse.frameDY, mouse.frameDX);
        let diff = target - mouse.pushAngle;
        diff = Math.atan2(Math.sin(diff), Math.cos(diff));
        let lerp = Math.abs(diff) > Math.PI * 0.5 ? PUSH_ANGLE_LERP_FAST : PUSH_ANGLE_LERP_SLOW;
        mouse.pushAngle += diff * lerp;
    }
}

// Reset simulation state — clears all grids and reinitializes particles
function reset() {
    zOff = 0;
    frameNum = 0;
    simSpeedAccum = 0;
    _prevX.fill(0);
    _prevY.fill(0);
    recycledCapillaryCount = 0;
    wetnessGrid.fill(0);
    erosionGrid.fill(0);
    dirtyFlags.fill(0);
    capWetnessGrid.fill(0);
    capErosionGrid.fill(0);
    capOwnerGrid.fill(0);
    capOwnerStr.fill(0);
    capFadeMask.fill(0);
    sourceOwnerGrid.fill(-1);
    riverGrid.fill(0);
    riverLabels.fill(0);
    riverCellLastSeen.fill(0);
    capillaryOrigins = [];
    prevCapillaryOriginKeys = new Set();
    sleepCounter_arr.fill(0);
    init();
    console.log('Simulation reset.');
}

function getSimSpeed() { return simSpeed; }

module.exports = { resize, init, reset, tick, getFrameData, getWetnessData, getErosionData, handleKey, handleMouse, getSimSpeed };
