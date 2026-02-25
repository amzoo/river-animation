const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const overlayCanvas = document.getElementById('overlay');
const overlayCtx = overlayCanvas.getContext('2d');

let width, height;
let particles = [];
let sourcePoints = [];
let debugOverlay = false; // Toggle with 'D' key
let wetnessOverlay = false; // Toggle with 'W' key
let erosionOverlay = false; // Toggle with 'E' key
let particleStatsOverlay = false; // Toggle with 'P' key
let transparentParticles = false; // Toggle with 'T' key
let sourceColorParticles = false; // Toggle with 'C' key
let riverSampleMode = false;       // toggled by 'R' key
let riverSampleRect = null;        // {x, y, w, h} in pixels — the selected rectangle
let riverSampleDragging = false;   // true while mouse is held down to size the rect
let riverSampleStart = null;       // {x, y} — mouse position at drag start
let riverSampleStats = null;       // computed stats object, displayed on overlay
// ==========================================
// CONFIGURATION & TUNING VARIABLES
// ==========================================

// --- Overall Simulation ---
// Number of particles spawned in the simulation
const NUM_PARTICLES = 20000;
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
const FADE_FAST_AMOUNT = 6;

// --- Capillary Ants ---
const CAPILLARY_DIVERT_RADIUS = 20;
const CAPILLARY_DIVERT_FRACTION = 0.15;
const CAPILLARY_LATERAL_FORCE = 1.2;
const CAPILLARY_GRAVITY = 0.4;
const CAPILLARY_MAX_OPACITY = 0.8;
const CAPILLARY_MAX_RADIUS = 1.4;
const CAPILLARY_WIGGLE_STRENGTH = 0.08;

// --- Capillary Wetness/Erosion (isolated grids) ---
const CAP_WETNESS_DEPOSIT    = 0.15;
const CAP_EROSION_DEPOSIT    = 0.03;
const CAP_EROSION_MAX        = 15.0;
const CAP_EVAPORATION_RATE   = 0.985;
const CAP_EROSION_DECAY      = 0.999;
const CAP_SCAN_RADIUS        = 20;
const CAP_EROSION_SPREAD     = 0.2;
const CAP_ATTRACT_SCALE      = 0.15;

// --- Zone Boundaries ---
const DELTA_ZONE_END = 0.30;
const TRANSITION_ZONE_END = 0.40;
const RIVER_CELL_SIZE = 3;

// --- River gap detection (particle-level repulsion) ---
const RIVER_GAP_THRESHOLD = 2.0;    // wetness below this = dry gap
const RIVER_GAP_MIN_WIDTH = 3;      // consecutive dry cells to count as a gap
const RIVER_REPULSE_STRENGTH = 0.4;  // multiplier for cross-gap repulsion

// ==========================================

let lastFrameTime = performance.now();
let smoothFPS = 60;
let simSpeed = 1;

let mouse = { x: 0, y: 0, prevX: 0, prevY: 0, frameDX: 0, frameDY: 0, dirX: 0, dirY: 1, targetDirX: 0, targetDirY: 1, speed: 0, active: false, middleDown: false, lastTime: 0 };
let burst = { charging: false, x: 0, y: 0, startTime: 0 };
const BURST_MIN_RADIUS = 50;
const BURST_MAX_RADIUS = 300;
const BURST_CHARGE_TIME = 2000; // ms to reach max size

let zOff = 0;
let cols, rows;
let wetnessGrid;
let erosionGrid;
let capWetnessGrid;
let capErosionGrid;
let capOwnerGrid;
let capOwnerStr;
let capFadeMask;
let riverGrid = null;           // Uint8Array, flat [row * riverGridCols + col] → 1 if bright
let riverLabels = null;         // Int32Array, flat → component ID (0 = inactive)
let riverGridCols = 0;
let riverGridRows = 0;
let numRiverComponents = 0;
let riverComponentColors = [];  // per-component color index, stable across frames
let capillaryHeights = [];  // Array of {y, sourceIdx} — computed once in resize()
let capillaryOrigins = [];  // Array of {x, y, sourceIdx} — x updated each river frame
let prevCapillaryOriginKeys = new Set();  // origin identity keys from previous frame

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
    capWetnessGrid = new Float32Array(cols * rows);
    capErosionGrid = new Float32Array(cols * rows);
    capOwnerGrid = new Int8Array(cols * rows);
    capOwnerStr  = new Float32Array(cols * rows);
    capFadeMask  = new Uint8Array(cols * rows);

    // River detection grid covering transition zone to bottom of canvas
    let rzYStart = Math.floor(height * TRANSITION_ZONE_END);
    riverGridCols = Math.ceil(width / RIVER_CELL_SIZE);
    riverGridRows = Math.ceil((height - rzYStart) / RIVER_CELL_SIZE);
    riverGrid = new Uint8Array(riverGridCols * riverGridRows);
    riverLabels = new Int32Array(riverGridCols * riverGridRows);

    // Generate fixed source points across the top edge (only on first load)
    if (sourcePoints.length === 0) {
        const NUM_SOURCES = 6;
        const margin = width * 0.1;
        const spacing = (width - 2 * margin) / (NUM_SOURCES - 1);
        for (let i = 0; i < NUM_SOURCES; i++) {
            sourcePoints.push(margin + i * spacing);
        }
    }

    // Generate fixed capillary origin heights for each source
    capillaryHeights = [];
    for (let s = 0; s < sourcePoints.length; s++) {
        let startY = height * (TRANSITION_ZONE_END + (s % 2 === 0 ? 0.10 : 0.05));
        let y = startY;
        while (y < height) {
            capillaryHeights.push({ y: y, sourceIdx: s });
            y += height * (0.20 + Math.random() * 0.10);
        }
    }

    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, width, height);
}

window.addEventListener('resize', resize);
resize();

