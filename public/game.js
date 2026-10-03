'use strict';

/* ==========================================================================
   CYBER ARENA 2D - GAME ENGINE & MULTIPLAYER (Mobile Touch & Desktop)
   ========================================================================== */

// Canvas & Context Setup
let canvas, ctx;
let cameraPos = { x: 0, y: 0 };
let cameraScale = 32; // Pixels per world unit

// Game World Bounds (-30 to +30)
const WORLD_SIZE = 60;

// Networking State
let ws = null;
let selfSocketId = null;
let currentRoomId = 'lobby';
let myPlayerName = 'CyberPlayer';
let myPlayerColor = '#00f3ff';

// Game Entities
let localPlayer = null;
const remotePlayersMap = new Map(); // socketId -> RemotePlayer
const orbsMap = new Map();          // orbId -> Orb
const projectilesList = [];         // Array of active lasers
const particlesList = [];           // Visual particle effects

// Audio Context (Web Audio API Procedural Synthesizer)
let audioCtx = null;

function initAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
}

function playSound(type) {
  if (!audioCtx) return;
  try {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);

    const now = audioCtx.currentTime;

    if (type === 'shoot') {
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(440, now);
      osc.frequency.exponentialRampToValueAtTime(110, now + 0.12);
      gain.gain.setValueAtTime(0.3, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.12);
      osc.start(now);
      osc.stop(now + 0.12);
    } else if (type === 'pickup') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(523.25, now);
      osc.frequency.setValueAtTime(659.25, now + 0.08);
      osc.frequency.setValueAtTime(783.99, now + 0.16);
      gain.gain.setValueAtTime(0.25, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.25);
      osc.start(now);
      osc.stop(now + 0.25);
    } else if (type === 'hit') {
      osc.type = 'square';
      osc.frequency.setValueAtTime(150, now);
      osc.frequency.exponentialRampToValueAtTime(40, now + 0.15);
      gain.gain.setValueAtTime(0.4, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.15);
      osc.start(now);
      osc.stop(now + 0.15);
    } else if (type === 'dash') {
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(200, now);
      osc.frequency.linearRampToValueAtTime(600, now + 0.18);
      gain.gain.setValueAtTime(0.35, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.18);
      osc.start(now);
      osc.stop(now + 0.18);
    }
  } catch (e) {}
}

/* ==========================================================================
   INPUT CONTROLLERS (Desktop Keyboard/Mouse + Mobile Virtual Touch Joystick)
   ========================================================================== */
const keys = {};
let mouseScreenPos = { x: 0, y: 0 };
let mouseWorldPos = { x: 0, y: 0 };
let isMouseDownLeft = false;
let isMouseDownRight = false;

// Touch State
let touchMoveVector = { x: 0, y: 0 }; // Normalized (-1 to +1)
let isTouchShooting = false;
let isTouchDashing = false;
let isTouchDevice = false;

window.addEventListener('keydown', (e) => { keys[e.code] = true; });
window.addEventListener('keyup', (e) => { keys[e.code] = false; });
window.addEventListener('mousemove', (e) => {
  mouseScreenPos.x = e.clientX;
  mouseScreenPos.y = e.clientY;
});
window.addEventListener('mousedown', (e) => {
  initAudio();
  if (e.button === 0) isMouseDownLeft = true;
  if (e.button === 2) isMouseDownRight = true;
});
window.addEventListener('mouseup', (e) => {
  if (e.button === 0) isMouseDownLeft = false;
  if (e.button === 2) isMouseDownRight = false;
});
window.addEventListener('contextmenu', (e) => e.preventDefault());

