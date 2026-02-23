const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

let width, height;
let particles = [];
// ==========================================
// CONFIGURATION & TUNING VARIABLES
// ==========================================

// --- Overall Simulation ---
// Number of particles spawned in the simulation
const NUM_PARTICLES = 16000;

// --- Flow Field & Noise ---
// How zoomed in the noise field is. Smaller = broader rivers
const NOISE_SCALE = 0.0008;
// How quickly the noise field (and thus the river paths) shifts over time
const NOISE_EVOLUTION_SPEED = 0.0003;
// Epsilon for calculating the noise gradient (steepness/direction)
const NOISE_EPSILON = 0.1;

// --- Fluid & Wetness Grid ---
// Size of each grid cell (px) for tracking water accumulation
const GRID_SIZE = 5;
// How quickly the wetness map dries up every frame (multiplier, 0.99 = 1% loss)
const EVAPORATION_RATE = 0.99;
// Added to wetness grid when particle is present
const WETNESS_DEPOSIT = 0.2;
// Threshold of wetness below which a particle is considered "dry"
const WETNESS_DRY_THRESHOLD = 3.0;

// --- Particle Physics ---
const PARTICLE_SPEED_BASE = 0.4;
const PARTICLE_SPEED_VAR = 0.8;

const PARTICLE_WEIGHT_BASE = 1.0;
const PARTICLE_WEIGHT_VAR = 2.5;

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
// ==========================================

let zOff = 0;
let cols, rows;
let wetnessGrid;

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

    cols = Math.ceil(width / GRID_SIZE);
    rows = Math.ceil(height / GRID_SIZE);
    wetnessGrid = new Float32Array(cols * rows);

    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, width, height);
}

window.addEventListener('resize', resize);
resize();

class Particle {
    constructor() {
        this.reset();
    }

    reset() {
        this.x = Math.random() * width;
        // Spawning mostly from the top to create long vertical rivers, but more spread out
        this.y = -Math.random() * height * 0.2;
        this.vx = 0;
        this.vy = 0;
        this.speed = Math.random() * PARTICLE_SPEED_VAR + PARTICLE_SPEED_BASE;
        this.weight = Math.random() * PARTICLE_WEIGHT_VAR + PARTICLE_WEIGHT_BASE;
        // Gravity variance: some flow fast downhill, some drag and swirl in lakes
        this.gravity = Math.random() * PARTICLE_GRAVITY_VAR + PARTICLE_GRAVITY_BASE;
        this.life = Math.random() * PARTICLE_LIFE_VAR + PARTICLE_LIFE_BASE;
        this.age = 0;
        this.drawOpacity = 0;
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

            // Calculate pressure gradient from wetness to push OUT of lakes
            let wLeft = c > 0 ? wetnessGrid[idx - 1] : cellWetness;
            let wRight = c < cols - 1 ? wetnessGrid[idx + 1] : cellWetness;
            let wUp = r > 0 ? wetnessGrid[idx - cols] : cellWetness;
            let wDown = r < rows - 1 ? wetnessGrid[idx + cols] : cellWetness;

            let px = -(wRight - wLeft);
            let py = -(wDown - wUp);

            let plen = Math.sqrt(px * px + py * py) || 1;

            // Pressure pushing outward grows stronger as lake gets deeper
            forceX += (px / plen) * Math.min(cellWetness * 0.01, 1.5);
            forceY += (py / plen) * Math.min(cellWetness * 0.01, 1.5);
        }

        // Add per-particle downward gravity. Low gravity particles will get trapped 
        // in local minima 'lakes' and swirl, high gravity will force main rivers down.
        forceY += this.gravity;

        // Normalize total force
        let length = Math.sqrt(forceX * forceX + forceY * forceY) || 1;
        forceX /= length;
        forceY /= length;

        this.vx += forceX * 0.2 * this.speed;
        this.vy += forceY * 0.2 * this.speed;

        // Friction to limit max speed
        this.vx *= FRICTION;
        this.vy *= FRICTION;

        this.x += this.vx;
        this.y += this.vy;

        // Fluid characteristics:
        if (cellWetness < WETNESS_DRY_THRESHOLD) {
            this.age += 4; // Small stray strands dry up / get absorbed rapidly
            this.drawOpacity = 0; // Don't draw solitary particles
        } else {
            this.age += 0.20; // Live much longer in established deep rivers/lakes
            // Opacity increases based on water depth
            this.drawOpacity = Math.min(MAX_DRAW_OPACITY, cellWetness / 100);
        }

        // Reset if out of bounds or too old
        if (this.x < -50 || this.x > width + 50 || this.y > height + 50 || this.age > this.life) {
            this.reset();
            // Once screen is running, mostly spawn from the top
            this.y = -Math.random() * 50;
            this.x = Math.random() * width;
        }
    }

    draw() {
        if (this.drawOpacity <= MIN_DRAW_OPACITY) return; // Don't paint invisible tiny swimmers

        ctx.fillStyle = `rgba(255, 255, 255, ${this.drawOpacity})`;
        ctx.beginPath();
        // Width based on weight and age
        let radius = this.weight * 2.5 * (Math.sin((this.age / this.life) * Math.PI));
        if (radius < 0.1) radius = 0.1;
        ctx.arc(this.x, this.y, radius, 0, Math.PI * 2);
        ctx.fill();
    }
}

for (let i = 0; i < NUM_PARTICLES; i++) {
    particles.push(new Particle());
}

function animate() {
    // Evaporate wetness grid
    for (let k = 0; k < wetnessGrid.length; k++) {
        wetnessGrid[k] *= EVAPORATION_RATE;
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
    }

    for (let i = 0; i < particles.length; i++) {
        particles[i].update();
        particles[i].draw();
    }

    // Slowly evolve the noise for shifting rivers
    zOff += NOISE_EVOLUTION_SPEED;

    requestAnimationFrame(animate);
}

animate();
