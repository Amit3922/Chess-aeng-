const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const { Chess } = require('chess.js');
const { analyse } = require('./engine');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const rooms = new Map(); // code -> room

// The secret: only a player called Amit gets engine help. Hints go ONLY to that socket.
const isAmit = (name) => String(name).trim().toLowerCase() === 'amit';

function newRoom(code) {
  return { code, chess: new Chess(), players: { w: null, b: null }, spectators: new Set(),
           lastMove: null, result: null, drawOffer: null, hintSeq: 0 };
}

function roomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do { c = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
  while (rooms.has(c));
  return c;
}

function status(room) {
  const ch = room.chess;
  if (room.result) return room.result;
  if (ch.isCheckmate()) return { over: true, text: `Checkmate — ${ch.turn() === 'w' ? 'Black' : 'White'} wins` };
  if (ch.isStalemate()) return { over: true, text: 'Draw by stalemate' };
  if (ch.isThreefoldRepetition()) return { over: true, text: 'Draw by repetition' };
  if (ch.isInsufficientMaterial()) return { over: true, text: 'Draw — insufficient material' };
  if (ch.isDraw()) return { over: true, text: 'Draw (50-move rule)' };
  return { over: false, text: ch.inCheck() ? 'Check!' : '' };
}

function safeSend(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }

function publicState(room) {
  const ch = room.chess;
  return {
    type: 'state',
    code: room.code,
    fen: ch.fen(),
    turn: ch.turn(),
    history: ch.history(),
    lastMove: room.lastMove,
    legal: ch.moves({ verbose: true }).map((m) => ({ from: m.from, to: m.to, promotion: m.promotion || null })),
    status: status(room),
    drawOffer: room.drawOffer,
    players: { w: room.players.w && room.players.w.name, b: room.players.b && room.players.b.name },
    spectators: room.spectators.size,
  };
}

function broadcast(room) {
  const state = publicState(room);
  const all = [room.players.w, room.players.b, ...room.spectators].filter(Boolean);
  for (const p of all) {
    // Note: the assistant flag is deliberately NOT part of the state anyone else can see.
    safeSend(p.ws, { ...state, you: p.color });
  }
  sendHint(room);
}

async function sendHint(room) {
  const seq = ++room.hintSeq;
  if (status(room).over) return;
  const turn = room.chess.turn();
  const p = room.players[turn];
  if (!p || !isAmit(p.name)) {
    // Also help Amit see the position's eval when it's the opponent's turn? Keep it to his own turn only.
    return;
  }
  const fen = room.chess.fen();
  const res = await analyse(fen, 700);
  if (seq !== room.hintSeq) return; // position changed meanwhile
  let san = null;
  try {
    const tmp = new Chess(fen);
    const m = tmp.move({ from: res.best.slice(0, 2), to: res.best.slice(2, 4), promotion: res.best[4] });
    san = m.san;
  } catch (e) { /* ignore */ }
  // Only Amit's socket receives this.
  safeSend(p.ws, { type: 'assist', best: res.best, san, cp: res.cp, mate: res.mate, depth: res.depth });
}

function leave(ws) {
  const room = ws.room;
  if (!room) return;
  room.spectators.delete(ws.me);
  for (const c of ['w', 'b']) {
    if (room.players[c] && room.players[c].ws === ws) room.players[c].ws = { readyState: 3, send() {} }; // keep seat for rejoin
  }
  const alive = [room.players.w, room.players.b, ...room.spectators].some((p) => p && p.ws.readyState === 1);
  if (!alive) rooms.delete(room.code);
  else broadcast(room);
}

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      const name = String(msg.name || 'Guest').trim().slice(0, 20) || 'Guest';
      let code = String(msg.code || '').toUpperCase().trim();
      if (!code) code = roomCode();
      let room = rooms.get(code);
      if (!room) { if (msg.code) return safeSend(ws, { type: 'error', text: 'Room not found' }); room = newRoom(code); rooms.set(code, room); }
      ws.room = room;
      // Rejoin an existing seat by name, otherwise take a free seat, otherwise spectate.
      let color = null;
      for (const c of ['w', 'b']) if (room.players[c] && room.players[c].name === name && room.players[c].ws.readyState !== 1) color = c;
      if (!color) for (const c of ['w', 'b']) if (!room.players[c]) { color = c; break; }
      const me = { ws, name, color };
      ws.me = me;
      if (color) room.players[color] = me; else room.spectators.add(me);
      safeSend(ws, { type: 'joined', code, color });
      broadcast(room);
      return;
    }

    const room = ws.room;
    if (!room || !ws.me) return;
    const color = ws.me.color;

    if (msg.type === 'move') {
      if (!color || status(room).over || room.chess.turn() !== color) return;
      try {
        const m = room.chess.move({ from: msg.from, to: msg.to, promotion: msg.promotion || 'q' });
        room.lastMove = { from: m.from, to: m.to };
        room.drawOffer = null;
        broadcast(room);
      } catch { safeSend(ws, { type: 'error', text: 'Illegal move' }); }
    } else if (msg.type === 'resign') {
      if (!color || status(room).over) return;
      room.result = { over: true, text: `${ws.me.name} resigned — ${color === 'w' ? 'Black' : 'White'} wins` };
      broadcast(room);
    } else if (msg.type === 'offerDraw') {
      if (!color || status(room).over) return;
      room.drawOffer = color; broadcast(room);
    } else if (msg.type === 'acceptDraw') {
      if (!color || !room.drawOffer || room.drawOffer === color) return;
      room.result = { over: true, text: 'Draw by agreement' }; broadcast(room);
    } else if (msg.type === 'rematch') {
      if (!status(room).over) return;
      room.chess = new Chess(); room.lastMove = null; room.result = null; room.drawOffer = null;
      // swap colors
      const { w, b } = room.players;
      room.players.w = b; room.players.b = w;
      if (room.players.w) room.players.w.color = 'w';
      if (room.players.b) room.players.b.color = 'b';
      for (const p of [room.players.w, room.players.b]) if (p) safeSend(p.ws, { type: 'joined', code: room.code, color: p.color });
      broadcast(room);
    }
  });
  ws.on('close', () => leave(ws));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Chess rooms on http://localhost:${PORT}`));
