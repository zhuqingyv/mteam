# Renderer Lib — Reusable WebGL2 Components

This directory contains reusable WebGL2 rendering modules for animated visual effects.

## LiquidBorder — Animated SDF Flowing Border

Renders a smooth animated border with wobbling effect using Signed Distance Fields (SDF).

### Features

- Single color or gradient color support
- Activity-responsive glow and wobble
- Adaptive frame rate (24fps idle, 60fps active)
- Smooth SDF rendering with anti-aliasing
- Easy parameter customization

### Usage

```typescript
import { LiquidBorder } from './lib/liquid-border';

// Single color border (blue)
const border = new LiquidBorder(canvas, {
  colors: [100, 180, 255],
  cornerRadius: 8,
  borderWidth: 4,
});
border.start();

// Later, update activity level (0.0-1.0)
border.setActivity(0.8);

// Change color dynamically
border.setColor([255, 100, 100]);

// Cleanup
border.dispose();
```

### Multi-Color Gradient

```typescript
// Gradient that flows around the border
const border = new LiquidBorder(canvas, {
  colors: [
    [255, 0, 0],      // Red
    [0, 255, 0],      // Green
    [0, 0, 255],      // Blue
  ],
});
border.start();

// Update colors at runtime
border.setColors([
  [255, 100, 100],
  [100, 255, 100],
  [100, 100, 255],
]);
```

### API Reference

#### Constructor

```typescript
new LiquidBorder(canvas: HTMLCanvasElement, options: LiquidBorderOptions)
```

#### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `colors` | RGB triplet or array | Required | Color(s) in RGB 0-255 format |
| `cornerRadius` | number | 8 | Corner radius in pixels |
| `borderWidth` | number | 4 | Border width in pixels |
| `wobbleIntensity` | number | 1.0 | Wobble amplitude multiplier |
| `animationSpeed` | number | 1.0 | Animation speed multiplier |
| `idleFPS` | number | 24 | Frame rate when idle |
| `activeFPS` | number | 60 | Frame rate when active |
| `glowEnabled` | boolean | true | Enable glow effect |
| `activityMode` | boolean | true | Enable activity-responsive effects |
| `margin` | number | 8 | Margin from canvas edges (pixels) |

#### Methods

- `start()`: Start rendering
- `stop()`: Stop rendering
- `setActivity(level: 0.0-1.0)`: Update activity level for glow
- `setColor(color)`: Set single color
- `setColors(colors)`: Set gradient colors
- `dispose()`: Clean up WebGL resources

### Implementation Details

**SDF (Signed Distance Field)**

The border uses a rounded box SDF computed in the fragment shader. This provides smooth edges without jagged aliasing.

**Wobble Effect**

Three harmonic sine waves at different frequencies (5, 8, 13) create an organic flowing effect. Speed scales with activity level.

**Glow**

When active, an exponential decay glow extends outward from the border. Intensity correlates with activity level.

**Color Modes**

- **Single Color**: Direct RGB uniform
- **Gradient**: Colors interpolated by arc-length position around the border, with time-based offset for marquee effect

---

## TentacleRenderer — Animated Bezier Curves

Renders animated tentacles connecting boxes using cubic Bezier curves with color interpolation.

### Features

- Cubic Bezier curve path rendering
- Smooth color gradient along tentacle
- Dynamic geometry updates
- Multiple tentacles (up to 8)
- Width tapering from base to tip

### Usage

```typescript
import { TentacleRenderer } from './lib/tentacle-renderer';

const renderer = new TentacleRenderer(canvas);

// Add a tentacle from one box to another
renderer.addTentacle({
  fromBox: { x: 100, y: 100, w: 200, h: 150 },
  toBox: { x: 400, y: 400, w: 200, h: 150 },
  colorA: [255, 100, 100],  // Red at source
  colorB: [100, 100, 255],  // Blue at target
});

renderer.start();

// Add more tentacles as needed
renderer.addTentacle({
  fromBox: { x: 150, y: 150, w: 200, h: 150 },
  toBox: { x: 450, y: 350, w: 200, h: 150 },
  colorA: [100, 255, 100],  // Green
  colorB: [255, 255, 100],  // Yellow
});

// Clear all tentacles
renderer.clearTentacles();

// Cleanup
renderer.dispose();
```

