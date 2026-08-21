/* ============================================================
   EMBERFALL — game.js
   Vanilla JS precision platformer. Celeste movement + Dark Souls rage.

   Structure:
     1. Tunable constants (physics & hazards)
     2. Input manager
     3. Utility helpers
     4. Level / gauntlet data (data-driven)
     5. Level builder + collision queries
     6. Particles
     7. Player (movement + collision)
     8. Camera
     9. Game state machine & flow
    10. Rendering
    11. Main loop (fixed timestep)
   ============================================================ */

'use strict';

/* ============================================================
   1. TUNABLE CONSTANTS
   ============================================================ */
const CFG = {
  // World / grid
  TILE: 30,                 // tile size in px
  VIEW_W: 960,              // canvas width
  VIEW_H: 540,              // canvas height

  // Movement (Celeste-style, momentum based)
  MOVE_ACCEL: 2600,         // ground horizontal acceleration (px/s^2)
  MOVE_ACCEL_AIR: 1750,     // air horizontal acceleration (px/s^2)
  FRICTION: 2200,           // ground friction (px/s^2 of decel)
  AIR_FRICTION: 420,        // air drag when no direction held (px/s^2)
  MAX_SPEED: 340,           // max run speed px/s
  GRAVITY: 2000,            // gravity (px/s^2)
  GRAVITY_APEX: 0.72,       // gravity multiplier near jump apex (float-y feel)
  APEX_WINDOW: 90,          // |vy| below this counts as apex (px/s)
  MAX_FALL: 720,            // terminal fall speed px/s

  // Jump — variable height via cut-on-release
  JUMP_SPEED: 640,          // initial jump velocity px/s
  JUMP_CUT_MULT: 0.38,      // velocity multiplier when released early
  COYOTE_TIME: 0.09,        // grace period to jump after leaving ground (s)
  JUMP_BUFFER: 0.12,        // press-early grace before landing (s)

  // Wall interaction
  WALL_PROBE: 3,            // px probe distance used to detect wall contact
  WALL_SLIDE_MAX: 130,      // max wall-slide speed px/s
  WALL_SLIDE_GRAV: 0.45,    // gravity multiplier while sliding
  WALL_JUMP_X: 430,         // wall-jump horizontal speed
  WALL_JUMP_Y: 560,         // wall-jump vertical speed
  WALL_COYOTE: 0.08,        // grace period to wall-jump after leaving a wall (s)
  WALL_STICK: 0.14,         // time horizontal input is damped after a wall jump (s)

  // Dash — one per grounding, cuts vertical momentum
  DASH_SPEED: 900,          // dash speed px/s
  DASH_TIME: 0.16,          // active dash time (s)
  DASH_COOLDOWN: 0.28,      // cooldown after dash (s)
  DASH_EXIT_MULT: 0.5,      // fraction of dash speed kept when it ends
  DASH_BUFFER: 0.12,        // press-early grace for dash (s)

  // Camera
  CAM_LERP: 9,              // camera follow stiffness
  CAM_LOOK: 40,             // look-ahead in the facing direction (px)

  // Juice
  SHAKE_MAX: 12,            // max screen shake px
  SHAKE_DECAY: 26,          // shake decay per second
  DEATH_FREEZE: 0.55,       // death animation before the overlay (s)

  // Colors
  COLORS: {
    player: '#ffb74d',
    playerDark: '#d97b2a',
    hazard: '#d64545',
    hazardEdge: '#ff6b6b',
    checkpoint: '#4f8f63',
    checkpointActive: '#b6ff9e',
    solid: '#2a2529',
    solidEdge: '#3d353c',
    solidTop: '#4a3f45',
    dust: '#c9bfb0',
    ember: '#ff9055',
    metal: '#8d8792',
    metalDark: '#514b58',
  },
};

/* ============================================================
   2. INPUT MANAGER
   ------------------------------------------------------------
   Tracks physical key codes, then derives logical actions from
   them. Several codes can map to one action, so an action is
   only "up" once every code bound to it is up.
   ============================================================ */
const Input = (() => {
  const KEY_MAP = {
    ArrowLeft: 'left', KeyA: 'left',
    ArrowRight: 'right', KeyD: 'right',
    ArrowUp: 'jump', KeyW: 'jump', Space: 'jump',
    ShiftLeft: 'dash', ShiftRight: 'dash', KeyS: 'dash', ArrowDown: 'dash',
    KeyR: 'respawn',
    Escape: 'pause',
  };

  const codesDown = new Set();
  const pressed = new Set();   // edge: became down this frame
  const released = new Set();  // edge: became up this frame

  const actionIsDown = (action) => {
    for (const code of codesDown) if (KEY_MAP[code] === action) return true;
    return false;
  };

  window.addEventListener('keydown', (e) => {
    const action = KEY_MAP[e.code];
    if (!action) return;
    e.preventDefault();
    if (e.repeat || codesDown.has(e.code)) return;
    const wasDown = actionIsDown(action);
    codesDown.add(e.code);
    if (!wasDown) pressed.add(action);
  });

  window.addEventListener('keyup', (e) => {
    const action = KEY_MAP[e.code];
    if (!action) return;
    e.preventDefault();
    if (!codesDown.delete(e.code)) return;
    if (!actionIsDown(action)) released.add(action);
  });

  // Held keys must not survive an alt-tab, or the player runs off on return.
  window.addEventListener('blur', () => {
    codesDown.clear();
    pressed.clear();
    released.clear();
  });

  return {
    isDown: actionIsDown,
    wasPressed: (a) => pressed.has(a),
    wasReleased: (a) => released.has(a),
    // Clear the per-frame edges. Called once at the end of every frame.
    consume: () => { pressed.clear(); released.clear(); },
  };
})();

/* ============================================================
   3. UTILITY
   ============================================================ */
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;
// Frame-rate independent exponential approach.
const damp = (a, b, rate, dt) => lerp(a, b, 1 - Math.exp(-rate * dt));

function rectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x &&
         a.y < b.y + b.h && a.y + a.h > b.y;
}

const roundRect = (ctx, x, y, w, h, r) => {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
};

