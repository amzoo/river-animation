# Generative River Flow

A generative art simulation of natural river formation, erosion, and capillary branching — rendered in real time with vanilla HTML5 Canvas.

![Example Animation](demo.webp)

## Overview

Thousands of particles trace paths through a shifting noise-based flow field, depositing wetness and erosion as they go. Over time, rivers self-organize into branching networks with capillary tributaries, pooling deltas, and persistent trail marks.

Key techniques:
- **Fractional Brownian Motion (fBm)** via Simplex Noise for the underlying terrain
- **Wetness and erosion grids** that accumulate over time and influence particle behavior
- **Capillary pheromone trails** that attract nearby particles into branching tributaries
- **Mouse interaction** — cursor acts as a flow source with burst mechanics

## How to Run

No build step required. Open `index.html` in any modern browser.

## Keyboard Controls

| Key | Action |
|-----|--------|
| `D` | Toggle debug overlay (flow field, origins) |
| `W` | Toggle wetness heatmap |
| `E` | Toggle erosion heatmap |
| `T` | Toggle transparent particles |
| `C` | Toggle source-colored particles |
| `R` | River sample mode (drag to select region) |