const RIVER_COLORS = [
    [253,189,165],  // Coral
    [130,253,209],  // Mint
    [32,128,208],   // Blue
    [191,157,220],  // Lilac
    [45,187,105],   // Green
    [160,216,255],  // Light Blue (original 226,242,255)
    [200,255,232],  // Light Mint (original 235,255,248)
];
const RIVER_BRIGHTNESS_THRESHOLD = 64; // min pixel brightness (0-255) for debug analysis
const RIVER_WETNESS_THRESHOLD = 5.0; // min wetness value to count as river

class Particle {
    constructor() {
        this.reset();
        // Spread initial particles vertically so they don't all bunch at the top
        this.y = -Math.random() * height * DELTA_ZONE_END;
    }

    reset() {
        // Spawn from a random fixed source point with wide delta spread
        const srcI = Math.floor(Math.random() * sourcePoints.length);
        const src = sourcePoints[srcI];
        this.sourceIdx = srcI;
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
                const SCAN_RADIUS = 40;
                let attractLeft = 0, attractRight = 0;
                let repulseLeft = 0, repulseRight = 0;
                let inPostTransition = this.y >= height * TRANSITION_ZONE_END;

                // Scan left
                let gapCount = 0, crossedGap = false;
                for (let s = 1; s <= SCAN_RADIUS; s++) {
                    if (c - s < 0) break;
                    let w = wetnessGrid[idx - s] + erosionGrid[idx - s] * 3;
                    let distFalloff = 1.0 / (s * s);
                    if (inPostTransition) {
                        if (w < RIVER_GAP_THRESHOLD) {
                            gapCount++;
                            if (gapCount >= RIVER_GAP_MIN_WIDTH) crossedGap = true;
                        } else {
                            gapCount = 0;
                        }
                        if (crossedGap) {
                            repulseLeft += w * distFalloff;
                        } else {
                            attractLeft += w * distFalloff;
                        }
                    } else {
                        attractLeft += w * distFalloff;
                    }
                }

                // Scan right
                gapCount = 0; crossedGap = false;
                for (let s = 1; s <= SCAN_RADIUS; s++) {
                    if (c + s >= cols) break;
                    let w = wetnessGrid[idx + s] + erosionGrid[idx + s] * 3;
                    let distFalloff = 1.0 / (s * s);
                    if (inPostTransition) {
                        if (w < RIVER_GAP_THRESHOLD) {
                            gapCount++;
                            if (gapCount >= RIVER_GAP_MIN_WIDTH) crossedGap = true;
                        } else {
                            gapCount = 0;
                        }
                        if (crossedGap) {
                            repulseRight += w * distFalloff;
                        } else {
                            attractRight += w * distFalloff;
                        }
                    } else {
                        attractRight += w * distFalloff;
                    }
                }

                // Attract toward own river, repulse from other rivers across gaps
                let pullX = (attractRight - attractLeft);
                let repulseX = (repulseLeft - repulseRight) * RIVER_REPULSE_STRENGTH;
                let netX = pullX + repulseX;

                let pullAbs = Math.abs(netX);
                if (pullAbs > 0.01) {
                    let sign = netX > 0 ? 1 : -1;
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

        // Capillary diversion: non-source river particles near a capillary origin
        // may fork off into capillary mode
        if (!this.isSource) {
            for (let o of capillaryOrigins) {
                let cdx = this.x - o.x;
                let cdy = this.y - o.y;
                let dist2 = cdx * cdx + cdy * cdy;
                if (dist2 < CAPILLARY_DIVERT_RADIUS * CAPILLARY_DIVERT_RADIUS) {
                    if (Math.random() < CAPILLARY_DIVERT_FRACTION) {
                        this.isCapillary = true;
                        this.capillaryDir = o.leftOk && !o.rightOk ? -1 : (!o.leftOk && o.rightOk ? 1 : (Math.random() < 0.5 ? -1 : 1));
                        this.streamId = o.sourceIdx * 2 + (this.capillaryDir > 0 ? 1 : 0) + 1;
                        this.capillaryOriginY = o.y;
                        this.sourceIdx = o.sourceIdx;
                        this.age = 0;
                        this.capillaryWiggleSeed = Math.random() * Math.PI * 2;
                        this.capillaryWiggleFreq = 0.04 + Math.random() * 0.06;
                        this.drawOpacity = CAPILLARY_MAX_OPACITY;
                        return;
                    }
                    break;
                }
            }
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
            this.age += 2; // Small stray strands dry up / get absorbed rapidly
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

    _revertToRiver() {
        this.isCapillary = false;
        this.reset();
    }

    _updateCapillary() {
        this.age++;

        // Varicose wiggle: sinusoidal oscillation orthogonal to travel direction
        let wiggle = Math.sin(this.x * this.capillaryWiggleFreq + this.capillaryWiggleSeed) * CAPILLARY_WIGGLE_STRENGTH;
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

        // Strong lateral force
        this.vx += this.capillaryDir * CAPILLARY_LATERAL_FORCE * 0.4;

        // Gentle gravity
        this.vy += CAPILLARY_GRAVITY;

        // Capillary wetness/erosion feedback (isolated grids)
        let c = Math.floor(this.x / GRID_SIZE);
        let r = Math.floor(this.y / GRID_SIZE);
        if (c >= 0 && c < cols && r >= 0 && r < rows) {
            let idx = c + r * cols;

            // Deposit into capillary-specific grids
            capWetnessGrid[idx] += CAP_WETNESS_DEPOSIT;
            if (capErosionGrid[idx] < CAP_EROSION_MAX) {
                capErosionGrid[idx] += CAP_EROSION_DEPOSIT;
            }

            // Update ownership grid
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

            // Directional channel scan: look ahead in capillaryDir, steer vertically
            let pullY = 0;
            let dir = this.capillaryDir > 0 ? 1 : -1;
            for (let s = 1; s <= CAP_SCAN_RADIUS; s++) {
                let sc = c + dir * s;
                if (sc < 0 || sc >= cols) break;
                for (let dr = -2; dr <= 2; dr++) {
                    let sr = r + dr;
                    if (sr < 0 || sr >= rows) continue;
                    let scanIdx = sc + sr * cols;
                    let w = capWetnessGrid[scanIdx] + capErosionGrid[scanIdx] * 3;
                    if (w > 0.1) {
                        let owner = capOwnerGrid[scanIdx];
                        if (owner === 0 || owner === this.streamId) {
                            pullY += dr * w * CAP_ATTRACT_SCALE / (s * s);
                        }
                    }
                }
            }
            this.vy += pullY;

            // Erosion-based lateral spread
            let erosionSpread = cellCapErosion * CAP_EROSION_SPREAD;
            this.vx += (Math.random() - 0.5) * erosionSpread;
        }

        // Friction and velocity clamping
        this.vx *= 0.94;
        this.vy *= 0.94;
        let spd = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
        if (spd > 3.0) {
            this.vx = (this.vx / spd) * 3.0;
            this.vy = (this.vy / spd) * 3.0;
        }

        this.x += this.vx;
        this.y += this.vy;

        // Mouse pill displacement
        if (mouse.active && mouse.middleDown && (mouse.frameDX !== 0 || mouse.frameDY !== 0)) {
            let mdx = this.x - mouse.x;
            let mdy = this.y - mouse.y;
            let dist = Math.sqrt(mdx * mdx + mdy * mdy);
            if (dist < 20) {
                let falloff = 1.0 - dist / 20;
                this.x += mouse.frameDX * falloff;
                this.y += mouse.frameDY * falloff;
            }
        }

        // Opacity: fade in over first 20 frames
        let fadeIn = Math.min(this.age / 20, 1.0);
        this.drawOpacity = CAPILLARY_MAX_OPACITY * fadeIn;

        // River absorption: revert to river particle on contact
        {
            let rzYStart = Math.floor(height * TRANSITION_ZONE_END);
            let rr = Math.floor((this.y - rzYStart) / RIVER_CELL_SIZE);
            let rc = Math.floor(this.x / RIVER_CELL_SIZE);
            if (rr >= 0 && rr < riverGridRows && rc >= 0 && rc < riverGridCols) {
                let lbl = riverLabels[rr * riverGridCols + rc];
                if (lbl > 0) {
                    this._revertToRiver();
                    return;
                }
            }
        }

        // OOB check — revert to river
        if (this.x < -50 || this.x > width + 50 || this.y < -50 || this.y > height + 50) {
            this._revertToRiver();
        }
    }

    draw() {
        if (this.drawOpacity <= MIN_DRAW_OPACITY) return;

        if (this.isCapillary) {
            let opacity = transparentParticles ? this.drawOpacity * 0.1 : this.drawOpacity;
            if (debugOverlay) {
                let clrD = RIVER_COLORS[this.sourceIdx % RIVER_COLORS.length];
                ctx.fillStyle = `rgb(${clrD[0]}, ${clrD[1]}, ${clrD[2]})`;
            } else if (sourceColorParticles) {
                let clr = RIVER_COLORS[this.sourceIdx % RIVER_COLORS.length];
                ctx.fillStyle = `rgba(${clr[0]}, ${clr[1]}, ${clr[2]}, ${opacity})`;
            } else {
                ctx.fillStyle = `rgba(255, 255, 255, ${opacity})`;
            }
            ctx.beginPath();
            let c = Math.floor(this.x / GRID_SIZE);
            let r = Math.floor(this.y / GRID_SIZE);
            let capW = 0;
            if (c >= 0 && c < cols && r >= 0 && r < rows) {
                capW = capWetnessGrid[c + r * cols];
            }
            let thickness = Math.min(capW / 6.0, 1.0);
            let radius = 0.8 + thickness * (CAPILLARY_MAX_RADIUS - 0.8);
            if (radius < 0.1) radius = 0.1;
            ctx.arc(this.x, this.y, radius, 0, Math.PI * 2);
            ctx.fill();
            return;
        }

        let opacity = transparentParticles ? this.drawOpacity * 0.1 : this.drawOpacity;
        if (sourceColorParticles) {
            let clr = RIVER_COLORS[this.sourceIdx % RIVER_COLORS.length];
            ctx.fillStyle = `rgba(${clr[0]}, ${clr[1]}, ${clr[2]}, ${opacity})`;
        } else {
            ctx.fillStyle = `rgba(255, 255, 255, ${opacity})`;
        }
        ctx.beginPath();
        let radius = this.weight * 1.5 * (Math.sin((this.age / this.life) * Math.PI));
        if (this.inDelta) radius = Math.max(radius, 1.5);
        if (radius < 0.1) radius = 0.1;
        ctx.arc(this.x, this.y, radius, 0, Math.PI * 2);
        ctx.fill();
    }
}

const SOURCE_COUNT = Math.floor(NUM_PARTICLES * SOURCE_PARTICLE_FRACTION);
for (let i = 0; i < NUM_PARTICLES; i++) {
    let p = new Particle();
    p.isCapillary = false;
    p.isSource = i < SOURCE_COUNT;
    particles.push(p);
}

function computeRiverSampleStats(rect) {
    let x = Math.max(0, Math.floor(rect.x));
    let y = Math.max(0, Math.floor(rect.y));
    let w = Math.min(Math.floor(rect.w), width - x);
    let h = Math.min(Math.floor(rect.h), height - y);
    if (w <= 0 || h <= 0) return null;

    let imageData = ctx.getImageData(x, y, w, h);
    let data = imageData.data;
    let pixelCount = w * h;

    let rVals = new Uint8Array(pixelCount);
    let gVals = new Uint8Array(pixelCount);
    let bVals = new Uint8Array(pixelCount);
    let brightVals = new Uint8Array(pixelCount);

    let rSum = 0, gSum = 0, bSum = 0;
    let rMin = 255, gMin = 255, bMin = 255;
    let rMax = 0, gMax = 0, bMax = 0;

    for (let i = 0; i < pixelCount; i++) {
        let ri = data[i * 4], gi = data[i * 4 + 1], bi = data[i * 4 + 2];
        rVals[i] = ri; gVals[i] = gi; bVals[i] = bi;
        brightVals[i] = Math.max(ri, gi, bi);
        rSum += ri; gSum += gi; bSum += bi;
        if (ri < rMin) rMin = ri; if (ri > rMax) rMax = ri;
        if (gi < gMin) gMin = gi; if (gi > gMax) gMax = gi;
        if (bi < bMin) bMin = bi; if (bi > bMax) bMax = bi;
    }

    let sorted = (arr) => { let a = Array.from(arr); a.sort((x, y) => x - y); return a; };
    let median = (arr) => { let s = sorted(arr); let m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

    let buckets = [0, 0, 0, 0, 0]; // 0, 1-15, 16-50, 51-128, 129-255
    let aboveThreshold = 0;
    for (let i = 0; i < pixelCount; i++) {
        let b = brightVals[i];
        if (b === 0) buckets[0]++;
        else if (b <= 15) buckets[1]++;
        else if (b <= 50) buckets[2]++;
        else if (b <= 128) buckets[3]++;
        else buckets[4]++;
        if (b >= RIVER_BRIGHTNESS_THRESHOLD) aboveThreshold++;
    }

    let col0 = Math.floor(x / GRID_SIZE);
    let col1 = Math.floor((x + w) / GRID_SIZE);
    let row0 = Math.floor(y / GRID_SIZE);
    let row1 = Math.floor((y + h) / GRID_SIZE);

    // Per-column average red brightness for river detection
    let colCount = col1 - col0 + 1;
    let colAvgs = new Float32Array(colCount);
    for (let c = 0; c < colCount; c++) {
        let xStart = (col0 + c) * GRID_SIZE - x;
        let xEnd = Math.min(xStart + GRID_SIZE, w);
        xStart = Math.max(0, xStart);
        let sum = 0, cnt = 0;
        for (let py = 0; py < h; py++) {
            let rowOff = py * w * 4;
            for (let px = xStart; px < xEnd; px++) {
                sum += data[rowOff + px * 4]; // red channel
                cnt++;
            }
        }
        colAvgs[c] = cnt > 0 ? sum / cnt : 0;
    }
    // Find runs of columns above threshold
    let detectedRuns = [];
    let inDetRun = false, detRunStart = 0;
    for (let c = 0; c < colCount; c++) {
        if (colAvgs[c] >= RIVER_BRIGHTNESS_THRESHOLD) {
            if (!inDetRun) { inDetRun = true; detRunStart = c; }
        } else {
            if (inDetRun) { detectedRuns.push({ left: detRunStart, right: c - 1 }); inDetRun = false; }
        }
    }
    if (inDetRun) detectedRuns.push({ left: detRunStart, right: colCount - 1 });
    // Merge runs with < 3 cell gap
    let mergedRuns = [];
    for (let r of detectedRuns) {
        if (mergedRuns.length > 0 && r.left - mergedRuns[mergedRuns.length - 1].right < 3) {
            mergedRuns[mergedRuns.length - 1].right = r.right;
        } else {
            mergedRuns.push({ ...r });
        }
    }
    mergedRuns = mergedRuns.filter(r => (r.right - r.left + 1) >= 3);
    let passingCols = 0;
    for (let c = 0; c < colCount; c++) if (colAvgs[c] >= RIVER_BRIGHTNESS_THRESHOLD) passingCols++;

    return {
        x, y, w, h,
        col0, col1, row0, row1,
        pixelCount,
        r: { min: rMin, max: rMax, mean: (rSum / pixelCount).toFixed(1), median: median(rVals) },
        g: { min: gMin, max: gMax, mean: (gSum / pixelCount).toFixed(1), median: median(gVals) },
        b: { min: bMin, max: bMax, mean: (bSum / pixelCount).toFixed(1), median: median(bVals) },
        buckets,
        aboveThreshold,
        threshold: RIVER_BRIGHTNESS_THRESHOLD,
        colCount,
        passingCols,
        riverRuns: mergedRuns
    };
}

let riverGridFrame = 0;
function updateRiverGrid() {
    riverGridFrame++;
    if (riverGridFrame % 3 !== 0) return; // throttle to every 3rd frame

    let rzYStart = Math.floor(height * TRANSITION_ZONE_END);
    let zoneH = height - rzYStart;
    if (zoneH <= 0 || riverGridCols === 0 || riverGridRows === 0) return;

    // Downsample wetness grid directly instead of reading back pixels
    riverGrid.fill(0);
    for (let r = 0; r < riverGridRows; r++) {
        let pyStart = rzYStart + r * RIVER_CELL_SIZE;
        let pyEnd = Math.min(pyStart + RIVER_CELL_SIZE, height);
        let wRowStart = Math.floor(pyStart / GRID_SIZE);
        let wRowEnd = Math.min(Math.ceil(pyEnd / GRID_SIZE), rows);
        for (let c = 0; c < riverGridCols; c++) {
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
            if (maxW >= RIVER_WETNESS_THRESHOLD) {
                riverGrid[r * riverGridCols + c] = 1;
            }
        }
    }

    // Row-by-row top-down label propagation
    // Rivers that merge keep distinct colors above the merge point;
    // below the merge, cells take the label of the largest (most cells) parent.
    riverLabels.fill(0);
    let label = 0;
    let labelMinRow = [0]; // 1-indexed: labelMinRow[lbl] = row where lbl first appeared
    let labelSize = [0];   // 1-indexed: labelSize[lbl] = number of cells assigned to lbl

    for (let r = 0; r < riverGridRows; r++) {
        // Find runs of contiguous active cells in this row
        let runs = [];
        let inRun = false, runStart = 0;
        for (let c = 0; c <= riverGridCols; c++) {
            let active = c < riverGridCols && riverGrid[r * riverGridCols + c] === 1;
            if (active && !inRun) { inRun = true; runStart = c; }
            if (!active && inRun) { runs.push([runStart, c - 1]); inRun = false; }
        }

        for (let [startC, endC] of runs) {
            // Collect labels from the row above (8-connected: check cols startC-1..endC+1)
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
                // Merge: pick the lowest label number (deterministic, stable across frames)
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

    // Compute per-component properties: minRow, centroid col, cell set
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

    // Filter out small components (fewer than 20 cells)
    const MIN_RIVER_CELLS = 100;
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

    // Count particles per source per component
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

    // Assign color from majority sourceIdx
    riverComponentColors = new Array(label).fill(-1);
    for (let i = 0; i < label; i++) {
        let counts = compSourceCounts[i];
        let bestSrc = -1, bestCnt = 0;
        for (let s in counts) {
            if (counts[s] > bestCnt) { bestCnt = counts[s]; bestSrc = +s; }
        }
        if (bestSrc >= 0) riverComponentColors[i] = bestSrc;
    }
    // Fallback for components with no particles
    for (let i = 0; i < label; i++) {
        if (riverComponentColors[i] === -1) riverComponentColors[i] = 0;
    }

    // Update capillary origin x-positions from active river components
    capillaryOrigins = [];

    // Collect which component each sourceIdx belongs to
    let sourceToComp = new Array(sourcePoints.length).fill(-1);
    let sourceToCompSize = new Array(sourcePoints.length).fill(0);
    for (let i = 0; i < label; i++) {
        let majorSrc = riverComponentColors[i];
        if (majorSrc >= 0 && comps[i].count > sourceToCompSize[majorSrc]) {
            sourceToComp[majorSrc] = i;
            sourceToCompSize[majorSrc] = comps[i].count;
        }
    }

    // Build per-source row centroid lookups
    let rzYStart_px = Math.floor(height * TRANSITION_ZONE_END);
    let sourceCentroids = new Array(sourcePoints.length).fill(null);
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

    // Map pre-computed heights to current x-positions
    for (let h of capillaryHeights) {
        let centroids = sourceCentroids[h.sourceIdx];
        if (!centroids) continue;
        let r = Math.floor((h.y - rzYStart_px) / RIVER_CELL_SIZE);
        if (r >= 0 && r < riverGridRows && centroids[r] !== undefined) {
            let s = h.sourceIdx;
            let leftOk = s > 0 && sourceToComp[s - 1] !== -1;
            let rightOk = s < sourcePoints.length - 1 && sourceToComp[s + 1] !== -1;
            if (!leftOk && !rightOk) continue;
            capillaryOrigins.push({ x: centroids[r], y: h.y, sourceIdx: s, leftOk, rightOk });
        }
    }

    // Detect disappeared origins and clear their capillary wetness/erosion bands
    let currentKeys = new Set();
    for (let o of capillaryOrigins) {
        currentKeys.add(o.sourceIdx * 100000 + Math.round(o.y));
    }
    for (let key of prevCapillaryOriginKeys) {
        if (!currentKeys.has(key)) {
            // This origin disappeared — mark its grid band for accelerated fade
            let originY = key % 100000;
            let rCenter = Math.floor(originY / GRID_SIZE);
            let rMin = Math.max(0, rCenter - 20);
            let rMax = Math.min(rows - 1, rCenter + 20);
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

function animate() {
    let now = performance.now();
    let dt = now - lastFrameTime;
    lastFrameTime = now;
    if (dt > 0) smoothFPS = smoothFPS * 0.95 + (1000 / dt) * 0.05;

    for (let tick = 0; tick < simSpeed; tick++) {
        // Evaporate wetness grid and slowly decay erosion
        for (let k = 0; k < wetnessGrid.length; k++) {
            wetnessGrid[k] *= EVAPORATION_RATE;
            erosionGrid[k] *= EROSION_DECAY;
            if (capFadeMask[k]) {
                // Accelerated decay for disappeared origins
                capWetnessGrid[k] *= 0.90;
                capErosionGrid[k] *= 0.95;
                capOwnerStr[k] *= 0.90;
                if (capWetnessGrid[k] < 0.01 && capErosionGrid[k] < 0.01) {
                    capFadeMask[k] = 0;
                    capOwnerGrid[k] = 0;
                    capOwnerStr[k] = 0;
                }
            } else {
                capWetnessGrid[k] *= CAP_EVAPORATION_RATE;
                capErosionGrid[k] *= CAP_EROSION_DECAY;
                capOwnerStr[k] *= CAP_EVAPORATION_RATE;
            }
            if (capOwnerStr[k] < 0.01) { capOwnerGrid[k] = 0; capOwnerStr[k] = 0; }
        }

        // Grid-based river detection (transition zone to bottom)
        updateRiverGrid();

        for (let i = 0; i < particles.length; i++) {
            particles[i].update();
        }
    }

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
        ctx.globalAlpha = 0.5;
        ctx.drawImage(canvas, 0, 0);
        ctx.restore();
    }

    for (let i = 0; i < particles.length; i++) {
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

        // River detection overlay
        let gridYStart = Math.floor(height * TRANSITION_ZONE_END);
        overlayCtx.setLineDash([]);
        if (riverLabels && numRiverComponents > 0) {
            // Draw river grid cells colored by component with white border
            overlayCtx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
            overlayCtx.lineWidth = 1;
            for (let r = 0; r < riverGridRows; r++) {
                for (let c = 0; c < riverGridCols; c++) {
                    let lbl = riverLabels[r * riverGridCols + c];
                    if (lbl > 0) {
                        let px = c * RIVER_CELL_SIZE;
                        let py = gridYStart + r * RIVER_CELL_SIZE;
                        let clr = RIVER_COLORS[riverComponentColors[lbl - 1] % RIVER_COLORS.length];
                        overlayCtx.fillStyle = `rgba(${clr[0]}, ${clr[1]}, ${clr[2]}, 0.3)`;
                        overlayCtx.fillRect(px, py, RIVER_CELL_SIZE, RIVER_CELL_SIZE);
                        // Draw border edges where this cell borders a different/empty cell
                        let top = r === 0 || riverLabels[(r - 1) * riverGridCols + c] !== lbl;
                        let bot = r === riverGridRows - 1 || riverLabels[(r + 1) * riverGridCols + c] !== lbl;
                        let lft = c === 0 || riverLabels[r * riverGridCols + c - 1] !== lbl;
                        let rgt = c === riverGridCols - 1 || riverLabels[r * riverGridCols + c + 1] !== lbl;
                        overlayCtx.beginPath();
                        if (top) { overlayCtx.moveTo(px, py); overlayCtx.lineTo(px + RIVER_CELL_SIZE, py); }
                        if (bot) { overlayCtx.moveTo(px, py + RIVER_CELL_SIZE); overlayCtx.lineTo(px + RIVER_CELL_SIZE, py + RIVER_CELL_SIZE); }
                        if (lft) { overlayCtx.moveTo(px, py); overlayCtx.lineTo(px, py + RIVER_CELL_SIZE); }
                        if (rgt) { overlayCtx.moveTo(px + RIVER_CELL_SIZE, py); overlayCtx.lineTo(px + RIVER_CELL_SIZE, py + RIVER_CELL_SIZE); }
                        overlayCtx.stroke();
                    }
                }
            }

            // Compute centroids and label each component
            let centroids = new Array(numRiverComponents);
            for (let i = 0; i < numRiverComponents; i++) centroids[i] = { sumR: 0, sumC: 0, count: 0 };
            for (let r = 0; r < riverGridRows; r++) {
                for (let c = 0; c < riverGridCols; c++) {
                    let lbl = riverLabels[r * riverGridCols + c];
                    if (lbl > 0) {
                        let ci = centroids[lbl - 1];
                        ci.sumR += r;
                        ci.sumC += c;
                        ci.count++;
                    }
                }
            }
            overlayCtx.font = '11px monospace';
            overlayCtx.textBaseline = 'middle';
            for (let i = 0; i < numRiverComponents; i++) {
                let ci = centroids[i];
                if (ci.count === 0) continue;
                let cx = (ci.sumC / ci.count + 0.5) * RIVER_CELL_SIZE;
                let cy = gridYStart + (ci.sumR / ci.count + 0.5) * RIVER_CELL_SIZE;
                let clr = RIVER_COLORS[riverComponentColors[i] % RIVER_COLORS.length];
                let label = `S${riverComponentColors[i] + 1}`;
                overlayCtx.strokeStyle = 'white';
                overlayCtx.lineWidth = 3;
                overlayCtx.strokeText(label, cx - 8, cy);
                overlayCtx.fillStyle = `rgb(${clr[0]}, ${clr[1]}, ${clr[2]})`;
                overlayCtx.fillText(label, cx - 8, cy);
            }
            overlayCtx.textBaseline = 'top';
        }

        // Draw capillary origins
        for (let co of capillaryOrigins) {
            let clr = RIVER_COLORS[co.sourceIdx % RIVER_COLORS.length];
            overlayCtx.strokeStyle = `rgb(${clr[0]}, ${clr[1]}, ${clr[2]})`;
            overlayCtx.lineWidth = 3;
            overlayCtx.beginPath();
            overlayCtx.arc(co.x, co.y, 12, 0, Math.PI * 2);
            overlayCtx.stroke();
        }

        // Component count label
        overlayCtx.fillStyle = '#ff8800';
        overlayCtx.font = '12px monospace';
        overlayCtx.fillText(`River grid: ${numRiverComponents} component(s)`, 8, gridYStart - 8);

        // Help bars at bottom
        overlayCtx.fillStyle = 'rgba(0, 0, 0, 0.6)';
        overlayCtx.fillRect(0, height - 42, width, 42);
        overlayCtx.font = '12px monospace';
        overlayCtx.fillStyle = '#aaaaaa';
        overlayCtx.fillText('Left click: hold to charge burst | Middle click: drag to push particles', 18, height - 32);
        overlayCtx.fillText('D: debug | W: wetness | E: erosion | T: transparent | C: source colors | R: river sample | P: stats | \u2191\u2193: speed', 18, height - 14);

        overlayCtx.restore();
    }

    // Wetness grid heatmap overlay (toggle with 'W' key)
    if (wetnessOverlay) {
        overlayCtx.save();
        // Find max wetness for normalization
        let maxW = 0;
        for (let i = 0; i < cols * rows; i++) {
            if (wetnessGrid[i] > maxW) maxW = wetnessGrid[i];
        }
        if (maxW < 1) maxW = 1;
        // Draw each cell as a colored rectangle
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                let w = wetnessGrid[r * cols + c];
                if (w < 0.5) continue;
                let t = w / maxW;
                // Blue (low) → cyan → yellow → red (high)
                let red, green, blue;
                if (t < 0.33) {
                    let s = t / 0.33;
                    red = 0; green = Math.floor(s * 255); blue = 255;
                } else if (t < 0.66) {
                    let s = (t - 0.33) / 0.33;
                    red = Math.floor(s * 255); green = 255; blue = Math.floor((1 - s) * 255);
                } else {
                    let s = (t - 0.66) / 0.34;
                    red = 255; green = Math.floor((1 - s) * 255); blue = 0;
                }
                overlayCtx.fillStyle = `rgba(${red}, ${green}, ${blue}, 0.5)`;
                overlayCtx.fillRect(c * GRID_SIZE, r * GRID_SIZE, GRID_SIZE, GRID_SIZE);
            }
        }
        // Label
        overlayCtx.font = '12px monospace';
        overlayCtx.fillStyle = '#ffffff';
        overlayCtx.fillText(`WETNESS (max: ${maxW.toFixed(1)})`, 8, 16);
        overlayCtx.restore();
    }

    // Erosion grid heatmap overlay (toggle with 'E' key)
    if (erosionOverlay) {
        overlayCtx.save();
        let maxE = 0;
        for (let i = 0; i < cols * rows; i++) {
            if (erosionGrid[i] > maxE) maxE = erosionGrid[i];
        }
        if (maxE < 0.01) maxE = 0.01;
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                let e = erosionGrid[r * cols + c];
                if (e < 0.005) continue;
                let t = e / maxE;
                // Purple (low) → orange (mid) → white (high)
                let red, green, blue;
                if (t < 0.5) {
                    let s = t / 0.5;
                    red = Math.floor(128 + s * 127); green = Math.floor(s * 165); blue = Math.floor(200 * (1 - s));
                } else {
                    let s = (t - 0.5) / 0.5;
                    red = 255; green = Math.floor(165 + s * 90); blue = Math.floor(s * 255);
                }
                overlayCtx.fillStyle = `rgba(${red}, ${green}, ${blue}, 0.6)`;
                overlayCtx.fillRect(c * GRID_SIZE, r * GRID_SIZE, GRID_SIZE, GRID_SIZE);
            }
        }
        overlayCtx.font = '12px monospace';
        overlayCtx.fillStyle = '#ffffff';
        overlayCtx.fillText(`EROSION (max: ${maxE.toFixed(1)})`, 8, wetnessOverlay ? 64 : 16);
        overlayCtx.restore();
    }

    // Capillary wetness heatmap (shown alongside river wetness, redder hue)
    if (wetnessOverlay) {
        overlayCtx.save();
        let maxCW = 0;
        for (let i = 0; i < cols * rows; i++) {
            if (capWetnessGrid[i] > maxCW) maxCW = capWetnessGrid[i];
        }
        if (maxCW < 1) maxCW = 1;
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                let w = capWetnessGrid[r * cols + c];
                if (w < 0.5) continue;
                let t = w / maxCW;
                // Dark red (low) → orange (mid) → bright red (high)
                let red = Math.floor(180 + t * 75);
                let green = Math.floor(t * 100);
                let blue = 0;
                overlayCtx.fillStyle = `rgba(${red}, ${green}, ${blue}, 0.5)`;
                overlayCtx.fillRect(c * GRID_SIZE, r * GRID_SIZE, GRID_SIZE, GRID_SIZE);
            }
        }
        overlayCtx.font = '12px monospace';
        overlayCtx.fillStyle = '#ff8844';
        overlayCtx.fillText(`CAP WETNESS (max: ${maxCW.toFixed(1)})`, 8, 32);  // line 2 (river wetness at 16)
        overlayCtx.restore();
    }

    // Capillary erosion heatmap (shown alongside river erosion, redder hue)
    if (erosionOverlay) {
        overlayCtx.save();
        let maxCE = 0;
        for (let i = 0; i < cols * rows; i++) {
            if (capErosionGrid[i] > maxCE) maxCE = capErosionGrid[i];
        }
        if (maxCE < 0.01) maxCE = 0.01;
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                let e = capErosionGrid[r * cols + c];
                if (e < 0.005) continue;
                let t = e / maxCE;
                // Dark red (low) → bright red-orange (high)
                let red = 255;
                let green = Math.floor(t * 80);
                let blue = Math.floor(t * 30);
                overlayCtx.fillStyle = `rgba(${red}, ${green}, ${blue}, 0.6)`;
                overlayCtx.fillRect(c * GRID_SIZE, r * GRID_SIZE, GRID_SIZE, GRID_SIZE);
            }
        }
        overlayCtx.font = '12px monospace';
        overlayCtx.fillStyle = '#ff6633';
        let yOff = wetnessOverlay ? 80 : 32;  // after river erosion label
        overlayCtx.fillText(`CAP EROSION (max: ${maxCE.toFixed(1)})`, 8, yOff);
        overlayCtx.restore();
    }

