"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
var http_1 = __importDefault(require("http"));
var socket_io_1 = require("socket.io");
var server = http_1.default.createServer();
var io = new socket_io_1.Server(server, {
    cors: { origin: '*' }
});
var rooms = {}; // { [roomId]: { players: { [socketId]: playerObj }, scores: { [socketId]: number }, startTime: number } }
function generateRoomId() {
    return Math.random().toString(36).substr(2, 8).toUpperCase();
}
// Helper to remove player by username (wallet address) from a room
function removePlayerByUsername(roomId, username) {
    if (!rooms[roomId])
        return;
    var players = rooms[roomId].players;
    for (var _i = 0, _a = Object.entries(players); _i < _a.length; _i++) {
        var _b = _a[_i], sid = _b[0], player = _b[1];
        if (player.username === username) {
            // Disconnect the old socket
            var oldSocket = io.sockets.sockets.get(sid);
            if (oldSocket)
                oldSocket.disconnect(true);
            // Remove from room
            delete rooms[roomId].players[sid];
            delete rooms[roomId].scores[sid];
            io.to(roomId).emit('playerDisconnected', sid);
            break;
        }
    }
}
io.on('connection', function (socket) {
    console.log("[SOCKET] Player connected: ".concat(socket.id));
    // Create a new room/round
    socket.on('createRoom', function (username, callback) {
        var roomId = generateRoomId();
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
        console.log("[ROOM] Created room ".concat(roomId, " by ").concat(username, " (").concat(socket.id, ")"));
        callback(roomId);
        io.to(roomId).emit('currentPlayers', rooms[roomId].players);
    });
    // Join an existing room/round
    socket.on('joinRoom', function (roomId, username, callback) {
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
            console.log("[ROOM] ".concat(username, " (").concat(socket.id, ") joined room ").concat(roomId));
            callback(true);
            io.to(roomId).emit('currentPlayers', rooms[roomId].players);
            socket.broadcast.to(roomId).emit('newPlayer', rooms[roomId].players[socket.id]);
        }
        else {
            console.log("[ROOM] Join failed: Room ".concat(roomId, " does not exist for ").concat(username, " (").concat(socket.id, ")"));
            callback(false);
        }
    });
    // Set username for legacy support (single room fallback)
    socket.on('setUsername', function (username) {
        // @ts-ignore
        if (typeof global.players === 'undefined') {
            // @ts-ignore
            global.players = {};
        }
        // @ts-ignore
        global.players[socket.id] = {
            id: socket.id,
            username: username || 'Player',
            x: 400 + Math.random() * 100,
            y: 300 + Math.random() * 100,
            vx: 0,
            vy: 0,
            score: 0,
            alive: true
        };
        console.log("[LEGACY] Username set for ".concat(socket.id, ": ").concat(username));
        // @ts-ignore
        socket.emit('currentPlayers', global.players);
        // @ts-ignore
        socket.broadcast.emit('newPlayer', global.players[socket.id]);
    });
    // Handle player movement (per room)
    socket.on('move', function (data) {
        var roomId = getRoomId(socket);
        if (roomId && rooms[roomId] && rooms[roomId].players[socket.id]) {
            rooms[roomId].players[socket.id].x = data.x;
            rooms[roomId].players[socket.id].y = data.y;
            rooms[roomId].players[socket.id].vx = data.vx;
            rooms[roomId].players[socket.id].vy = data.vy;
            console.log("[MOVE] ".concat(rooms[roomId].players[socket.id].username, " (").concat(socket.id, ") moved in room ").concat(roomId));
            io.to(roomId).emit('playerMoved', rooms[roomId].players[socket.id]);
        }
    });
    // Handle score update (per room)
    socket.on('score', function (score) {
        var roomId = getRoomId(socket);
        if (roomId && rooms[roomId] && rooms[roomId].players[socket.id]) {
            rooms[roomId].players[socket.id].score = score;
            rooms[roomId].scores[socket.id] = score;
            console.log("[SCORE] ".concat(rooms[roomId].players[socket.id].username, " (").concat(socket.id, ") scored ").concat(score, " in room ").concat(roomId));
            io.to(roomId).emit('playerScored', rooms[roomId].players[socket.id]);
        }
    });
    // End round and broadcast results
    socket.on('endRound', function () {
        var roomId = getRoomId(socket);
        if (roomId && rooms[roomId]) {
            var scores = Object.entries(rooms[roomId].scores).map(function (_a) {
                var _b;
                var id = _a[0], score = _a[1];
                return ({
                    id: id,
                    username: ((_b = rooms[roomId].players[id]) === null || _b === void 0 ? void 0 : _b.username) || 'Player',
                    score: score
                });
            });
            scores.sort(function (a, b) { return b.score - a.score; });
            console.log("[ROUND END] Room ".concat(roomId, " ended. Scores:"), scores);
            io.to(roomId).emit('roundEnded', scores);
            // Disconnect all sockets in the room and clean up immediately
            var socketsInRoom = Object.keys(rooms[roomId].players);
            socketsInRoom.forEach(function (sid) {
                var _a;
                var s = io.sockets.sockets.get(sid);
                if (s) {
                    console.log("[ROOM CLEANUP] Disconnecting ".concat((_a = rooms[roomId].players[sid]) === null || _a === void 0 ? void 0 : _a.username, " (").concat(sid, ") from room ").concat(roomId));
                    s.disconnect(true);
                }
            });
            delete rooms[roomId];
            console.log("[ROOM CLEANUP] Room ".concat(roomId, " deleted after round end."));
        }
    });
    // Handle disconnect (per room)
    socket.on('disconnect', function () {
        var _a;
        var roomId = getRoomId(socket);
        if (roomId && rooms[roomId]) {
            var username = (_a = rooms[roomId].players[socket.id]) === null || _a === void 0 ? void 0 : _a.username;
            delete rooms[roomId].players[socket.id];
            delete rooms[roomId].scores[socket.id];
            io.to(roomId).emit('playerDisconnected', socket.id);
            console.log("[DISCONNECT] ".concat(username, " (").concat(socket.id, ") disconnected from room ").concat(roomId));
            // If room is empty, clean up
            if (Object.keys(rooms[roomId].players).length === 0) {
                delete rooms[roomId];
                console.log("[ROOM CLEANUP] Room ".concat(roomId, " deleted (empty after disconnect)."));
            }
        }
        console.log("[SOCKET] Player disconnected: ".concat(socket.id));
        io.emit('playerDisconnected', socket.id);
    });
});
function getRoomId(socket) {
    var roomsArr = Array.from(socket.rooms);
    // The first room is always the socket id, so look for another
    return roomsArr.find(function (r) { return r !== socket.id; });
}
var PORT = process.env.PORT || 3001;
server.listen(PORT, function () {
    console.log("Socket.IO server running on port ".concat(PORT));
});
