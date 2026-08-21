/* ============================================================
   EMBERFALL — game.js
   Vanilla JS precision platformer. Celeste movement + Dark Souls rage.
   
   Structure:
     1. Tunable constants (physics & hazards)
     2. Input manager
     3. Utility helpers
     4. Level / gauntlet data (data-driven)
     5. Particles
     6. Player (movement + collision)
     7. Camera
     8. Game state machine & flow
     9. Rendering
     10. Main loop (fixed timestep)
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
  MOVE_ACCEL_AIR: 1400,     // air horizontal acceleration
  FRICTION: 2200,           // ground friction (px/s^2 of decel)
  MAX_SPEED: 340,           // max run speed px/s
  AIR_CONTROL: 0.55,        // multiplier for air accel vs ground
  GRAVITY: 2000,            // gravity (px/s^2)
  MAX_FALL: 720,            // terminal fall speed px/s

  // Jump — variable height via cut-on-release
  JUMP_SPEED: 640,          // initial jump velocity px/s
  JUMP_CUT_MULT: 0.35,      // velocity multiplier when released early
  JUMP_HELD_MIN: 0.12,      // min hang time before full jump (s)

  // Wall interaction
  WALL_SLIDE_MAX: 130,      // max wall-slide speed px/s
  WALL_SLIDE_GRAV: 0.45,    // gravity multiplier while sliding
  WALL_JUMP_X: 430,         // wall-jump horizontal speed
  WALL_JUMP_Y: 560,         // wall-jump vertical speed
  WALL_GRAB_RANGE: 18,      // how far "into" the wall we may settle

  // Dash — breaks falls, cancels damage
  DASH_SPEED: 900,          // dash distance speed px/s
  DASH_TIME: 0.16,          // active dash time (s)
  DASH_COOLDOWN: 0.28,      // cooldown after dash (s)
  DASH_FALL_CATCH: 260,     // max fall speed a dash can cancel (px/s)

  // Collision snap
  OVERLAP_EPS: 1.5,         // px snap threshold

  // World scale (camera padding around player)
  CAM_MARGIN: 220,

  // Juice
  SHAKE_MAX: 12,            // max screen shake px
  SHAKE_DECAY: 6,           // shake decay per second

  // Colors
  COLORS: {
    bg: '#0c0c10',
    player: '#ffb74d',
    playerDark: '#d97b2a',
    hazard: '#d64545',
    hazardEdge: '#ff6b6b',
    checkpoint: '#7bd88f',
    checkpointActive: '#b6ff9e',
    solid: '#2a2529',
    solidEdge: '#3d353c',
    solidTop: '#4a3f45',
    dust: '#c9bfb0',
    ember: '#ff9055',
    text: '#ece7df',
  },
};

/* ============================================================
   2. INPUT MANAGER
   ============================================================ */
const Input = (() => {
  const down = new Set();
  const pressed = new Set();   // edge: became down this frame
  const released = new Set();  // edge: became up this frame

  const KEY_MAP = {
    ArrowLeft: 'left', KeyA: 'left',
    ArrowRight: 'right', KeyD: 'right',
    ArrowUp: 'jump', KeyW: 'jump', Space: 'jump',
    ShiftLeft: 'dash', ShiftRight: 'dash', KeyS: 'dash', ArrowDown: 'dash',
    KeyR: 'respawn',
    Escape: 'pause',
  };

  window.addEventListener('keydown', (e) => {
    const action = KEY_MAP[e.code];
    if (!action) return;
    e.preventDefault();
    if (!down.has(action)) pressed.add(action);
    down.add(action);
  });
  window.addEventListener('keyup', (e) => {
    const action = KEY_MAP[e.code];
    if (!action) return;
    e.preventDefault();
    if (down.has(action)) released.add(action);
    down.delete(action);
  });

  return {
    isDown: (a) => down.has(a),
    wasPressed: (a) => pressed.has(a),
    wasReleased: (a) => released.has(a),
    // Peek without consuming edges (used by menus)
    consume: () => { pressed.clear(); released.clear(); },
  };
})();

/* ============================================================
   3. UTILITY
   ============================================================ */
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;

function rectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x &&
         a.y < b.y + b.h && a.y + a.h > b.y;
}

