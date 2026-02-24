const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const overlayCanvas = document.getElementById('overlay');
const overlayCtx = overlayCanvas.getContext('2d');

let width, height;
let particles = [];
let sourcePoints = [];
let debugOverlay = false; // Toggle with 'D' key
// ==========================================
// CONFIGURATION & TUNING VARIABLES
// ==========================================

// --- Overall Simulation ---
// Number of particles spawned in the simulation
const NUM_PARTICLES = 16000;
const BURST_COUNT = 200;
// Fraction of particles dedicated to the delta zone (reset when they leave it)
const SOURCE_PARTICLE_FRACTION = 0.25;

// --- Flow Field & Noise ---
// How zoomed in the noise field is. Smaller = broader rivers
const NOISE_SCALE = 0.0008;
// How quickly the noise field (and thus the river paths) shifts over time
const NOISE_EVOLUTION_SPEED = 0.0003;
// Epsilon for calculating the noise gradient (steepness/direction)
const NOISE_EPSILON = 0.1;

// --- Fluid & Wetness Grid ---
// Size of each grid cell (px) for tracking water accumulation
const GRID_SIZE = 3;
// How quickly the wetness map dries up every frame (multiplier, 0.99 = 1% loss)
const EVAPORATION_RATE = 0.99;
// Added to wetness grid when particle is present
const WETNESS_DEPOSIT = 0.2;
// Threshold of wetness below which a particle is considered "dry"
const WETNESS_DRY_THRESHOLD = 3.0;

// --- Erosion ---
// How much erosion accumulates per particle per frame
const EROSION_DEPOSIT = 0.05;
// How quickly erosion heals (1.0 = never, 0.999 = very slowly)
const EROSION_DECAY = 0.9999;
// Max erosion value a cell can reach
const EROSION_MAX = 25.0;
// How strongly erosion widens channels (lateral spread multiplier)
const EROSION_SPREAD_STRENGTH = 0.35;

// --- Particle Physics ---
const PARTICLE_SPEED_BASE = 0.4;
const PARTICLE_SPEED_VAR = 0.8;

const PARTICLE_WEIGHT_BASE = 0.3;
const PARTICLE_WEIGHT_VAR = 0.7;

// Gravity variance: some flow fast downhill, some drag and swirl in lakes
const PARTICLE_GRAVITY_BASE = 0.1;
const PARTICLE_GRAVITY_VAR = 1.5;

const PARTICLE_LIFE_BASE = 400;
const PARTICLE_LIFE_VAR = 1200;

// Friction applied to limit terminal velocity (lower = more friction)
const FRICTION = 0.85;

// --- Visuals & Fading ---
// Particles with opacity below this will not be drawn (hides tiny swimmers)
const MIN_DRAW_OPACITY = 0.0;
// The maximum opacity a path can have when drawn (achieved in deep water)
const MAX_DRAW_OPACITY = 0.20;

// "Hold then quickly fade" effect:
// RGB value above which trails hold their brightness strongly (0-255)
const FADE_HOLD_THRESHOLD = 190;
// How much RGB to subtract when path is bright (slow fade)
const FADE_SLOW_AMOUNT = 1;
// How much RGB to subtract when path drops below threshold (fast fade)
const FADE_FAST_AMOUNT = 3;

// --- Zone Boundaries ---
const DELTA_ZONE_END = 0.30;
const TRANSITION_ZONE_END = 0.40;

// --- Capillary System ---
const CAPILLARY_FRACTION = 0.06;
const CAPILLARY_ORIGIN_START = TRANSITION_ZONE_END;
const CAPILLARY_ORIGIN_SPACING_MIN = 0.10;
const CAPILLARY_ORIGIN_SPACING_MAX = 0.15;
const CAPILLARY_SPAWN_WETNESS = 5.0;
const CAPILLARY_TARGET_WETNESS = 3.0;
const CAPILLARY_LATERAL_FORCE = 2.5;
const CAPILLARY_GRAVITY = 0.03;
const CAPILLARY_MAX_OPACITY = 0.18;
const CAPILLARY_MAX_RADIUS = 1.0;
const CAPILLARY_PHEROMONE_DEPOSIT = 0.4;
const CAPILLARY_PHEROMONE_ATTRACT = 0.15;
const CAPILLARY_PHEROMONE_EVAP = 0.997;
const CAPILLARY_REPULSE_STRENGTH = 0.3;
// ==========================================

let mouse = { x: 0, y: 0, prevX: 0, prevY: 0, frameDX: 0, frameDY: 0, dirX: 0, dirY: 1, targetDirX: 0, targetDirY: 1, speed: 0, active: false, middleDown: false, lastTime: 0 };
let burst = { charging: false, x: 0, y: 0, startTime: 0 };
const BURST_MIN_RADIUS = 50;
const BURST_MAX_RADIUS = 300;
const BURST_CHARGE_TIME = 2000; // ms to reach max size

let zOff = 0;
let cols, rows;
let wetnessGrid;
let erosionGrid;
let capillaryGrid;
let trackedRivers = [];   // Array of { id, color, centerCol, origins: [{ yPixel, yRow }], dead }
let nextRiverId = 0;
let riverTrackFrame = 0;  // Frame counter for throttling origin growth checks

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

