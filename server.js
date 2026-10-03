import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');

// MIME types dictionary for static file serving
const MIME_TYPES = {
  '.html': 'text/html; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.js': 'application/javascript; charset=UTF-8',
  '.json': 'application/json; charset=UTF-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml'
};

// World & Game constants
const WORLD_SIZE = 60;
const MAX_ORBS_PER_ROOM = 15;

// Rooms Map: roomId -> { roomId, players: Map, orbs: Array }
const rooms = new Map();
// Active Connections Map: socketId -> { socket, roomId, playerData }
const socketsMap = new Map();

function getRandomPosition(padding = 5) {
  const half = WORLD_SIZE / 2 - padding;
  return {
    x: Math.round(((Math.random() * 2 - 1) * half) * 100) / 100,
    y: Math.round(((Math.random() * 2 - 1) * half) * 100) / 100
  };
}

function createOrbs(count) {
  const orbs = [];
  const colors = ['#00f3ff', '#ff007f', '#00ff66', '#ffb700', '#9d00ff'];
  for (let i = 0; i < count; i++) {
    const pos = getRandomPosition();
    orbs.push({
      id: 'orb_' + Math.random().toString(36).substr(2, 9),
      x: pos.x,
      y: pos.y,
      color: colors[Math.floor(Math.random() * colors.length)],
      value: Math.floor(Math.random() * 3) + 1
    });
  }
  return orbs;
}

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      roomId,
      players: new Map(),
      orbs: createOrbs(MAX_ORBS_PER_ROOM)
    });
  }
  return rooms.get(roomId);
}

// --------------------------------------------------------------------------
// WebSocket Helpers (RFC 6455)
// --------------------------------------------------------------------------

function createWebSocketFrame(payloadStr) {
  const payloadBuffer = Buffer.from(payloadStr, 'utf-8');
  const length = payloadBuffer.length;
  let header;

  if (length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // FIN + Text
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  return Buffer.concat([header, payloadBuffer]);
}

function sendToSocket(socket, messageObj) {
  try {
    if (socket && !socket.destroyed && socket.writable) {
      const frame = createWebSocketFrame(JSON.stringify(messageObj));
      socket.write(frame);
    }
  } catch (err) {
    console.error('Error writing to socket:', err.message);
  }
}

function broadcastToRoom(roomId, messageObj, excludeSocketId = null) {
  const room = rooms.get(roomId);
  if (!room) return;

  const frame = createWebSocketFrame(JSON.stringify(messageObj));
  for (const [pId, player] of room.players.entries()) {
    if (pId !== excludeSocketId) {
      const conn = socketsMap.get(pId);
      if (conn && conn.socket && !conn.socket.destroyed && conn.socket.writable) {
        conn.socket.write(frame);
      }
    }
  }
}

function parseWebSocketFrame(buffer) {
  if (buffer.length < 2) return null;

  const firstByte = buffer[0];
  const secondByte = buffer[1];

  const fin = (firstByte & 0x80) === 0x80;
  const opcode = firstByte & 0x0f;
  const masked = (secondByte & 0x80) === 0x80;

  if (opcode === 0x8) return { opcode: 0x8, payload: null, totalBytes: buffer.length }; // Close
  if (opcode === 0x9) return { opcode: 0x9, payload: null, totalBytes: buffer.length }; // Ping

  let payloadLen = secondByte & 0x7f;
  let offset = 2;

  if (payloadLen === 126) {
    if (buffer.length < 4) return null;
    payloadLen = buffer.readUInt16BE(2);
    offset += 2;
  } else if (payloadLen === 127) {
    if (buffer.length < 10) return null;
    payloadLen = Number(buffer.readBigUInt64BE(2));
    offset += 8;
  }

  let maskKey = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    maskKey = buffer.subarray(offset, offset + 4);
    offset += 4;
  }

  if (buffer.length < offset + payloadLen) return null;

  const payload = Buffer.from(buffer.subarray(offset, offset + payloadLen));
  if (masked && maskKey) {
    for (let i = 0; i < payload.length; i++) {
      payload[i] ^= maskKey[i % 4];
    }
  }

  return {
    fin,
    opcode,
    payload,
    totalBytes: offset + payloadLen
  };
}

