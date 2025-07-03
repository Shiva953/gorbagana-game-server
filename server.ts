import http from 'http';
import { Server, Socket } from 'socket.io';

interface Player {
  id: string;
  username: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  score: number;
  alive: boolean;
}

interface Room {
  players: { [socketId: string]: Player };
  scores: { [socketId: string]: number };
  startTime: number;
}

const server = http.createServer();
const io = new Server(server, {
  cors: { origin: '*' }
});

let rooms: { [roomId: string]: Room } = {}; // { [roomId]: { players: { [socketId]: playerObj }, scores: { [socketId]: number }, startTime: number } }

function generateRoomId(): string {
  return Math.random().toString(36).substr(2, 8).toUpperCase();
}

// Helper to remove player by username (wallet address) from a room
function removePlayerByUsername(roomId: string, username: string): void {
  if (!rooms[roomId]) return;
  const players = rooms[roomId].players;
  for (const [sid, player] of Object.entries(players)) {
    if (player.username === username) {
      // Disconnect the old socket
      const oldSocket = io.sockets.sockets.get(sid);
      if (oldSocket) oldSocket.disconnect(true);
      // Remove from room
      delete rooms[roomId].players[sid];
      delete rooms[roomId].scores[sid];
      io.to(roomId).emit('playerDisconnected', sid);
      break;
    }
  }
}

io.on('connection', (socket: Socket) => {
  console.log(`[SOCKET] Player connected: ${socket.id}`);

  // Create a new room/round
  socket.on('createRoom', (username: string, callback: (roomId: string) => void) => {
    const roomId = generateRoomId();
    rooms[roomId] = {
      players: {},
      scores: {},
      startTime: Date.now(),
    };
    socket.join(roomId);
    // Remove any existing player with the same username (shouldn't happen on create, but for safety)
    removePlayerByUsername(roomId, username);
    rooms[roomId].players[socket.id] = {
      id: socket.id,
      username: username || 'Player',
      x: 400 + Math.random() * 100,
      y: 300 + Math.random() * 100,
      vx: 0,
      vy: 0,
      score: 0,
      alive: true
    };
    rooms[roomId].scores[socket.id] = 0;
    console.log(`[ROOM] Created room ${roomId} by ${username} (${socket.id})`);
    callback(roomId);
    io.to(roomId).emit('currentPlayers', rooms[roomId].players);
  });

  // Join an existing room/round
  socket.on('joinRoom', (roomId: string, username: string, callback: (success: boolean) => void) => {
    if (rooms[roomId]) {
      socket.join(roomId);
      // Remove any existing player with the same username (wallet address) before adding new one
      removePlayerByUsername(roomId, username);
      rooms[roomId].players[socket.id] = {
        id: socket.id,
        username: username || 'Player',
        x: 400 + Math.random() * 100,
        y: 300 + Math.random() * 100,
        vx: 0,
        vy: 0,
        score: 0,
        alive: true
      };
      rooms[roomId].scores[socket.id] = 0;
      console.log(`[ROOM] ${username} (${socket.id}) joined room ${roomId}`);
      callback(true);
      io.to(roomId).emit('currentPlayers', rooms[roomId].players);
      socket.broadcast.to(roomId).emit('newPlayer', rooms[roomId].players[socket.id]);
    } else {
      console.log(`[ROOM] Join failed: Room ${roomId} does not exist for ${username} (${socket.id})`);
      callback(false);
    }
  });

  // Set username for legacy support (single room fallback)
  socket.on('setUsername', (username: string) => {
    // @ts-ignore
    if (typeof (global as any).players === 'undefined') {
      // @ts-ignore
      (global as any).players = {};
    }
    // @ts-ignore
    (global as any).players[socket.id] = {
      id: socket.id,
      username: username || 'Player',
      x: 400 + Math.random() * 100,
      y: 300 + Math.random() * 100,
      vx: 0,
      vy: 0,
      score: 0,
      alive: true
    };
    console.log(`[LEGACY] Username set for ${socket.id}: ${username}`);
    // @ts-ignore
    socket.emit('currentPlayers', (global as any).players);
    // @ts-ignore
    socket.broadcast.emit('newPlayer', (global as any).players[socket.id]);
  });

  // Handle player movement (per room)
  socket.on('move', (data: { x: number; y: number; vx: number; vy: number }) => {
    const roomId = getRoomId(socket);
    if (roomId && rooms[roomId] && rooms[roomId].players[socket.id]) {
      rooms[roomId].players[socket.id].x = data.x;
      rooms[roomId].players[socket.id].y = data.y;
      rooms[roomId].players[socket.id].vx = data.vx;
      rooms[roomId].players[socket.id].vy = data.vy;
      console.log(`[MOVE] ${rooms[roomId].players[socket.id].username} (${socket.id}) moved in room ${roomId}`);
      io.to(roomId).emit('playerMoved', rooms[roomId].players[socket.id]);
    }
  });

  // Handle score update (per room)
  socket.on('score', (score: number) => {
    const roomId = getRoomId(socket);
    if (roomId && rooms[roomId] && rooms[roomId].players[socket.id]) {
      rooms[roomId].players[socket.id].score = score;
      rooms[roomId].scores[socket.id] = score;
      console.log(`[SCORE] ${rooms[roomId].players[socket.id].username} (${socket.id}) scored ${score} in room ${roomId}`);
      io.to(roomId).emit('playerScored', rooms[roomId].players[socket.id]);
    }
  });

  // End round and broadcast results
  socket.on('endRound', () => {
    const roomId = getRoomId(socket);
    if (roomId && rooms[roomId]) {
      const scores = Object.entries(rooms[roomId].scores).map(([id, score]) => ({
        id,
        username: rooms[roomId].players[id]?.username || 'Player',
        score: score as number
      }));
      scores.sort((a, b) => b.score - a.score);
      console.log(`[ROUND END] Room ${roomId} ended. Scores:`, scores);
      io.to(roomId).emit('roundEnded', scores);
      // Disconnect all sockets in the room and clean up immediately
      const socketsInRoom = Object.keys(rooms[roomId].players);
      socketsInRoom.forEach(sid => {
        const s = io.sockets.sockets.get(sid);
        if (s) {
          console.log(`[ROOM CLEANUP] Disconnecting ${rooms[roomId].players[sid]?.username} (${sid}) from room ${roomId}`);
          s.disconnect(true);
        }
      });
      delete rooms[roomId];
      console.log(`[ROOM CLEANUP] Room ${roomId} deleted after round end.`);
    }
  });

  // Handle disconnect (per room)
  socket.on('disconnect', () => {
    const roomId = getRoomId(socket);
    if (roomId && rooms[roomId]) {
      const username = rooms[roomId].players[socket.id]?.username;
      delete rooms[roomId].players[socket.id];
      delete rooms[roomId].scores[socket.id];
      io.to(roomId).emit('playerDisconnected', socket.id);
      console.log(`[DISCONNECT] ${username} (${socket.id}) disconnected from room ${roomId}`);
      // If room is empty, clean up
      if (Object.keys(rooms[roomId].players).length === 0) {
        delete rooms[roomId];
        console.log(`[ROOM CLEANUP] Room ${roomId} deleted (empty after disconnect).`);
      }
    }
    console.log(`[SOCKET] Player disconnected: ${socket.id}`);
    io.emit('playerDisconnected', socket.id);
  });
});

function getRoomId(socket: Socket): string | undefined {
  const roomsArr = Array.from(socket.rooms);
  // The first room is always the socket id, so look for another
  return roomsArr.find(r => r !== socket.id);
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Socket.IO server running on port ${PORT}`);
}); 