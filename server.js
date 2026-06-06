// ════════════════════════════════════════════════
//  MARBLES CLOUD SERVER — Railway / Render ready
//  Reads Kick chat via Pusher, relays to widgets via WebSocket
// ════════════════════════════════════════════════
const express   = require('express');
const cors      = require('cors');
const WebSocket = require('ws');
const http      = require('http');
const path      = require('path');

const app    = express();
const server = http.createServer(app);
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── ROOMS: один канал Kick = одна кімната ──────────
// room = { kickWs, chatroomId, regOpen, joinCmd, players:Map, joined:Set, clients:Set<ws> }
const rooms = new Map();

function getRoom(channel) {
  if (!rooms.has(channel)) {
    rooms.set(channel, {
      channel,
      chatroomId: null,
      kickWs: null,
      regOpen: false,
      joinCmd: '!play',
      players: new Map(),  // username -> {colorHex}
      joined: new Set(),
      clients: new Set(),  // widget + control WebSocket connections
      pingInterval: null,
      reconnectTimer: null,
    });
  }
  return rooms.get(channel);
}

const COLORS = ['#ef4444','#f97316','#eab308','#22c55e','#06b6d4','#3b82f6','#8b5cf6','#ec4899','#14b8a6','#f59e0b','#84cc16','#6366f1','#a78bfa','#fb923c','#34d399','#60a5fa','#f472b6','#4ade80'];
function colorFor(name) {
  let h = 0; for (const c of name) h = c.charCodeAt(0) + ((h<<5)-h);
  return COLORS[Math.abs(h) % COLORS.length];
}

// ── Broadcast to all clients (widget+control) of a room ──
function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  room.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  });
}

// ── Resolve Kick channel slug → chatroom_id via API ──
async function resolveChatroomId(channel) {
  const endpoints = [
    `https://kick.com/api/v2/channels/${channel}`,
    `https://kick.com/api/v1/channels/${channel}`,
  ];
  for (const url of endpoints) {
    try {
      const r = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      if (!r.ok) continue;
      const data = await r.json();
      if (data?.chatroom?.id) return data.chatroom.id;
    } catch (e) { /* try next */ }
  }
  return null;
}

// ── Connect a room to Kick Pusher ──────────────────
async function connectKick(room) {
  if (!room.chatroomId) {
    const id = await resolveChatroomId(room.channel);
    if (!id) {
      broadcast(room, { type: 'kick_status', status: 'error', msg: 'Канал не знайдено' });
      console.log(`❌ Cannot resolve chatroom for ${room.channel}`);
      return;
    }
    room.chatroomId = id;
  }

  if (room.kickWs) { try { room.kickWs.terminate(); } catch(e){} }
  if (room.pingInterval) clearInterval(room.pingInterval);
  if (room.reconnectTimer) clearTimeout(room.reconnectTimer);

  console.log(`📡 [${room.channel}] connecting chatroom ${room.chatroomId}`);
  broadcast(room, { type: 'kick_status', status: 'connecting' });

  const url = 'wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0-rc2&flash=false';
  const kw = new WebSocket(url, { handshakeTimeout: 10000 });
  room.kickWs = kw;

  kw.on('open', () => {
    kw.send(JSON.stringify({ event:'pusher:subscribe', data:{ auth:'', channel:`chatrooms.${room.chatroomId}` }}));
    room.pingInterval = setInterval(() => {
      if (kw.readyState === WebSocket.OPEN) kw.send(JSON.stringify({ event:'pusher:ping', data:{} }));
    }, 25000);
  });

  kw.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.event === 'pusher:connection_established') {
        console.log(`✅ [${room.channel}] connected`);
        broadcast(room, { type: 'kick_status', status: 'connected', chatroomId: room.chatroomId });
      }
      if (msg.event === 'App\\Events\\ChatMessageEvent' || msg.event === 'App\\Events\\ChatMessageSentEvent') {
        const d = typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data;
        const message = d.message || d;
        const sender  = d.sender || d.user || {};
        const name = (sender.username || sender.slug || '').trim();
        const text = (message.content || message.message || '').trim();
        if (!name || !text) return;

        // Relay chat line to control panel
        broadcast(room, { type: 'chat', name, text });

        // Registration
        if (room.regOpen && text.toLowerCase() === room.joinCmd.toLowerCase() && !room.joined.has(name)) {
          room.joined.add(name);
          const color = colorFor(name);
          room.players.set(name, { colorHex: color });
          broadcast(room, { type: 'player_join', username: name, colorHex: color, count: room.players.size });
          console.log(`✅ [${room.channel}] +${name} (${room.players.size})`);
        }
      }
    } catch(e) {}
  });

  kw.on('error', (e) => {
    console.error(`❌ [${room.channel}] WS error:`, e.message);
    broadcast(room, { type: 'kick_status', status: 'error', msg: e.message });
  });

  kw.on('close', () => {
    clearInterval(room.pingInterval);
    broadcast(room, { type: 'kick_status', status: 'disconnected' });
    // Reconnect if room still has clients
    if (room.clients.size > 0) {
      room.reconnectTimer = setTimeout(() => connectKick(room), 3000);
    }
  });
}