/* ============================================================
   4. LEVEL / GAUNTLET DATA
   ------------------------------------------------------------
   Data-driven gauntlets. Every row is exactly 32 chars wide and
   every gauntlet is 18 rows tall, so one gauntlet is exactly one
   960x540 screen (32*30 x 18*30).

   Tile legend (single char per tile):
     '.' empty    '#' solid
     'S' spike (points up)      's' spike (points down)
     '^' spike (points left)    '|' spike (points right)
     'P' player start           'C' checkpoint      'G' goal

   Moving hazards are defined separately in `movers`, in pixels:
     { type:'saw'|'crusher', x, y, w, h,
       move: { axis:'x'|'y', min, max, speed, phase } }
   They ping-pong between min and max; `phase` offsets them in
   seconds so several movers don't march in lockstep.
   ============================================================ */
const GAUNTLETS = [
  {
    name: 'GAUNTLET I — THE AWAKENING',
    tiles: [
      '################################',
      '#..............................#',
      '#..............................#',
      '#..............................#',
      '#..............................#',
      '#..............................#',
      '#..............................#',
      '#...................G..........#',
      '#..................####........#',
      '#..............................#',
      '#.............C................#',
      '#............####..............#',
      '#..............................#',
      '#..............................#',
      '#......####....................#',
      '#..............................#',
      '#.P...SS........SS......SS.....#',
      '################################',
    ],
    movers: [],
  },
  {
    name: 'GAUNTLET II — THE DESCENT',
    tiles: [
      '################################',
      '#..............................#',
      '#.P............................#',
      '#####..........................#',
      '#..............................#',
      '#..............................#',
      '#............####..............#',
      '#..............................#',
      '#..............................#',
      '#.....................####.....#',
      '#..............................#',
      '#..............................#',
      '#....####......................#',
      '#..............................#',
      '#..............................#',
      '#..............................#',
      '#...C..........SS.............G#',
      '##########...###########...#####',
    ],
    movers: [
      { type: 'saw', x: 540, y: 466, w: 44, h: 44, move: { axis: 'x', min: 540, max: 690, speed: 150, phase: 0 } },
      { type: 'saw', x: 270, y: 300, w: 44, h: 44, move: { axis: 'y', min: 250, max: 450, speed: 190, phase: 1.5 } },
    ],
  },
  {
    name: 'GAUNTLET III — THE CRUSHERS',
    tiles: [
      '################################',
      '#..............................#',
      '#..............................#',
      '#..............................#',
      '#..............................#',
      '#..............................#',
      '#..............................#',
      '#..............................#',
      '#..............................#',
      '#..............####............#',
      '#..............................#',
      '#..............................#',
      '#...####.......................#',
      '#..............................#',
      '#......................#####...#',
      '#..............................#',
      '#.P..C.......................G.#',
      '########...#############...#####',
    ],
    movers: [
      // Crushing pistons — vertical kill zones on a hard cadence.
      { type: 'crusher', x: 360, y: 30, w: 54, h: 90, move: { axis: 'y', min: 30, max: 420, speed: 320, phase: 0 } },
      { type: 'crusher', x: 600, y: 30, w: 54, h: 90, move: { axis: 'y', min: 30, max: 420, speed: 300, phase: 1.4 } },
      { type: 'saw', x: 420, y: 466, w: 44, h: 44, move: { axis: 'x', min: 420, max: 620, speed: 220, phase: 0.5 } },
    ],
  },
  {
    name: 'GAUNTLET IV — THE EMBER LORD',
    tiles: [
      '################################',
      '#..............................#',
      '#..............................#',
      '#....................G.........#',
      '#...................####.......#',
      '#..............................#',
      '#..............................#',
      '#........................####..#',
      '#..............................#',
      '#..............................#',
      '#...................####.......#',
      '#..............................#',
      '#..............................#',
      '#..............####............#',
      '#..............................#',
      '#..............................#',
      '#.P.C..........................#',
      '##########...#########...#######',
    ],
    movers: [
      { type: 'saw', x: 400, y: 466, w: 44, h: 44, move: { axis: 'x', min: 400, max: 560, speed: 240, phase: 0 } },
      { type: 'saw', x: 300, y: 300, w: 44, h: 44, move: { axis: 'y', min: 200, max: 450, speed: 260, phase: 1 } },
      { type: 'crusher', x: 225, y: 30, w: 50, h: 96, move: { axis: 'y', min: 30, max: 400, speed: 340, phase: 2.5 } },
    ],
  },
];

/* ============================================================
   5. LEVEL BUILDER + COLLISION QUERIES
   ============================================================ */
const SOLID = '#';
const SPIKE_CHARS = { S: 'up', s: 'down', '^': 'left', '|': 'right' };

const PLAYER_W = 22;
const PLAYER_H = 28;

// Spike hitboxes are deliberately smaller than their tile so grazing
// the base of a spike doesn't kill.
function spikeHitbox(col, row, dir) {
  const T = CFG.TILE;
  const x = col * T, y = row * T;
  const thin = T * 0.5, pad = 5;
  switch (dir) {
    case 'up':    return { x: x + pad, y: y + T - thin, w: T - pad * 2, h: thin };
    case 'down':  return { x: x + pad, y: y,            w: T - pad * 2, h: thin };
    case 'left':  return { x: x,       y: y + pad,      w: thin,        h: T - pad * 2 };
    default:      return { x: x + T - thin, y: y + pad, w: thin,        h: T - pad * 2 };
  }
}