function resize() {
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = width;
    canvas.height = height;
    overlayCanvas.width = width;
    overlayCanvas.height = height;

    cols = Math.ceil(width / GRID_SIZE);
    rows = Math.ceil(height / GRID_SIZE);
    wetnessGrid = new Float32Array(cols * rows);
    erosionGrid = new Float32Array(cols * rows);
    capillaryGrid = new Float32Array(cols * rows);

    // Generate fixed source points across the top edge (only on first load)
    if (sourcePoints.length === 0) {
        const NUM_SOURCES = 6;
        const margin = width * 0.1;
        const spacing = (width - 2 * margin) / (NUM_SOURCES - 1);
        for (let i = 0; i < NUM_SOURCES; i++) {
            sourcePoints.push(margin + i * spacing);
        }
    }

    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, width, height);
}

window.addEventListener('resize', resize);
resize();

const RIVER_COLORS = [[0,204,204],[204,68,255],[68,255,204],[255,204,68],[255,68,204],[68,136,255],[255,136,68],[136,255,68]];
const RIVER_MATCH_TOLERANCE = 15; // cells

function updateTrackedRivers() {
    riverTrackFrame++;
    let detectionY = CAPILLARY_ORIGIN_START * height;
    let detectionRow = Math.floor(detectionY / GRID_SIZE);

    // --- Detection line scan: find rivers crossing the detection row ---
    let rivers = findRiversAtBand(detectionRow);

    // --- Match detected rivers to existing tracked rivers ---
    let matched = new Set();       // indices into rivers[]
    let riverToTracked = new Map(); // river index -> tracked river

    // Snapshot length to avoid iterating over newly-pushed merged rivers
    let snapshotLen = trackedRivers.length;
    for (let ti = 0; ti < snapshotLen; ti++) {
        let tr = trackedRivers[ti];
        if (tr.dead) continue;
        let bestDist = Infinity;
        let bestIdx = -1;
        for (let i = 0; i < rivers.length; i++) {
            let d = Math.abs(rivers[i].centerCol - tr.centerCol);
            if (d < bestDist) { bestDist = d; bestIdx = i; }
        }
        if (bestIdx >= 0 && bestDist < RIVER_MATCH_TOLERANCE) {
            tr.missedFrames = 0;
            // Check for merge: is another tracked river already matched to this same wet run?
            if (riverToTracked.has(bestIdx)) {
                // Merge: two tracked rivers match the same detected run
                let otherTr = riverToTracked.get(bestIdx);
                let mergedRiver = {
                    id: nextRiverId++,
                    color: RIVER_COLORS[nextRiverId % RIVER_COLORS.length],
                    centerCol: rivers[bestIdx].centerCol,
                    origins: [...otherTr.origins, ...tr.origins],
                    dead: false,
                    missedFrames: 0
                };
                tr.dead = true;
                otherTr.dead = true;
                trackedRivers.push(mergedRiver);
                riverToTracked.set(bestIdx, mergedRiver);
            } else {
                tr.centerCol = rivers[bestIdx].centerCol;
                matched.add(bestIdx);
                riverToTracked.set(bestIdx, tr);
            }
        }
    }

    // --- Staleness: increment missed frames for unmatched rivers, mark dead ---
    let matchedTracked = new Set();
    for (let [, tr] of riverToTracked) matchedTracked.add(tr);
    for (let ti = 0; ti < snapshotLen; ti++) {
        let tr = trackedRivers[ti];
        if (tr.dead || matchedTracked.has(tr)) continue;
        tr.missedFrames = (tr.missedFrames || 0) + 1;
        if (tr.missedFrames > 120) tr.dead = true;
    }

    // Periodically prune dead entries to prevent unbounded array growth
    if (riverTrackFrame % 300 === 0) {
        trackedRivers = trackedRivers.filter(tr => !tr.dead);
    }

    // --- Create new tracked rivers for unmatched detected runs ---
    for (let i = 0; i < rivers.length; i++) {
        if (matched.has(i) || riverToTracked.has(i)) continue;
        // Need at least 2 rivers detected to spawn capillaries between them
        let id = nextRiverId++;
        let startY = detectionY;
        let firstOrigin = { yPixel: startY, yRow: detectionRow };
        trackedRivers.push({
            id: id,
            color: RIVER_COLORS[id % RIVER_COLORS.length],
            centerCol: rivers[i].centerCol,
            origins: [firstOrigin],
            dead: false,
            missedFrames: 0
        });
    }

    // --- Origin growth: extend origins downward as rivers grow (throttled) ---
    if (riverTrackFrame % 60 === 0) {
        let growLen = trackedRivers.length;
        for (let gi = 0; gi < growLen; gi++) {
            let tr = trackedRivers[gi];
            if (tr.dead) continue;
            // Prune origins where the river is no longer detected
            tr.origins = tr.origins.filter(o => {
                let bandsAtOrigin = findRiversAtBand(o.yRow);
                for (let rv of bandsAtOrigin) {
                    if (Math.abs(rv.centerCol - tr.centerCol) < RIVER_MATCH_TOLERANCE) return true;
                }
                return false;
            });
            // Find the lowest existing origin
            let lowestY = -Infinity;
            for (let o of tr.origins) {
                if (o.yPixel > lowestY) lowestY = o.yPixel;
            }
            // Scan downward from lowest origin to find how far the river extends
            let maxExtentY = lowestY;
            let scanRow = Math.floor(lowestY / GRID_SIZE);
            for (let r = scanRow; r < rows; r++) {
                let riversAtRow = findRiversAtBand(r);
                let found = false;
                for (let rv of riversAtRow) {
                    if (Math.abs(rv.centerCol - tr.centerCol) < RIVER_MATCH_TOLERANCE) {
                        maxExtentY = r * GRID_SIZE;
                        found = true;
                        break;
                    }
                }
                if (!found) break;
            }
            // Add new origins if river extends far enough below lowest origin
            let spacingThreshold = CAPILLARY_ORIGIN_SPACING_MAX * height;
            while (maxExtentY - lowestY > spacingThreshold) {
                let spacing = (CAPILLARY_ORIGIN_SPACING_MIN + Math.random() * (CAPILLARY_ORIGIN_SPACING_MAX - CAPILLARY_ORIGIN_SPACING_MIN)) * height;
                let newY = lowestY + spacing;
                if (newY > height - 20) break;
                let newRow = Math.floor(newY / GRID_SIZE);
                tr.origins.push({ yPixel: newY, yRow: newRow });
                lowestY = newY;
            }
        }
    }
}

