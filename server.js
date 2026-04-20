// ====================================================================
//  NEON SIEGE — Multiplayer Room Broker  (ZERO DEPENDENCIES)
//  Uses only Node.js built-in modules: http, fs, path, crypto.
//  WebSocket protocol (RFC 6455) is implemented from scratch below.
//  Run with:   node server.js
// ====================================================================

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8787;
const ROOM_CODE_LEN = 4;
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

// =====================================================================
//  Minimal WebSocket server (RFC 6455 — text frames only, no extensions)
// =====================================================================
const WS_GUID = '258EAFA5-E914-47DA-95CA-5AB5DC525C61';
const OPEN = 1, CLOSED = 3;

class WsClient {
  constructor(socket) {
    this.socket = socket;
    this.readyState = OPEN;
    this._buf = Buffer.alloc(0);
    this._onMessage = null;
    this._onClose = null;

    socket.on('data', chunk => this._onData(chunk));
    socket.on('close', () => this._handleClose());
    socket.on('error', () => this._handleClose());
  }

  send(str) {
    if (this.readyState !== OPEN) return;
    const payload = Buffer.from(str, 'utf8');
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x81; // FIN + text opcode
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      // write 64-bit length (upper 32 bits = 0 for any realistic message)
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(len, 6);
    }
    try { this.socket.write(Buffer.concat([header, payload])); } catch (_) {}
  }

  close() {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    try {
      const frame = Buffer.alloc(2);
      frame[0] = 0x88; // FIN + close opcode
      frame[1] = 0;
      this.socket.write(frame);
      this.socket.end();
    } catch (_) {}
  }

  _handleClose() {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    if (this._onClose) this._onClose();
  }

  _onData(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);
    while (this._buf.length >= 2) {
      const firstByte  = this._buf[0];
      const secondByte = this._buf[1];
      const opcode = firstByte & 0x0F;
      const masked = !!(secondByte & 0x80);
      let payloadLen = secondByte & 0x7F;
      let offset = 2;

      if (payloadLen === 126) {
        if (this._buf.length < 4) return; // need more data
        payloadLen = this._buf.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this._buf.length < 10) return;
        payloadLen = this._buf.readUInt32BE(6); // ignore upper 32 bits
        offset = 10;
      }

      const maskLen = masked ? 4 : 0;
      const totalLen = offset + maskLen + payloadLen;
      if (this._buf.length < totalLen) return; // need more data

      let payload = this._buf.slice(offset + maskLen, totalLen);
      if (masked) {
        const mask = this._buf.slice(offset, offset + 4);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      this._buf = this._buf.slice(totalLen);

      if (opcode === 0x08) { // close
        this.close();
        return;
      }
      if (opcode === 0x09) { // ping -> pong
        const pong = Buffer.alloc(2 + payload.length);
        pong[0] = 0x8A; pong[1] = payload.length;
        payload.copy(pong, 2);
        try { this.socket.write(pong); } catch (_) {}
        continue;
      }
      if (opcode === 0x0A) continue; // pong — ignore

      // text (0x01) or continuation — treat as text
      if (this._onMessage) {
        try { this._onMessage(payload.toString('utf8')); } catch (_) {}
      }
    }
  }
}

// upgrade handler
httpServer.on('upgrade', (req, socket, head) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1')
    .update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n` +
    '\r\n'
  );
  const ws = new WsClient(socket);
  onConnection(ws);
});

// =====================================================================
//  Room broker (identical logic, now using WsClient instead of 'ws')
// =====================================================================
const rooms = new Map();
let playerSeq = 0;

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < ROOM_CODE_LEN; i++) code += chars[Math.floor(Math.random() * chars.length)];
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
    if (p.ws.readyState === OPEN) p.ws.send(data);
  }
  room.lastActive = Date.now();
}

function sendTo(player, msg) {
  if (player.ws.readyState === OPEN) player.ws.send(JSON.stringify(msg));
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

function onConnection(ws) {
  const player = {
    id: `p${++playerSeq}`,
    ws,
    name: 'OPERATOR',
    roomCode: null,
    isHost: false,
  };
  console.log(`[${player.id}] connected`);

  ws._onMessage = (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
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
      const code = String(msg.roomCode || '').toUpperCase();
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

    if (msg.t === 'hit') {
      const host = room.players.get(room.hostId);
      if (host && host.id !== player.id) {
        sendTo(host, { ...msg, from: player.id });
      }
      return;
    }

    broadcast(room, { ...msg, from: player.id }, player.id);
  };

  ws._onClose = () => {
    console.log(`[${player.id}] disconnected`);
    if (player.roomCode) removePlayer(player);
  };
}

// periodic idle room reaper
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
  console.log(`NEON SIEGE co-op server ready`);
  console.log(`  Local:    http://localhost:${PORT}/`);
  console.log(`  Network:  http://<your-lan-ip>:${PORT}/`);
  console.log(`  Rooms:    up to ${MAX_PLAYERS_PER_ROOM} players each`);
  console.log(`  Zero dependencies — just node.exe + this file`);
});