    // River sample mode overlay (independent of debugOverlay)
    if (riverSampleMode) {
        overlayCtx.save();
        // Mode label
        overlayCtx.font = '14px monospace';
        overlayCtx.fillStyle = '#00ffff';
        overlayCtx.fillText('RIVER SAMPLE MODE (R to exit)', 8, height - 12);

        // Draw rectangle
        if (riverSampleRect && riverSampleRect.w > 0 && riverSampleRect.h > 0) {
            overlayCtx.strokeStyle = '#00ffff';
            overlayCtx.lineWidth = 2;
            overlayCtx.setLineDash([]);
            overlayCtx.strokeRect(riverSampleRect.x, riverSampleRect.y, riverSampleRect.w, riverSampleRect.h);
            overlayCtx.fillStyle = 'rgba(0, 255, 255, 0.08)';
            overlayCtx.fillRect(riverSampleRect.x, riverSampleRect.y, riverSampleRect.w, riverSampleRect.h);
        }

        // Draw stats panel
        if (riverSampleStats) {
            let s = riverSampleStats;
            let pct = (v) => (v / s.pixelCount * 100).toFixed(1);
            let lines = [
                `Rect: (${s.x}, ${s.y}) ${s.w}x${s.h}px`,
                `Grid: cols ${s.col0}-${s.col1}, rows ${s.row0}-${s.row1}`,
                `Pixels: ${s.pixelCount}`,
                ``,
                `R: min=${s.r.min} max=${s.r.max} mean=${s.r.mean} med=${s.r.median}`,
                `G: min=${s.g.min} max=${s.g.max} mean=${s.g.mean} med=${s.g.median}`,
                `B: min=${s.b.min} max=${s.b.max} mean=${s.b.mean} med=${s.b.median}`,
                ``,
                `Brightness histogram:`,
                `  0      : ${s.buckets[0]} (${pct(s.buckets[0])}%)`,
                `  1-15   : ${s.buckets[1]} (${pct(s.buckets[1])}%)`,
                `  16-50  : ${s.buckets[2]} (${pct(s.buckets[2])}%)`,
                `  51-128 : ${s.buckets[3]} (${pct(s.buckets[3])}%)`,
                `  129-255: ${s.buckets[4]} (${pct(s.buckets[4])}%)`,
                ``,
                `>= threshold (${s.threshold}): ${s.aboveThreshold} (${pct(s.aboveThreshold)}%)`,
                ``,
                `Column detection (avg red >= ${s.threshold}):`,
                `  Columns passing: ${s.passingCols}/${s.colCount}`,
                `  River runs (>= 3 wide): ${s.riverRuns.length}`,
                ...s.riverRuns.map((r, i) => `    #${i + 1}: cols ${r.left}-${r.right} (${r.right - r.left + 1} wide)`),
                ``,
                s.riverRuns.length > 0 ? `  PASS — ${s.riverRuns.length} river(s) detected` : `  FAIL — no rivers detected`
            ];
            let lineH = 16;
            let panelW = 380;
            let panelH = lines.length * lineH + 16;
            overlayCtx.fillStyle = 'rgba(0, 0, 0, 0.85)';
            overlayCtx.fillRect(8, 8, panelW, panelH);
            overlayCtx.strokeStyle = '#00ffff';
            overlayCtx.lineWidth = 1;
            overlayCtx.strokeRect(8, 8, panelW, panelH);
            overlayCtx.font = '12px monospace';
            let verdictIdx = lines.length - 1;
            for (let i = 0; i < lines.length; i++) {
                if (i === verdictIdx) {
                    overlayCtx.fillStyle = s.riverRuns.length > 0 ? '#00ff00' : '#ff4444';
                } else {
                    overlayCtx.fillStyle = '#00ffff';
                }
                overlayCtx.fillText(lines[i], 16, 24 + i * lineH);
            }
        }
        overlayCtx.restore();
    }