const RIVER_BAND_HALF = 5;           // rows above/below detection line
const RIVER_EROSION_THRESHOLD = 15.0; // min erosion to count as river
const RIVER_MIN_WIDTH = 3;           // cells — filter out noise/spray

function findRiversAtBand(centerRow) {
    if (centerRow < 0 || centerRow >= rows) return [];
    let rMin = Math.max(0, centerRow - RIVER_BAND_HALF);
    let rMax = Math.min(rows - 1, centerRow + RIVER_BAND_HALF);

    // Build per-column max erosion across band
    let profile = new Float32Array(cols);
    for (let r = rMin; r <= rMax; r++) {
        let offset = r * cols;
        for (let c = 0; c < cols; c++) {
            let e = erosionGrid[c + offset];
            if (e > profile[c]) profile[c] = e;
        }
    }

    // Find runs above threshold
    let runs = [];
    let inRun = false, runStart = 0;
    for (let c = 0; c < cols; c++) {
        if (profile[c] >= RIVER_EROSION_THRESHOLD) {
            if (!inRun) { inRun = true; runStart = c; }
        } else {
            if (inRun) { runs.push({leftCol: runStart, rightCol: c - 1}); inRun = false; }
        }
    }
    if (inRun) runs.push({leftCol: runStart, rightCol: cols - 1});

    // Merge runs with < 3 cell gap
    let merged = [];
    for (let r of runs) {
        if (merged.length > 0 && r.leftCol - merged[merged.length - 1].rightCol < 3) {
            merged[merged.length - 1].rightCol = r.rightCol;
        } else {
            merged.push({...r});
        }
    }
    merged = merged.filter(r => (r.rightCol - r.leftCol + 1) >= RIVER_MIN_WIDTH);
    for (let r of merged) r.centerCol = Math.floor((r.leftCol + r.rightCol) / 2);
    return merged;
}

class Particle {
    constructor() {
        this.reset();
        // Spread initial particles vertically so they don't all bunch at the top
        this.y = -Math.random() * height * DELTA_ZONE_END;
    }

    reset() {
        // Spawn from a random fixed source point with wide delta spread
        const src = sourcePoints[Math.floor(Math.random() * sourcePoints.length)];
        this.x = src + (Math.random() - 0.5) * 120;
        this.y = -Math.random() * 30;
        // Reset age for source particles so they stay fresh
        if (this.isSource) this.age = 0;
        this.vx = 0;
        this.vy = 0;
        this.speed = Math.random() * PARTICLE_SPEED_VAR + PARTICLE_SPEED_BASE;
        this.weight = Math.random() * PARTICLE_WEIGHT_VAR + PARTICLE_WEIGHT_BASE;
        // Gravity variance: some flow fast downhill, some drag and swirl in lakes
        this.gravity = Math.random() * PARTICLE_GRAVITY_VAR + PARTICLE_GRAVITY_BASE;
        this.life = Math.random() * PARTICLE_LIFE_VAR + PARTICLE_LIFE_BASE;
        this.age = 0;
        this.drawOpacity = 0;
        this.stagnation = 0;
    }