/* ============================================================
   4. LEVEL / GAUNTLET DATA
   ------------------------------------------------------------
   Data-driven gauntlets. Each gauntlet is an array of tiles.
   Tile legend (single char per tile):
     '.' empty   '#' solid   'S' spike (ground face up)
     's' spike (facing down) '^' spike (facing left)
     '|' spike (facing right) 'P' player start
     'C' checkpoint 'G' gauntlet goal (flag)

   Moving hazards are defined separately as objects with
   x,y,width,height and a move spec: {axis, min, max, speed, phase}.
   'S' saws rotate and act as moving spikes.
   ============================================================ */
const GAUNTLETS = [
  {
    name: 'GAUNTLET I — THE AWAKENING',
    // 24 tiles wide (720px), 18 tiles tall (540px)
    tiles: [
      '########################',
      '#................................#',
      '#..P...#..........................#',
      '#....##S##........................#',
      '#...............#.................#',
      '#...............#..##S##..........#',
      '#...............#...............#',
      '#.......###.......##S##.......###.#',
      '#.................................#',
      '#..C.......S.......G..............#',
      '#.....#####S####......####........#',
      '#.................................#',
      '#.....###.................###.....#',
      '#.................................#',
      '#........S..........S............#',
      '#..P.......##S##.......##S##......#',
      '#................................#',
      '########################',
    ].map(row => row.split('')),
    movers: [],
  },
  {
    name: 'GAUNTLET II — THE DESCENT',
    tiles: [
      '########################',
      '#......................#',
      '#P.....................#',
      '#....S##...............#',
      '#................S##...#',
      '#......................#',
      '#...##........S##......#',
      '#......................#',
      '#......S##.............#',
      '#................S##...#',
      '#.........C............#',
      '#....####S####....###..#',
      '#......................#',
      '#..S...............S##.#',
      '#......................#',
      '#.####S####....G..####.#',
      '#......................#',
      '########################',
    ].map(row => row.split('')),
    movers: [
      { type: 'saw', x: 300, y: 200, w: 44, h: 44, move: { axis: 'x', min: 260, max: 480, speed: 160, phase: 0 } },
      { type: 'saw', x: 500, y: 360, w: 44, h: 44, move: { axis: 'y', min: 300, max: 480, speed: 190, phase: 1.5 } },
    ],
  },
  {
    name: 'GAUNTLET III — THE CRUSHERS',
    tiles: [
      '########################',
      '#........................#',
      '#P........................#',
      '#....S##..................#',
      '#....................S##..#',
      '#........................#',
      '#......S##............S##.',
      '#........................#',
      '#....C.........S##......#',
      '#..####S####.........####.',
      '#......................#',
      '#..S............S......#',
      '#..................####.',
      '#..####......G.....####.',
      '#......................#',
      '#....S##.........S##...#',
      '#......................#',
      '########################',
    ].map(row => row.split('')),
    movers: [
      // crushing walls (vertical kill zones)
      { type: 'crusher', x: 200, y: 0, w: 54, h: 90, move: { axis: 'y', min: 0, max: 300, speed: 320, phase: 0 } },
      { type: 'crusher', x: 620, y: 0, w: 54, h: 90, move: { axis: 'y', min: 120, max: 420, speed: 300, phase: 2 } },
      { type: 'saw', x: 400, y: 400, w: 44, h: 44, move: { axis: 'x', min: 360, max: 560, speed: 220, phase: 0.5 } },
    ],
  },
  {
    name: 'GAUNTLET IV — THE EMBER LORD',
    tiles: [
      '########################',
      '#........................#',
      '#P.......................#',
      '#...S##..................#',
      '#...................S##..#',
      '#........................#',
      '#....S##..........S##....#',
      '#........................#',
      '#......C.........S##.....#',
      '#..####S####.......####..#',
      '#.......................#',
      '#..S.........S.........S#',
      '#.......................#',
      '#..####......G......####.#',
      '#.......................#',
      '#...S##.......S##......#',
      '#.......................#',
      '########################',
    ].map(row => row.split('')),
    movers: [
      { type: 'saw', x: 260, y: 220, w: 44, h: 44, move: { axis: 'x', min: 220, max: 460, speed: 240, phase: 0 } },
      { type: 'saw', x: 560, y: 300, w: 44, h: 44, move: { axis: 'y', min: 240, max: 460, speed: 260, phase: 1 } },
      { type: 'crusher', x: 420, y: 0, w: 50, h: 96, move: { axis: 'y', min: 0, max: 360, speed: 340, phase: 2.5 } },
    ],
  },
];