function buildLevel(def) {
  const T = CFG.TILE;
  const tiles = def.tiles.map((row) => row.split(''));

  const level = {
    name: def.name,
    tiles,
    rows: tiles.length,
    cols: tiles[0].length,
    w: tiles[0].length * T,
    h: tiles.length * T,
    spikes: [],
    checkpoints: [],
    goal: null,
    spawn: { x: T, y: T },
    movers: (def.movers || []).map((m) => ({ ...m, move: { ...m.move } })),
  };

  // Ragged rows silently corrupt collision, so fail loudly instead.
  const bad = tiles.findIndex((r) => r.length !== level.cols);
  if (bad !== -1) {
    console.error(`[emberfall] "${def.name}" row ${bad} is ${tiles[bad].length} tiles, expected ${level.cols}.`);
  }

  for (let row = 0; row < level.rows; row++) {
    for (let col = 0; col < level.cols; col++) {
      const ch = tiles[row][col];
      if (SPIKE_CHARS[ch]) {
        level.spikes.push({ col, row, dir: SPIKE_CHARS[ch], box: spikeHitbox(col, row, SPIKE_CHARS[ch]) });
      } else if (ch === 'P') {
        level.spawn = { x: col * T + (T - PLAYER_W) / 2, y: row * T + (T - PLAYER_H) };
      } else if (ch === 'C') {
        level.checkpoints.push({
          col, row, active: false,
          box: { x: col * T + 4, y: row * T + 2, w: T - 8, h: T - 2 },
          spawn: { x: col * T + (T - PLAYER_W) / 2, y: row * T + (T - PLAYER_H) },
        });
      } else if (ch === 'G') {
        level.goal = { col, row, box: { x: col * T + 5, y: row * T + 3, w: T - 10, h: T - 3 } };
      }
    }
  }

  if (!level.goal) console.error(`[emberfall] "${def.name}" has no goal tile.`);
  return level;
}

function solidAt(level, col, row) {
  if (row < 0 || row >= level.rows) return false;
  if (col < 0 || col >= level.cols) return false;
  return level.tiles[row][col] === SOLID;
}

// Does an axis-aligned box overlap any solid tile?
function probeCollides(box, level) {
  const T = CFG.TILE;
  const c0 = Math.floor(box.x / T);
  const c1 = Math.floor((box.x + box.w - 0.001) / T);
  const r0 = Math.floor(box.y / T);
  const r1 = Math.floor((box.y + box.h - 0.001) / T);
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      if (solidAt(level, c, r)) return true;
    }
  }
  return false;
}

function moverBox(m) {
  return { x: m.x, y: m.y, w: m.w, h: m.h };
}

// Ping-pong a mover along its axis. Position is a pure function of
// time, so respawning mid-gauntlet never desyncs the hazards.
function updateMovers(level, time) {
  for (const m of level.movers) {
    const mv = m.move;
    const range = mv.max - mv.min;
    if (range <= 0) { m[mv.axis] = mv.min; continue; }
    const cycle = (range * 2) / mv.speed;
    let t = ((time + (mv.phase || 0)) % cycle + cycle) % cycle;
    const travelled = t * mv.speed;
    m[mv.axis] = mv.min + (travelled <= range ? travelled : range * 2 - travelled);
  }
}

// Returns the hazard the player is touching, or null.
function checkHazards(player, level) {
  const box = player.hurtBox();
  for (const s of level.spikes) {
    if (rectsOverlap(box, s.box)) return { kind: 'spike', ref: s };
  }
  for (const m of level.movers) {
    if (rectsOverlap(box, moverBox(m))) return { kind: m.type, ref: m };
  }
  // Fell out of the world.
  if (player.y > level.h + 40) return { kind: 'pit', ref: null };
  return null;
}

/* ============================================================
   6. PARTICLES
   ============================================================ */
class ParticleSystem {
  constructor() { this.particles = []; }

  clear() { this.particles.length = 0; }

  emit(x, y, opts = {}) {
    const count = opts.count ?? 6;
    for (let i = 0; i < count; i++) {
      const angle = opts.angle != null
        ? opts.angle + (opts.spread != null ? (Math.random() - 0.5) * opts.spread : 0)
        : Math.random() * Math.PI * 2;
      const speed = (opts.speed ?? 120) * (0.5 + Math.random() * 0.75);
      this.particles.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - (opts.upBias ?? 0),
        life: opts.life ?? 0.5,
        maxLife: opts.life ?? 0.5,
        size: opts.size ?? 3,
        color: opts.color ?? CFG.COLORS.dust,
        gravity: opts.gravity ?? 900,
        fade: opts.fade ?? true,
      });
    }
  }

  update(dt) {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.vy += p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
      // ground the dust a touch
      if (p.vy > 0) p.vx *= (1 - 2.5 * dt);
      if (p.life <= 0) this.particles.splice(i, 1);
    }
  }

  draw(ctx, cam) {
    for (const p of this.particles) {
      const a = p.fade ? clamp(p.life / p.maxLife, 0, 1) : 1;
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      const s = p.size * (0.6 + a * 0.5);
      ctx.fillRect(Math.round(p.x - cam.x - s / 2), Math.round(p.y - cam.y - s / 2), s, s);
    }
    ctx.globalAlpha = 1;
  }
}

/* ============================================================
   7. PLAYER
   ============================================================ */
class Player {
  constructor(startX, startY) {
    this.w = PLAYER_W;
    this.h = PLAYER_H;
    this.trail = [];   // dash streak positions
    this.reset(startX, startY);
  }

  reset(startX, startY) {
    this.x = startX;
    this.y = startY;
    this.vx = 0;
    this.vy = 0;
    this.onGround = false;
    this.wallLeft = false;
    this.wallRight = false;
    this.wallSliding = false;
    this.coyote = 0;
    this.wallCoyote = 0;
    this.wallCoyoteDir = 0;    // -1 wall was on the left, +1 on the right
    this.wallStick = 0;
    this.jumpBuffer = 0;
    this.jumpCutQueued = false;
    this.dashing = false;
    this.dashTimer = 0;
    this.dashCooldown = 0;
    this.dashBuffer = 0;
    this.dashDir = 1;
    this.hasDash = true;       // one dash per grounding / wall touch
    this.dead = false;
    this.sx = 1; this.sy = 1;  // visual squash / stretch
    this.trail.length = 0;
    this.facing = 1;
  }

  // Slightly inset from the collision box so hazards feel fair.
  hurtBox() {
    return { x: this.x + 4, y: this.y + 4, w: this.w - 8, h: this.h - 7 };
  }

  update(dt, level, particles) {
    if (this.dead) return;

    // --- Timers ---
    this.dashCooldown = Math.max(0, this.dashCooldown - dt);
    this.coyote = Math.max(0, this.coyote - dt);
    this.wallCoyote = Math.max(0, this.wallCoyote - dt);
    this.wallStick = Math.max(0, this.wallStick - dt);
    this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);
    this.dashBuffer = Math.max(0, this.dashBuffer - dt);