    update() {
        if (this.isCapillary) { this._updateCapillary(); return; }
        // Calculate noise gradient
        const n1 = fbm(this.x * NOISE_SCALE, this.y * NOISE_SCALE, zOff);
        const nx = fbm((this.x + NOISE_EPSILON) * NOISE_SCALE, this.y * NOISE_SCALE, zOff);
        const ny = fbm(this.x * NOISE_SCALE, (this.y + NOISE_EPSILON) * NOISE_SCALE, zOff);

        const dx = (nx - n1) / NOISE_EPSILON;
        const dy = (ny - n1) / NOISE_EPSILON;

        // Steepest descent vector
        let forceX = -dx;
        let forceY = -dy;

        // Normalize gradient vector to make it robust against steepness variance
        let gradLen = Math.sqrt(forceX * forceX + forceY * forceY) || 1;
        forceX /= gradLen;
        forceY /= gradLen;

        // Map particle to wetness grid
        let c = Math.floor(this.x / GRID_SIZE);
        let r = Math.floor(this.y / GRID_SIZE);
        let cellWetness = 0;

        if (c >= 0 && c < cols && r >= 0 && r < rows) {
            let idx = c + r * cols;
            wetnessGrid[idx] += WETNESS_DEPOSIT; // deposit water
            cellWetness = wetnessGrid[idx];

            // Accumulate erosion where water flows (very slow, persistent)
            if (erosionGrid[idx] < EROSION_MAX) {
                erosionGrid[idx] += EROSION_DEPOSIT;
            }
            let cellErosion = erosionGrid[idx];

            // Scan laterally for nearby wet channels and pull toward the strongest one.
            // Larger channels (higher wetness+erosion) pull from further away,
            // causing small parallel streams to merge into dominant rivers.
            let convergeFactor = Math.min(this.y / (height * 0.10), 1.0);
            if (convergeFactor < 0) convergeFactor = 0;

            if (convergeFactor > 0) {
                let pullX = 0;
                const SCAN_RADIUS = 40; // cells to scan in each direction
                for (let s = 1; s <= SCAN_RADIUS; s++) {
                    let distFalloff = 1.0 / (s * s); // inverse square falloff
                    let wL = (c - s >= 0) ? wetnessGrid[idx - s] + erosionGrid[idx - s] * 3 : 0;
                    let wR = (c + s < cols) ? wetnessGrid[idx + s] + erosionGrid[idx + s] * 3 : 0;
                    pullX += (wR - wL) * distFalloff;
                }
                let pullAbs = Math.abs(pullX);
                if (pullAbs > 0.01) {
                    let sign = pullX > 0 ? 1 : -1;
                    let attractStrength = Math.min(pullAbs * 0.1, 2.0) * convergeFactor;
                    let stagnationBoost = 1.0 + this.stagnation * 0.05;
                    attractStrength *= stagnationBoost;
                    forceX += sign * attractStrength;
                }
            }

            // Erosion-based widening: more eroded channels spread particles laterally,
            // simulating how rivers carve wider beds over time
            let erosionSpread = cellErosion * EROSION_SPREAD_STRENGTH;
            forceX += (Math.random() - 0.5) * erosionSpread;

            // Base lateral spread at high wetness (immediate width from water volume)
            if (cellWetness > 15) {
                forceX += (Math.random() - 0.5) * Math.min(cellWetness * 0.005, 0.3);
            }
        }

        // Add per-particle downward gravity. Low gravity particles will get trapped
        // in local minima 'lakes' and swirl, high gravity will force main rivers down.
        // Stagnant particles get extra downward push to escape local minima
        forceY += this.gravity + this.stagnation * 0.02;

        // Extra downward push near the top so particles don't stagnate in the delta zone
        if (this.y < height * 0.10) {
            let topFactor = 1.0 - (this.y / (height * 0.10));
            forceY += topFactor * 2.0;
        }

        // Push particles away from left/right edges
        let edgeMargin = width * 0.05;
        if (this.x < edgeMargin) {
            let edgeFactor = 1.0 - (this.x / edgeMargin);
            forceX += edgeFactor * 2.0;
        } else if (this.x > width - edgeMargin) {
            let edgeFactor = 1.0 - ((width - this.x) / edgeMargin);
            forceX += -edgeFactor * 2.0;
        }

        // Normalize total force
        let length = Math.sqrt(forceX * forceX + forceY * forceY) || 1;
        forceX /= length;
        forceY /= length;

        this.vx += forceX * 0.2 * this.speed;
        this.vy += forceY * 0.2 * this.speed;

        // Friction to limit max speed
        this.vx *= FRICTION;
        this.vy *= FRICTION;

        // Prevent particles from moving upward — water flows downhill
        if (this.vy < 0) this.vy *= 0.1;

        // Track stagnation: particles barely moving accumulate stagnation,
        // which boosts their attraction toward nearby streams
        let speed = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
        if (speed < 0.3) {
            this.stagnation = Math.min(this.stagnation + 1, 60);
        } else {
            this.stagnation *= 0.95;
        }

        this.x += this.vx;
        this.y += this.vy;

        // Mouse pill displacement — physically push particles
        // Pill: 100px long axis (perpendicular to motion), 20px short axis (along motion)
        if (mouse.active && mouse.middleDown && (mouse.frameDX !== 0 || mouse.frameDY !== 0)) {
            let halfLength = 90; // half of line segment (pill total = 80 + 2*10 = 100)
            let halfWidth = 10;  // radius of capsule (pill width = 20)
            // Long axis is perpendicular to mouse direction
            let perpX = -mouse.dirY;
            let perpY = mouse.dirX;
            // Vector from mouse to particle
            let mdx = this.x - mouse.x;
            let mdy = this.y - mouse.y;
            // Project onto pill axes
            let alongLong = mdx * perpX + mdy * perpY;
            let alongShort = mdx * mouse.dirX + mdy * mouse.dirY;
            // Clamp long-axis projection to segment
            let clamped = Math.max(-halfLength, Math.min(halfLength, alongLong));
            // Nearest point on segment to particle
            let nearX = mouse.x + perpX * clamped;
            let nearY = mouse.y + perpY * clamped;
            let distX = this.x - nearX;
            let distY = this.y - nearY;
            let dist = Math.sqrt(distX * distX + distY * distY);
            if (dist < halfWidth) {
                let falloff = 1.0 - dist / halfWidth;
                this.x += mouse.frameDX * falloff;
                this.y += mouse.frameDY * falloff;
                this.vx += mouse.frameDX * falloff * 0.3;
                this.vy += mouse.frameDY * falloff * 0.3;
            }
        }

        // Source particles are confined to the delta zone — reset when they leave
        if (this.isSource && this.y > height * DELTA_ZONE_END) {
            this.reset();
            return;
        }

        // Fluid characteristics:
        // Particles near the top (delta zone) are always visible and don't decay fast,
        // even when spread thin, so deltas can form before streams converge.
        // A transition zone (20%-35%) softly blends delta treatment into river treatment.
        let inDelta = this.y > 0 && this.y < height * DELTA_ZONE_END;
        let inTransition = !inDelta && this.y >= height * DELTA_ZONE_END && this.y < height * TRANSITION_ZONE_END;
        // 0 = full delta treatment, 1 = full river treatment
        let transitionT = inTransition ? (this.y - height * DELTA_ZONE_END) / (height * (TRANSITION_ZONE_END - DELTA_ZONE_END)) : 1.0;
        let inStream = cellWetness >= WETNESS_DRY_THRESHOLD;

        if (!inStream && !inDelta && !inTransition && !this.isSource) {
            this.age += 4; // Small stray strands dry up / get absorbed rapidly
            // Fade out based on age — stray particles become invisible over time
            let ageFade = 1.0 - Math.min(this.age / (this.life * 0.3), 1.0);
            this.drawOpacity = MAX_DRAW_OPACITY * 0.15 * ageFade;
        } else {
            // Blend aging rate: delta (0.20) -> river (0.20) for in-stream,
            // but transition zone strays age faster as they leave the delta
            let ageRate = 0.20;
            if (inTransition && !inStream) {
                ageRate = 0.20 + transitionT * 3.8; // blends toward 4.0
            }
            this.age += ageRate;

            let baseOpacity = Math.min(MAX_DRAW_OPACITY, cellWetness / 100);
            if (inDelta) {
                // Delta particles fade as they age without finding a stream
                let deltaAge = Math.min(this.age / (this.life * 0.5), 1.0);
                let deltaFade = 1.0 - deltaAge * 0.7;
                baseOpacity = Math.max(baseOpacity, MAX_DRAW_OPACITY * deltaFade);
            } else if (inTransition && !inStream) {
                // Transition zone: blend delta opacity boost toward zero
                let deltaAge = Math.min(this.age / (this.life * 0.5), 1.0);
                let deltaFade = 1.0 - deltaAge * 0.7;
                let deltaOpacity = MAX_DRAW_OPACITY * deltaFade;
                baseOpacity = Math.max(baseOpacity, deltaOpacity * (1.0 - transitionT));
            }
            this.drawOpacity = baseOpacity;
        }
        this.inDelta = inDelta || inTransition;

        // Reset if out of bounds or too old
        if (this.x < -50 || this.x > width + 50 || this.y > height + 50 || this.age > this.life) {
            this.reset();
        }
    }