/* ============================================================
   5. PARTICLES
   ============================================================ */
class ParticleSystem {
  constructor() { this.particles = []; }

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
      ctx.fillRect(p.x - cam.x - s / 2, p.y - cam.y - s / 2, s, s);
    }
    ctx.globalAlpha = 1;
  }
}

/* ============================================================
   6. PLAYER
   ============================================================ */
class Player {
  constructor(startX, startY) {
    this.w = 22;
    this.h = 28;
    this.reset(startX, startY);
    // visual squash/stretch
    this.sx = 1; this.sy = 1;
    this.trail = [];   // dash streak positions
    this.facing = 1;
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
    this.jumpHeld = false;
    this.jumpTime = 0;
    this.dashing = false;
    this.dashTimer = 0;
    this.dashCooldown = 0;
    this.dashDir = 1;
    this.canDash = true;
    this.hasDash = true;   // dashes available (no double-dash here)
    this.dead = false;
    this.sx = 1; this.sy = 1;
    this.trail.length = 0;
    this.facing = 1;
    this.landSquash = 0;   // countdown of landing squash
  }

  // Is the player currently touching a wall on a given side?
  againstWall(side) {
    return side === 'left' ? this.wallLeft : this.wallRight;
  }

  update(dt, tiles, movers, input, particles) {
    if (this.dead) return;

    // --- Timers ---
    if (this.dashCooldown > 0) this.dashCooldown -= dt;
    if (this.dashTimer > 0) this.dashTimer -= dt;
    if (this.landSquash > 0) this.landSquash -= dt;

    // --- Dash trigger ---
    if (input.isDown('dash') && this.hasDash && this.dashCooldown <= 0 && !this.dashing) {
      this.startDash(input.isDown('right') ? 1 : input.isDown('left') ? -1 : this.facing);
    }

    if (this.dashing) {
      this.updateDash(dt, particles);
    } else {
      this.updateMovement(dt, input, particles);
    }

    // --- Jump (buffered on press) ---
    if (input.wasPressed('jump')) {
      this.tryJump(input, particles);
    }

    // --- Variable jump height: cut when released ---
    if (this.vy < 0 && input.wasReleased('jump') && this.jumpTime < CFG.JUMP_HELD_MIN) {
      this.vy *= CFG.JUMP_CUT_MULT;
    }
    this.jumpTime += dt;

    // --- Wall detection (for sliding + grab) ---
    this.detectWalls(tiles);

    // --- Gravity (reduced while sliding) ---
    if (this.wallSliding) {
      this.vy = Math.min(this.vy + CFG.GRAVITY * CFG.WALL_SLIDE_GRAV * dt, CFG.WALL_SLIDE_MAX);
    } else {
      this.vy = Math.min(this.vy + CFG.GRAVITY * dt, CFG.MAX_FALL);
    }

    // --- Move & collide ---
    this.moveAndCollide(tiles, movers);

    // --- Squash/stretch recovery ---
    this.sx = lerp(this.sx, 1, 1 - Math.pow(0.001, dt));
    this.sy = lerp(this.sy, 1, 1 - Math.pow(0.001, dt));

    // --- Trail for dash ---
    this.trail.push({ x: this.x, y: this.y, dir: this.facing });
    if (this.trail.length > 8) this.trail.shift();
  }

  startDash(dir) {
    this.dashing = true;
    this.dashTimer = CFG.DASH_TIME;
    this.dashCooldown = CFG.DASH_COOLDOWN;
    this.dashDir = dir;
    this.facing = dir;
    this.hasDash = false;
    this.vy = 0;          // break falls / reset vertical
    this.canDash = false;
    // slight stretch
    this.sx = 1.4; this.sy = 0.65;
  }

  updateDash(dt, particles) {
    const dir = this.dashDir;
    this.vx = dir * CFG.DASH_SPEED;
    this.vy = 0;
    // ember streak
    if (Math.random() < 0.8) {
      particles.emit(this.x + this.w / 2, this.y + this.h / 2, {
        count: 1, speed: 40, life: 0.3, size: 4,
        color: CFG.COLORS.ember, gravity: 0, spread: 1.2, upBias: 0,
      });
    }
    if (this.dashTimer <= 0) {
      this.dashing = false;
      this.vx = dir * CFG.DASH_SPEED * 0.5;
      this.hasDash = true;
      this.canDash = true;
    }
  }

