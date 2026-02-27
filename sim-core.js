'use strict';

// Node.js shim for performance.now()
const _perf = globalThis.performance ?? { now: () => Date.now() };

const SimplexNoise = require('simplex-noise');

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
let particles = [];
let sourcePoints = [];
let deltaParticleCount = 0;
let riverZoneParticleCount = 0;
let frameDiversions = 0;
let capillaryDiversion = false;
let mixSources = true;
let frameNum = 0;

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

    cols = Math.ceil(width / GRID_SIZE);
    rows = Math.ceil(height / GRID_SIZE);
    wetnessGrid = new Float32Array(cols * rows);
    erosionGrid = new Float32Array(cols * rows);
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

function init() {
    particles = [];
    const SOURCE_COUNT = SOURCE_PARTICLE_COUNT;
    for (let i = 0; i < NUM_PARTICLES; i++) {
        let p = new Particle();
        p.isCapillary = false;
        p.isSource = i < SOURCE_COUNT;
        particles.push(p);
    }
}

// Distance from point (px,py) to the push arc pill shape
function pushArcDist(px, py) {
    let angle = mouse.pushAngle;
    let dirX = Math.cos(angle);
    let dirY = Math.sin(angle);
    let acx = mouse.x - dirX * PUSH_ARC_RADIUS;
    let acy = mouse.y - dirY * PUSH_ARC_RADIUS;
    let dx = px - acx;
    let dy = py - acy;
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
    let ndx = px - nearX;
    let ndy = py - nearY;
    return Math.sqrt(ndx * ndx + ndy * ndy);
}

class Particle {
    constructor() {
        this._recycled = false;
        this.reset();
        // Spread initial particles vertically so they don't all bunch at the top
        this.y = -Math.random() * height * DELTA_ZONE_END;
    }

    reset() {
        const srcI = Math.floor(Math.random() * sourcePoints.length);
        const src = sourcePoints[srcI];
        this.sourceIdx = srcI;
        this.x = src + (Math.random() - 0.5) * DELTA_SPAWN_WIDTH;
        this.y = -Math.random() * SOURCE_SPAWN_HEIGHT;
        if (this.isSource) this.age = 0;
        this.vx = 0;
        this.vy = 0;
        this.speed = Math.random() * PARTICLE_SPEED_VAR + PARTICLE_SPEED_BASE;
        this.weight = Math.random() * PARTICLE_WEIGHT_VAR + PARTICLE_WEIGHT_BASE;
        this.gravity = Math.random() * PARTICLE_GRAVITY_VAR + PARTICLE_GRAVITY_BASE;
        this.life = Math.random() * PARTICLE_LIFE_VAR + PARTICLE_LIFE_BASE;
        this.age = 0;
        this.drawOpacity = 0;
        this.stagnation = 0;
    }