    _resetCapillary() {
        // Filter to live tracked rivers with at least 1 origin
        let liveRivers = trackedRivers.filter(r => !r.dead && r.origins.length > 0);
        if (liveRivers.length < 2) { this._parkCapillary(); return; }
        for (let attempt = 0; attempt < 5; attempt++) {
            let river = liveRivers[Math.floor(Math.random() * liveRivers.length)];
            let origin = river.origins[Math.floor(Math.random() * river.origins.length)];
            let rivers = findRiversAtBand(origin.yRow);
            if (rivers.length < 2) continue;
            // Find the river closest to this tracked river's centerCol
            let bestDist = Infinity;
            let matchedRiver = rivers[0];
            for (let rv of rivers) {
                let d = Math.abs(rv.centerCol - river.centerCol);
                if (d < bestDist) { bestDist = d; matchedRiver = rv; }
            }
            let dir = Math.random() < 0.5 ? -1 : 1;
            let edgeCol = dir > 0 ? matchedRiver.rightCol + 1 : matchedRiver.leftCol - 1;
            this.x = edgeCol * GRID_SIZE + Math.random() * GRID_SIZE;
            this.y = origin.yPixel + (Math.random() - 0.5) * GRID_SIZE * 2;
            this.vx = 0;
            this.vy = 0;
            this.age = 0;
            this.capillaryDir = dir;
            this.capillaryRiverId = river.id;
            this.originRow = origin.yRow;
            this.spawnY = this.y;
            this.drawOpacity = 0;
            this.parked = false;
            this.parkTimer = 0;
            this.fadingOut = false;
            this.fadeTimer = 0;
            return;
        }
        this._parkCapillary();
    }

    _parkCapillary() {
        this.x = -200;
        this.y = -200;
        this.vx = 0;
        this.vy = 0;
        this.drawOpacity = 0;
        this.parked = true;
        this.parkTimer = 60;
    }