    // --- Wall contact (needed before jumps so wall-jumps can fire) ---
    this.detectWalls(level);

    // --- Dash trigger (buffered press, one dash per grounding) ---
    if (this.dashBuffer > 0 && this.hasDash && this.dashCooldown <= 0 && !this.dashing) {
      this.dashBuffer = 0;
      this.startDash(Input.isDown('right') ? 1 : Input.isDown('left') ? -1 : this.facing);
    }

    if (this.dashing) {
      this.updateDash(dt, particles);
    } else {
      this.updateMovement(dt);
    }

    // --- Jump (buffered press) ---
    if (this.jumpBuffer > 0) this.tryJump(particles);

    // --- Variable jump height: cut the rise when the key is released ---
    if (this.jumpCutQueued) {
      this.jumpCutQueued = false;
      if (this.vy < 0) this.vy *= CFG.JUMP_CUT_MULT;
    }

    // --- Gravity (skipped mid-dash, reduced while wall sliding) ---
    if (!this.dashing) {
      if (this.wallSliding && this.vy >= 0) {
        this.vy = Math.min(this.vy + CFG.GRAVITY * CFG.WALL_SLIDE_GRAV * dt, CFG.WALL_SLIDE_MAX);
      } else {
        const g = Math.abs(this.vy) < CFG.APEX_WINDOW ? CFG.GRAVITY * CFG.GRAVITY_APEX : CFG.GRAVITY;
        this.vy = Math.min(this.vy + g * dt, CFG.MAX_FALL);
      }
    }

    // --- Move & collide ---
    const wasOnGround = this.onGround;
    this.moveAndCollide(dt, level);

    // --- Landing: refill dash + coyote, squash, kick up dust ---
    if (this.onGround) {
      this.coyote = CFG.COYOTE_TIME;
      this.hasDash = true;
      if (!wasOnGround) {
        this.sx = 1.35; this.sy = 0.7;
        particles.emit(this.x + this.w / 2, this.y + this.h, {
          count: 6, speed: 80, life: 0.32, size: 3,
          color: CFG.COLORS.dust, gravity: 700, angle: -Math.PI / 2, spread: 2.6, upBias: 10,
        });
      }
    }
    if (this.wallLeft || this.wallRight) this.hasDash = true;

    // --- Squash/stretch recovery ---
    this.sx = damp(this.sx, 1, 14, dt);
    this.sy = damp(this.sy, 1, 14, dt);

