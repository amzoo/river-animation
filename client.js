'use strict';

const canvas = document.getElementById('canvas');

// Unit 6: Try WebGL2 first for the main rendering canvas.
// Unit 1: If WebGL2 unavailable, fall back to Canvas2D with destination-out fade.
const gl  = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false });
const ctx = gl ? null : canvas.getContext('2d');

const overlayCanvas = document.getElementById('overlay');
const overlayCtx = overlayCanvas.getContext('2d');
const canvasWrap = document.getElementById('canvas-wrap');
const vignetteEl = document.getElementById('vignette');
const statusEl = document.getElementById('status');
const hintEl = document.getElementById('hint');
const fpsEl = document.getElementById('fps');
let hintVisible = true;

let capillaryDiversion = false;
let mixSources = true;

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
let ws = null;

function resizeCanvas() {
    width = canvas.width = overlayCanvas.width = window.innerWidth;
    height = canvas.height = overlayCanvas.height = window.innerHeight;
    if (glRenderer) glRenderer.resize(width, height);
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'client_dimensions', width, height }));
    }
}
resizeCanvas();
window.addEventListener('resize', resizeCanvas);

const params = new URLSearchParams(window.location.search);
const isSecure = window.location.protocol === 'https:';
const serverAddr = params.get('server');
const wsUrl = serverAddr
    ? `${isSecure ? 'wss' : 'ws'}://${serverAddr}`
    : `${isSecure ? 'wss' : 'ws'}://${window.location.host}/ws`;
const isProjector = params.get('role') === 'projector';

let particles = [];
let transparentParticles = false;
let sourceColorParticles = false;
let wetnessOverlay = false;
let erosionOverlay = false;

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

let connected = false;
let statusHideTimer = null;
let fadeToggle = false;
let smoothFPS = 0;
let lastFrameTime = performance.now();
let serverFPS = null;
let fpsReportTimer = 0;
let awaitingReset = false;
let frameNum = 0;
const CONNECT_FADE_IN_FRAMES = 180;
let connectFadeFrame = 0;
let wetnessGrid = null;
let erosionGrid = null;
let transformOverlayVisible = false;

// Unit 3: Zstd decompression flag — set when server signals 'encoding: zstd'
let useZstd = false;

let displayTransform = {
    insetTop: 0, insetBottom: 0, insetLeft: 0, insetRight: 0,
    shiftTop: 0, shiftBottom: 0, shiftLeft: 0, shiftRight: 0,
    fadeTop: 0, fadeBottom: 0, fadeLeft: 0, fadeRight: 0,
};

// ============================================================
// Unit 6: WebGL2 FBO renderer
// ============================================================

let glRenderer = null;