    update() {
        if (this.isCapillary) { this._updateCapillary(); return; }

        const n1 = fbm(this.x * NOISE_SCALE, this.y * NOISE_SCALE, zOff);
        const nx = fbm((this.x + NOISE_EPSILON) * NOISE_SCALE, this.y * NOISE_SCALE, zOff);
        const ny = fbm(this.x * NOISE_SCALE, (this.y + NOISE_EPSILON) * NOISE_SCALE, zOff);

        const dx = (nx - n1) / NOISE_EPSILON;
        const dy = (ny - n1) / NOISE_EPSILON;

        let forceX = -dx;
        let forceY = -dy;

        let gradLen = Math.sqrt(forceX * forceX + forceY * forceY) || 1;
        forceX /= gradLen;
        forceY /= gradLen;

        let c = Math.floor(this.x / GRID_SIZE);
        let r = Math.floor(this.y / GRID_SIZE);
        let cellWetness = 0;

        if (c >= 0 && c < cols && r >= 0 && r < rows) {
            let idx = c + r * cols;
            wetnessGrid[idx] += WETNESS_DEPOSIT;
            sourceOwnerGrid[idx] = this.sourceIdx;
            cellWetness = wetnessGrid[idx];

            if (erosionGrid[idx] < EROSION_MAX) {
                erosionGrid[idx] += EROSION_DEPOSIT;
            }
            let cellErosion = erosionGrid[idx];

            let convergeFactor = Math.min(this.y / (height * CONVERGENCE_RAMP_RATIO), 1.0);
            if (convergeFactor < 0) convergeFactor = 0;

            if (convergeFactor > 0) {
                let attractLeft = 0, attractRight = 0;
                let repulseLeft = 0, repulseRight = 0;
                let inPostTransition = this.y >= height * CONVERGENCE_RAMP_RATIO;

                for (let s = 1; s <= STREAM_SCAN_RADIUS; s++) {
                    if (c - s < 0) break;
                    let w = wetnessGrid[idx - s] + erosionGrid[idx - s] * EROSION_WEIGHT;
                    let distFalloff = 1.0 / (s * s);
                    if (inPostTransition && sourceOwnerGrid[idx - s] >= 0
                        && sourceOwnerGrid[idx - s] !== this.sourceIdx) {
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
                        && sourceOwnerGrid[idx + s] !== this.sourceIdx) {
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
                    let stagnationBoost = 1.0 + this.stagnation * STAGNATION_BOOST_RATE;
                    attractStrength *= stagnationBoost;
                    forceX += sign * attractStrength;
                }
            }

            let erosionSpread = cellErosion * EROSION_SPREAD_STRENGTH;
            forceX += (Math.random() - 0.5) * erosionSpread;

            if (cellWetness > WETNESS_SPREAD_THRESHOLD) {
                forceX += (Math.random() - 0.5) * Math.min(cellWetness * WETNESS_SPREAD_SCALE, WETNESS_SPREAD_MAX);
            }
        }

        forceY += this.gravity + this.stagnation * 0.02;

        if (this.y < height * CONVERGENCE_RAMP_RATIO) {
            let topFactor = 1.0 - (this.y / (height * CONVERGENCE_RAMP_RATIO));
            forceY += topFactor * TOP_PUSH_FORCE;
        }

        let edgeMargin = width * EDGE_MARGIN_RATIO;
        if (this.x < edgeMargin) {
            let edgeFactor = 1.0 - (this.x / edgeMargin);
            forceX += edgeFactor * TOP_PUSH_FORCE;
        } else if (this.x > width - edgeMargin) {
            let edgeFactor = 1.0 - ((width - this.x) / edgeMargin);
            forceX += -edgeFactor * TOP_PUSH_FORCE;
        }

        let length = Math.sqrt(forceX * forceX + forceY * forceY) || 1;
        forceX /= length;
        forceY /= length;

        this.vx += forceX * FORCE_TO_VELOCITY * this.speed;
        this.vy += forceY * FORCE_TO_VELOCITY * this.speed;

        this.vx *= FRICTION;
        this.vy *= FRICTION;

        if (this.vy < 0) this.vy *= UPWARD_VELOCITY_DAMP;

        let speed = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
        if (speed < STAGNATION_THRESHOLD) {
            this.stagnation = Math.min(this.stagnation + 1, STAGNATION_MAX);
        } else {
            this.stagnation *= STAGNATION_DECAY;
        }

        this.x += this.vx;
        this.y += this.vy;

        // Mouse arc pill displacement (only active when server receives mouse events)
        if (mouse.active && mouse.leftDown && (mouse.frameDX !== 0 || mouse.frameDY !== 0)) {
            let dist = pushArcDist(this.x, this.y);
            if (dist < PUSH_PILL_RADIUS) {
                let falloff = 1.0 - dist / PUSH_PILL_RADIUS;
                this.x += mouse.frameDX * falloff * MOUSE_PUSH_SCALE;
                this.y += mouse.frameDY * falloff * MOUSE_PUSH_SCALE;
                this.vx += mouse.frameDX * falloff * MOUSE_PUSH_VELOCITY;
                this.vy += mouse.frameDY * falloff * MOUSE_PUSH_VELOCITY;
            }
        }

        if (this.isSource && this.y > height * DELTA_ZONE_END) {
            this.reset();
            return;
        }

        let inDelta = this.y > 0 && this.y < height * DELTA_ZONE_END;
        let inTransition = !inDelta && this.y >= height * DELTA_ZONE_END && this.y < height * TRANSITION_ZONE_END;
        let transitionT = inTransition ? (this.y - height * DELTA_ZONE_END) / (height * (TRANSITION_ZONE_END - DELTA_ZONE_END)) : 1.0;
        let inStream = cellWetness >= WETNESS_DRY_THRESHOLD;

        if (!inStream && !inDelta && !inTransition && !this.isSource) {
            this.age += STRAY_AGE_ACCEL;
            let ageFade = 1.0 - Math.min(this.age / (this.life * STRAY_FADE_RATIO), 1.0);
            this.drawOpacity = MAX_DRAW_OPACITY * STRAY_OPACITY_FACTOR * ageFade;
        } else {
            let ageRate = BASE_AGE_RATE;
            if (inTransition && !inStream) {
                ageRate = TRANSITION_AGE_BASE + transitionT * TRANSITION_AGE_RAMP;
            }
            this.age += ageRate;

            let baseOpacity = Math.min(MAX_DRAW_OPACITY, cellWetness / 100);
            if (inDelta) {
                let deltaAge = Math.min(this.age / (this.life * DELTA_FADE_RATIO), 1.0);
                let deltaFade = 1.0 - deltaAge * DELTA_FADE_STRENGTH;
                baseOpacity = Math.max(baseOpacity, MAX_DRAW_OPACITY * deltaFade);
            } else if (inTransition && !inStream) {
                let deltaAge = Math.min(this.age / (this.life * DELTA_FADE_RATIO), 1.0);
                let deltaFade = 1.0 - deltaAge * DELTA_FADE_STRENGTH;
                let deltaOpacity = MAX_DRAW_OPACITY * deltaFade;
                baseOpacity = Math.max(baseOpacity, deltaOpacity * (1.0 - transitionT));
            }
            this.drawOpacity = baseOpacity;
        }
        this.inDelta = inDelta || inTransition;

        if (this.x < -OOB_MARGIN || this.x > width + OOB_MARGIN || this.y > height + OOB_MARGIN || this.age > this.life) {
            this.reset();
        }
    }

    _recycleCapillary() {
        if (this._recycled) recycledCapillaryCount--;

        let bestDist2 = Infinity, bestOrigin = null;
        for (let o of capillaryOrigins) {
            if (o.sourceIdx !== this.sourceIdx) continue;
            let dx = o.x - this.capillaryOriginX;
            let dy = o.y - this.capillaryOriginY;
            let d2 = dx * dx + dy * dy;
            if (d2 < bestDist2) { bestDist2 = d2; bestOrigin = o; }
        }
        if (!bestOrigin || recycledCapillaryCount >= MAX_RECYCLED_CAPILLARIES) {
            this.isCapillary = false;
            this._recycled = false;
            this.reset();
            return;
        }
        recycledCapillaryCount++;
        this._recycled = true;
        this.x = bestOrigin.x;
        this.y = bestOrigin.y;
        this.capillaryOriginX = bestOrigin.x;
        this.capillaryOriginY = bestOrigin.y;
        this.capillaryAngle = bestOrigin.targetAngle;
        this.capillaryDir = Math.cos(bestOrigin.targetAngle) >= 0 ? 1 : -1;
        this.age = 0;
        this.capillaryWiggleSeed = Math.random() * Math.PI * 2;
        this.drawOpacity = 0;

        let oc = Math.floor(bestOrigin.x / GRID_SIZE);
        let or_ = Math.floor(bestOrigin.y / GRID_SIZE);
        let dir = this.capillaryDir;
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
            this.vx = outX * CAPILLARY_LATERAL_FORCE * CAP_LATERAL_SCALE;
            this.vy = outY * CAPILLARY_LATERAL_FORCE * CAP_LATERAL_SCALE + bestDr * CAP_ATTRACT_SCALE;
        } else {
            this.vx = 0;
            this.vy = 0;
        }
    }