    // --- Trail for dash afterimages ---
    this.trail.push({ x: this.x, y: this.y, dir: this.facing, dashing: this.dashing });
    if (this.trail.length > 8) this.trail.shift();
  }

  startDash(dir) {
    this.dashing = true;
    this.dashTimer = CFG.DASH_TIME;
    this.dashCooldown = CFG.DASH_COOLDOWN;
    this.dashDir = dir;
    this.facing = dir;
    this.hasDash = false;    // refilled by touching ground or a wall
    this.vy = 0;             // break the fall
    this.wallSliding = false;
    this.sx = 1.4; this.sy = 0.65;
    Game.shake(4);
  }

  updateDash(dt, particles) {
    this.dashTimer -= dt;
    this.vx = this.dashDir * CFG.DASH_SPEED;
    this.vy = 0;
    if (Math.random() < 0.8) {
      particles.emit(this.x + this.w / 2, this.y + this.h / 2, {
        count: 1, speed: 40, life: 0.3, size: 4,
        color: CFG.COLORS.ember, gravity: 0, spread: 1.2, upBias: 0,
      });
    }
    if (this.dashTimer <= 0) {
      this.dashing = false;
      this.vx = this.dashDir * CFG.DASH_SPEED * CFG.DASH_EXIT_MULT;
    }
  }

  updateMovement(dt) {
    const wantLeft = Input.isDown('left');
    const wantRight = Input.isDown('right');
    const dir = (wantRight ? 1 : 0) - (wantLeft ? 1 : 0);
    if (dir !== 0 && this.wallStick <= 0) this.facing = dir;

    const accel = this.onGround ? CFG.MOVE_ACCEL : CFG.MOVE_ACCEL_AIR;
    // Right after a wall jump, damp steering so the kick-off actually lands.
    const control = this.wallStick > 0 ? 0.25 : 1;

    if (dir !== 0) {
      const decel = (this.onGround ? CFG.FRICTION : CFG.AIR_FRICTION) * dt;
      if (Math.abs(this.vx) > CFG.MAX_SPEED && Math.sign(this.vx) === dir) {
        // Already over the cap (dash exit, wall-jump kick): bleed it off toward
        // MAX_SPEED instead of accelerating, so run speed can never run away.
        this.vx = Math.max(Math.abs(this.vx) - decel, CFG.MAX_SPEED) * dir;
      } else {
        this.vx += dir * accel * control * dt;
        if (Math.abs(this.vx) > CFG.MAX_SPEED && Math.sign(this.vx) === dir) {
          this.vx = CFG.MAX_SPEED * dir;
        }
      }
    } else {
      const decel = (this.onGround ? CFG.FRICTION : CFG.AIR_FRICTION) * dt;
      if (this.vx > 0) this.vx = Math.max(0, this.vx - decel);
      else this.vx = Math.min(0, this.vx + decel);
    }
  }

  tryJump(particles) {
    // Ground jump (with coyote time)
    if (this.onGround || this.coyote > 0) {
      this.jumpBuffer = 0;
      this.coyote = 0;
      this.vy = -CFG.JUMP_SPEED;
      this.onGround = false;
      this.sx = 0.7; this.sy = 1.35;
      particles.emit(this.x + this.w / 2, this.y + this.h, {
        count: 7, speed: 90, life: 0.4, size: 3,
        color: CFG.COLORS.dust, gravity: 500, angle: -Math.PI / 2, spread: 2.4, upBias: 40,
      });
      return;
    }

    // Wall jump — kicks away from the wall (with a short grace window)
    let wallDir = 0;
    if (this.wallLeft) wallDir = -1;
    else if (this.wallRight) wallDir = 1;
    else if (this.wallCoyote > 0) wallDir = this.wallCoyoteDir;

    if (wallDir !== 0) {
      this.jumpBuffer = 0;
      this.wallCoyote = 0;
      this.wallSliding = false;
      this.vy = -CFG.WALL_JUMP_Y;
      this.vx = -wallDir * CFG.WALL_JUMP_X;   // wall on the left pushes right
      this.facing = -wallDir;
      this.wallStick = CFG.WALL_STICK;
      this.hasDash = true;
      this.sx = 0.7; this.sy = 1.3;
      particles.emit(this.x + this.w / 2 + wallDir * this.w / 2, this.y + this.h / 2, {
        count: 8, speed: 130, life: 0.4, size: 3,
        color: CFG.COLORS.ember, gravity: 300, angle: wallDir > 0 ? 0 : Math.PI, spread: 1.6, upBias: 60,
      });
    }
  }

  detectWalls(level) {
    const p = CFG.WALL_PROBE;
    // Probe a thin strip just outside each side of the body. Inset the
    // strip vertically so a floor or ceiling tile never reads as a wall.
    const probeLeft = { x: this.x - p, y: this.y + 2, w: p, h: this.h - 4 };
    const probeRight = { x: this.x + this.w, y: this.y + 2, w: p, h: this.h - 4 };
    this.wallLeft = probeCollides(probeLeft, level);
    this.wallRight = probeCollides(probeRight, level);

    if (this.wallLeft || this.wallRight) {
      this.wallCoyote = CFG.WALL_COYOTE;
      this.wallCoyoteDir = this.wallLeft ? -1 : 1;
    }

    // Slide only while falling, airborne, and actively pressing into the wall.
    const pressingIn = (this.wallLeft && Input.isDown('left')) ||
                       (this.wallRight && Input.isDown('right'));
    this.wallSliding = !this.onGround && !this.dashing && this.vy > 0 && pressingIn;
  }

  moveAndCollide(dt, level) {
    // Horizontal
    this.x += this.vx * dt;
    this.resolveHorizontal(level);

    // Vertical
    this.onGround = false;
    this.y += this.vy * dt;
    this.resolveVertical(level);
  }

  resolveHorizontal(level) {
    const T = CFG.TILE;
    const r0 = Math.floor(this.y / T);
    const r1 = Math.floor((this.y + this.h - 0.001) / T);

    if (this.vx > 0) {
      const col = Math.floor((this.x + this.w - 0.001) / T);
      for (let r = r0; r <= r1; r++) {
        if (solidAt(level, col, r)) {
          this.x = col * T - this.w;
          this.vx = 0;
          if (this.dashing) this.endDashOnImpact();
          break;
        }
      }
    } else if (this.vx < 0) {
      const col = Math.floor(this.x / T);
      for (let r = r0; r <= r1; r++) {
        if (solidAt(level, col, r)) {
          this.x = (col + 1) * T;
          this.vx = 0;
          if (this.dashing) this.endDashOnImpact();
          break;
        }
      }
    }
  }

  resolveVertical(level) {
    const T = CFG.TILE;
    const c0 = Math.floor(this.x / T);
    const c1 = Math.floor((this.x + this.w - 0.001) / T);

    if (this.vy > 0) {
      const row = Math.floor((this.y + this.h - 0.001) / T);
      for (let c = c0; c <= c1; c++) {
        if (solidAt(level, c, row)) {
          this.y = row * T - this.h;
          this.vy = 0;
          this.onGround = true;
          break;
        }
      }
    } else if (this.vy < 0) {
      const row = Math.floor(this.y / T);
      for (let c = c0; c <= c1; c++) {
        if (solidAt(level, c, row)) {
          this.y = (row + 1) * T;
          this.vy = 0;
          break;
        }
      }
    }
  }

  endDashOnImpact() {
    this.dashing = false;
    this.dashTimer = 0;
  }
}

/* ============================================================
   8. CAMERA
   ------------------------------------------------------------
   Follows the player and clamps to the level bounds. Gauntlets are
   exactly one screen, so in practice it only ever adds screen shake,
   but larger rooms scroll for free.
   ============================================================ */
class Camera {
  constructor() { this.x = 0; this.y = 0; this.shakeAmt = 0; this.ox = 0; this.oy = 0; }

  snap(player, level) {
    const t = this.target(player, level);
    this.x = t.x; this.y = t.y;
    this.shakeAmt = 0; this.ox = 0; this.oy = 0;
  }

  target(player, level) {
    let x = player.x + player.w / 2 + player.facing * CFG.CAM_LOOK - CFG.VIEW_W / 2;
    let y = player.y + player.h / 2 - CFG.VIEW_H / 2;
    x = clamp(x, 0, Math.max(0, level.w - CFG.VIEW_W));
    y = clamp(y, 0, Math.max(0, level.h - CFG.VIEW_H));
    return { x, y };
  }

  update(dt, player, level) {
    const t = this.target(player, level);
    this.x = damp(this.x, t.x, CFG.CAM_LERP, dt);
    this.y = damp(this.y, t.y, CFG.CAM_LERP, dt);
    this.shakeAmt = Math.max(0, this.shakeAmt - CFG.SHAKE_DECAY * dt);
    const s = this.shakeAmt;
    this.ox = (Math.random() * 2 - 1) * s;
    this.oy = (Math.random() * 2 - 1) * s;
  }

  // Where the world should be drawn from, including shake.
  get drawX() { return this.x + this.ox; }
  get drawY() { return this.y + this.oy; }

  add(amount) { this.shakeAmt = Math.min(CFG.SHAKE_MAX, this.shakeAmt + amount); }
}

/* ============================================================
   9. GAME STATE MACHINE & FLOW
   ============================================================ */
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

const UI = {
  menu: document.getElementById('menu'),
  pause: document.getElementById('pause'),
  died: document.getElementById('died'),
  victory: document.getElementById('victory'),
  hud: document.getElementById('hud'),
  gauntletName: document.getElementById('gauntlet-name'),
  deathHud: document.getElementById('death-hud'),
  deathCount: document.getElementById('death-count'),
  deathCountFinal: document.getElementById('death-count-final'),
  timer: document.getElementById('timer'),
  checkpointToggle: document.getElementById('checkpoint-toggle'),
};