function initWebGL(glCtx) {
    // ---------- shader sources ----------

    const FADE_VERT = `#version 300 es
precision mediump float;
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`;

    // "Hold bright, fade dim" — matches Canvas2D getImageData logic exactly.
    const FADE_FRAG = `#version 300 es
precision mediump float;
uniform sampler2D u_trail;
uniform vec2 u_resolution;
uniform float u_holdThreshold; // normalised 0-1
uniform float u_slowFade;      // per-frame subtract amount
uniform float u_fastFade;
out vec4 outColor;
void main() {
    vec2 uv = gl_FragCoord.xy / u_resolution;
    vec4 c = texture(u_trail, uv);
    float v = c.r; // brightness (white-on-black; for source colors same logic on R)
    float fadeAmt = v > u_holdThreshold ? u_slowFade : u_fastFade;
    float newV = max(0.0, v - fadeAmt);
    // For source-color mode keep hue; scale by brightness ratio
    float ratio = v > 0.0001 ? newV / v : 0.0;
    outColor = vec4(c.rgb * ratio, 1.0);
}`;

    const PARTICLE_VERT = `#version 300 es
precision mediump float;
in vec2  a_pos;     // NDC [-1, 1]
in float a_size;    // diameter in CSS pixels
in float a_opacity;
in vec3  a_color;
out float v_opacity;
out vec3  v_color;
void main() {
    gl_Position  = vec4(a_pos, 0.0, 1.0);
    gl_PointSize = a_size;
    v_opacity = a_opacity;
    v_color   = a_color;
}`;

    const PARTICLE_FRAG = `#version 300 es
precision mediump float;
in float v_opacity;
in vec3  v_color;
out vec4 outColor;
void main() {
    outColor = vec4(v_color * v_opacity, v_opacity);
}`;

    const BLIT_VERT = FADE_VERT;

    const BLIT_FRAG = `#version 300 es
precision mediump float;
uniform sampler2D u_trail;
uniform vec2 u_resolution;
out vec4 outColor;
void main() {
    vec2 uv = gl_FragCoord.xy / u_resolution;
    outColor = texture(u_trail, uv);
}`;

    function compileShader(type, src) {
        const s = glCtx.createShader(type);
        glCtx.shaderSource(s, src);
        glCtx.compileShader(s);
        if (!glCtx.getShaderParameter(s, glCtx.COMPILE_STATUS)) {
            console.error('Shader compile error:', glCtx.getShaderInfoLog(s));
            return null;
        }
        return s;
    }

    function linkProgram(vsSrc, fsSrc) {
        const vs = compileShader(glCtx.VERTEX_SHADER, vsSrc);
        const fs = compileShader(glCtx.FRAGMENT_SHADER, fsSrc);
        if (!vs || !fs) return null;
        const p = glCtx.createProgram();
        glCtx.attachShader(p, vs);
        glCtx.attachShader(p, fs);
        glCtx.linkProgram(p);
        if (!glCtx.getProgramParameter(p, glCtx.LINK_STATUS)) {
            console.error('Program link error:', glCtx.getProgramInfoLog(p));
            return null;
        }
        return p;
    }

    const fadeProg     = linkProgram(FADE_VERT,     FADE_FRAG);
    const particleProg = linkProgram(PARTICLE_VERT, PARTICLE_FRAG);
    const blitProg     = linkProgram(BLIT_VERT,     BLIT_FRAG);
    if (!fadeProg || !particleProg || !blitProg) return null;

    // ---------- fullscreen quad ----------
    const quadBuf = glCtx.createBuffer();
    glCtx.bindBuffer(glCtx.ARRAY_BUFFER, quadBuf);
    glCtx.bufferData(glCtx.ARRAY_BUFFER, new Float32Array([
        -1, -1,  1, -1,  -1, 1,
         1, -1,  1,  1,  -1, 1,
    ]), glCtx.STATIC_DRAW);

    // ---------- particle buffer (dynamic, re-uploaded each frame) ----------
    // Layout per particle: [x_ndc, y_ndc, size, opacity, r, g, b]  = 7 floats
    const MAX_PARTICLES = 35000;
    const PARTICLE_FLOATS = 7;
    const particleBuf = glCtx.createBuffer();
    glCtx.bindBuffer(glCtx.ARRAY_BUFFER, particleBuf);
    glCtx.bufferData(glCtx.ARRAY_BUFFER, MAX_PARTICLES * PARTICLE_FLOATS * 4, glCtx.DYNAMIC_DRAW);
    const particleData = new Float32Array(MAX_PARTICLES * PARTICLE_FLOATS);

    // ---------- FBO helpers ----------
    function makeFBO(w, h) {
        const tex = glCtx.createTexture();
        glCtx.bindTexture(glCtx.TEXTURE_2D, tex);
        glCtx.texImage2D(glCtx.TEXTURE_2D, 0, glCtx.RGBA8, w, h, 0, glCtx.RGBA, glCtx.UNSIGNED_BYTE, null);
        glCtx.texParameteri(glCtx.TEXTURE_2D, glCtx.TEXTURE_MIN_FILTER, glCtx.NEAREST);
        glCtx.texParameteri(glCtx.TEXTURE_2D, glCtx.TEXTURE_MAG_FILTER, glCtx.NEAREST);
        glCtx.texParameteri(glCtx.TEXTURE_2D, glCtx.TEXTURE_WRAP_S, glCtx.CLAMP_TO_EDGE);
        glCtx.texParameteri(glCtx.TEXTURE_2D, glCtx.TEXTURE_WRAP_T, glCtx.CLAMP_TO_EDGE);
        const fbo = glCtx.createFramebuffer();
        glCtx.bindFramebuffer(glCtx.FRAMEBUFFER, fbo);
        glCtx.framebufferTexture2D(glCtx.FRAMEBUFFER, glCtx.COLOR_ATTACHMENT0, glCtx.TEXTURE_2D, tex, 0);
        glCtx.bindFramebuffer(glCtx.FRAMEBUFFER, null);
        glCtx.bindTexture(glCtx.TEXTURE_2D, null);
        return { fbo, tex, w, h };
    }

    function deleteFBO(f) {
        if (!f) return;
        glCtx.deleteFramebuffer(f.fbo);
        glCtx.deleteTexture(f.tex);
    }

    let fboA = makeFBO(width, height);
    let fboB = makeFBO(width, height);

    // Clear both FBOs to black
    function clearFBO(f) {
        glCtx.bindFramebuffer(glCtx.FRAMEBUFFER, f.fbo);
        glCtx.clearColor(0, 0, 0, 1);
        glCtx.clear(glCtx.COLOR_BUFFER_BIT);
        glCtx.bindFramebuffer(glCtx.FRAMEBUFFER, null);
    }
    clearFBO(fboA);
    clearFBO(fboB);

    // ---------- VAOs ----------
    function makeQuadVAO(prog) {
        const vao = glCtx.createVertexArray();
        glCtx.bindVertexArray(vao);
        glCtx.bindBuffer(glCtx.ARRAY_BUFFER, quadBuf);
        const loc = glCtx.getAttribLocation(prog, 'a_pos');
        glCtx.enableVertexAttribArray(loc);
        glCtx.vertexAttribPointer(loc, 2, glCtx.FLOAT, false, 0, 0);
        glCtx.bindVertexArray(null);
        return vao;
    }

    const fadeVAO  = makeQuadVAO(fadeProg);
    const blitVAO  = makeQuadVAO(blitProg);

    const particleVAO = glCtx.createVertexArray();
    glCtx.bindVertexArray(particleVAO);
    glCtx.bindBuffer(glCtx.ARRAY_BUFFER, particleBuf);
    const STRIDE = PARTICLE_FLOATS * 4;
    function pAttrib(prog, name, size, offset) {
        const loc = glCtx.getAttribLocation(prog, name);
        if (loc >= 0) {
            glCtx.enableVertexAttribArray(loc);
            glCtx.vertexAttribPointer(loc, size, glCtx.FLOAT, false, STRIDE, offset * 4);
        }
    }
    pAttrib(particleProg, 'a_pos',     2, 0);
    pAttrib(particleProg, 'a_size',    1, 2);
    pAttrib(particleProg, 'a_opacity', 1, 3);
    pAttrib(particleProg, 'a_color',   3, 4);
    glCtx.bindVertexArray(null);

    // ---------- uniform locations ----------
    const uFadeTrail      = glCtx.getUniformLocation(fadeProg, 'u_trail');
    const uFadeRes        = glCtx.getUniformLocation(fadeProg, 'u_resolution');
    const uFadeHold       = glCtx.getUniformLocation(fadeProg, 'u_holdThreshold');
    const uFadeSlow       = glCtx.getUniformLocation(fadeProg, 'u_slowFade');
    const uFadeFast       = glCtx.getUniformLocation(fadeProg, 'u_fastFade');
    const uBlitTrail      = glCtx.getUniformLocation(blitProg,  'u_trail');
    const uBlitRes        = glCtx.getUniformLocation(blitProg,  'u_resolution');

    // Normalised fade constants
    const HOLD_N  = FADE_HOLD_THRESHOLD / 255;
    const SLOW_N  = FADE_SLOW_AMOUNT    / 255;
    const FAST_N  = FADE_FAST_AMOUNT    / 255;

    // ---------- renderer object ----------
    const renderer = {
        resize(w, h) {
            deleteFBO(fboA);
            deleteFBO(fboB);
            fboA = makeFBO(w, h);
            fboB = makeFBO(w, h);
            clearFBO(fboA);
            clearFBO(fboB);
        },

        clearTrail() {
            clearFBO(fboA);
            clearFBO(fboB);
            // Also clear the screen canvas immediately — FBO clears alone don't
            // update what's visible until the next blit pass.
            glCtx.bindFramebuffer(glCtx.FRAMEBUFFER, null);
            glCtx.clearColor(0, 0, 0, 1);
            glCtx.clear(glCtx.COLOR_BUFFER_BIT);
        },

        render(opts) {
            const {
                parts, fadeThisFrame, connectFade,
                transparent, sourceColors, dpr,
            } = opts;

            const W = glCtx.drawingBufferWidth;
            const H = glCtx.drawingBufferHeight;

            // ---- pass 1: fade fboA → fboB ----
            if (fadeThisFrame) {
                glCtx.bindFramebuffer(glCtx.FRAMEBUFFER, fboB.fbo);
                glCtx.viewport(0, 0, W, H);
                glCtx.useProgram(fadeProg);
                glCtx.activeTexture(glCtx.TEXTURE0);
                glCtx.bindTexture(glCtx.TEXTURE_2D, fboA.tex);
                glCtx.uniform1i(uFadeTrail, 0);
                glCtx.uniform2f(uFadeRes, W, H);
                glCtx.uniform1f(uFadeHold, HOLD_N);
                glCtx.uniform1f(uFadeSlow, SLOW_N);
                glCtx.uniform1f(uFadeFast, FAST_N);
                glCtx.bindVertexArray(fadeVAO);
                glCtx.drawArrays(glCtx.TRIANGLES, 0, 6);
            } else {
                // No fade this frame: copy fboA → fboB unchanged
                // (blit is cheaper than a full fade pass)
                glCtx.bindFramebuffer(glCtx.READ_FRAMEBUFFER, fboA.fbo);
                glCtx.bindFramebuffer(glCtx.DRAW_FRAMEBUFFER, fboB.fbo);
                glCtx.blitFramebuffer(0, 0, W, H, 0, 0, W, H, glCtx.COLOR_BUFFER_BIT, glCtx.NEAREST);
            }

            // ---- pass 2: draw particles into fboB ----
            glCtx.bindFramebuffer(glCtx.FRAMEBUFFER, fboB.fbo);
            glCtx.viewport(0, 0, W, H);
            glCtx.enable(glCtx.BLEND);
            glCtx.blendFunc(glCtx.ONE, glCtx.ONE_MINUS_SRC_ALPHA); // pre-multiplied alpha

            let pCount = 0;
            const WHITE = [1, 1, 1];
            for (let i = 0; i < parts.length; i++) {
                const p = parts[i];
                if (p.opacity <= MIN_DRAW_OPACITY) continue;
                const radius = p.radius;
                if (radius < 0.1) continue;
                const opacity = (transparent ? p.opacity * TRANSPARENT_OPACITY : p.opacity) * connectFade;
                const size = radius * 2 * dpr;
                const clr  = sourceColors ? RIVER_COLORS[p.sourceIdx % RIVER_COLORS.length] : null;
                const r = clr ? clr[0] / 255 : 1;
                const g = clr ? clr[1] / 255 : 1;
                const b = clr ? clr[2] / 255 : 1;
                const base = pCount * PARTICLE_FLOATS;
                particleData[base]     = (p.x / width)  *  2 - 1;
                particleData[base + 1] = (p.y / height) * -2 + 1;
                particleData[base + 2] = Math.max(1, size);
                particleData[base + 3] = opacity;
                particleData[base + 4] = r;
                particleData[base + 5] = g;
                particleData[base + 6] = b;
                pCount++;
                if (pCount >= MAX_PARTICLES) break;
            }

            if (pCount > 0) {
                glCtx.useProgram(particleProg);
                glCtx.bindBuffer(glCtx.ARRAY_BUFFER, particleBuf);
                glCtx.bufferSubData(glCtx.ARRAY_BUFFER, 0, particleData, 0, pCount * PARTICLE_FLOATS);
                glCtx.bindVertexArray(particleVAO);
                glCtx.drawArrays(glCtx.POINTS, 0, pCount);
            }

            glCtx.disable(glCtx.BLEND);

            // ---- pass 3: blit fboB → screen ----
            glCtx.bindFramebuffer(glCtx.FRAMEBUFFER, null);
            glCtx.viewport(0, 0, W, H);
            glCtx.useProgram(blitProg);
            glCtx.activeTexture(glCtx.TEXTURE0);
            glCtx.bindTexture(glCtx.TEXTURE_2D, fboB.tex);
            glCtx.uniform1i(uBlitTrail, 0);
            glCtx.uniform2f(uBlitRes, W, H);
            glCtx.bindVertexArray(blitVAO);
            glCtx.drawArrays(glCtx.TRIANGLES, 0, 6);

            // ---- swap FBOs ----
            const tmp = fboA; fboA = fboB; fboB = tmp;

            glCtx.bindVertexArray(null);
        },
    };

    return renderer;
}