    // Particle statistics overlay
    if (particleStatsOverlay) {
        let total = particles.length;
        let river = 0, capillary = 0, source = 0;
        let onCanvas = 0, offCanvas = 0;
        for (let p of particles) {
            if (p.x >= 0 && p.x <= width && p.y >= 0 && p.y <= height) {
                onCanvas++;
            } else {
                offCanvas++;
            }
            if (p.isCapillary) {
                capillary++;
            } else {
                river++;
                if (p.isSource) source++;
            }
        }
        let lines = [
            `PARTICLE STATS (P to hide)`,
            ``,
            `Total: ${total}  (on canvas: ${onCanvas}, off: ${offCanvas})`,
            `River: ${river}  (source: ${source})`,
            `Capillary: ${capillary}`,
            `Origins: ${capillaryOrigins.length}`,
            `FPS: ${smoothFPS.toFixed(1)}  Speed: ${simSpeed}x (Up/Down)`,
        ];
        let lineH = 16;
        let panelW = 420;
        let panelH = lines.length * lineH + 16;
        let panelX = width - panelW - 8;
        overlayCtx.save();
        overlayCtx.fillStyle = 'rgba(0, 0, 0, 0.85)';
        overlayCtx.fillRect(panelX, 8, panelW, panelH);
        overlayCtx.strokeStyle = '#00ff88';
        overlayCtx.lineWidth = 1;
        overlayCtx.strokeRect(panelX, 8, panelW, panelH);
        overlayCtx.font = '12px monospace';
        overlayCtx.fillStyle = '#00ff88';
        for (let i = 0; i < lines.length; i++) {
            overlayCtx.fillText(lines[i], panelX + 8, 24 + i * lineH);
        }
        overlayCtx.restore();
    }