const Game = {
  state: 'menu',          // menu | playing | dying | dead | paused | victory
  level: null,
  levelIndex: 0,
  player: new Player(0, 0),
  particles: new ParticleSystem(),
  camera: new Camera(),
  time: 0,                // hazard clock for the current gauntlet
  runTime: 0,             // total elapsed time this run
  deaths: 0,
  useCheckpoints: true,
  deathTimer: 0,
  embers: [],             // ambient background motes

  shake(amount) { this.camera.add(amount); },

  /* ---------- flow ---------- */
  startRun() {
    this.deaths = 0;
    this.runTime = 0;
    this.levelIndex = 0;
    this.useCheckpoints = UI.checkpointToggle ? UI.checkpointToggle.checked : true;
    this.loadLevel(0);
    this.setState('playing');
  },

  loadLevel(index) {
    this.levelIndex = index;
    this.level = buildLevel(GAUNTLETS[index]);
    this.time = 0;
    updateMovers(this.level, 0);
    this.particles.clear();
    this.player.reset(this.level.spawn.x, this.level.spawn.y);
    this.camera.snap(this.player, this.level);
    UI.gauntletName.textContent = this.level.name;
  },

  restartLevel() {
    this.loadLevel(this.levelIndex);
    this.setState('playing');
  },

  respawn() {
    // Most recent activated checkpoint wins; otherwise the level start.
    let spawn = this.level.spawn;
    for (const c of this.level.checkpoints) if (c.active) spawn = c.spawn;
    this.player.reset(spawn.x, spawn.y);
    this.camera.snap(this.player, this.level);
    this.particles.clear();
    this.setState('playing');
  },

  killPlayer(cause) {
    if (this.state !== 'playing') return;
    this.player.dead = true;
    this.deaths++;
    this.deathTimer = CFG.DEATH_FREEZE;
    this.shake(CFG.SHAKE_MAX);
    this.particles.emit(this.player.x + this.player.w / 2, this.player.y + this.player.h / 2, {
      count: 26, speed: 320, life: 0.75, size: 4,
      color: CFG.COLORS.player, gravity: 900, upBias: 90,
    });
    this.particles.emit(this.player.x + this.player.w / 2, this.player.y + this.player.h / 2, {
      count: 14, speed: 200, life: 0.6, size: 3,
      color: cause === 'spike' ? CFG.COLORS.hazardEdge : CFG.COLORS.ember, gravity: 700, upBias: 60,
    });
    this.setState('dying');
  },

  completeGauntlet() {
    this.particles.emit(this.player.x + this.player.w / 2, this.player.y + this.player.h / 2, {
      count: 30, speed: 260, life: 0.9, size: 4,
      color: CFG.COLORS.player, gravity: 260, upBias: 140,
    });
    this.shake(7);
    if (this.levelIndex + 1 >= GAUNTLETS.length) {
      this.setState('victory');
    } else {
      const carry = this.particles.particles.slice();
      this.loadLevel(this.levelIndex + 1);
      this.particles.particles = carry;
    }
  },

  setState(next) {
    this.state = next;
    const playing = next === 'playing' || next === 'dying' || next === 'paused';
    UI.menu.classList.toggle('hidden', next !== 'menu');
    UI.pause.classList.toggle('hidden', next !== 'paused');
    UI.died.classList.toggle('hidden', next !== 'dead');
    UI.victory.classList.toggle('hidden', next !== 'victory');
    UI.hud.classList.toggle('hidden', !playing);

    if (next === 'dead') UI.deathCount.textContent = String(this.deaths);
    if (next === 'victory') UI.deathCountFinal.textContent = String(this.deaths);
    this.syncHud();
  },

  syncHud() {
    UI.deathHud.textContent = `Deaths: ${this.deaths}`;
    UI.timer.textContent = `${this.runTime.toFixed(1)}s`;
  },

  /* ---------- per-frame input → buffers ---------- */
  pollInput() {
    if (Input.wasPressed('pause')) {
      if (this.state === 'playing') this.setState('paused');
      else if (this.state === 'paused') this.setState('playing');
    }

    if (Input.wasPressed('respawn')) {
      if (this.state === 'dead') this.respawn();
      else if (this.state === 'playing') this.killPlayer('respawn');
    }

    if (this.state === 'dead' && Input.wasPressed('jump')) this.respawn();

    if (this.state !== 'playing') return;

    // Edge-triggered actions become timed buffers so a single press can
    // never be consumed twice by the fixed-timestep substeps.
    if (Input.wasPressed('jump')) this.player.jumpBuffer = CFG.JUMP_BUFFER;
    if (Input.wasReleased('jump')) this.player.jumpCutQueued = true;
    if (Input.wasPressed('dash')) this.player.dashBuffer = CFG.DASH_BUFFER;
  },

  /* ---------- fixed-step simulation ---------- */
  step(dt) {
    this.time += dt;
    this.runTime += dt;

    updateMovers(this.level, this.time);
    this.player.update(dt, this.level, this.particles);
    this.particles.update(dt);
    this.camera.update(dt, this.player, this.level);

    if (this.state !== 'playing' || this.player.dead) return;

    const box = this.player.hurtBox();

    // Checkpoints
    if (this.useCheckpoints) {
      for (const c of this.level.checkpoints) {
        if (!c.active && rectsOverlap(box, c.box)) {
          c.active = true;
          this.particles.emit(c.box.x + c.box.w / 2, c.box.y + c.box.h / 2, {
            count: 16, speed: 150, life: 0.7, size: 3,
            color: CFG.COLORS.checkpointActive, gravity: 180, upBias: 90,
          });
          this.shake(3);
        }
      }
    }

    // Goal
    if (this.level.goal && rectsOverlap(box, this.level.goal.box)) {
      this.completeGauntlet();
      return;
    }

    // Hazards
    const hit = checkHazards(this.player, this.level);
    if (hit) this.killPlayer(hit.kind);
  },

  // Runs on every frame regardless of state (menus keep breathing).
  updateAmbient(dt) {
    if (this.embers.length === 0) {
      for (let i = 0; i < 44; i++) {
        this.embers.push({
          x: Math.random() * CFG.VIEW_W,
          y: Math.random() * CFG.VIEW_H,
          vy: -6 - Math.random() * 22,
          vx: (Math.random() - 0.5) * 12,
          r: 0.8 + Math.random() * 1.8,
          a: 0.12 + Math.random() * 0.35,
          t: Math.random() * 100,
        });
      }
    }
    for (const e of this.embers) {
      e.t += dt;
      e.x += (e.vx + Math.sin(e.t * 1.3) * 8) * dt;
      e.y += e.vy * dt;
      if (e.y < -6) { e.y = CFG.VIEW_H + 6; e.x = Math.random() * CFG.VIEW_W; }
      if (e.x < -6) e.x = CFG.VIEW_W + 6;
      if (e.x > CFG.VIEW_W + 6) e.x = -6;
    }

    if (this.state === 'dying') {
      this.deathTimer -= dt;
      this.particles.update(dt);
      this.camera.update(dt, this.player, this.level);
      if (this.deathTimer <= 0) this.setState('dead');
    }
    this.syncHud();
  },
};

