/* Copyright (c) 2026 CJS flshw@126.com — Private Chatroom lightweight 3D engine. */
'use strict';
/*
 * PC3D — a dependency-free Canvas 2D pseudo-3D scene for the deluxe client.
 * No WebGL, no external library: keeps the single-file, offline E2EE promise.
 * Renders a perspective table with a subtle static grid + felt glow.
 *
 * MOTION POLICY: this scene is ALWAYS STATIC. Earlier revisions drifting
 * particles and rotating poker cards in a requestAnimationFrame loop; users
 * found the moving card backs distracting over the chat, so the animated
 * path has been removed entirely. There is no RAF loop, no rotating cards,
 * no moving particles. `start`/`stop` are kept as no-op aliases so any older
 * caller still works without re-introducing motion.
 */
window.PC3D = (function () {
  var canvas = null, ctx = null;
  var W = 0, H = 0, dpr = 1;

  function resize() {
    if (!canvas || !ctx) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth; H = canvas.clientHeight;
    canvas.width = Math.max(1, W * dpr);
    canvas.height = Math.max(1, H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    renderStatic();
  }

  function init(el) {
    canvas = el || document.getElementById('scene3d');
    if (!canvas || !canvas.getContext) return false;
    ctx = canvas.getContext('2d');
    if (!ctx) return false;
    if (!window.__pc3dResizeBound) {
      window.addEventListener('resize', resize);
      window.__pc3dResizeBound = true;
    }
    resize();
    return true;
  }

  /* Perspective projection: map (x,z) world to screen with vanishing point. */
  function project(x, z) {
    var horizon = H * 0.42;
    var depth = Math.max(0.05, z);
    var k = 1 / depth;
    return { x: W / 2 + x * W * 0.5 * k, y: horizon + (1 - depth) * H * 0.85 * k * 0.35 };
  }

  function drawBackground() {
    var g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#080d1c');
    g.addColorStop(0.55, '#111a35');
    g.addColorStop(1, '#070b17');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }

  function drawTable() {
    var cx = W / 2, cy = H * 0.72;
    ctx.save();
    var glow = ctx.createRadialGradient(cx, cy, 10, cx, cy, W * 0.42);
    glow.addColorStop(0, 'rgba(91,140,255,0.22)');
    glow.addColorStop(1, 'rgba(91,140,255,0)');
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.ellipse(cx, cy, W * 0.42, H * 0.16, 0, 0, Math.PI * 2); ctx.fill();
    var felt = ctx.createLinearGradient(0, cy - H * 0.12, 0, cy + H * 0.12);
    felt.addColorStop(0, '#143056');
    felt.addColorStop(1, '#0d1f3c');
    ctx.fillStyle = felt;
    ctx.strokeStyle = 'rgba(120,160,255,0.45)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(cx, cy, W * 0.34, H * 0.115, 0, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
    ctx.strokeStyle = 'rgba(120,160,255,0.18)';
    ctx.beginPath();
    ctx.ellipse(cx, cy, W * 0.29, H * 0.095, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  function drawGrid() {
    var horizon = H * 0.42;
    ctx.save();
    ctx.strokeStyle = 'rgba(91,140,255,0.10)';
    ctx.lineWidth = 1;
    for (var i = 1; i <= 10; i++) {
      var z = i / 10;
      var y = horizon + Math.pow(z, 2) * (H - horizon) * 0.9;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }
    for (var k = -8; k <= 8; k++) {
      ctx.beginPath();
      ctx.moveTo(W / 2 + k * 8, horizon);
      ctx.lineTo(W / 2 + k * W * 0.16, H);
      ctx.stroke();
    }
    ctx.restore();
  }

  /* The ONE and only paint path: a static gradient + grid + table. No cards,
   * no particles, no animation frame. Safe to call any number of times. */
  function renderStatic() {
    if (!ctx) return;
    drawBackground();
    drawGrid();
    drawTable();
  }

  /* Kept for API compatibility with any caller that still invokes them; both
   * are no-ops that simply repaint the static scene. */
  function start() { renderStatic(); }
  function stop() { /* nothing is ever scheduled; no-op */ }

  return { init: init, start: start, stop: stop, resize: resize, renderStatic: renderStatic,
    available: function () { return !!ctx; } };
})();