### API Reference

#### Constructor

```typescript
new TentacleRenderer(canvas: HTMLCanvasElement)
```

#### Methods

- `addTentacle(params)`: Add a tentacle to render
- `clearTentacles()`: Remove all tentacles
- `start()`: Start rendering
- `stop()`: Stop rendering
- `dispose()`: Clean up WebGL resources

#### TentacleParams

```typescript
interface TentacleParams {
  fromBox: BoxGeometry;           // Source box
  toBox: BoxGeometry;             // Destination box
  colorA: [number, number, number]; // Color at source (RGB 0-255)
  colorB: [number, number, number]; // Color at destination (RGB 0-255)
  reach?: number;                 // Width multiplier (default: 1.0)
  headPos?: number;               // Head position [0,1] (default: 1.0)
  tailPos?: number;               // Tail position [0,1] (default: 0.0)
  fuse?: number;                  // Animation state (default: 1.0)
}

interface BoxGeometry {
  x: number;  // X coordinate
  y: number;  // Y coordinate
  w: number;  // Width
  h: number;  // Height
}
```

### Implementation Details

**Bezier Curves**

The tentacle path is defined by a cubic Bezier curve with:
- p0: Edge exit point from source box
- p1, p2: Control points (pulled toward center midpoint)
- p3: Edge exit point from destination box

Control points are computed to create a gentle pull toward the center.

**Width Profile**

- Base: 1.2x the configured width at the root
- Middle: 0.35x at the curve midpoint
- Parabolic tapering along the curve
- Head and tail fade to point (smoothstep)

**Color Interpolation**

Color smoothly transitions from colorA to colorB along the Bezier parameter (0 to 1).

---

## Integration Examples

### Terminal Border

```typescript
import { LiquidBorder } from './lib/liquid-border';

const canvas = document.getElementById('border-canvas');
const border = new LiquidBorder(canvas, {
  colors: [100, 150, 255],
  cornerRadius: 8,
  borderWidth: 4,
  activityMode: true,
});

// Update activity from PTY output
setInterval(() => {
  const activity = (window as any).__borderActivity || 0;
  border.setActivity(activity);
}, 50);

border.start();
```

### Panel Border with Member Colors

```typescript
import { LiquidBorder } from './lib/liquid-border';

const canvas = document.getElementById('border-canvas');
const border = new LiquidBorder(canvas, {
  colors: [
    [100, 150, 255],
    [150, 100, 255],
    [255, 100, 150],
  ],
  cornerRadius: 12,
  borderWidth: 4,
  glowEnabled: false,
  activityMode: false,
});

// Update colors from team status
teamHub.onStatusUpdate((status) => {
  const colors = status.members.map(m => uidToColorRgb(m.uid));
  border.setColors(colors);
});

border.start();
```

### Overlay Tentacles

```typescript
import { TentacleRenderer } from './lib/tentacle-renderer';

const canvas = document.getElementById('overlay-canvas');
const renderer = new TentacleRenderer(canvas);

// Add tentacles between window positions
windowPositions.forEach(pos => {
  if (pos.fromId && pos.toId) {
    renderer.addTentacle({
      fromBox: getBoxForId(pos.fromId),
      toBox: getBoxForId(pos.toId),
      colorA: getColorForMember(pos.from),
      colorB: getColorForMember(pos.to),
    });
  }
});

renderer.start();
```

---

## Performance Considerations

- **Adaptive Frame Rate**: Idle (24fps) vs Active (60fps) reduces CPU usage when nothing is happening
- **Discard Early**: Fragment shader uses `discard` to skip pixels outside the border/tentacle
- **Uniform Updates**: Color changes are applied via uniforms (hot path)
- **Device Pixel Ratio**: All sizes scale with DPR for crisp rendering on high-DPI displays

## Browser Compatibility

Requires WebGL2 support. Tested on:
- Chrome/Chromium 60+
- Firefox 55+
- Safari 15+
- Electron (any recent version)