/* ---------- DOM wiring ---------- */
function bind(id, fn) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('click', () => { el.blur(); fn(); });
}

bind('start-btn', () => Game.startRun());
bind('resume-btn', () => Game.setState('playing'));
bind('restart-btn', () => Game.restartLevel());
bind('respawn-btn', () => Game.respawn());
bind('play-again-btn', () => Game.startRun());
bind('menu-btn', () => Game.setState('menu'));

/* ============================================================
   10. RENDERING
   ============================================================ */
function drawBackground() {
  const g = ctx.createLinearGradient(0, 0, 0, CFG.VIEW_H);
  g.addColorStop(0, '#15111a');
  g.addColorStop(0.55, '#0d0b11');
  g.addColorStop(1, '#08080a');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, CFG.VIEW_W, CFG.VIEW_H);

  // ambient embers
  for (const e of Game.embers) {
    ctx.globalAlpha = e.a;
    ctx.fillStyle = CFG.COLORS.ember;
    ctx.beginPath();
    ctx.arc(e.x, e.y, e.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawTiles(level, cam) {
  const T = CFG.TILE;
  const C = CFG.COLORS;
  for (let r = 0; r < level.rows; r++) {
    for (let c = 0; c < level.cols; c++) {
      if (level.tiles[r][c] !== SOLID) continue;
      const x = Math.round(c * T - cam.x);
      const y = Math.round(r * T - cam.y);
      ctx.fillStyle = C.solid;
      ctx.fillRect(x, y, T, T);
      // lit top face when nothing sits above
      if (!solidAt(level, c, r - 1)) {
        ctx.fillStyle = C.solidTop;
        ctx.fillRect(x, y, T, 3);
        ctx.fillStyle = 'rgba(255,144,85,0.07)';
        ctx.fillRect(x, y + 3, T, 5);
      }
      ctx.strokeStyle = C.solidEdge;
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, T - 1, T - 1);
    }
  }
}

function drawSpikes(level, cam) {
  const T = CFG.TILE;
  const C = CFG.COLORS;
  for (const s of level.spikes) {
    const x = s.col * T - cam.x;
    const y = s.row * T - cam.y;
    const teeth = 3;
    const step = T / teeth;
    ctx.fillStyle = C.hazard;
    ctx.beginPath();
    for (let i = 0; i < teeth; i++) {
      const o = i * step;
      switch (s.dir) {
        case 'up':
          ctx.moveTo(x + o, y + T);
          ctx.lineTo(x + o + step / 2, y + T * 0.32);
          ctx.lineTo(x + o + step, y + T);
          break;
        case 'down':
          ctx.moveTo(x + o, y);
          ctx.lineTo(x + o + step / 2, y + T * 0.68);
          ctx.lineTo(x + o + step, y);
          break;
        case 'left':
          ctx.moveTo(x, y + o);
          ctx.lineTo(x + T * 0.68, y + o + step / 2);
          ctx.lineTo(x, y + o + step);
          break;
        default:
          ctx.moveTo(x + T, y + o);
          ctx.lineTo(x + T * 0.32, y + o + step / 2);
          ctx.lineTo(x + T, y + o + step);
          break;
      }
    }
    ctx.fill();
    ctx.strokeStyle = C.hazardEdge;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

function drawCheckpoints(level, cam, t) {
  const C = CFG.COLORS;
  for (const cp of level.checkpoints) {
    const b = cp.box;
    const x = b.x - cam.x, y = b.y - cam.y;
    const pulse = 0.5 + 0.5 * Math.sin(t * (cp.active ? 6 : 2.2));
    ctx.save();
    ctx.shadowBlur = cp.active ? 16 + pulse * 10 : 6;
    ctx.shadowColor = cp.active ? C.checkpointActive : C.checkpoint;
    ctx.fillStyle = cp.active ? C.checkpointActive : C.checkpoint;
    // post
    ctx.fillRect(Math.round(x + b.w / 2 - 1.5), Math.round(y + 4), 3, b.h - 4);
    // banner
    ctx.beginPath();
    ctx.moveTo(x + b.w / 2, y + 5);
    ctx.lineTo(x + b.w / 2 + 12, y + 10 + pulse * 1.5);
    ctx.lineTo(x + b.w / 2, y + 15);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

function drawGoal(level, cam, t) {
  if (!level.goal) return;
  const b = level.goal.box;
  const cx = b.x + b.w / 2 - cam.x;
  const cy = b.y + b.h / 2 - cam.y;
  const pulse = 0.5 + 0.5 * Math.sin(t * 3);
  ctx.save();
  ctx.shadowBlur = 22 + pulse * 16;
  ctx.shadowColor = CFG.COLORS.player;
  const g = ctx.createRadialGradient(cx, cy, 1, cx, cy, 16 + pulse * 4);
  g.addColorStop(0, '#fff3d6');
  g.addColorStop(0.45, CFG.COLORS.player);
  g.addColorStop(1, 'rgba(255,144,85,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, 16 + pulse * 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Rotating ember ring
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(t * 1.4);
  ctx.strokeStyle = CFG.COLORS.ember;
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 6]);
  ctx.beginPath();
  ctx.arc(0, 0, 12, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
  ctx.setLineDash([]);
}

function drawMovers(level, cam, t) {
  const C = CFG.COLORS;
  for (const m of level.movers) {
    const x = m.x - cam.x, y = m.y - cam.y;
    if (m.type === 'saw') {
      const cx = x + m.w / 2, cy = y + m.h / 2, R = m.w / 2;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(t * 9);
      ctx.fillStyle = C.metal;
      ctx.beginPath();
      const teeth = 10;
      for (let i = 0; i < teeth; i++) {
        const a0 = (i / teeth) * Math.PI * 2;
        const a1 = ((i + 0.5) / teeth) * Math.PI * 2;
        ctx.lineTo(Math.cos(a0) * R, Math.sin(a0) * R);
        ctx.lineTo(Math.cos(a1) * R * 0.72, Math.sin(a1) * R * 0.72);
      }
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = C.metalDark;
      ctx.beginPath();
      ctx.arc(0, 0, R * 0.38, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = C.hazardEdge;
      ctx.beginPath();
      ctx.arc(0, 0, R * 0.15, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    } else {
      // crusher
      ctx.fillStyle = C.metalDark;
      roundRect(ctx, x, y, m.w, m.h, 3);
      ctx.fill();
      ctx.strokeStyle = C.metal;
      ctx.lineWidth = 2;
      ctx.stroke();
      // spiked underside
      ctx.fillStyle = CFG.COLORS.hazard;
      const teeth = 4;
      const step = m.w / teeth;
      ctx.beginPath();
      for (let i = 0; i < teeth; i++) {
        ctx.moveTo(x + i * step, y + m.h);
        ctx.lineTo(x + i * step + step / 2, y + m.h + 9);
        ctx.lineTo(x + i * step + step, y + m.h);
      }
      ctx.fill();
      // guide rail up to the ceiling
      ctx.strokeStyle = 'rgba(141,135,146,0.22)';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(x + m.w / 2, 0);
      ctx.lineTo(x + m.w / 2, y);
      ctx.stroke();
    }
  }
}

function drawPlayer(p, cam) {
  const C = CFG.COLORS;

  // dash afterimages
  for (let i = 0; i < p.trail.length; i++) {
    const t = p.trail[i];
    if (!t.dashing) continue;
    const a = (i + 1) / p.trail.length * 0.4;
    ctx.globalAlpha = a;
    ctx.fillStyle = C.ember;
    ctx.fillRect(Math.round(t.x - cam.x), Math.round(t.y - cam.y), p.w, p.h);
  }
  ctx.globalAlpha = 1;

  if (p.dead) return;

  const w = p.w * p.sx;
  const h = p.h * p.sy;
  // Keep the feet planted while squashing.
  const x = p.x + p.w / 2 - w / 2 - cam.x;
  const y = p.y + p.h - h - cam.y;

  ctx.save();
  ctx.shadowBlur = p.dashing ? 26 : 14;
  ctx.shadowColor = CFG.COLORS.ember;
  ctx.fillStyle = p.hasDash ? C.player : C.playerDark;
  roundRect(ctx, x, y, w, h, 4);
  ctx.fill();
  ctx.restore();

  // inner core + facing eye
  ctx.fillStyle = p.hasDash ? '#fff0cf' : '#f0c48c';
  ctx.fillRect(Math.round(x + w / 2 + p.facing * (w * 0.16) - 2), Math.round(y + h * 0.28), 4, 4);

  // wall-slide sparks
  if (p.wallSliding) {
    ctx.fillStyle = 'rgba(255,144,85,0.5)';
    const sx = p.wallLeft ? x - 3 : x + w;
    ctx.fillRect(Math.round(sx), Math.round(y + h * 0.3), 3, h * 0.5);
  }
}

function drawVignette() {
  const g = ctx.createRadialGradient(
    CFG.VIEW_W / 2, CFG.VIEW_H / 2, CFG.VIEW_H * 0.35,
    CFG.VIEW_W / 2, CFG.VIEW_H / 2, CFG.VIEW_H * 0.85
  );
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, CFG.VIEW_W, CFG.VIEW_H);
}

function render() {
  ctx.clearRect(0, 0, CFG.VIEW_W, CFG.VIEW_H);
  drawBackground();

  if (Game.level) {
    const cam = { x: Game.camera.drawX, y: Game.camera.drawY };
    const t = Game.time;
    drawTiles(Game.level, cam);
    drawSpikes(Game.level, cam);
    drawCheckpoints(Game.level, cam, t);
    drawGoal(Game.level, cam, t);
    drawMovers(Game.level, cam, t);
    drawPlayer(Game.player, cam);
    Game.particles.draw(ctx, cam);
  }

  drawVignette();
}

/* ============================================================
   11. MAIN LOOP (fixed timestep)
   ============================================================ */
const FIXED_DT = 1 / 120;
const MAX_STEPS = 8;
let lastTime = performance.now();
let accumulator = 0;

function frame(now) {
  requestAnimationFrame(frame);

  let dt = (now - lastTime) / 1000;
  lastTime = now;
  if (!Number.isFinite(dt) || dt < 0) dt = 0;
  if (dt > 0.25) dt = 0.25;    // tab was backgrounded — don't simulate the gap

  Game.pollInput();

  if (Game.state === 'playing') {
    accumulator += dt;
    let steps = 0;
    while (accumulator >= FIXED_DT && steps < MAX_STEPS && Game.state === 'playing') {
      Game.step(FIXED_DT);
      accumulator -= FIXED_DT;
      steps++;
    }
    if (steps >= MAX_STEPS) accumulator = 0;   // give up on the backlog
  } else {
    accumulator = 0;
  }

  Game.updateAmbient(dt);
  render();
  Input.consume();
}

Game.setState('menu');
requestAnimationFrame(frame);