if (gl) {
    glRenderer = initWebGL(gl);
    if (!glRenderer) console.warn('WebGL2 init failed; falling back to Canvas2D.');
}

// ---- WebSocket ----

function applyClientState(s) {
    if ('t' in s) transparentParticles  = s.t;
    if ('c' in s) sourceColorParticles  = s.c;
    if ('w' in s) { wetnessOverlay = s.w; if (!s.w) wetnessGrid = null; }
    if ('e' in s) { erosionOverlay = s.e; if (!s.e) erosionGrid  = null; }
    if ('h' in s) { hintVisible = !s.h; hintEl.classList.toggle('hidden', s.h); fpsEl.classList.toggle('hidden', s.h); }
    if ('b' in s) capillaryDiversion = s.b;
    if ('m' in s) mixSources = s.m;
    updateHint();
}

function applyDisplayTransform(t) {
    displayTransform = t;
    canvasWrap.style.clipPath = '';
    const sx = Math.max(0.01, (100 - t.insetLeft - t.insetRight) / 100);
    const sy = Math.max(0.01, (100 - t.insetTop - t.insetBottom) / 100);
    const tx = (t.insetLeft - t.insetRight) / 2 + (t.shiftRight - t.shiftLeft);
    const ty = (t.insetTop - t.insetBottom) / 2 + (t.shiftBottom - t.shiftTop);
    canvasWrap.style.transform = `translateX(${tx}%) translateY(${ty}%) scaleX(${sx}) scaleY(${sy})`;
    function fadePow(dir, depth) {
        const d = depth * 50;
        return `linear-gradient(${dir}, ` +
            `black 0%, ` +
            `rgba(0,0,0,0.85) ${(d * 0.15).toFixed(2)}%, ` +
            `rgba(0,0,0,0.5)  ${(d * 0.35).toFixed(2)}%, ` +
            `rgba(0,0,0,0.15) ${(d * 0.65).toFixed(2)}%, ` +
            `transparent      ${d.toFixed(2)}%)`;
    }
    const parts = [];
    if (t.fadeTop    > 0) parts.push(fadePow('to bottom', t.fadeTop));
    if (t.fadeBottom > 0) parts.push(fadePow('to top',    t.fadeBottom));
    if (t.fadeLeft   > 0) parts.push(fadePow('to right',  t.fadeLeft));
    if (t.fadeRight  > 0) parts.push(fadePow('to left',   t.fadeRight));
    vignetteEl.style.background = parts.length > 0 ? parts.join(', ') : 'none';
}

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
        connectFadeFrame = 0;
        showStatus('Connected', true);
        if (isProjector) ws.send(JSON.stringify({ type: 'register', role: 'projector' }));
        ws.send(JSON.stringify({ type: 'client_dimensions', width, height }));
    };

    ws.onmessage = (e) => {
        if (typeof e.data === 'string') {
            const msg = JSON.parse(e.data);
            if (msg.type === 'error' && msg.reason === 'projector_taken') {
                rejected = true;
                showStatus('Projector already connected — connection refused.', false);
                return;
            }
            if (msg.type === 'fps') serverFPS = msg.fps;
            if (msg.type === 'client_key') handleClientKey(msg.key);
            if (msg.type === 'display_transform') applyDisplayTransform(msg);
            if (msg.type === 'client_state') applyClientState(msg);
            if (msg.type === 'reset_ack') {
                awaitingReset = false;
                particles = [];
                connectFadeFrame = 0;
                if (glRenderer) glRenderer.clearTrail();
            }
            // Unit 3: server signals it will send Zstd-compressed binary frames
            if (msg.type === 'encoding' && msg.compression === 'zstd') {
                useZstd = typeof window.fzstd !== 'undefined';
                if (useZstd) console.log('Zstd decompression enabled');
            }
            return;
        }

        // Unit 3: Decompress if server is sending Zstd frames
        let rawBuf = e.data;
        if (useZstd) {
            try {
                rawBuf = window.fzstd.decompress(new Uint8Array(e.data)).buffer;
            } catch (err) {
                console.warn('Zstd decompress failed, using raw:', err);
                rawBuf = e.data;
            }
        }

        const view = new DataView(rawBuf);
        const type = view.getUint8(0);
        if (type === 0x00) unpackParticles(view);
        else if (type === 0x01) unpackGrid(view, 'wetness');
        else if (type === 0x02) unpackGrid(view, 'erosion');
    };

    let rejected = false;
    ws.onclose = () => {
        connected = false;
        if (rejected) return;
        showStatus('Disconnected — reconnecting…');
        setTimeout(connect, 2000);
    };
    ws.onerror = () => { ws.close(); };
}

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

