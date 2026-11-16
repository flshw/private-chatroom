/* Copyright (c) 2026 CJS flshw@126.com — Private Chatroom lightweight 3D engine. */
'use strict';
/*
 * PC3D — a dependency-free Canvas 2D pseudo-3D scene for the deluxe client.
 * No WebGL, no external library: keeps the single-file, offline E2EE promise.
 * Renders a perspective table, drifting particles and floating cards with a
 * simple 3D projection. Falls back silently if canvas is unavailable.
 */
window.PC3D = (function () {
  var canvas = null, ctx = null, raf = 0, running = false;
  var W = 0, H = 0, dpr = 1, t = 0;
  var particles = [];
  var cards = [];
  var reduced = false;

  function rand(a, b) { return a + Math.random() * (b - a); }

  function resize() {
    if (!canvas) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth; H = canvas.clientHeight;
    canvas.width = Math.max(1, W * dpr);
    canvas.height = Math.max(1, H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function init(el) {
    canvas = el || document.getElementById('scene3d');
    if (!canvas || !canvas.getContext) return false;
    ctx = canvas.getContext('2d');
    if (!ctx) return false;
    try { reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
    resize();
    window.addEventListener('resize', resize);
    particles = [];
    for (var i = 0; i < 70; i++) {
      particles.push({ x: rand(0, 1), y: rand(0, 1), z: rand(0.2, 1),
        s: rand(0.6, 2.2), v: rand(0.00008, 0.0004) });
    }
    cards = [];
    var suits = ['♠', '♥', '♣', '♦'];
    for (var j = 0; j < 7; j++) {
      cards.push({ suit: suits[j % 4], rank: ['A', 'K', 'Q', 'J', '10', '9', '8'][j],
        a: rand(0, Math.PI * 2), r: rand(0.18, 0.42), y: rand(0.15, 0.75),
        sp: rand(0.00012, 0.00035) });
    }
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

  function drawParticles(dt) {
    ctx.save();
    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      if (!reduced) p.y -= p.v * dt;
      if (p.y < 0) { p.y = 1; p.x = Math.random(); }
      var pos = project((p.x - 0.5) * 2, p.z);
      var alpha = 0.15 + p.z * 0.5;
      ctx.fillStyle = 'rgba(130,165,255,' + alpha.toFixed(3) + ')';
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, p.s * p.z, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawTable() {
    var cx = W / 2, cy = H * 0.72;
    ctx.save();
    // Glow under table.
    var glow = ctx.createRadialGradient(cx, cy, 10, cx, cy, W * 0.42);
    glow.addColorStop(0, 'rgba(91,140,255,0.22)');
    glow.addColorStop(1, 'rgba(91,140,255,0)');
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.ellipse(cx, cy, W * 0.42, H * 0.16, 0, 0, Math.PI * 2); ctx.fill();
    // Perspective felt ellipse (3D table top).
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
    // Horizontal depth lines.
    for (var i = 1; i <= 10; i++) {
      var z = i / 10;
      var y = horizon + Math.pow(z, 2) * (H - horizon) * 0.9;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }
    // Radial vertical lines toward vanishing point.
    for (var k = -8; k <= 8; k++) {
      ctx.beginPath();
      ctx.moveTo(W / 2 + k * 8, horizon);
      ctx.lineTo(W / 2 + k * W * 0.16, H);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawCards(dt) {
    ctx.save();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      if (!reduced) c.a += c.sp * dt;
      var x = W / 2 + Math.cos(c.a) * W * c.r;
      var y = H * (0.30 + c.y * 0.28) + Math.sin(c.a * 1.6) * H * 0.03;
      var scale = 0.75 + 0.25 * Math.sin(c.a);
      var cw = 42 * scale, ch = 60 * scale;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(Math.sin(c.a) * 0.18);
      ctx.fillStyle = 'rgba(236,241,252,0.88)';
      ctx.strokeStyle = 'rgba(91,140,255,0.6)';
      ctx.lineWidth = 1;
      roundRect(-cw / 2, -ch / 2, cw, ch, 6);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = (c.suit === '♥' || c.suit === '♦') ? '#d9455f' : '#1b2440';
      ctx.font = 'bold ' + (15 * scale).toFixed(0) + 'px sans-serif';
      ctx.fillText(c.rank, 0, -ch * 0.18);
      ctx.font = (18 * scale).toFixed(0) + 'px sans-serif';
      ctx.fillText(c.suit, 0, ch * 0.16);
      ctx.restore();
    }
    ctx.restore();
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  var last = 0;
  function frame(ts) {
    if (!running) return;
    var dt = last ? Math.min(ts - last, 50) : 16;
    last = ts; t += dt;
    drawBackground();
    drawParticles(dt);
    drawGrid();
    drawTable();
    drawCards(dt);
    raf = requestAnimationFrame(frame);
  }

  function start() { if (!ctx || running) return; running = true; last = 0; raf = requestAnimationFrame(frame); }
  function stop() { running = false; if (raf) cancelAnimationFrame(raf); raf = 0; }
  /* Static backdrop: paint the gradient + grid + table ONCE, with no drifting
   * particles or floating cards and no animation loop. Used when the user wants
   * the ambience without motion. */
  function renderStatic() {
    stop();
    if (!ctx) return;
    drawBackground();
    drawGrid();
    drawTable();
  }

  return { init: init, start: start, stop: stop, resize: resize, renderStatic: renderStatic,
    available: function () { return !!ctx; } };
})();