  updateMovement(dt, input, particles) {
    const wantLeft = input.isDown('left');
    const wantRight = input.isDown('right');
    const dir = (wantRight ? 1 : 0) - (wantLeft ? 1 : 0);
    if (dir !== 0) this.facing = dir;

    const accel = this.onGround ? CFG.MOVE_ACCEL : CFG.MOVE_ACCEL_AIR * CFG.AIR_CONTROL;

    if (dir !== 0) {
      this.vx += dir * accel * dt;
      this.vx = clamp(this.vx, -CFG.MAX_SPEED, CFG.MAX_SPEED);
    } else if (this.onGround) {
      // friction
      if (this.vx > 0) this.vx = Math.max(0, this.vx - CFG.FRICTION * dt);
      else this.vx = Math.min(0, this.vx + CFG.FRICTION * dt);
    } else {
      // minimal air drift toward zero
      this.vx *= Math.pow(0.02, dt);
    }

    // clamp on ground
    if (this.onGround) this.vx = clamp(this.vx, -CFG.MAX_SPEED, CFG.MAX_SPEED);
  }

  tryJump(input, particles) {
    // Normal ground jump
    if (this.onGround) {
      this.vy = -CFG.JUMP_SPEED;
      this.onGround = false;
      this.jumpTime = 0;
      this.jumpHeld = true;
      this.sx = 0.7; this.sy = 1.35;
      particles.emit(this.x + this.w / 2, this.y + this.h, {
        count: 7, speed: 90, life: 0.4, size: 3,
        color: CFG.COLORS.dust, gravity: 500, spread: 1.6, upBias: 40,
      });
      return;
    }
    // Wall jump
    if ((this.wallLeft && !input.isDown('left')) || (this.wallRight && !input.isDown('right'))) {
      this.vy = -CFG.WALL_JUMP_Y;
      const fromLeft = this.wallLeft;
      this.vx = fromLeft ? CFG.WALL_JUMP_X : -CFG.WALL_JUMP_X;
      this.facing = fromLeft ? -1 : 1;
      this.jumpTime = 0;
      this.sx = 0.7; this.sy = 1.3;
      particles.emit(this.x + this.w / 2, this.y + this.h / 2, {
        count: 8, speed: 130, life: 0.4, size: 3,
        color: CFG.COLORS.ember, gravity: 300, spread: 2.0, upBias: 60,
      });
    }
  }

  detectWalls(tiles) {
    this.wallLeft = false;
    this.wallRight = false;
    // Sample points along the player's vertical extent
    const checkSide = (xOffset, isLeft) => {
      const px = isLeft ? this.x : this.x + this.w;
      // Check a small region just off the wall
      for (let t = 0; t <= 1; t += 0.25) {
        const sampleY = this.y + this.h * t;
        if (tileAt(tiles, (px + (isLeft ? -1 : 1)) , sampleY)) return true;
      }
      return false;
    };
    // Use AABB overlap against a probe just outside the body
    const probeLeft = { x: this.x - CFG.WALL_GRAB_RANGE - 1, y: this.y, w: CFG.WALL_GRAB_RANGE + 2, h: this.h };
    const probeRight = { x: this.x + this.w, y: this.y, w: CFG.WALL_GRAB_RANGE + 2, h: this.h };
    this.wallLeft = probeCollides(probeLeft, tiles);
    this.wallRight = probeCollides(probeRight, tiles);

    // Only slide if falling and not actively jumping away
    if (this.wallLeft || this.wallRight) {
      const pushAway = this.wallLeft ? -1 : 1;
      const jumpingAway = (this.wallLeft && input_wasLeft()) || (this.wallRight && input_wasRight());
      this.wallSliding = this.vy > 0 && !jumpingAway;
    } else {
      this.wallSliding = false;
    }
  }

  moveAndCollide(tiles, movers) {
    // Horizontal
    this.x += this.vx * dt_placeholder();
    this.resolveHorizontal(tiles);

    // Vertical
    this.y += this.vy * dt_placeholder();
    this.resolveVertical(tiles, movers);

    // Hazard checks
    checkHazards(this, tiles, movers);
  }

  // placeholder replaced below
}
