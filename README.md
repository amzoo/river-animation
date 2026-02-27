# Generative River Flow

A generative art simulation of natural river formation, erosion, and capillary branching — rendered in real time with vanilla HTML5 Canvas.

![Example Animation](demo.webp)

## Overview

Thousands of particles trace paths through a shifting noise-based flow field, depositing wetness and erosion as they go. Over time, rivers self-organize into branching networks with capillary tributaries, pooling deltas, and persistent trail marks.

Key techniques:
- **Fractional Brownian Motion (fBm)** via Simplex Noise for the underlying terrain
- **Wetness and erosion grids** that accumulate over time and influence particle behavior
- **Capillary branching** with isolated wetness/erosion grids that form tributaries off main rivers
- **Mouse interaction** — cursor acts as a flow source with burst mechanics

## How to Run

### Standalone (single machine)

No build step required. Open `index.html` in any modern browser.

### Server + Client (offload simulation to a faster machine)

If you need to run the display on a slower laptop (e.g. connected to a projector), you can run the physics on a faster server and stream the results over WebSocket on a local network.

**On the server machine:**

```bash
npm install
node server.js
```

The server runs the full 30,000-particle simulation at 1920×1080 and broadcasts binary particle frames to all connected clients at ~30fps. It logs `Sim ready. WS listening on :8080` on startup.

**On the display machine:**

Open `client.html` in a browser, passing the server's local IP:

```
client.html?server=192.168.1.10:8080
```

Replace `192.168.1.10` with the server's actual LAN IP address. The client renders the animation full-screen and forwards keyboard input back to the server.

The default port is `8080`. Override it with `PORT=9000 node server.js`.

**What stays on the client:** canvas rendering, trail fade, `T` (transparent) and `C` (source colors) toggles.

**What runs on the server:** all physics — noise gradients, wetness/erosion grids, river detection, capillary branching.

## Keyboard Controls

| Key | Action | Client mode |
|-----|--------|-------------|
| `B` | Toggle capillary diversion on/off | forwarded to server |
| `C` | Toggle source-colored particles | local |
| `D` | Toggle debug overlay (flow field, origins) | standalone only |
| `E` | Toggle erosion heatmap | standalone only |
| `M` | Toggle source mixing (disable river repulsion) | forwarded to server |
| `P` | Toggle particle stats overlay | standalone only |
| `R` | River sample mode (drag to select region) | standalone only |
| `T` | Toggle transparent particles | local |
| `W` | Toggle wetness heatmap | standalone only |
| `↑/↓` | Adjust sim speed (0.1x – 5x, default 1x) | forwarded to server |
| `[/]` | Adjust sample size (R mode) | standalone only |

## Mouse Controls

| Input | Action |
|-------|--------|
| Left click | Push arc — deflects nearby particles |
| Middle click | Particle burst |
| Scroll wheel | Adjust sample size (R mode) |