    _updateCapillary() {
        if (this.parked) {
            this.parkTimer--;
            if (this.parkTimer <= 0) this._resetCapillary();
            return;
        }

        this.age++;

        // Fade-out after reaching another stream
        if (this.fadingOut) {
            this.fadeTimer--;
            if (this.fadeTimer <= 0) { this._resetCapillary(); return; }
            this.drawOpacity = CAPILLARY_MAX_OPACITY * (this.fadeTimer / 15);
        }

        // FBM noise gradient for organic feel
        let n1 = fbm(this.x * NOISE_SCALE, this.y * NOISE_SCALE, zOff);
        let nx = fbm((this.x + NOISE_EPSILON) * NOISE_SCALE, this.y * NOISE_SCALE, zOff);
        let ny = fbm(this.x * NOISE_SCALE, (this.y + NOISE_EPSILON) * NOISE_SCALE, zOff);
        let dx = (nx - n1) / NOISE_EPSILON;
        let dy = (ny - n1) / NOISE_EPSILON;
        let forceX = -dx;
        let forceY = -dy;
        let gradLen = Math.sqrt(forceX * forceX + forceY * forceY) || 1;
        forceX /= gradLen;
        forceY /= gradLen;

        // Strong lateral bias
        forceX += this.capillaryDir * CAPILLARY_LATERAL_FORCE;

        // Pheromone following: scan +-5 cells in move direction
        let c = Math.floor(this.x / GRID_SIZE);
        let r = Math.floor(this.y / GRID_SIZE);
        if (c >= 0 && c < cols && r >= 0 && r < rows) {
            let idx = c + r * cols;

            // Deposit pheromone
            capillaryGrid[idx] += CAPILLARY_PHEROMONE_DEPOSIT;

            // Deposit wetness so capillaries show on the grid
            wetnessGrid[idx] += WETNESS_DEPOSIT * 0.3;

            // Follow pheromone
            let pheroX = 0;
            let pheroY = 0;
            let pheroTotal = 0;
            for (let s = 1; s <= 5; s++) {
                let invDist = 1.0 / s;
                // Horizontal scan in move direction
                let sc = c + this.capillaryDir * s;
                if (sc >= 0 && sc < cols) {
                    let pVal = capillaryGrid[sc + r * cols];
                    pheroX += this.capillaryDir * pVal * invDist;
                    pheroTotal += pVal;
                }
                // Vertical scan +-
                if (r - s >= 0) {
                    let pVal = capillaryGrid[c + (r - s) * cols];
                    pheroY -= pVal * invDist;
                    pheroTotal += pVal;
                }
                if (r + s < rows) {
                    let pVal = capillaryGrid[c + (r + s) * cols];
                    pheroY += pVal * invDist;
                    pheroTotal += pVal;
                }
            }
            if (pheroTotal > 0.1) {
                forceX += pheroX * CAPILLARY_PHEROMONE_ATTRACT;
                forceY += pheroY * CAPILLARY_PHEROMONE_ATTRACT;
            }

            // Capillary-capillary repulsion: push away from nearby pheromone vertically
            let repulseY = 0;
            for (let s = 1; s <= 8; s++) {
                let invDist = 1.0 / (s * s);
                let above = (r - s >= 0) ? capillaryGrid[c + (r - s) * cols] : 0;
                let below = (r + s < rows) ? capillaryGrid[c + (r + s) * cols] : 0;
                repulseY += (above - below) * invDist;
            }
            forceY -= repulseY * CAPILLARY_REPULSE_STRENGTH;

            // Arrival detection: reached another river below spawn point?
            if (!this.fadingOut && this.age > 30 && this.y > this.spawnY && wetnessGrid[idx] >= CAPILLARY_TARGET_WETNESS) {
                // Check we're not still near our origin river
                let distFromOrigin = Math.abs(r - this.originRow);
                if (distFromOrigin >= 3) {
                    this.fadingOut = true;
                    this.fadeTimer = 15;
                }
            }
        }

        // Vertical cohesion: gentle pull back toward origin row
        let targetY = this.originRow * GRID_SIZE;
        let yDiff = targetY - this.y;
        forceY += yDiff * 0.002;

        // Weak gravity
        forceY += CAPILLARY_GRAVITY;

        // Normalize force
        let fLen = Math.sqrt(forceX * forceX + forceY * forceY) || 1;
        forceX /= fLen;
        forceY /= fLen;

        this.vx += forceX * 0.3;
        this.vy += forceY * 0.3;

        // Friction
        this.vx *= FRICTION;
        this.vy *= FRICTION;

        // Clamp velocity
        let spd = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
        if (spd > 3.0) {
            this.vx = (this.vx / spd) * 3.0;
            this.vy = (this.vy / spd) * 3.0;
        }

        this.x += this.vx;
        this.y += this.vy;

        // Mouse pill displacement (same as main particles)
        if (mouse.active && mouse.middleDown && (mouse.frameDX !== 0 || mouse.frameDY !== 0)) {
            let halfLength = 90;
            let halfWidth = 10;
            let perpX = -mouse.dirY;
            let perpY = mouse.dirX;
            let mdx = this.x - mouse.x;
            let mdy = this.y - mouse.y;
            let alongLong = mdx * perpX + mdy * perpY;
            let clamped = Math.max(-halfLength, Math.min(halfLength, alongLong));
            let nearX = mouse.x + perpX * clamped;
            let nearY = mouse.y + perpY * clamped;
            let distX = this.x - nearX;
            let distY = this.y - nearY;
            let dist = Math.sqrt(distX * distX + distY * distY);
            if (dist < halfWidth) {
                let falloff = 1.0 - dist / halfWidth;
                this.x += mouse.frameDX * falloff;
                this.y += mouse.frameDY * falloff;
                this.vx += mouse.frameDX * falloff * 0.3;
                this.vy += mouse.frameDY * falloff * 0.3;
            }
        }

        // Out of bounds check
        if (this.x < -50 || this.x > width + 50 || this.y < -50 || this.y > height + 50) {
            this._resetCapillary();
            return;
        }

        // Opacity: quick fade-in, then hold (fade-out handled by fadingOut above)
        if (!this.fadingOut) {
            let fadeIn = Math.min(this.age / 20, 1.0);
            this.drawOpacity = CAPILLARY_MAX_OPACITY * fadeIn;
        }
    }

    draw() {
        if (this.drawOpacity <= MIN_DRAW_OPACITY) return;

        if (this.isCapillary && debugOverlay) {
            let cc = [255,255,255];
            for (let tr of trackedRivers) {
                if (tr.id === this.capillaryRiverId) { cc = tr.color; break; }
            }
            ctx.fillStyle = `rgba(${cc[0]}, ${cc[1]}, ${cc[2]}, ${this.drawOpacity})`;
        } else {
            ctx.fillStyle = `rgba(255, 255, 255, ${this.drawOpacity})`;
        }
        ctx.beginPath();
        let radius;
        if (this.isCapillary) {
            let fadeIn = Math.min(this.age / 20, 1.0);
            let fadeOut = this.fadingOut ? this.fadeTimer / 15 : 1.0;
            radius = CAPILLARY_MAX_RADIUS * fadeIn * fadeOut;
        } else {
            radius = this.weight * 1.5 * (Math.sin((this.age / this.life) * Math.PI));
            if (this.inDelta) radius = Math.max(radius, 1.5);
        }
        if (radius < 0.1) radius = 0.1;
        ctx.arc(this.x, this.y, radius, 0, Math.PI * 2);
        ctx.fill();
    }
}