    // Slowly evolve the noise for shifting rivers
    zOff += NOISE_EVOLUTION_SPEED;

    requestAnimationFrame(animate);
}

canvas.addEventListener('mousemove', (e) => {
    if (riverSampleMode && riverSampleDragging && riverSampleStart) {
        let sx = Math.min(riverSampleStart.x, e.clientX);
        let sy = Math.min(riverSampleStart.y, e.clientY);
        let sw = Math.abs(e.clientX - riverSampleStart.x);
        let sh = Math.abs(e.clientY - riverSampleStart.y);
        riverSampleRect = { x: sx, y: sy, w: sw, h: sh };
    }
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
    if (riverSampleMode) {
        riverSampleDragging = true;
        riverSampleStart = { x: e.clientX, y: e.clientY };
        riverSampleRect = { x: e.clientX, y: e.clientY, w: 0, h: 0 };
        riverSampleStats = null;
        return;
    }
    burst.charging = true;
    burst.x = e.clientX;
    burst.y = e.clientY;
    burst.startTime = performance.now();
});

canvas.addEventListener('mouseup', (e) => {
    if (e.button === 1) { mouse.middleDown = false; return; }
    if (riverSampleMode && riverSampleDragging) {
        riverSampleDragging = false;
        if (riverSampleRect && riverSampleRect.w > 2 && riverSampleRect.h > 2) {
            riverSampleStats = computeRiverSampleStats(riverSampleRect);
        }
        return;
    }
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
    if (e.key === 'w' || e.key === 'W') wetnessOverlay = !wetnessOverlay;
    if (e.key === 'e' || e.key === 'E') erosionOverlay = !erosionOverlay;
    if (e.key === 'p' || e.key === 'P') particleStatsOverlay = !particleStatsOverlay;
    if (e.key === 't' || e.key === 'T') transparentParticles = !transparentParticles;
    if (e.key === 'c' || e.key === 'C') sourceColorParticles = !sourceColorParticles;
    if (e.key === 'ArrowUp') simSpeed = Math.min(simSpeed + 1, 5);
    if (e.key === 'ArrowDown') simSpeed = Math.max(simSpeed - 1, 1);
    if (e.key === 'r' || e.key === 'R') {
        riverSampleMode = !riverSampleMode;
        if (!riverSampleMode) {
            riverSampleRect = null;
            riverSampleDragging = false;
            riverSampleStart = null;
            riverSampleStats = null;
        } else {
            riverSampleRect = null;
            riverSampleStats = null;
        }
    }
});

animate();
