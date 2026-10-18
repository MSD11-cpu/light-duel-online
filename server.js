import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
const PORT = process.env.PORT || 10000;

const SIZE = 44;
const START_SPEED = 95;
const MIN_SPEED = 65;
const WIN_SCORE = 5;
const NEXT_ROUND_DELAY = 2200;

const rooms = new Map();

function sanitizeName(value) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/[^A-Za-z0-9 _'-]/g, "").slice(0, 16);
}

function send(ws, type, data = {}) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type, ...data }));
  }
}

function roomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = "";
    for (let i = 0; i < 4; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
  } while (rooms.has(code));
  return code;
}

function createRoom() {
  return {
    code: roomCode(),
    players: [null, null],
    scores: [0, 0],
    round: 0,
    phase: "waiting",
    countdown: 3,
    timer: null,
    lastMove: 0,
    speed: START_SPEED,
    playerNames: ["", ""]
  };
}

function makePlayer(number) {
  return number === 0
    ? { x: 10, y: 22, dx: 1, dy: 0, trail: [[10, 22]], turns: [] }
    : { x: 33, y: 22, dx: -1, dy: 0, trail: [[33, 22]], turns: [] };
}

function turn(player, direction) {
  const opposite =
    (player.dx === 1 && player.dy === 0 && direction === "L") ||
    (player.dx === -1 && player.dy === 0 && direction === "R") ||
    (player.dx === 0 && player.dy === 1 && direction === "U") ||
    (player.dx === 0 && player.dy === -1 && direction === "D");

  if (opposite) return;

  const directions = {
    U: [0, -1],
    D: [0, 1],
    L: [-1, 0],
    R: [1, 0]
  };

  if (directions[direction]) {
    [player.dx, player.dy] = directions[direction];
  }
}

function queueTurn(ws, direction) {
  if (!ws?.game || !["U", "D", "L", "R"].includes(direction)) return;
  if (ws.game.turns.length >= 2) return;
  ws.game.turns.push(direction);
}

function stopRoom(room) {
  if (room.timer !== null) {
    clearTimeout(room.timer);
    clearInterval(room.timer);
    room.timer = null;
  }
}

function state(room) {
  return {
    players: room.players.map(ws =>
      ws?.game
        ? { x: ws.game.x, y: ws.game.y, trail: ws.game.trail }
        : null
    ),
    scores: [...room.scores],
    playerNames: [...room.playerNames]
  };
}

function broadcast(room) {
  const data = state(room);
  for (const ws of room.players) {
    if (ws) send(ws, "state", data);
  }
}

function occupied(trail, x, y) {
  return trail.some(cell => cell[0] === x && cell[1] === y);
}

function outside(x, y) {
  return x < 0 || x >= SIZE || y < 0 || y >= SIZE;
}

function beginRound(room) {
  stopRoom(room);

  if (
    !rooms.has(room.code) ||
    !room.players[0] ||
    !room.players[1] ||
    room.players.some(ws => ws.readyState !== 1)
  ) {
    room.phase = "waiting";
    return;
  }

  if (room.scores.some(score => score >= WIN_SCORE)) {
    room.phase = "matchover";
    return;
  }

  room.round += 1;
  room.phase = "countdown";
  room.countdown = 3;
  room.speed = START_SPEED;

  room.players[0].game = makePlayer(0);
  room.players[1].game = makePlayer(1);

  for (const ws of room.players) {
    send(ws, "round", {
      players: state(room).players,
      scores: [...room.scores],
      count: 3,
      playerNames: [...room.playerNames]
    });
  }

  let count = 3;

  room.timer = setInterval(() => {
    if (room.phase !== "countdown") {
      stopRoom(room);
      return;
    }

    count -= 1;

    if (count > 0) {
      room.countdown = count;
      for (const ws of room.players) {
        send(ws, "count", { count });
      }
      return;
    }

    stopRoom(room);
    room.phase = "playing";
    room.lastMove = Date.now();

    for (const ws of room.players) {
      send(ws, "go");
    }

    startGame(room);
  }, 1000);
}