function unpackGrid(view, which) {
    const cols   = view.getUint16(1, true);
    const rows   = view.getUint16(3, true);
    const maxVal = view.getFloat32(5, true);
    const data   = new Uint8Array(view.buffer, 9, cols * rows);
    if (which === 'wetness') wetnessGrid = { cols, rows, maxVal, data };
    else                     erosionGrid  = { cols, rows, maxVal, data };
}

// ---- Overlay & transform guide (Canvas2D on #overlay) ----

function renderTransformOverlay() {
    const t = displayTransform;
    const W = width, H = height;
    const ix1 = t.insetLeft   / 100 * W;
    const iy1 = t.insetTop    / 100 * H;
    const ix2 = W - t.insetRight  / 100 * W;
    const iy2 = H - t.insetBottom / 100 * H;
    const iw  = Math.max(0, ix2 - ix1);
    const ih  = Math.max(0, iy2 - iy1);
    const dx  = (t.shiftRight - t.shiftLeft) / 100 * W;
    const dy  = (t.shiftBottom - t.shiftTop) / 100 * H;
    const rx  = ix1 + dx, ry = iy1 + dy;
    overlayCtx.fillStyle = 'rgba(120, 30, 30, 0.45)';
    if (t.insetTop    > 0) overlayCtx.fillRect(0, 0, W, iy1);
    if (t.insetBottom > 0) overlayCtx.fillRect(0, iy2, W, H - iy2);
    if (t.insetLeft   > 0) overlayCtx.fillRect(0, 0, ix1, H);
    if (t.insetRight  > 0) overlayCtx.fillRect(ix2, 0, W - ix2, H);
    overlayCtx.strokeStyle = 'rgba(100, 130, 220, 0.85)';
    overlayCtx.lineWidth = 2;
    overlayCtx.strokeRect(rx, ry, iw, ih);
    if (dx !== 0 || dy !== 0) {
        const cx = W / 2, cy = H / 2;
        overlayCtx.strokeStyle = 'rgba(220, 200, 80, 0.75)';
        overlayCtx.lineWidth = 1.5;
        overlayCtx.setLineDash([6, 4]);
        overlayCtx.beginPath();
        overlayCtx.moveTo(cx, cy);
        overlayCtx.lineTo(cx + dx, cy + dy);
        overlayCtx.stroke();
        overlayCtx.setLineDash([]);
        overlayCtx.fillStyle = 'rgba(220, 200, 80, 0.9)';
        overlayCtx.beginPath();
        overlayCtx.arc(cx + dx, cy + dy, 5, 0, Math.PI * 2);
        overlayCtx.fill();
    }
    const fades = [
        { v: t.fadeTop,    x: rx,      y: ry,      w: iw,  h: ih * t.fadeTop    * 0.5, gx: [0,0,0,1] },
        { v: t.fadeBottom, x: rx,      y: ry + ih, w: iw,  h: ih * t.fadeBottom * 0.5, gx: [0,1,0,0] },
        { v: t.fadeLeft,   x: rx,      y: ry,      w: iw * t.fadeLeft   * 0.5, h: ih, gx: [0,0,1,0] },
        { v: t.fadeRight,  x: rx + iw, y: ry,      w: iw * t.fadeRight  * 0.5, h: ih, gx: [1,0,0,0] },
    ];
    for (const f of fades) {
        if (f.v <= 0) continue;
        const x0 = f.x - f.w * f.gx[0], y0 = f.y - f.h * f.gx[1];
        const x1 = f.x + f.w * f.gx[2], y1 = f.y + f.h * f.gx[3];
        const grad = overlayCtx.createLinearGradient(x0, y0, x1, y1);
        grad.addColorStop(0, 'rgba(60,80,180,0.55)');
        grad.addColorStop(1, 'rgba(60,80,180,0)');
        overlayCtx.fillStyle = grad;
        overlayCtx.fillRect(Math.min(x0, x1), Math.min(y0, y1), f.w || iw, f.h || ih);
    }
}

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
    fpsReportTimer += dt;
    if (fpsReportTimer >= 1000) {
        fpsReportTimer = 0;
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'client_fps', fps: Math.round(smoothFPS * 10) / 10 }));
        }
    }

    fadeToggle = !fadeToggle;

    // Overlay heatmaps + transform guide (always Canvas2D)
    overlayCtx.clearRect(0, 0, width, height);
    if (wetnessOverlay && wetnessGrid) renderWetness(wetnessGrid);
    if (erosionOverlay  && erosionGrid)  renderErosion(erosionGrid);
    if (transformOverlayVisible) renderTransformOverlay();

    if (awaitingReset || particles.length === 0) {
        // Keep canvas black while waiting for particles.
        // WebGL: blit the (cleared) FBO so the screen stays black.
        // Canvas2D: fill black instantly rather than fading slowly.
        if (glRenderer) {
            glRenderer.render({
                parts: [], fadeThisFrame: false, connectFade: 0,
                transparent: false, sourceColors: false,
                dpr: window.devicePixelRatio || 1,
            });
        } else if (ctx) {
            ctx.globalCompositeOperation = 'source-over';
            ctx.fillStyle = 'black';
            ctx.fillRect(0, 0, width, height);
        }
        return;
    }

    const connectFade = Math.min(connectFadeFrame / CONNECT_FADE_IN_FRAMES, 1.0);
    if (connectFadeFrame < CONNECT_FADE_IN_FRAMES) connectFadeFrame++;

    const dpr = window.devicePixelRatio || 1;

    if (glRenderer) {
        // Unit 6: WebGL2 path
        glRenderer.render({
            parts: particles,
            fadeThisFrame: fadeToggle,
            connectFade,
            transparent: transparentParticles,
            sourceColors: sourceColorParticles,
            dpr,
        });
    } else {
        // Unit 1: Canvas2D fallback with destination-out fade (no getImageData)
        if (fadeToggle) {
            // destination-out replaces the expensive getImageData/putImageData loop.
            // The uniform-rate fade approximates the "hold bright / fade dim" effect.
            ctx.globalCompositeOperation = 'destination-out';
            ctx.fillStyle = `rgba(0,0,0,${FADE_FAST_AMOUNT / 255})`;
            ctx.fillRect(0, 0, width, height);
            ctx.globalCompositeOperation = 'source-over';

            // Subtle blur softens trail edges (skip during fade-in)
            if (connectFadeFrame >= CONNECT_FADE_IN_FRAMES) {
                ctx.save();
                ctx.filter = `blur(${TRAIL_BLUR_RADIUS}px)`;
                ctx.globalAlpha = TRAIL_BLUR_ALPHA;
                ctx.drawImage(canvas, 0, 0);
                ctx.restore();
            }
        }

        // Draw particles with fillRect
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
}