// --------------------------------------------------------------------------
// HTTP Server (Static Files)
// --------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  let filePath = path.join(PUBLIC_DIR, req.url === '/' ? 'index.html' : req.url);

  // Security: prevent directory traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const extname = String(path.extname(filePath)).toLowerCase();
  const contentType = MIME_TYPES[extname] || 'application/octet-stream';

  fs.readFile(filePath, (error, content) => {
    if (error) {
      if (error.code === 'ENOENT') {
        // Fallback to index.html for SPA routing
        fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err, indexContent) => {
          if (err) {
            res.writeHead(404);
            res.end('404 Not Found');
          } else {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8' });
            res.end(indexContent, 'utf-8');
          }
        });
      } else {
        res.writeHead(500);
        res.end(`Server Error: ${error.code}`);
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content, 'utf-8');
    }
  });
});

// --------------------------------------------------------------------------
// WebSocket Upgrade Handler
// --------------------------------------------------------------------------

server.on('upgrade', (req, socket, head) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }

  const acceptKey = crypto.createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');

  const headers = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey}`
  ];

  socket.write(headers.join('\r\n') + '\r\n\r\n');

  const socketId = 'sock_' + Math.random().toString(36).substr(2, 9);
  socketsMap.set(socketId, { socket, roomId: null, playerData: null });

  console.log(`[WS] Cliente conectado ID: ${socketId}`);

  let bufferAcc = Buffer.alloc(0);

  socket.on('data', (chunk) => {
    bufferAcc = Buffer.concat([bufferAcc, chunk]);

    while (bufferAcc.length > 0) {
      const parsed = parseWebSocketFrame(bufferAcc);
      if (!parsed) break; // Incomplete frame

      bufferAcc = bufferAcc.subarray(parsed.totalBytes);

      if (parsed.opcode === 0x8) { // Close frame
        handleSocketDisconnect(socketId);
        socket.end();
        break;
      }

      if (parsed.opcode === 0x1 && parsed.payload) { // Text frame
        try {
          const msgStr = parsed.payload.toString('utf-8');
          const msg = JSON.parse(msgStr);
          handleClientMessage(socketId, msg);
        } catch (e) {
          console.error('Error parsing JSON message:', e.message);
        }
      }
    }
  });

  socket.on('close', () => {
    handleSocketDisconnect(socketId);
  });

  socket.on('error', (err) => {
    console.error(`[WS Error] ${socketId}:`, err.message);
    handleSocketDisconnect(socketId);
  });
});

function handleSocketDisconnect(socketId) {
  const conn = socketsMap.get(socketId);
  if (conn) {
    const roomId = conn.roomId;
    if (roomId) {
      const room = rooms.get(roomId);
      if (room) {
        room.players.delete(socketId);
        broadcastToRoom(roomId, { type: 'player_left', id: socketId });

        if (room.players.size === 0 && roomId !== 'lobby') {
          rooms.delete(roomId);
        }
      }
    }
    socketsMap.delete(socketId);
    console.log(`[WS] Cliente desconectado ID: ${socketId}`);
  }
}

// --------------------------------------------------------------------------
// Game Logic Event Dispatcher
// --------------------------------------------------------------------------

function handleClientMessage(socketId, msg) {
  const conn = socketsMap.get(socketId);
  if (!conn) return;

  switch (msg.type) {
    case 'join_room': {
      const roomId = msg.roomId || 'lobby';
      const playerName = msg.playerName || `Player_${socketId.substr(0, 4)}`;
      const playerColor = msg.playerColor || '#00f3ff';

      // Leave old room if any
      if (conn.roomId) {
        const oldRoom = rooms.get(conn.roomId);
        if (oldRoom) {
          oldRoom.players.delete(socketId);
          broadcastToRoom(conn.roomId, { type: 'player_left', id: socketId });
        }
      }

      conn.roomId = roomId;
      const room = getOrCreateRoom(roomId);
      const startPos = getRandomPosition(10);

      const playerData = {
        id: socketId,
        name: playerName,
        color: playerColor,
        x: startPos.x,
        y: startPos.y,
        vx: 0,
        vy: 0,
        angle: 0,
        score: 0,
        health: 100,
        maxHealth: 100,
        isDashing: false
      };

      conn.playerData = playerData;
      room.players.set(socketId, playerData);

      // Send initial full game state to joined player
      sendToSocket(conn.socket, {
        type: 'init_game_state',
        selfId: socketId,
        worldSize: WORLD_SIZE,
        players: Array.from(room.players.values()),
        orbs: room.orbs
      });

      // Notify others in room
      broadcastToRoom(roomId, {
        type: 'player_joined',
        player: playerData
      }, socketId);

      console.log(`[Game] ${playerName} (${socketId}) entrou na sala: ${roomId}`);
      break;
    }

    case 'player_update': {
      if (!conn.roomId) return;
      const room = rooms.get(conn.roomId);
      if (!room) return;

      const player = room.players.get(socketId);
      if (player) {
        player.x = msg.x;
        player.y = msg.y;
        player.vx = msg.vx;
        player.vy = msg.vy;
        player.angle = msg.angle;
        player.isDashing = msg.isDashing || false;

        broadcastToRoom(conn.roomId, {
          type: 'remote_player_update',
          id: socketId,
          x: player.x,
          y: player.y,
          vx: player.vx,
          vy: player.vy,
          angle: player.angle,
          isDashing: player.isDashing
        }, socketId);
      }
      break;
    }

    case 'shoot_projectile': {
      if (!conn.roomId) return;
      const projId = 'proj_' + Math.random().toString(36).substr(2, 9);
      broadcastToRoom(conn.roomId, {
        type: 'projectile_spawned',
        id: projId,
        ownerId: socketId,
        x: msg.x,
        y: msg.y,
        vx: msg.vx,
        vy: msg.vy,
        color: msg.color || '#ff007f'
      });
      break;
    }

    case 'collect_orb': {
      if (!conn.roomId) return;
      const room = rooms.get(conn.roomId);
      if (!room) return;

      const orbIndex = room.orbs.findIndex(o => o.id === msg.orbId);
      if (orbIndex !== -1) {
        const collectedOrb = room.orbs[orbIndex];
        const player = room.players.get(socketId);

        if (player) {
          player.score += collectedOrb.value * 10;
          player.health = Math.min(player.maxHealth, player.health + 5);
        }

        // Remove orb and spawn new one
        room.orbs.splice(orbIndex, 1);
        const newPos = getRandomPosition();
        const colors = ['#00f3ff', '#ff007f', '#00ff66', '#ffb700', '#9d00ff'];
        const newOrb = {
          id: 'orb_' + Math.random().toString(36).substr(2, 9),
          x: newPos.x,
          y: newPos.y,
          color: colors[Math.floor(Math.random() * colors.length)],
          value: Math.floor(Math.random() * 3) + 1
        };
        room.orbs.push(newOrb);

        broadcastToRoom(conn.roomId, {
          type: 'orb_collected',
          orbId: msg.orbId,
          newOrb,
          collectorId: socketId,
          newScore: player ? player.score : 0,
          newHealth: player ? player.health : 100
        });
      }
      break;
    }

    case 'player_damaged': {
      if (!conn.roomId) return;
      const room = rooms.get(conn.roomId);
      if (!room) return;

      const victim = room.players.get(msg.victimId);
      const attacker = room.players.get(msg.attackerId);

      if (victim) {
        victim.health -= msg.damage || 15;
        if (victim.health <= 0) {
          const newPos = getRandomPosition(10);
          victim.health = 100;
          victim.x = newPos.x;
          victim.y = newPos.y;
          victim.score = Math.max(0, victim.score - 20);

          if (attacker && msg.attackerId !== msg.victimId) {
            attacker.score += 50;
          }

          broadcastToRoom(conn.roomId, {
            type: 'player_respawned',
            id: msg.victimId,
            x: victim.x,
            y: victim.y,
            health: victim.health,
            score: victim.score,
            killedBy: attacker ? attacker.name : 'Inimigo'
          });
        } else {
          broadcastToRoom(conn.roomId, {
            type: 'player_health_updated',
            id: msg.victimId,
            health: victim.health
          });
        }
      }
      break;
    }

    case 'send_chat': {
      if (!conn.roomId || !msg.text) return;
      const room = rooms.get(conn.roomId);
      if (!room) return;
      const player = room.players.get(socketId);
      if (player) {
        broadcastToRoom(conn.roomId, {
          type: 'chat_received',
          senderId: socketId,
          senderName: player.name,
          senderColor: player.color,
          text: String(msg.text).substring(0, 100)
        });
      }
      break;
    }

    case 'ping_check': {
      sendToSocket(conn.socket, { type: 'pong_check' });
      break;
    }
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`=================================================`);
  console.log(`  🚀 Jogo Online LittleJS (Zero-Dependency)`);
  console.log(`  👉 Servidor rodando em: http://localhost:${PORT}`);
  console.log(`=================================================`);
});