// Initialize Virtual Touch Joystick
function initTouchControls() {
  const joystickZone = document.getElementById('joystick-left-zone');
  const joystickKnob = document.getElementById('joystick-knob');
  const btnShoot = document.getElementById('btn-touch-shoot');
  const btnDash = document.getElementById('btn-touch-dash');

  if (!joystickZone || !joystickKnob) return;

  let activeTouchId = null;
  let touchStartPos = { x: 0, y: 0 };
  const maxRadius = 45;

  joystickZone.addEventListener('touchstart', (e) => {
    initAudio();
    e.preventDefault();
    if (activeTouchId === null && e.changedTouches.length > 0) {
      const touch = e.changedTouches[0];
      activeTouchId = touch.identifier;
      const rect = joystickZone.getBoundingClientRect();
      touchStartPos = {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2
      };
      updateJoystick(touch.clientX, touch.clientY);
    }
  }, { passive: false });

  joystickZone.addEventListener('touchmove', (e) => {
    e.preventDefault();
    for (let i = 0; i < e.changedTouches.length; i++) {
      const touch = e.changedTouches[i];
      if (touch.identifier === activeTouchId) {
        updateJoystick(touch.clientX, touch.clientY);
        break;
      }
    }
  }, { passive: false });

  const endJoystick = (e) => {
    for (let i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier === activeTouchId) {
        activeTouchId = null;
        touchMoveVector = { x: 0, y: 0 };
        joystickKnob.style.transform = `translate(0px, 0px)`;
        break;
      }
    }
  };

  joystickZone.addEventListener('touchend', endJoystick, { passive: false });
  joystickZone.addEventListener('touchcancel', endJoystick, { passive: false });

  function updateJoystick(clientX, clientY) {
    const dx = clientX - touchStartPos.x;
    const dy = clientY - touchStartPos.y;
    const dist = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx);

    const clampedDist = Math.min(dist, maxRadius);
    const knobX = Math.cos(angle) * clampedDist;
    const knobY = Math.sin(angle) * clampedDist;

    joystickKnob.style.transform = `translate(${knobX}px, ${knobY}px)`;

    // Vector normalized (-1 to +1)
    touchMoveVector.x = Math.cos(angle) * (clampedDist / maxRadius);
    touchMoveVector.y = -Math.sin(angle) * (clampedDist / maxRadius); // Invert Y for world coords
  }

  // Touch Shoot Button
  if (btnShoot) {
    btnShoot.addEventListener('touchstart', (e) => {
      initAudio();
      e.preventDefault();
      btnShoot.classList.add('active');
      isTouchShooting = true;
    }, { passive: false });

    btnShoot.addEventListener('touchend', (e) => {
      e.preventDefault();
      btnShoot.classList.remove('active');
      isTouchShooting = false;
    }, { passive: false });
  }

  // Touch Dash Button
  if (btnDash) {
    btnDash.addEventListener('touchstart', (e) => {
      initAudio();
      e.preventDefault();
      btnDash.classList.add('active');
      isTouchDashing = true;
    }, { passive: false });

    btnDash.addEventListener('touchend', (e) => {
      e.preventDefault();
      btnDash.classList.remove('active');
      isTouchDashing = false;
    }, { passive: false });
  }
}

/* ==========================================================================
   CAMERA & COORDINATE CONVERSION
   ========================================================================== */
function worldToScreen(wx, wy) {
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  return {
    x: cx + (wx - cameraPos.x) * cameraScale,
    y: cy - (wy - cameraPos.y) * cameraScale
  };
}

function screenToWorld(sx, sy) {
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  return {
    x: cameraPos.x + (sx - cx) / cameraScale,
    y: cameraPos.y - (sy - cy) / cameraScale
  };
}

/* ==========================================================================
   PARTICLE SYSTEM
   ========================================================================== */
function spawnParticles(x, y, color, count = 10, speedMax = 5) {
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = (Math.random() * 0.7 + 0.3) * speedMax;
    particlesList.push({
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      color,
      size: Math.random() * 0.4 + 0.2,
      alpha: 1.0,
      life: Math.random() * 0.4 + 0.3
    });
  }
}