function startGame(room) {
  stopRoom(room);

  room.timer = setInterval(() => {
    if (room.phase !== "playing") return;

    const now = Date.now();
    if (now - room.lastMove < room.speed) return;

    room.lastMove = now;
    move(room);
  }, 10);
}

function move(room) {
  const a = room.players[0];
  const b = room.players[1];

  if (!a?.game || !b?.game) return;

  const p0 = a.game;
  const p1 = b.game;

  if (p0.turns.length) turn(p0, p0.turns.shift());
  if (p1.turns.length) turn(p1, p1.turns.shift());

  const next0 = { x: p0.x + p0.dx, y: p0.y + p0.dy };
  const next1 = { x: p1.x + p1.dx, y: p1.y + p1.dy };

  const wall0 = outside(next0.x, next0.y);
  const wall1 = outside(next1.x, next1.y);

  const ownTrail0 = !wall0 && occupied(p0.trail, next0.x, next0.y);
  const ownTrail1 = !wall1 && occupied(p1.trail, next1.x, next1.y);
  const enemyTrail0 = !wall0 && occupied(p1.trail, next0.x, next0.y);
  const enemyTrail1 = !wall1 && occupied(p0.trail, next1.x, next1.y);

  const headOn = next0.x === next1.x && next0.y === next1.y;

  const dead0 = wall0 || ownTrail0 || enemyTrail0 || headOn;
  const dead1 = wall1 || ownTrail1 || enemyTrail1 || headOn;

  if (dead0 || dead1) {
    finishRound(room, dead0, dead1, headOn);
    return;
  }

  p0.x = next0.x;
  p0.y = next0.y;
  p1.x = next1.x;
  p1.y = next1.y;

  p0.trail.push([p0.x, p0.y]);
  p1.trail.push([p1.x, p1.y]);

  const longestTrail = Math.max(p0.trail.length, p1.trail.length);
  room.speed = Math.max(MIN_SPEED, START_SPEED - Math.floor(longestTrail / 60));

  broadcast(room);
}

function finishRound(room, dead0, dead1, headOn) {
  if (room.phase !== "playing") return;

  stopRoom(room);
  room.phase = "result";

  let winner = null;

  if (!headOn) {
    if (dead0 && !dead1) {
      room.scores[1] += 1;
      winner = 1;
    } else if (dead1 && !dead0) {
      room.scores[0] += 1;
      winner = 0;
    }
  }

  const matchOver = room.scores.some(score => score >= WIN_SCORE);

  for (const ws of room.players) {
    if (ws) {
      send(ws, "result", {
        players: state(room).players,
        scores: [...room.scores],
        winner,
        headOn,
        matchOver,
        playerNames: [...room.playerNames]
      });
    }
  }

  // Automatically start the next round unless the match has been won.
  if (!matchOver) {
    room.timer = setTimeout(() => {
      if (room.phase === "result") beginRound(room);
    }, NEXT_ROUND_DELAY);
  } else {
    room.phase = "matchover";
  }
}

function handleCreate(ws, name) {
  if (ws.room) {
    send(ws, "error", { message: "You are already in a room." });
    return;
  }

  const safeName = sanitizeName(name);
  if (!safeName) {
    send(ws, "error", { message: "Please enter your name." });
    return;
  }

  const room = createRoom();
  room.playerNames[0] = safeName;
  room.players[0] = ws;

  ws.room = room;
  ws.player = 0;
  ws.game = null;

  rooms.set(room.code, room);

  send(ws, "room", {
    code: room.code,
    player: 0,
    playerNames: [...room.playerNames]
  });
  send(ws, "waiting");
}

