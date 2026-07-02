const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// WebSocket upgrade on /ws path handled by wss

// roomId -> Set of WebSocket clients
const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Set());
  }
  return rooms.get(roomId);
}

function broadcast(roomId, message, exclude = null) {
  const room = rooms.get(roomId);
  if (!room) return;
  const data = JSON.stringify(message);
  for (const client of room) {
    if (client !== exclude && client.readyState === 1) {
      client.send(data);
    }
  }
}

wss.on('connection', (ws) => {
  let roomId = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'join': {
        roomId = msg.roomId;
        const room = getRoom(roomId);
        room.add(ws);

        const peers = room.size - 1;
        ws.send(JSON.stringify({ type: 'joined', peers, roomId }));

        if (peers > 0) {
          broadcast(roomId, { type: 'peer-joined' }, ws);
        }
        break;
      }

      case 'offer':
      case 'answer':
      case 'ice-candidate':
      case 'screen-share':
      case 'draw':
      case 'draw-clear':
        broadcast(roomId, msg, ws);
        break;

      case 'leave':
        cleanup();
        break;
    }
  });

  function cleanup() {
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (room) {
      room.delete(ws);
      broadcast(roomId, { type: 'peer-left' });
      if (room.size === 0) {
        rooms.delete(roomId);
      }
    }
    roomId = null;
  }

  ws.on('close', cleanup);
});

server.listen(PORT, () => {
  console.log(`Video Call server running at http://localhost:${PORT}`);
});