function updateAndDrawParticles(dt) {
  for (let i = particlesList.length - 1; i >= 0; i--) {
    const p = particlesList[i];
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.life -= dt;
    p.alpha = Math.max(0, p.life / 0.5);

    if (p.life <= 0) {
      particlesList.splice(i, 1);
      continue;
    }

    const scr = worldToScreen(p.x, p.y);
    ctx.save();
    ctx.globalAlpha = p.alpha;
    ctx.fillStyle = p.color;
    ctx.shadowColor = p.color;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(scr.x, scr.y, p.size * cameraScale * 0.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

/* ==========================================================================
   ENTITY CLASSES
   ========================================================================== */

class LocalPlayerEntity {
  constructor(x, y, color, name) {
    this.x = x;
    this.y = y;
    this.vx = 0;
    this.vy = 0;
    this.angle = 0;
    this.color = color;
    this.name = name;
    this.health = 100;
    this.score = 0;
    this.dashStamina = 100;
    this.dashCooldown = 0;
    this.shootCooldown = 0;
    this.isDashing = false;
  }

  update(dt) {
    // Input Movement (Desktop WASD + Mobile Touch Joystick)
    let dx = 0, dy = 0;
    if (keys['KeyW'] || keys['ArrowUp']) dy += 1;
    if (keys['KeyS'] || keys['ArrowDown']) dy -= 1;
    if (keys['KeyA'] || keys['ArrowLeft']) dx -= 1;
    if (keys['KeyD'] || keys['ArrowRight']) dx += 1;

    // Combine keyboard input with touch joystick vector
    if (touchMoveVector.x !== 0 || touchMoveVector.y !== 0) {
      dx = touchMoveVector.x;
      dy = touchMoveVector.y;
    }

    // Aim Angle Calculation
    if (touchMoveVector.x !== 0 || touchMoveVector.y !== 0) {
      // Aim in direction of joystick movement
      this.angle = Math.atan2(touchMoveVector.y, touchMoveVector.x);
    } else {
      // Aim towards mouse cursor on desktop
      mouseWorldPos = screenToWorld(mouseScreenPos.x, mouseScreenPos.y);
      this.angle = Math.atan2(mouseWorldPos.y - this.y, mouseWorldPos.x - this.x);
    }

    // Dash Action (Shift key, Right Mouse Button, or Mobile Dash Button)
    this.isDashing = false;
    const dashRequested = keys['ShiftLeft'] || keys['ShiftRight'] || isMouseDownRight || isTouchDashing;
    if (dashRequested && this.dashStamina >= 25 && this.dashCooldown <= 0) {
      this.isDashing = true;
      this.dashStamina -= 25;
      this.dashCooldown = 0.25;
      isTouchDashing = false;
      playSound('dash');
      spawnParticles(this.x, this.y, this.color, 20, 8);
    }

    // Recover Stamina
    if (this.dashStamina < 100) {
      this.dashStamina = Math.min(100, this.dashStamina + 30 * dt);
    }

    if (this.dashCooldown > 0) this.dashCooldown -= dt;
    if (this.shootCooldown > 0) this.shootCooldown -= dt;

    // Velocity & Speed
    const speed = this.isDashing ? 22 : 9;
    if (dx !== 0 || dy !== 0) {
      const len = Math.hypot(dx, dy);
      this.vx += (dx / len) * speed * 4 * dt;
      this.vy += (dy / len) * speed * 4 * dt;

      const curSpeed = Math.hypot(this.vx, this.vy);
      if (curSpeed > speed) {
        this.vx = (this.vx / curSpeed) * speed;
        this.vy = (this.vy / curSpeed) * speed;
      }

      if (Math.random() < 0.4) {
        spawnParticles(
          this.x - Math.cos(this.angle) * 0.8,
          this.y - Math.sin(this.angle) * 0.8,
          this.color, 2, 2
        );
      }
    } else {
      this.vx *= 0.88;
      this.vy *= 0.88;
    }

    this.x += this.vx * dt;
    this.y += this.vy * dt;

    // Arena Bounds (-30 to +30)
    const bound = WORLD_SIZE / 2 - 1.2;
    this.x = Math.max(-bound, Math.min(bound, this.x));
    this.y = Math.max(-bound, Math.min(bound, this.y));

    // Smooth Camera lerp
    cameraPos.x += (this.x - cameraPos.x) * 0.1;
    cameraPos.y += (this.y - cameraPos.y) * 0.1;

    // Shoot Action (Left Click or Mobile Shoot Button)
    const shootRequested = isMouseDownLeft || isTouchShooting;
    if (shootRequested && this.shootCooldown <= 0) {
      this.shootCooldown = 0.18;
      this.shootLaser();
    }

    // Orb Pickup Collision
    for (const [orbId, orb] of orbsMap.entries()) {
      const distSq = (this.x - orb.x) ** 2 + (this.y - orb.y) ** 2;
      if (distSq < 1.8) {
        sendWS({ type: 'collect_orb', orbId });
        playSound('pickup');
        spawnParticles(orb.x, orb.y, orb.color, 15, 6);
        break;
      }
    }

    // Send Multiplayer position update to socket
    sendWS({
      type: 'player_update',
      x: this.x,
      y: this.y,
      vx: this.vx,
      vy: this.vy,
      angle: this.angle,
      isDashing: this.isDashing
    });

    // Update HUD bars
    document.getElementById('hud-dash-fill').style.width = `${this.dashStamina}%`;
  }

  shootLaser() {
    playSound('shoot');
    const spawnX = this.x + Math.cos(this.angle) * 1.2;
    const spawnY = this.y + Math.sin(this.angle) * 1.2;
    const laserSpeed = 28;

    sendWS({
      type: 'shoot_projectile',
      x: spawnX,
      y: spawnY,
      vx: Math.cos(this.angle) * laserSpeed,
      vy: Math.sin(this.angle) * laserSpeed,
      color: this.color
    });
  }

  draw() {
    const scr = worldToScreen(this.x, this.y);
    const radius = 0.9 * cameraScale;

    ctx.save();
    ctx.translate(scr.x, scr.y);

    // Glow Outer Circle
    ctx.shadowColor = this.color;
    ctx.shadowBlur = 20;

    // Main Ship Hull
    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.fill();

    // Inner Core
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(0, 0, radius * 0.5, 0, Math.PI * 2);
    ctx.fill();

    // Aim Cannon Pointer
    ctx.rotate(-this.angle);
    ctx.strokeStyle = this.color;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(radius * 1.5, 0);
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(radius * 1.5, 0, 4, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();

    // Draw Player Name Tag
    const nameScr = worldToScreen(this.x, this.y + 1.4);
    ctx.save();
    ctx.font = 'bold 13px Orbitron, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = '#000000';
    ctx.shadowBlur = 6;
    ctx.fillText(this.name, nameScr.x, nameScr.y);
    ctx.restore();
  }
}

class RemotePlayerEntity {
  constructor(data) {
    this.id = data.id;
    this.x = data.x;
    this.y = data.y;
    this.targetX = data.x;
    this.targetY = data.y;
    this.angle = data.angle || 0;
    this.color = data.color;
    this.name = data.name;
    this.health = data.health || 100;
    this.score = data.score || 0;
    this.isDashing = false;
  }

  updateData(data) {
    this.targetX = data.x;
    this.targetY = data.y;
    this.angle = data.angle;
    this.isDashing = data.isDashing;
  }

  update(dt) {
    this.x += (this.targetX - this.x) * 0.25;
    this.y += (this.targetY - this.y) * 0.25;

    if (this.isDashing) {
      spawnParticles(this.x, this.y, this.color, 3, 4);
    }
  }

  draw() {
    const scr = worldToScreen(this.x, this.y);
    const radius = 0.9 * cameraScale;

    ctx.save();
    ctx.translate(scr.x, scr.y);

    ctx.shadowColor = this.color;
    ctx.shadowBlur = 20;

    // Main Hull
    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.fill();

    // Core
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(0, 0, radius * 0.5, 0, Math.PI * 2);
    ctx.fill();

    // Aim Pointer
    ctx.rotate(-this.angle);
    ctx.strokeStyle = this.color;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(radius * 1.5, 0);
    ctx.stroke();

    ctx.restore();

    // Name & Health bar
    const nameScr = worldToScreen(this.x, this.y + 1.4);
    ctx.save();
    ctx.font = 'bold 13px Orbitron, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = '#000000';
    ctx.shadowBlur = 6;
    ctx.fillText(this.name, nameScr.x, nameScr.y);

    // Health Bar
    const hpScr = worldToScreen(this.x, this.y + 1.0);
    const barW = 40;
    const barH = 5;
    const hpPercent = Math.max(0, this.health / 100);

    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillRect(hpScr.x - barW / 2, hpScr.y, barW, barH);
    ctx.fillStyle = '#00ff66';
    ctx.fillRect(hpScr.x - barW / 2, hpScr.y, barW * hpPercent, barH);
    ctx.restore();
  }
}

class OrbEntity {
  constructor(data) {
    this.id = data.id;
    this.x = data.x;
    this.y = data.y;
    this.color = data.color;
    this.value = data.value;
    this.pulse = Math.random() * 10;
  }

  update(dt) {
    this.pulse += dt * 4;
  }

  draw() {
    const scr = worldToScreen(this.x, this.y);
    const scale = 0.4 + Math.sin(this.pulse) * 0.08;
    const radius = scale * cameraScale;

    ctx.save();
    ctx.translate(scr.x, scr.y);
    ctx.shadowColor = this.color;
    ctx.shadowBlur = 15;

    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(0, 0, radius * 0.4, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }
}

class LaserBulletEntity {
  constructor(data) {
    this.id = data.id;
    this.ownerId = data.ownerId;
    this.x = data.x;
    this.y = data.y;
    this.vx = data.vx;
    this.vy = data.vy;
    this.color = data.color;
    this.life = 1.8;
  }

  update(dt) {
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.life -= dt;

    if (this.ownerId !== selfSocketId && localPlayer) {
      const distSq = (this.x - localPlayer.x) ** 2 + (this.y - localPlayer.y) ** 2;
      if (distSq < 1.2) {
        playSound('hit');
        spawnParticles(this.x, this.y, '#ff0033', 25, 10);
        sendWS({
          type: 'player_damaged',
          victimId: selfSocketId,
          attackerId: this.ownerId,
          damage: 15
        });
        this.life = 0;
      }
    }
  }

  draw() {
    const scr = worldToScreen(this.x, this.y);
    ctx.save();
    ctx.translate(scr.x, scr.y);
    ctx.shadowColor = this.color;
    ctx.shadowBlur = 12;

    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.arc(0, 0, 6, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(0, 0, 3, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }
}

/* ==========================================================================
   RENDER & GAME LOOP
   ========================================================================== */
let lastFrameTime = performance.now();

function gameLoop(now) {
  const dt = Math.min(0.1, (now - lastFrameTime) / 1000);
  lastFrameTime = now;

  // Clear Canvas
  ctx.fillStyle = '#0a0c14';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Draw Cyber Grid & Arena Boundaries
  drawArenaGrid();

  // Update & Draw Orbs
  for (const orb of orbsMap.values()) {
    orb.update(dt);
    orb.draw();
  }

  // Update & Draw Remote Players
  for (const rPlayer of remotePlayersMap.values()) {
    rPlayer.update(dt);
    rPlayer.draw();
  }

  // Update & Draw Local Player
  if (localPlayer) {
    localPlayer.update(dt);
    localPlayer.draw();
  }

  // Update & Draw Lasers
  for (let i = projectilesList.length - 1; i >= 0; i--) {
    const laser = projectilesList[i];
    laser.update(dt);
    laser.draw();
    if (laser.life <= 0) {
      projectilesList.splice(i, 1);
    }
  }

  // Update & Draw Particles
  updateAndDrawParticles(dt);

  requestAnimationFrame(gameLoop);
}

function drawArenaGrid() {
  const bound = WORLD_SIZE / 2;
  const gridStep = 4;

  ctx.save();
  ctx.strokeStyle = 'rgba(0, 243, 255, 0.08)';
  ctx.lineWidth = 1;

  for (let x = -bound; x <= bound; x += gridStep) {
    const p1 = worldToScreen(x, -bound);
    const p2 = worldToScreen(x, bound);
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
  }
  for (let y = -bound; y <= bound; y += gridStep) {
    const p1 = worldToScreen(-bound, y);
    const p2 = worldToScreen(bound, y);
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
  }

  // Glowing Boundary Box
  const topLeft = worldToScreen(-bound, bound);
  const bottomRight = worldToScreen(bound, -bound);
  const w = bottomRight.x - topLeft.x;
  const h = bottomRight.y - topLeft.y;

  ctx.strokeStyle = '#00f3ff';
  ctx.lineWidth = 3;
  ctx.shadowColor = '#00f3ff';
  ctx.shadowBlur = 15;
  ctx.strokeRect(topLeft.x, topLeft.y, w, h);

  ctx.restore();
}

/* ==========================================================================
   NETWORKING & WEBSOCKET PROTOCOL
   ========================================================================== */

function sendWS(msgObj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msgObj));
  }
}

function initSocketConnection() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log('🌐 Conectado ao servidor WebSocket!');
    showToast('Conectado ao servidor!');

    sendWS({
      type: 'join_room',
      roomId: currentRoomId,
      playerName: myPlayerName,
      playerColor: myPlayerColor
    });

    setInterval(() => {
      pingStartTime = Date.now();
      sendWS({ type: 'ping_check' });
    }, 3000);
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleServerMessage(msg);
    } catch (e) {}
  };

  ws.onclose = () => {
    showToast('Conexão encerrada.');
  };
}

let pingStartTime = 0;

function handleServerMessage(msg) {
  switch (msg.type) {
    case 'init_game_state': {
      selfSocketId = msg.selfId;

      const myData = msg.players.find(p => p.id === selfSocketId);
      if (myData) {
        localPlayer = new LocalPlayerEntity(myData.x, myData.y, myPlayerColor, myPlayerName);
        localPlayer.health = myData.health;
        localPlayer.score = myData.score;
        updateHUD();
      }

      remotePlayersMap.clear();
      msg.players.forEach(pData => {
        if (pData.id !== selfSocketId) {
          remotePlayersMap.set(pData.id, new RemotePlayerEntity(pData));
        }
      });

      orbsMap.clear();
      msg.orbs.forEach(oData => {
        orbsMap.set(oData.id, new OrbEntity(oData));
      });

      updateLeaderboard();
      break;
    }

    case 'player_joined': {
      const pData = msg.player;
      if (pData.id !== selfSocketId && !remotePlayersMap.has(pData.id)) {
        remotePlayersMap.set(pData.id, new RemotePlayerEntity(pData));
        showToast(`${pData.name} entrou na sala!`);
        updateLeaderboard();
      }
      break;
    }

    case 'remote_player_update': {
      const rPlayer = remotePlayersMap.get(msg.id);
      if (rPlayer) {
        rPlayer.updateData(msg);
      }
      break;
    }

    case 'player_left': {
      const rPlayer = remotePlayersMap.get(msg.id);
      if (rPlayer) {
        showToast(`${rPlayer.name} saiu.`);
        remotePlayersMap.delete(msg.id);
        updateLeaderboard();
      }
      break;
    }

    case 'projectile_spawned': {
      projectilesList.push(new LaserBulletEntity(msg));
      break;
    }

    case 'orb_collected': {
      orbsMap.delete(msg.orbId);
      if (msg.newOrb) {
        orbsMap.set(msg.newOrb.id, new OrbEntity(msg.newOrb));
      }

      if (msg.collectorId === selfSocketId && localPlayer) {
        localPlayer.score = msg.newScore;
        localPlayer.health = msg.newHealth;
        updateHUD();
      } else {
        const rPlayer = remotePlayersMap.get(msg.collectorId);
        if (rPlayer) rPlayer.score = msg.newScore;
      }

      updateLeaderboard();
      break;
    }

    case 'player_health_updated': {
      if (msg.id === selfSocketId && localPlayer) {
        localPlayer.health = msg.health;
        updateHUD();
      } else {
        const rPlayer = remotePlayersMap.get(msg.id);
        if (rPlayer) rPlayer.health = msg.health;
      }
      break;
    }

    case 'player_respawned': {
      if (msg.id === selfSocketId && localPlayer) {
        localPlayer.health = msg.health;
        localPlayer.score = msg.score;
        localPlayer.x = msg.x;
        localPlayer.y = msg.y;
        localPlayer.vx = 0;
        localPlayer.vy = 0;
        updateHUD();
        showToast(`Eliminado por ${msg.killedBy}! Respawnando...`);
      } else {
        const rPlayer = remotePlayersMap.get(msg.id);
        if (rPlayer) {
          rPlayer.health = msg.health;
          rPlayer.score = msg.score;
          rPlayer.x = msg.x;
          rPlayer.y = msg.y;
        }
      }
      updateLeaderboard();
      break;
    }

    case 'chat_received': {
      addChatMessage(msg.senderName, msg.text, msg.senderColor);
      break;
    }

    case 'pong_check': {
      const ping = Date.now() - pingStartTime;
      document.getElementById('hud-ping').innerHTML = `<i class="fa-solid fa-bolt"></i> ${ping} ms`;
      break;
    }
  }
}

/* ==========================================================================
   UI HELPERS & DOM EVENT LISTENERS
   ========================================================================== */

function updateHUD() {
  if (!localPlayer) return;
  document.getElementById('hud-player-name').innerText = myPlayerName;
  document.getElementById('hud-color-indicator').style.backgroundColor = myPlayerColor;
  document.getElementById('hud-color-indicator').style.boxShadow = `0 0 12px ${myPlayerColor}`;
  document.getElementById('hud-score').innerText = localPlayer.score;
  document.getElementById('hud-health-fill').style.width = `${Math.max(0, localPlayer.health)}%`;
  document.getElementById('hud-room-id').innerText = currentRoomId;
}

function updateLeaderboard() {
  const listEl = document.getElementById('leaderboard-list');
  listEl.innerHTML = '';

  const allPlayers = [];

  if (localPlayer) {
    allPlayers.push({
      name: myPlayerName,
      score: localPlayer.score,
      color: myPlayerColor,
      isSelf: true
    });
  }

  remotePlayersMap.forEach(r => {
    allPlayers.push({
      name: r.name,
      score: r.score,
      color: r.color,
      isSelf: false
    });
  });

  allPlayers.sort((a, b) => b.score - a.score);

  document.getElementById('player-count').innerText = allPlayers.length;

  allPlayers.forEach(p => {
    const li = document.createElement('li');
    li.className = `leaderboard-item ${p.isSelf ? 'is-self' : ''}`;
    li.innerHTML = `
      <div class="player-name-dot">
        <span class="dot" style="background:${p.color}; box-shadow:0 0 8px ${p.color};"></span>
        <span>${escapeHtml(p.name)}</span>
      </div>
      <span class="score">${p.score}</span>
    `;
    listEl.appendChild(li);
  });
}

function addChatMessage(sender, text, color) {
  const container = document.getElementById('chat-messages');
  const msgEl = document.createElement('div');
  msgEl.className = 'chat-msg';
  msgEl.innerHTML = `<span class="sender" style="color:${color || '#00f3ff'}">${escapeHtml(sender)}:</span> ${escapeHtml(text)}`;
  container.appendChild(msgEl);
  container.scrollTop = container.scrollHeight;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m]));
}