// ════════════════════════════════════════════════
//  WEBSOCKET SERVER (widgets + control panels)
// ════════════════════════════════════════════════
const wss = new WebSocket.Server({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  // Channel from query: /ws?channel=NICK&role=widget|control
  const params  = new URLSearchParams((req.url.split('?')[1]) || '');
  const channel = (params.get('channel') || '').trim().toLowerCase();
  const role    = params.get('role') || 'widget';

  if (!channel) { ws.close(); return; }

  const room = getRoom(channel);
  room.clients.add(ws);
  ws.channel = channel;
  ws.role = role;

  console.log(`🔌 [${channel}] ${role} connected (clients: ${room.clients.size})`);

  // Send current state to new client
  ws.send(JSON.stringify({
    type: 'state',
    regOpen: room.regOpen,
    joinCmd: room.joinCmd,
    chatroomId: room.chatroomId,
    kickConnected: room.kickWs?.readyState === WebSocket.OPEN,
    players: Array.from(room.players.entries()).map(([username, d]) => ({ username, colorHex: d.colorHex }))
  }));

  // Auto-connect to Kick when first client joins
  if (!room.kickWs || room.kickWs.readyState !== WebSocket.OPEN) {
    connectKick(room);
  }

  // ── Messages from control panel ──
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch(e) { return; }

    if (msg.type === 'open_registration') {
      room.regOpen = true;
      room.joined.clear();
      room.players.clear();
      room.joinCmd = msg.cmd || '!play';
      broadcast(room, { type: 'registration_opened', joinCmd: room.joinCmd });
      console.log(`📋 [${channel}] registration OPEN`);
    }
    if (msg.type === 'close_registration') {
      room.regOpen = false;
      broadcast(room, { type: 'registration_closed' });
    }
    if (msg.type === 'start_race') {
      // relay players + start signal to all widgets
      broadcast(room, {
        type: 'start_race',
        players: Array.from(room.players.entries()).map(([username, d]) => ({ username, colorHex: d.colorHex }))
      });
      room.regOpen = false;
    }
    if (msg.type === 'reset') {
      room.regOpen = false;
      room.joined.clear();
      room.players.clear();
      broadcast(room, { type: 'reset' });
    }
    if (msg.type === 'race_finished') {
      broadcast(room, { type: 'race_finished', order: msg.order });
    }
    if (msg.type === 'add_player') {
      // manual add from control panel
      const name = (msg.username || '').trim();
      if (name && !room.joined.has(name)) {
        room.joined.add(name);
        const color = msg.colorHex || colorFor(name);
        room.players.set(name, { colorHex: color });
        broadcast(room, { type: 'player_join', username: name, colorHex: color, count: room.players.size });
      }
    }
  });

  ws.on('close', () => {
    room.clients.delete(ws);
    console.log(`🔌 [${channel}] ${role} left (clients: ${room.clients.size})`);
    // Cleanup empty room
    if (room.clients.size === 0) {
      if (room.kickWs) { try { room.kickWs.terminate(); } catch(e){} }
      if (room.pingInterval) clearInterval(room.pingInterval);
      if (room.reconnectTimer) clearTimeout(room.reconnectTimer);
      rooms.delete(channel);
      console.log(`🗑  [${channel}] room closed`);
    }
  });
});

// Health check for Railway
app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size }));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════╗');
  console.log('║    🎮  MARBLES CLOUD SERVER           ║');
  console.log('╚══════════════════════════════════════╝');
  console.log(`  Port: ${PORT}`);
  console.log(`  WS:   /ws?channel=NICK&role=widget`);
  console.log('');
});
