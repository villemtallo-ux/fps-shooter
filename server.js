// ====================================================================
//  NEON SIEGE — Multiplayer Room Broker
//  Uses the battle-tested `ws` npm package (Render auto-installs it).
//  Hosts the static game files + WebSocket room broker on one port.
//  Run with:   npm install && npm start      (or just node server.js after npm install)
// ====================================================================

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

process.on('uncaughtException',  (err) => console.error('[uncaught]', err));
process.on('unhandledRejection', (err) => console.error('[unhandled]', err));

const PORT = process.env.PORT || 8787;
const ROOM_CODE_LEN = 6;          // 6-digit numeric PIN (Kahoot-style)
const MAX_PLAYERS_PER_ROOM = 4;
const ROOM_IDLE_MS = 1000 * 60 * 30; // 30 min -> reap

// ----- Tiny static file server -----
const STATIC_DIR = __dirname;
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

const httpServer = http.createServer((req, res) => {
  let reqPath = decodeURIComponent(req.url.split('?')[0]);
  if (reqPath === '/') reqPath = '/index.html';
  const filePath = path.join(STATIC_DIR, reqPath);
  if (!filePath.startsWith(STATIC_DIR)) { res.statusCode = 403; return res.end('forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.statusCode = 404; return res.end('not found'); }
    const ext = path.extname(filePath).toLowerCase();
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    res.end(data);
  });
});

// ----- Rooms -----
const rooms = new Map();
let playerSeq = 0;

function genCode() {
  // 6-digit numeric PIN, first digit 1-9
  let code;
  do {
    let c = String(1 + Math.floor(Math.random() * 9));
    for (let i = 1; i < ROOM_CODE_LEN; i++) c += Math.floor(Math.random() * 10);
    code = c;
  } while (rooms.has(code));
  return code;
}

function createRoom(hostPlayer) {
  const code = genCode();
  const room = {
    code,
    players: new Map(),
    hostId: hostPlayer.id,
    createdAt: Date.now(),
    lastActive: Date.now(),
  };
  room.players.set(hostPlayer.id, hostPlayer);
  hostPlayer.roomCode = code;
  hostPlayer.isHost = true;
  rooms.set(code, room);
  return room;
}

function broadcast(room, msg, exceptId = null) {
  const data = JSON.stringify(msg);
  for (const p of room.players.values()) {
    if (p.id === exceptId) continue;
    if (p.ws.readyState === 1) p.ws.send(data);
  }
  room.lastActive = Date.now();
}

function sendTo(player, msg) {
  if (player.ws.readyState === 1) player.ws.send(JSON.stringify(msg));
}

function removePlayer(player) {
  const room = rooms.get(player.roomCode);
  if (!room) return;
  room.players.delete(player.id);
  if (room.players.size === 0) {
    rooms.delete(room.code);
    console.log(`[room ${room.code}] closed (empty)`);
    return;
  }
  if (player.isHost) {
    const newHost = room.players.values().next().value;
    newHost.isHost = true;
    room.hostId = newHost.id;
    broadcast(room, { t: 'hostChange', id: newHost.id });
    console.log(`[room ${room.code}] host migrated to ${newHost.id}`);
  }
  broadcast(room, { t: 'peerLeave', id: player.id });
}

// ----- WebSocket server (ws package — handles all the protocol for us) -----
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  const player = {
    id: `p${++playerSeq}`,
    ws,
    name: 'OPERATOR',
    roomCode: null,
    isHost: false,
  };
  console.log(`[${player.id}] connected`);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
    if (!msg || typeof msg.t !== 'string') return;

    if (msg.t === 'create') {
      if (player.roomCode) return;
      player.name = (msg.name || 'OPERATOR').slice(0, 16);
      const room = createRoom(player);
      sendTo(player, { t: 'created', roomCode: room.code, yourId: player.id });
      console.log(`[room ${room.code}] created by ${player.id}`);
      return;
    }

    if (msg.t === 'join') {
      if (player.roomCode) return;
      const code = String(msg.roomCode || '').replace(/\D/g, '');
      const room = rooms.get(code);
      if (!room) return sendTo(player, { t: 'joinFail', reason: 'Room not found' });
      if (room.players.size >= MAX_PLAYERS_PER_ROOM) {
        return sendTo(player, { t: 'joinFail', reason: 'Room full' });
      }
      player.name = (msg.name || 'OPERATOR').slice(0, 16);
      player.roomCode = room.code;
      player.isHost = false;
      room.players.set(player.id, player);
      const peers = [...room.players.values()]
        .filter(p => p.id !== player.id)
        .map(p => ({ id: p.id, name: p.name, isHost: p.isHost }));
      sendTo(player, {
        t: 'joined',
        roomCode: room.code,
        yourId: player.id,
        hostId: room.hostId,
        peers,
      });
      broadcast(room, { t: 'peerJoin', id: player.id, name: player.name }, player.id);
      console.log(`[room ${room.code}] ${player.id} joined (${room.players.size}/${MAX_PLAYERS_PER_ROOM})`);
      return;
    }

    if (msg.t === 'leave') {
      if (!player.roomCode) return;
      removePlayer(player);
      player.roomCode = null;
      player.isHost = false;
      return;
    }

    if (!player.roomCode) return;
    const room = rooms.get(player.roomCode);
    if (!room) return;
    room.lastActive = Date.now();

    // guest-sent hits go ONLY to the host
    if (msg.t === 'hit') {
      const host = room.players.get(room.hostId);
      if (host && host.id !== player.id) {
        sendTo(host, { ...msg, from: player.id });
      }
      return;
    }

    broadcast(room, { ...msg, from: player.id }, player.id);
  });

  ws.on('close', () => {
    console.log(`[${player.id}] disconnected`);
    if (player.roomCode) removePlayer(player);
  });

  ws.on('error', (err) => console.error(`[${player.id}] ws error`, err.message));
});

// idle room reaper
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.lastActive > ROOM_IDLE_MS) {
      for (const p of room.players.values()) try { p.ws.close(); } catch {}
      rooms.delete(code);
      console.log(`[room ${code}] reaped (idle)`);
    }
  }
}, 60 * 1000);

httpServer.listen(PORT, () => {
  console.log(`NEON SIEGE co-op server ready on port ${PORT}`);
  console.log(`  Rooms:  up to ${MAX_PLAYERS_PER_ROOM} players each`);
  console.log(`  PIN:    ${ROOM_CODE_LEN}-digit numeric (Kahoot-style)`);
});