function handleJoin(ws, code, name) {
  if (ws.room) {
    send(ws, "error", { message: "You are already in a room." });
    return;
  }

  const safeName = sanitizeName(name);
  if (!safeName) {
    send(ws, "error", { message: "Please enter your name." });
    return;
  }

  const room = rooms.get(code);
  if (!room) {
    send(ws, "error", { message: "Room not found." });
    return;
  }

  if (room.phase !== "waiting" || room.players[0] && room.players[1]) {
    send(ws, "error", { message: "Room is full or already in a match." });
    return;
  }

  const slot = room.players[0] ? 1 : 0;
  room.players[slot] = ws;
  room.playerNames[slot] = safeName;

  ws.room = room;
  ws.player = slot;
  ws.game = null;

  send(ws, "room", {
    code: room.code,
    player: slot,
    playerNames: [...room.playerNames]
  });

  for (const player of room.players) {
    if (player) {
      send(player, "connected", {
        playerNames: [...room.playerNames]
      });
    }
  }

  beginRound(room);
}

function handleNext(ws) {
  const room = ws.room;

  if (!room || room.phase !== "matchover") return;
  if (!room.players[0] || !room.players[1]) return;
  if (room.players.some(player => player.readyState !== 1)) return;

  // Reset the score and start a fresh match.
  room.scores = [0, 0];
  room.round = 0;
  room.speed = START_SPEED;

  beginRound(room);
}

function handleMessage(ws, raw) {
  let message;

  try {
    message = JSON.parse(raw);
  } catch {
    send(ws, "error", { message: "Invalid message." });
    return;
  }

  if (!message || typeof message.type !== "string") return;

  if (message.type === "create") {
    handleCreate(ws, message.name);
    return;
  }

  if (message.type === "join") {
    const code = String(message.code || "").trim().toUpperCase();

    if (code.length !== 4) {
      send(ws, "error", { message: "Enter the 4-character room code." });
      return;
    }

    handleJoin(ws, code, message.name);
    return;
  }

  if (message.type === "turn") {
    if (ws.room && ws.player !== null && ws.room.phase === "playing") {
      queueTurn(ws, message.dir);
    }
    return;
  }

  if (message.type === "next") {
    handleNext(ws);
    return;
  }
}

/* HTTP SERVER */
const server = http.createServer((req, res) => {
  let requestPath = req.url || "/";
  if (requestPath === "/") requestPath = "/index.html";

  try {
    requestPath = decodeURIComponent(requestPath.split("?")[0]);
  } catch {
    res.writeHead(400);
    res.end("Bad request");
    return;
  }

  const cleanPath = path.normalize(requestPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(publicDir, cleanPath);

  if (!filePath.startsWith(publicDir + path.sep) && filePath !== path.join(publicDir, "index.html")) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    const contentTypes = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".svg": "image/svg+xml"
    };

    res.writeHead(200, {
      "Content-Type": contentTypes[extension] || "application/octet-stream",
      "Cache-Control": "no-cache"
    });
    res.end(content);
  });
});

/* WEBSOCKET SERVER */
const wss = new WebSocketServer({ server });

wss.on("connection", ws => {
  ws.room = null;
  ws.player = null;
  ws.game = null;

  send(ws, "connected");

  ws.on("message", message => {
    handleMessage(ws, message.toString());
  });

  ws.on("close", () => {
    const room = ws.room;
    if (!room) return;

    stopRoom(room);

    // Remove the room after a disconnect so a stale match cannot continue.
    rooms.delete(room.code);

    const remaining = room.players.find(player => player && player !== ws);

    if (remaining) {
      send(remaining, "opponent_left");

      remaining.room = null;
      remaining.player = null;
      remaining.game = null;
    }

    for (const player of room.players) {
      if (player && player !== ws) {
        player.room = null;
        player.player = null;
        player.game = null;
      }
    }

    room.players = [null, null];
    room.phase = "waiting";

    ws.room = null;
    ws.player = null;
    ws.game = null;
  });

  ws.on("error", () => {
    // The close handler performs cleanup.
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Light Duel listening on port ${PORT}`);
});