    _updateCapillary() {
        this.age++;

        let wiggle = Math.sin(this.age * this.capillaryWiggleFreq + this.capillaryWiggleSeed) * CAPILLARY_WIGGLE_STRENGTH;
        let spd2 = this.vx * this.vx + this.vy * this.vy;
        if (spd2 > 0.01) {
            let inv = 1.0 / Math.sqrt(spd2);
            let px = -this.vy * inv;
            let py =  this.vx * inv;
            this.vx += px * wiggle;
            this.vy += py * wiggle;
        } else {
            this.vy += wiggle;
        }

        let dx0 = this.x - this.capillaryOriginX;
        let dy0 = this.y - this.capillaryOriginY;
        let dist = Math.sqrt(dx0 * dx0 + dy0 * dy0);
        let lateralFactor = Math.exp(-dist / CAP_LATERAL_DECAY_DIST);
        let outX = Math.cos(this.capillaryAngle);
        let outY = Math.sin(this.capillaryAngle);
        this.vx += outX * CAPILLARY_LATERAL_FORCE * CAP_LATERAL_SCALE * lateralFactor;
        this.vy += outY * CAPILLARY_LATERAL_FORCE * CAP_LATERAL_SCALE * lateralFactor;

        this.vy += CAPILLARY_GRAVITY;

        let c = Math.floor(this.x / GRID_SIZE);
        let r = Math.floor(this.y / GRID_SIZE);
        if (c >= 0 && c < cols && r >= 0 && r < rows) {
            let idx = c + r * cols;

            capWetnessGrid[idx] += CAP_WETNESS_DEPOSIT;
            if (capErosionGrid[idx] < CAP_EROSION_MAX) {
                capErosionGrid[idx] += CAP_EROSION_DEPOSIT;
            }

            let deposit = CAP_WETNESS_DEPOSIT + CAP_EROSION_DEPOSIT;
            if (capOwnerStr[idx] < deposit || capOwnerGrid[idx] === this.streamId) {
                capOwnerGrid[idx] = this.streamId;
                capOwnerStr[idx] += deposit;
            } else if (capOwnerGrid[idx] !== this.streamId) {
                capOwnerStr[idx] -= deposit * 0.5;
                if (capOwnerStr[idx] <= 0) {
                    capOwnerGrid[idx] = this.streamId;
                    capOwnerStr[idx] = deposit;
                }
            }
            let cellCapErosion = capErosionGrid[idx];

            let pullY = 0;
            let dir = this.capillaryDir > 0 ? 1 : -1;
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
                        if (owner === 0 || owner === this.streamId) {
                            pullY += dr * w * CAP_ATTRACT_SCALE / (s * s);
                        }
                    }
                }
            }
            this.vy += pullY;

            let erosionSpread = cellCapErosion * CAP_EROSION_SPREAD;
            this.vx += (Math.random() - 0.5) * erosionSpread;
        }

        this.vx *= CAP_FRICTION;
        this.vy *= CAP_FRICTION;
        let spd = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
        if (spd > CAP_MAX_SPEED) {
            this.vx = (this.vx / spd) * CAP_MAX_SPEED;
            this.vy = (this.vy / spd) * CAP_MAX_SPEED;
        }

        this.x += this.vx;
        this.y += this.vy;

        // Mouse arc pill displacement (only active when server receives mouse events)
        if (mouse.active && mouse.leftDown && (mouse.frameDX !== 0 || mouse.frameDY !== 0)) {
            let dist = pushArcDist(this.x, this.y);
            if (dist < PUSH_PILL_RADIUS) {
                let falloff = 1.0 - dist / PUSH_PILL_RADIUS;
                this.x += mouse.frameDX * falloff * MOUSE_PUSH_SCALE;
                this.y += mouse.frameDY * falloff * MOUSE_PUSH_SCALE;
            }
        }

        let fadeIn = Math.min(this.age / CAP_FADE_IN_FRAMES, 1.0);
        this.drawOpacity = CAPILLARY_MAX_OPACITY * fadeIn;

        if (this.age > CAP_FADE_IN_FRAMES) {
            let rzYStart = Math.floor(height * TRANSITION_ZONE_END);
            let rr = Math.floor((this.y - rzYStart) / RIVER_CELL_SIZE);
            let rc = Math.floor(this.x / RIVER_CELL_SIZE);
            if (rr >= 0 && rr < riverGridRows && rc >= 0 && rc < riverGridCols) {
                let lbl = riverLabels[rr * riverGridCols + rc];
                if (lbl > 0) {
                    this._recycleCapillary();
                    return;
                }
            }
        }

        if (this.x < -OOB_MARGIN || this.x > width + OOB_MARGIN || this.y < -OOB_MARGIN || this.y > height + OOB_MARGIN) {
            this._recycleCapillary();
        }
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
    for (let i = 0; i < particles.length; i++) {
        let p = particles[i];
        if (p.isCapillary || p.y < rzYStart) continue;
        let r = Math.floor((p.y - rzYStart) / RIVER_CELL_SIZE);
        let c = Math.floor(p.x / RIVER_CELL_SIZE);
        if (r >= 0 && r < riverGridRows && c >= 0 && c < riverGridCols) {
            cellCounts[r * riverGridCols + c]++;
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

    for (let p of particles) {
        let pr = Math.floor((p.y - rzYStart) / RIVER_CELL_SIZE);
        let pc = Math.floor(p.x / RIVER_CELL_SIZE);
        if (pr < 0 || pr >= riverGridRows || pc < 0 || pc >= riverGridCols) continue;
        let lbl = riverLabels[pr * riverGridCols + pc];
        if (lbl > 0 && p.sourceIdx >= 0) {
            let counts = compSourceCounts[lbl - 1];
            counts[p.sourceIdx] = (counts[p.sourceIdx] || 0) + 1;
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
        // Evaporate wetness grid and slowly decay erosion
        for (let k = 0; k < wetnessGrid.length; k++) {
            wetnessGrid[k] *= EVAPORATION_RATE;
            if (wetnessGrid[k] < 0.1) sourceOwnerGrid[k] = -1;
            erosionGrid[k] *= EROSION_DECAY;
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
        for (let i = 0; i < particles.length; i++) {
            let p = particles[i];
            if (p.y >= 0 && p.y < deltaEnd) deltaParticleCount++;
            if (!p.isSource && p.y >= height * TRANSITION_ZONE_END) riverZoneParticleCount++;
        }

        updateRiverGrid();

        frameDiversions = 0;

        // Delta-zone capillary diversion
        if (capillaryDiversion && capillaryOrigins.length > 0 &&
            riverZoneParticleCount > CAPILLARY_DIVERSION_THRESHOLD) {
            for (let d = 0; d < CAPILLARY_DIVERSIONS_PER_FRAME; d++) {
                let idx = Math.floor(Math.random() * particles.length);
                let p = particles[idx];
                if (p.isSource || p.isCapillary || p.y < 0 || p.y >= deltaEnd) continue;

                let o = capillaryOrigins[Math.floor(Math.random() * capillaryOrigins.length)];
                p.isCapillary = true;
                p.x = o.x;
                p.y = o.y;
                p.capillaryDir = Math.cos(o.targetAngle) >= 0 ? 1 : -1;
                p.streamId = o.sourceIdx * 2 + (p.capillaryDir > 0 ? 1 : 0) + 1;
                p.capillaryOriginX = o.x;
                p.capillaryOriginY = o.y;
                p.capillaryAngle = o.targetAngle;
                p.sourceIdx = o.sourceIdx;
                p.age = 0;
                p.capillaryWiggleSeed = Math.random() * Math.PI * 2;
                p.capillaryWiggleFreq = CAP_WIGGLE_FREQ_BASE + Math.random() * CAP_WIGGLE_FREQ_VAR;
                p.drawOpacity = CAPILLARY_MAX_OPACITY;
                p._recycled = false;

                let oc = Math.floor(o.x / GRID_SIZE);
                let or_ = Math.floor(o.y / GRID_SIZE);
                let dir = p.capillaryDir;
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
                    p.vx = outX * CAPILLARY_LATERAL_FORCE * CAP_LATERAL_SCALE;
                    p.vy = outY * CAPILLARY_LATERAL_FORCE * CAP_LATERAL_SCALE + bestDr * CAP_ATTRACT_SCALE;
                } else {
                    p.vx = 0;
                    p.vy = 0;
                }
            }
        }

        for (let i = 0; i < particles.length; i++) {
            particles[i].update();
        }
    }

    // Reset per-frame mouse displacement accumulators
    mouse.frameDX = 0;
    mouse.frameDY = 0;

    // Slowly evolve the noise for shifting rivers
    zOff += NOISE_EVOLUTION_SPEED;
    frameNum++;
}

// Pack all visible particle render data into a compact binary Buffer.
// Header (8 bytes): frameNum (uint32LE) + particleCount (uint32LE)
// Per particle (8 bytes): x (uint16), y (uint16), opacity (uint8 * 255),
//   radius (uint8 * 10), sourceIdx (uint8), flags (uint8: bit0=isCapillary)
function getFrameData() {
    // Count visible particles
    let count = 0;
    for (let i = 0; i < particles.length; i++) {
        if (particles[i].drawOpacity > MIN_DRAW_OPACITY) count++;
    }

    const buf = Buffer.allocUnsafe(8 + count * 8);
    buf.writeUInt32LE(frameNum, 0);
    buf.writeUInt32LE(count, 4);

    let offset = 8;
    for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        if (p.drawOpacity <= MIN_DRAW_OPACITY) continue;

        // x (uint16, normalized 0–65535 across simulation width)
        const xEnc = Math.max(0, Math.min(65535, Math.round(p.x / width * 65535)));
        buf.writeUInt16LE(xEnc, offset); offset += 2;

        // y (uint16, normalized 0–65535 across simulation height)
        const yEnc = Math.max(0, Math.min(65535, Math.round(p.y / height * 65535)));
        buf.writeUInt16LE(yEnc, offset); offset += 2;

        // opacity (uint8, opacity * 255)
        const opacityEnc = Math.max(0, Math.min(255, Math.round(p.drawOpacity * 255)));
        buf.writeUInt8(opacityEnc, offset++);

        // radius (uint8, radius * 10) — compute server-side
        let radius;
        if (p.isCapillary) {
            let c = Math.floor(p.x / GRID_SIZE);
            let r = Math.floor(p.y / GRID_SIZE);
            let capW = (c >= 0 && c < cols && r >= 0 && r < rows) ? capWetnessGrid[c + r * cols] : 0;
            let thickness = Math.min(capW / CAP_THICKNESS_DIVISOR, 1.0);
            radius = CAP_MIN_RADIUS + thickness * (CAPILLARY_MAX_RADIUS - CAP_MIN_RADIUS);
        } else {
            radius = p.weight * PARTICLE_RADIUS_SCALE * Math.sin((p.age / p.life) * Math.PI);
            if (p.inDelta) radius = Math.max(radius, DELTA_MIN_RADIUS);
        }
        const radiusEnc = Math.max(0, Math.min(255, Math.round(radius * 10)));
        buf.writeUInt8(radiusEnc, offset++);

        // sourceIdx (uint8)
        buf.writeUInt8(p.sourceIdx & 0xFF, offset++);

        // flags (uint8): bit 0 = isCapillary
        buf.writeUInt8(p.isCapillary ? 1 : 0, offset++);
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
    recycledCapillaryCount = 0;
    wetnessGrid.fill(0);
    erosionGrid.fill(0);
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
    particles = [];
    init();
    console.log('Simulation reset.');
}

module.exports = { resize, init, reset, tick, getFrameData, handleKey, handleMouse };
