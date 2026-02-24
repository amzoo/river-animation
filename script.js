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
// ==========================================

let mouse = { x: 0, y: 0, prevX: 0, prevY: 0, frameDX: 0, frameDY: 0, speed: 0, active: false, lastTime: 0 };
let burst = { charging: false, x: 0, y: 0, startTime: 0 };
const BURST_MIN_RADIUS = 50;
const BURST_MAX_RADIUS = 300;
const BURST_CHARGE_TIME = 2000; // ms to reach max size

let zOff = 0;
let cols, rows;
let wetnessGrid;
let erosionGrid;

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

class Particle {
    constructor() {
        this.reset();
        // Spread initial particles vertically so they don't all bunch at the top
        this.y = -Math.random() * height * 0.3;
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

        // Mouse bar displacement — physically push particles
        if (mouse.active && (mouse.frameDX !== 0 || mouse.frameDY !== 0)) {
            let mdx = this.x - mouse.x;
            let mdy = this.y - mouse.y;
            let dist = Math.sqrt(mdx * mdx + mdy * mdy);
            let radius = 120;
            if (dist < radius) {
                let falloff = 1.0 - dist / radius;
                this.x += mouse.frameDX * falloff;
                this.y += mouse.frameDY * falloff;
                this.vx += mouse.frameDX * falloff * 0.3;
                this.vy += mouse.frameDY * falloff * 0.3;
            }
        }

        // Source particles are confined to the delta zone — reset when they leave
        if (this.isSource && this.y > height * 0.3) {
            this.reset();
            return;
        }

        // Fluid characteristics:
        // Particles near the top (delta zone) are always visible and don't decay fast,
        // even when spread thin, so deltas can form before streams converge.
        // A transition zone (20%-35%) softly blends delta treatment into river treatment.
        let inDelta = this.y > 0 && this.y < height * 0.3;
        let inTransition = !inDelta && this.y >= height * 0.3 && this.y < height * 0.45;
        // 0 = full delta treatment, 1 = full river treatment
        let transitionT = inTransition ? (this.y - height * 0.3) / (height * 0.15) : 1.0;
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

    draw() {
        if (this.drawOpacity <= MIN_DRAW_OPACITY) return; // Don't paint invisible tiny swimmers

        ctx.fillStyle = `rgba(255, 255, 255, ${this.drawOpacity})`;
        ctx.beginPath();
        // Width based on weight and age
        let radius = this.weight * 1.5 * (Math.sin((this.age / this.life) * Math.PI));
        // Larger particles in the delta zone so the fan is visible
        if (this.inDelta) radius = Math.max(radius, 1.5);
        if (radius < 0.1) radius = 0.1;
        ctx.arc(this.x, this.y, radius, 0, Math.PI * 2);
        ctx.fill();
    }
}

const SOURCE_COUNT = Math.floor(NUM_PARTICLES * SOURCE_PARTICLE_FRACTION);
for (let i = 0; i < NUM_PARTICLES; i++) {
    let p = new Particle();
    p.isSource = i < SOURCE_COUNT;
    particles.push(p);
}

function animate() {
    // Evaporate wetness grid and slowly decay erosion
    for (let k = 0; k < wetnessGrid.length; k++) {
        wetnessGrid[k] *= EVAPORATION_RATE;
        erosionGrid[k] *= EROSION_DECAY;
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
        ctx.globalAlpha = 0.6;
        ctx.drawImage(canvas, 0, 0);
        ctx.restore();
    }

    for (let i = 0; i < particles.length; i++) {
        particles[i].update();
        particles[i].draw();
    }

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
            { y: height * 0.3,   label: 'Delta zone end (30%)',        color: '#44ff44' },
            { y: height * 0.45,  label: 'Transition zone end (45%)',   color: '#4488ff' },
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

        // Draw mouse push radius
        if (mouse.active) {
            overlayCtx.setLineDash([4, 4]);
            overlayCtx.strokeStyle = 'rgba(255, 100, 100, 0.6)';
            overlayCtx.lineWidth = 1;
            overlayCtx.beginPath();
            overlayCtx.arc(mouse.x, mouse.y, 120, 0, Math.PI * 2);
            overlayCtx.stroke();
            overlayCtx.fillStyle = 'rgba(255, 100, 100, 0.05)';
            overlayCtx.fill();
            overlayCtx.fillStyle = '#ff6464';
            overlayCtx.fillText('Push radius (120px)', mouse.x + 125, mouse.y - 5);
        }

        overlayCtx.restore();
    }

    // Slowly evolve the noise for shifting rivers
    zOff += NOISE_EVOLUTION_SPEED;

    requestAnimationFrame(animate);
}

canvas.addEventListener('mousemove', (e) => {
    mouse.frameDX += e.clientX - mouse.x;
    mouse.frameDY += e.clientY - mouse.y;
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    mouse.active = true;
});

canvas.addEventListener('mouseleave', () => {
    mouse.active = false;
});

canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    burst.charging = true;
    burst.x = e.clientX;
    burst.y = e.clientY;
    burst.startTime = performance.now();
});

canvas.addEventListener('mouseup', (e) => {
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
