# PixelLab Prompts — Hex-World Agent Visualizer (StarCraft-style)

**Theme:** futuristic real-time-strategy, StarCraft-inspired. A **world = a base on a hex**,
a **worker = a harvesting/utility unit**, per-session **player colors** distinguish bases.

> ⚠️ **Gate note:** Art is **Phase 3**. Do NOT bulk-generate (spend PixelLab credits) until
> **Phase 2** placeholder render passes **GATE 2** and the motion is confirmed legible.
> These prompts are prepared ahead so generation is one paste away when we get there.

Animation/prop names below match the behavior keys in `config/behaviors.mjs` (single source
of truth). If you rename a clip, rename it there too.

---

## 0) Global style tokens — paste into EVERY prompt (keeps the set consistent)
```
top-down 3/4 isometric, 48x48, sci-fi real-time-strategy game unit, StarCraft-inspired,
sleek armored plating, glowing energy accents, neon rim light, dark metallic palette with
one bright team-color accent, clean readable silhouette, single light source top-left,
game asset, transparent background
```

## 1) Base worker unit (generate ONE; recolor for the rest)
```
<style tokens> — a compact bipedal utility drone / power-suit worker unit, rounded armored
hull, glowing single visor, back thrusters, small manipulator arms, friendly-menacing,
8 directional rotations
```
Then generate these **animations** on that unit (name = behavior key):

| Behavior key | Worker state | PixelLab animation prompt |
|---|---|---|
| `standby` | `idle` (waiting on model) | `idle hover: bob slightly, visor pulses, servos idle — awaiting orders` |
| `harvest` | `working:shell` (Bash/PowerShell) | `mining: fire a short laser cutter downward at a crystal, recoil, repeat` |
| `weld`    | `working:edit` (Edit/Write) | `welding: arc-weld a panel, bright sparks spray, repeat` |
| `scan`    | `working:read` (Read/Grep/Glob) | `scanning: sweep a handheld scanner beam left-to-right over a console` |
| `warp`    | `working:spawn` (Agent/Task) | `warp-in cast: raise arms, a glowing warp rift opens, energy crackles` |
| `uplink`  | `working:web` (WebFetch/Search) | `uplink: point up, a vertical comms beam connects to orbit, data pulses` |
| `operate` | `working:tool` (other) | `operate: tap a floating holo-panel, lights blink` |
| `walk`    | spawn-in / move | `hover-move cycle, 8 directions, thruster glow` |
| `powerdown` (unit half) | world `dormant` | `power down: settle to the ground, visor dims, steam vents` |

## 2) Environment (each "working" action needs a target to hit)
```
<style tokens> — hex platform floor tile, brushed metal with glowing seam edges, tileable
<style tokens> — a cluster of glowing blue mineral crystals prop        (harvest target)
<style tokens> — a half-built structure frame with weld points prop     (weld target)
<style tokens> — a holographic scanner console prop                     (scan target)
<style tokens> — a warp gate / spawning rift floor decal, glowing       (warp / spawn)
<style tokens> — a comms/satellite dish prop                            (uplink target)
<style tokens> — a central command hub building, dim when powered down  (base / dormant)
```

## 3) Per-world variants (readable status — the branch we picked)
Use PixelLab style-consistent recolor so each session's base/units read at a glance.
StarCraft-style player colors, up to ~8 parallel worlds:
```
same worker unit, team-color accent recolored to <color> — style-consistent variant
```
`red, blue, teal, purple, orange, yellow, green, pink`

## Recommended PixelLab settings
- **Size:** 48×48 (bump to 64×64 only if detail suffers); keep it uniform across the whole set.
- **View:** high top-down / isometric — matches the RTS "base builder" read.
- **Directions:** 8 for the unit (so it faces its target); props need none.
- **Start minimal for GATE 2 → 3:** one base unit + `standby`/`harvest`/`weld`/`walk`
  animations + the hex tile + mineral + structure props. Add `scan`/`warp`/`uplink`,
  recolors, and the rest only after the motion reads well.
