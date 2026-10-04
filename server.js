import http from "http";
import { WebSocketServer } from "ws";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const PORT = process.env.PORT || 10000;

const N = 44;
const rooms = new Map();

function send(ws, type, data = {}) {
  if (ws.readyState === 1) ws.send(JSON.stringify({type, ...data}));
}

function other(p) { return p === 0 ? 1 : 0; }
}

function send(ws, type, data = {}) {
  if (ws.readyState === 1) ws.send(JSON.stringify({type, ...data}));
}

function other(p) { return p === 0 ? 1 : 0; }

function freshRound(room) {
  room.phase = "countdown";
  room.count = 3;
  room.countAt = Date.now();
  room.acc = 0;
  room.round++;
  room.players = [
    {x: 7, y: 22, dx: 1, dy: 0, q: [], trail:[[7,22]], alive:true},
    {x: 36, y: 22, dx:-1, dy: 0, q: [], trail:[[36,22]], alive:true}
  ];
  broadcast(room, "round", {
    round: room.round,
    scores: room.scores,
    players: room.players,
    count: 3
  });
}

function broadcast(room, type, data = {}) {
  for (const ws of room.clients) send(ws, type, data);
}

function applyTurns(p) {
  while (p.q.length) {
    const t = p.q.shift();
    if (t === "L") {
      const dx = -p.dy, dy = p.dx;
      p.dx = dx; p.dy = dy;
    } else {
      const dx = p.dy, dy = -p.dx;
      p.dx = dx; p.dy = dy;
    }
  }
}

function tick(room, dt) {
  if (room.phase !== "play") return;
  room.acc += dt;
  const elapsed = Math.min(1, (Date.now() - room.startAt) / 45000);
  const stepMs = 95 - elapsed * 27;
  if (room.acc < stepMs) return;
  room.acc -= stepMs;

  for (const p of room.players) applyTurns(p);

  const next = room.players.map(p => ({x:p.x+p.dx, y:p.y+p.dy}));
  const occ = new Set();
  room.players.forEach(p => p.trail.forEach(([x,y]) => occ.add(y*N+x)));

  const dead = [false,false];
  next.forEach((n,i) => {
    if (n.x < 0 || n.x >= N || n.y < 0 || n.y >= N) dead[i] = true;
    if (occ.has(n.y*N+n.x)) dead[i] = true;
  });

  if (next[0].x === next[1].x && next[0].y === next[1].y) dead[0] = dead[1] = true;

  if (dead[0] || dead[1]) {
    for (let i=0;i<2;i++) {
      if (!dead[i]) {
        room.players[i].x = next[i].x;
        room.players[i].y = next[i].y;
        room.players[i].trail.push([room.players[i].x, room.players[i].y]);
      }
      room.players[i].alive = !dead[i];
    }

    let winner = -1;
    if (dead[0] && !dead[1]) winner = 1;
    if (dead[1] && !dead[0]) winner = 0;

    if (winner >= 0) room.scores[winner]++;

    room.phase = "result";
    broadcast(room, "result", {
      winner,
      scores: room.scores,
      headOn: dead[0] && dead[1],
      players: room.players,
      matchOver: winner >= 0 && room.scores[winner] >= 5
    });
    return;
  }

  room.players.forEach((p,i) => {
    p.x = next[i].x;
    p.y = next[i].y;
    p.trail.push([p.x,p.y]);
  });

  broadcast(room, "state", {
    players: room.players,
    scores: room.scores,
    round: room.round
  });
}

const server = http.createServer((req,res) => {
  let u = new URL(req.url, `http://${req.headers.host}`);
  let file = u.pathname === "/" ? "/index.html" : u.pathname;
  const safe = path.normalize(file).replace(/^(\.\.[\/\\])+/, "");
  const full = path.join(publicDir, safe);
  if (!full.startsWith(publicDir)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err,data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    const ext = path.extname(full);
    const types = {".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8"};
    res.writeHead(200, {"Content-Type":types[ext] || "application/octet-stream"});
    res.end(data);
  });
});

const wss = new WebSocketServer({server});

wss.on("connection", ws => {
  let room = null;
  let player = null;

  ws.on("message", raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }

    if (m.type === "create") {
      if (room) return;
      const id = code();
      room = {id, clients:new Set([ws]), players:[null,null], sockets:[null,null], scores:[0,0], round:0, phase:"waiting", acc:0};
      rooms.set(id, room);
      player = 0;
      room.sockets[0] = ws;
      send(ws, "room", {code:id, player:0});
      send(ws, "waiting");
      return;
    }

    if (m.type === "join") {
      if (room) return;
      const id = String(m.code || "").toUpperCase().trim();
      const r = rooms.get(id);
      if (!r || r.clients.size >= 2) { send(ws,"error",{message:"Room not found or full."}); return; }
      room = r;
      room.clients.add(ws);
      player = 1;
      room.sockets[1] = ws;
      send(ws, "room", {code:id, player:1});
      for (const c of room.clients) send(c,"connected",{players:2});
      freshRound(room);
      return;
    }

    if (!room || player === null) return;

    if (m.type === "turn" && room.phase === "play") {
      const d = m.dir === "L" ? "L" : "R";
      const q = room.players[player].q;
      if (q.length < 2 && (q.length === 0 || q[q.length-1] !== d)) q.push(d);
    }

    if (m.type === "next" && room.phase === "result") {
      if (room.scores[0] >= 5 || room.scores[1] >= 5) return;
      if (room.clients.size === 2) freshRound(room);
    }
  });

  ws.on("close", () => {
    if (!room) return;
    room.clients.delete(ws);
    if (room.sockets[player] === ws) room.sockets[player] = null;
    if (room.clients.size === 0) {
      rooms.delete(room.id);
    } else {
      room.phase = "ended";
      broadcast(room,"opponent_left");
      rooms.delete(room.id);
    }
  });
});

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.phase === "countdown" && now - room.countAt >= 700) {
      room.count--;
      room.countAt = now;
      if (room.count > 0) broadcast(room,"count",{count:room.count});
      else {
        room.phase = "play";
        room.startAt = now;
        broadcast(room,"go");
      }
    }
    tick(room, 16);
  }
}, 16);

server.listen(PORT, '0.0.0.0', () => console.log(`Light Duel listening on ${PORT}`));