// ---- Keyboard ----

function handleClientKey(key) {
    if (key === 'h' || key === 'H') {
        hintVisible = !hintVisible;
        hintEl.classList.toggle('hidden', !hintVisible);
        fpsEl.classList.toggle('hidden', !hintVisible);
        return;
    }
    if (key === 't' || key === 'T') { transparentParticles = !transparentParticles; updateHint(); return; }
    if (key === 'c' || key === 'C') { sourceColorParticles = !sourceColorParticles; updateHint(); return; }
    if (key === 'w' || key === 'W') {
        wetnessOverlay = !wetnessOverlay;
        if (!wetnessOverlay) wetnessGrid = null;
        if (ws && ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ type: 'overlay', grid: 'wetness' }));
        updateHint();
        return;
    }
    if (key === 'e' || key === 'E') {
        erosionOverlay = !erosionOverlay;
        if (!erosionOverlay) erosionGrid = null;
        if (ws && ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ type: 'overlay', grid: 'erosion' }));
        updateHint();
        return;
    }
    if (key === 'b' || key === 'B') { capillaryDiversion = !capillaryDiversion; updateHint(); }
    if (key === 'm' || key === 'M') { mixSources = !mixSources; updateHint(); }
    if (key === 'transform_overlay_toggle') { transformOverlayVisible = !transformOverlayVisible; return; }
    if (key === 'transform_overlay_refresh') { return; }
    if (key === 'reload') {
        if (ctx) { ctx.fillStyle = 'black'; ctx.fillRect(0, 0, width, height); }
        if (glRenderer) glRenderer.clearTrail();
        awaitingReset = true;
        window.location.reload();
    }
}

window.addEventListener('keydown', (e) => {
    if ('hHtTcCwWeE'.includes(e.key)) { handleClientKey(e.key); return; }
    if (e.key === '0') {
        if (ws && ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ type: 'reset' }));
        if (ctx) { ctx.fillStyle = 'black'; ctx.fillRect(0, 0, width, height); }
        if (glRenderer) glRenderer.clearTrail();
        particles = [];
        awaitingReset = true;
        return;
    }
    if (ws && ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: 'key', key: e.key }));
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
// canvas.addEventListener('mouseup',   (e) => { if (e.button === 0) mouseLeftDown = false; });

// ---- Start ----

connect();
animate();
updateHint();
