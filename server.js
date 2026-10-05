import http from "http";
import { WebSocketServer } from "ws";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const publicDir = path.join(__dirname, "public");
const PORT = process.env.PORT || 10000;

const N = 44;
const START_SPEED = 95;
const MIN_SPEED = 68;
const MAX_SCORE = 5;

const rooms = new Map();

function send(ws, type, data = {}) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type, ...data }));
  }
}

function makeRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;

  do {
    code = Array.from(
      { length: 4 },
      () => chars[Math.floor(Math.random() * chars.length)]
    ).join("");
  } while (rooms.has(code));

  return code;
}

function otherPlayer(player) {
  return player === 0 ? 1 : 0;
}

function positionKey(x, y) {
  return `${x},${y}`;
}

function directionFor(player) {
  // Player 0 starts moving right.
  // Player 1 starts moving left.
  return player === 0 ? { x: 1, y: 0 } : { x: -1, y: 0 };
}

function createPlayer(player) {
  const y = player === 0 ? 14 : 29;
  const x = player === 0 ? 10 : 33;

  return {
    x,
    y,
    dir: directionFor(player),
    trail: [positionKey(x, y)],
    turns: []
  };
}

function createRoom() {
  return {
    code: makeRoomCode(),
    players: [null, null],
    score: [0, 0],

    round: 0,
    phase: "waiting",

    count: 3,
    countAt: 0,

    lastMove: 0,
    speed: START_SPEED,

    winner: null,
    tickTimer: null,
    countdownTimer: null
  };
}

function publicState(room) {
  return {
    code: room.code,
    phase: room.phase,
    round: room.round,
    score: room.score,
    count: room.count,

    players: room.players.map((player) => {
      if (!player) return null;

      return {
        x: player.x,
        y: player.y,
        dir: player.dir,
        trail: player.trail
      };
    }),

    winner: room.winner
  };
}

function broadcast(room) {
  const state = publicState(room);

  for (const ws of room.players) {
    if (ws) {
      send(ws, "state", state);
    }
  }
}

function stopTimers(room) {
  if (room.tickTimer) {
    clearInterval(room.tickTimer);
    room.tickTimer = null;
  }

  if (room.countdownTimer) {
    clearInterval(room.countdownTimer);
    room.countdownTimer = null;
  }
}

function startCountdown(room) {
  stopTimers(room);

  room.phase = "countdown";
  room.count = 3;
  room.countAt = Date.now();
  room.lastMove = 0;
  room.speed = START_SPEED;
  room.winner = null;

  room.players[0].game = createPlayer(0);
  room.players[1].game = createPlayer(1);

  broadcast(room);

  room.countdownTimer = setInterval(() => {
    if (room.phase !== "countdown") {
      stopTimers(room);
      return;
    }

    room.count--;

    if (room.count > 0) {
      broadcast(room);
      return;
    }

    room.phase = "playing";
    room.lastMove = Date.now();

    broadcast(room);

    clearInterval(room.countdownTimer);
    room.countdownTimer = null;

    startGameLoop(room);
  }, 1000);
}

function startGameLoop(room) {
  if (room.tickTimer) {
    clearInterval(room.tickTimer);
  }

  room.tickTimer = setInterval(() => {
    if (room.phase !== "playing") return;

    const now = Date.now();

    if (now - room.lastMove < room.speed) return;

    room.lastMove = now;
    movePlayers(room);
  }, 10);
}

function applyTurn(player, turn) {
  const current = player.dir;

  if (turn === "left") {
    player.dir = {
      x: current.y,
      y: -current.x
    };
  } else if (turn === "right") {