const SOURCE_COUNT = Math.floor(NUM_PARTICLES * SOURCE_PARTICLE_FRACTION);
const CAPILLARY_COUNT = Math.floor(NUM_PARTICLES * CAPILLARY_FRACTION);
for (let i = 0; i < NUM_PARTICLES; i++) {
    let p = new Particle();
    if (i >= NUM_PARTICLES - CAPILLARY_COUNT) {
        p.isCapillary = true;
        p.isSource = false;
        p._parkCapillary();
    } else {
        p.isCapillary = false;
        p.isSource = i < SOURCE_COUNT;
    }
    particles.push(p);
}

function animate() {
    // Evaporate wetness grid and slowly decay erosion
    for (let k = 0; k < wetnessGrid.length; k++) {
        wetnessGrid[k] *= EVAPORATION_RATE;
        erosionGrid[k] *= EROSION_DECAY;
        capillaryGrid[k] *= CAPILLARY_PHEROMONE_EVAP;
    }

    // Dynamically track rivers and grow capillary origins
    updateTrackedRivers();

    // Instead of using fillRect with a very low opacity (which gets stuck  
    // before true black due to browser 8-bit color rounding), we manually 
    // decrement the pixel values directly to ensure trails persist for a long time
    // but ALWAYS steadily reach true black eventually.

    // We only do the expensive pixel fade every other frame to improve performance
    // and double the persistence time of the trails naturally.
    if (zOff * 10000 % 2 < 1) { // roughly every other frame
        let imgData = ctx.getImageData(0, 0, width, height);
        let data = imgData.data;
        for (let j = 0; j < data.length; j += 4) {
            // "Hold then quickly fade" effect:
            // If the pixel is mostly white, fade extremely slowly (hold for a long time).
            // Once it drops below a threshold, fade out much faster.
            let r = data[j];
            if (r > 0) {
                let fadeAmount = (r > FADE_HOLD_THRESHOLD) ? FADE_SLOW_AMOUNT : FADE_FAST_AMOUNT;
                data[j] -= fadeAmount;
                data[j + 1] -= fadeAmount;
                data[j + 2] -= fadeAmount;
            }
        }
        ctx.putImageData(imgData, 0, 0);

        // Subtle blur pass to soften accumulated trail edges
        ctx.save();
        ctx.filter = 'blur(0.8px)';
        ctx.globalAlpha = 0.6;
        ctx.drawImage(canvas, 0, 0);
        ctx.restore();
    }

    for (let i = 0; i < particles.length; i++) {
        particles[i].update();
        particles[i].draw();
    }

    // Smoothly interpolate pill direction toward target
    let lerpRate = 0.1;
    mouse.dirX += (mouse.targetDirX - mouse.dirX) * lerpRate;
    mouse.dirY += (mouse.targetDirY - mouse.dirY) * lerpRate;
    let dirLen = Math.sqrt(mouse.dirX * mouse.dirX + mouse.dirY * mouse.dirY) || 1;
    mouse.dirX /= dirLen;
    mouse.dirY /= dirLen;

    // Reset per-frame mouse displacement accumulators (after particles have read them)
    mouse.frameDX = 0;
    mouse.frameDY = 0;

    // Draw burst charge preview
    if (burst.charging) {
        let elapsed = performance.now() - burst.startTime;
        let t = Math.min(elapsed / BURST_CHARGE_TIME, 1.0);
        let radius = BURST_MIN_RADIUS + (BURST_MAX_RADIUS - BURST_MIN_RADIUS) * t;
        ctx.save();
        ctx.beginPath();
        ctx.arc(burst.x, burst.y, radius, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255, 255, 255, ${0.15 + t * 0.25})`;
        ctx.lineWidth = 1;
        ctx.stroke();
        // Subtle fill
        ctx.fillStyle = `rgba(255, 255, 255, ${0.02 + t * 0.04})`;
        ctx.fill();
        ctx.restore();
    }

    // Debug overlay: dotted lines at vertical region boundaries (drawn on separate canvas)
    overlayCtx.clearRect(0, 0, width, height);
    if (debugOverlay) {
        overlayCtx.save();
        overlayCtx.setLineDash([8, 6]);
        overlayCtx.lineWidth = 1;
        overlayCtx.font = '12px monospace';
        overlayCtx.textBaseline = 'top';

        const regions = [
            { y: 0,              label: 'Spawn boundary (y=0)',        color: '#ff4444' },
            { y: height * 0.10,  label: 'Convergence ramp end (10%)',  color: '#ffaa00' },
            { y: height * DELTA_ZONE_END,      label: `Delta zone end (${DELTA_ZONE_END * 100}%)`,      color: '#44ff44' },
            { y: height * TRANSITION_ZONE_END, label: `Transition zone end (${TRANSITION_ZONE_END * 100}%)`, color: '#4488ff' },
        ];

        for (const r of regions) {
            overlayCtx.strokeStyle = r.color;
            overlayCtx.fillStyle = r.color;
            overlayCtx.beginPath();
            overlayCtx.moveTo(0, r.y);
            overlayCtx.lineTo(width, r.y);
            overlayCtx.stroke();
            overlayCtx.fillText(r.label, 8, r.y + 4);
        }

        // Draw mouse push pill
        if (mouse.active) {
            let halfLength = 90;
            let halfWidth = 10;
            let perpX = -mouse.dirY;
            let perpY = mouse.dirX;
            // Draw pill shape: two semicircles connected by lines
            overlayCtx.setLineDash(mouse.middleDown ? [] : [4, 4]);
            overlayCtx.strokeStyle = mouse.middleDown ? 'rgba(255, 100, 100, 0.9)' : 'rgba(255, 100, 100, 0.6)';
            overlayCtx.lineWidth = 1;
            // Endpoints of the center line segment
            let ax = mouse.x + perpX * halfLength;
            let ay = mouse.y + perpY * halfLength;
            let bx = mouse.x - perpX * halfLength;
            let by = mouse.y - perpY * halfLength;
            // Angle of the perpendicular axis
            let angle = Math.atan2(perpY, perpX);
            overlayCtx.beginPath();
            overlayCtx.arc(ax, ay, halfWidth, angle - Math.PI / 2, angle + Math.PI / 2);
            overlayCtx.arc(bx, by, halfWidth, angle + Math.PI / 2, angle + Math.PI / 2 + Math.PI);
            overlayCtx.closePath();
            overlayCtx.stroke();
            overlayCtx.fillStyle = 'rgba(255, 100, 100, 0.05)';
            overlayCtx.fill();
            overlayCtx.fillStyle = '#ff6464';
            overlayCtx.fillText('Push pill (100x20)', mouse.x + halfLength + 15, mouse.y - 5);
        }

        // Detection line
        let detectionY = CAPILLARY_ORIGIN_START * height;
        overlayCtx.setLineDash([]);
        overlayCtx.strokeStyle = '#ff8800';
        overlayCtx.lineWidth = 2;
        overlayCtx.beginPath();
        overlayCtx.moveTo(0, detectionY);
        overlayCtx.lineTo(width, detectionY);
        overlayCtx.stroke();
        overlayCtx.fillStyle = '#ff8800';
        overlayCtx.fillText(`River detection line (${(CAPILLARY_ORIGIN_START * 100).toFixed(0)}%)`, 8, detectionY - 8);

        // Capillary origin markers (per tracked river)
        for (let tr of trackedRivers) {
            if (tr.dead) continue;
            let c = tr.color;
            let colorStr = `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
            overlayCtx.strokeStyle = colorStr;
            overlayCtx.setLineDash([]);
            overlayCtx.lineWidth = 1;
            for (let origin of tr.origins) {
                let rivers = findRiversAtBand(origin.yRow);
                for (let rv of rivers) {
                    if (Math.abs(rv.centerCol - tr.centerCol) < RIVER_MATCH_TOLERANCE) {
                        let cx = rv.centerCol * GRID_SIZE;
                        overlayCtx.beginPath();
                        overlayCtx.arc(cx, origin.yPixel, 8, 0, Math.PI * 2);
                        overlayCtx.stroke();
                    }
                }
            }
            // Label the river at its centerCol on the detection line
            overlayCtx.fillStyle = colorStr;
            overlayCtx.fillText(`R${tr.id}`, tr.centerCol * GRID_SIZE - 5, detectionY + 14);
        }

        overlayCtx.restore();
    }

    // Slowly evolve the noise for shifting rivers
    zOff += NOISE_EVOLUTION_SPEED;

    requestAnimationFrame(animate);
}

