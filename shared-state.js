'use strict';

// Constants shared between the main WebSocket thread (server.js) and the
// simulation worker thread (sim-worker.js).  Keeping them here avoids
// duplication and ensures both sides agree on values.

const SIM_WIDTH       = 1920;
const SIM_HEIGHT      = 1080;
const TARGET_FPS      = 30;
const GRID_SEND_EVERY = 6; // send grid overlays every N particle frames (~5 fps)

module.exports = { SIM_WIDTH, SIM_HEIGHT, TARGET_FPS, GRID_SEND_EVERY };