function showToast(message) {
  const toast = document.getElementById('toast');
  document.getElementById('toast-message').innerText = message;
  toast.classList.remove('hidden');
  setTimeout(() => { toast.classList.add('hidden'); }, 3000);
}

// Window Initialization
window.addEventListener('load', () => {
  const container = document.getElementById('game-container');
  canvas = document.createElement('canvas');
  ctx = canvas.getContext('2d');
  container.appendChild(canvas);

  function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  // Initialize Touch Controls
  initTouchControls();

  // Parse Room Parameter from URL
  const urlParams = new URLSearchParams(window.location.search);
  const roomParam = urlParams.get('room');
  if (roomParam) {
    document.getElementById('room-id').value = roomParam;
  } else {
    document.getElementById('room-id').value = 'cyber-room-' + Math.floor(Math.random() * 900 + 100);
  }

  document.getElementById('random-room-btn').addEventListener('click', () => {
    document.getElementById('room-id').value = 'arena-' + Math.floor(Math.random() * 9000 + 1000);
  });

  const colorBtns = document.querySelectorAll('.color-btn');
  colorBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      colorBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      myPlayerColor = btn.getAttribute('data-color');
    });
  });

  // Mobile Chat Toggle Button
  const btnToggleChat = document.getElementById('btn-toggle-chat');
  const chatContainer = document.getElementById('chat-container');
  if (btnToggleChat && chatContainer) {
    btnToggleChat.addEventListener('click', () => {
      chatContainer.classList.toggle('hidden-mobile');
    });
  }

  // Join Game Form
  document.getElementById('join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    myPlayerName = document.getElementById('player-name').value.trim() || 'CyberPlayer';
    currentRoomId = document.getElementById('room-id').value.trim() || 'lobby';

    const newUrl = window.location.protocol + "//" + window.location.host + window.location.pathname + '?room=' + encodeURIComponent(currentRoomId);
    window.history.pushState({ path: newUrl }, '', newUrl);

    document.getElementById('join-screen').classList.add('hidden');
    document.getElementById('game-hud').classList.remove('hidden');

    initSocketConnection();

    // Start 60FPS Game Loop
    requestAnimationFrame(gameLoop);
  });

  // Share Link Button
  document.getElementById('btn-share-link').addEventListener('click', () => {
    const shareUrl = window.location.href;
    navigator.clipboard.writeText(shareUrl).then(() => {
      showToast('Link da sala copiado!');
    }).catch(() => {
      prompt('Copie o link da sala:', shareUrl);
    });
  });

  // Chat Form
  document.getElementById('chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (text && ws) {
      sendWS({ type: 'send_chat', text });
      input.value = '';
    }
  });
});