canvas.addEventListener('mousemove', (e) => {
    let dx = e.clientX - mouse.x;
    let dy = e.clientY - mouse.y;
    mouse.frameDX += dx;
    mouse.frameDY += dy;
    // Update target direction when mouse is moving
    let len = Math.sqrt(dx * dx + dy * dy);
    if (len > 1) {
        mouse.targetDirX = dx / len;
        mouse.targetDirY = dy / len;
    }
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    mouse.active = true;
});

canvas.addEventListener('mouseleave', () => {
    mouse.active = false;
    mouse.middleDown = false;
});

// Prevent default middle-click auto-scroll
canvas.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });

canvas.addEventListener('mousedown', (e) => {
    if (e.button === 1) { mouse.middleDown = true; e.preventDefault(); return; }
    if (e.button !== 0) return;
    burst.charging = true;
    burst.x = e.clientX;
    burst.y = e.clientY;
    burst.startTime = performance.now();
});

canvas.addEventListener('mouseup', (e) => {
    if (e.button === 1) { mouse.middleDown = false; return; }
    if (!burst.charging) return;
    burst.charging = false;
    let elapsed = performance.now() - burst.startTime;
    let t = Math.min(elapsed / BURST_CHARGE_TIME, 1.0);
    let radius = BURST_MIN_RADIUS + (BURST_MAX_RADIUS - BURST_MIN_RADIUS) * t;
    let count = Math.floor(BURST_COUNT + (BURST_COUNT * 4) * t); // 200 to 1000
    for (let i = 0; i < count; i++) {
        let p = new Particle();
        let angle = Math.random() * Math.PI * 2;
        let r = Math.random() * radius;
        p.x = burst.x + Math.cos(angle) * r;
        p.y = burst.y + Math.sin(angle) * r;
        p.isSource = false;
        particles.push(p);
    }
});

window.addEventListener('keydown', (e) => {
    if (e.key === 'd' || e.key === 'D') debugOverlay = !debugOverlay;
});

animate();
