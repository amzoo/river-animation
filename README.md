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

No build step required. Open `index.html` in any modern browser.

## Keyboard Controls

| Key | Action |
|-----|--------|
| `B` | Toggle capillary diversion on/off |
| `C` | Toggle source-colored particles |
| `D` | Toggle debug overlay (flow field, origins) |
| `E` | Toggle erosion heatmap |
| `M` | Toggle source mixing (disable river repulsion) |
| `P` | Toggle particle stats overlay |
| `R` | River sample mode (drag to select region) |
| `T` | Toggle transparent particles |
| `W` | Toggle wetness heatmap |
| `↑/↓` | Adjust sim speed (0.1x – 5x, default 1x) |
| `[/]` | Adjust sample size (R mode) |
