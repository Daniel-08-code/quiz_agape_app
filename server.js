const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const rooms = new Map();

function send(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1_000_000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
  });
}

function roomCode() {
  let code;
  do {
    code = String(Math.floor(100000 + Math.random() * 900000));
  } while (rooms.has(code));
  return code;
}

function playerName(room, requestedName) {
  const base = String(requestedName || 'Joueur').trim().slice(0, 18) || 'Joueur';
  let name = base;
  let suffix = 2;
  while (room.players.some(p => p.name.toLowerCase() === name.toLowerCase())) {
    name = `${base} ${suffix++}`.slice(0, 18);
  }
  return name;
}

function currentQuestion(room) {
  return room.questions[room.currentQ] || null;
}

function scoreAnswer(q, answer, timeLeft) {
  if (!q || q.mType === 'open' || answer === null || answer === undefined) {
    return { correct: null, points: 0 };
  }
  const correct = q.mType === 'tf' ? Boolean(answer) === Boolean(q.correct) : Number(answer) === Number(q.correct);
  const safeTime = Math.max(0, Math.min(Number(timeLeft) || 0, q.mType === 'open' ? 60 : 20));
  return { correct, points: correct ? Math.round(500 + safeTime * 50) : 0 };
}

function publicRoom(room, playerId) {
  const q = currentQuestion(room);
  const isReveal = room.status === 'reveal' || room.status === 'results';
  const players = room.players.map(p => ({
    id: p.id,
    name: p.name,
    score: p.score,
    answered: Boolean(room.answers[p.id]),
  }));

  return {
    code: room.code,
    status: room.status,
    currentQ: room.currentQ,
    total: room.questions.length,
    players,
    answeredCount: Object.keys(room.answers).length,
    me: playerId ? players.find(p => p.id === playerId) || null : null,
    myAnswer: playerId ? room.answers[playerId] || null : null,
    question: q ? {
      q: q.q,
      answers: q.answers || null,
      mType: q.mType,
      mName: q.mName,
      mBadge: q.mBadge,
      correct: isReveal ? q.correct : null,
      correctText: isReveal ? q.correct : null,
      expl: isReveal ? q.expl : null,
    } : null,
  };
}

function nextRoomStep(room) {
  if (room.currentQ >= room.questions.length - 1) {
    room.status = 'results';
    room.answers = {};
    return;
  }
  room.currentQ += 1;
  room.status = 'question';
  room.answers = {};
  room.questionStartedAt = Date.now();
}

async function handleApi(req, res, url) {
  if (req.method === 'POST' && url.pathname === '/api/rooms') {
    const body = await readBody(req);
    if (!Array.isArray(body.questions) || body.questions.length === 0) {
      return send(res, 400, { error: 'Aucune question envoyee.' });
    }
    const code = roomCode();
    const room = {
      code,
      status: 'lobby',
      questions: body.questions.slice(0, 50),
      currentQ: 0,
      players: [],
      answers: {},
      createdAt: Date.now(),
      questionStartedAt: null,
    };
    rooms.set(code, room);
    return send(res, 201, publicRoom(room));
  }

  const roomMatch = url.pathname.match(/^\/api\/rooms\/(\d{6})(?:\/(join|start|answer|reveal|next))?$/);
  if (!roomMatch) return send(res, 404, { error: 'Route introuvable.' });

  const room = rooms.get(roomMatch[1]);
  if (!room) return send(res, 404, { error: 'Partie introuvable.' });

  const action = roomMatch[2];
  if (req.method === 'GET' && !action) {
    return send(res, 200, publicRoom(room, url.searchParams.get('playerId')));
  }

  if (req.method !== 'POST') return send(res, 405, { error: 'Methode non autorisee.' });
  const body = await readBody(req);

  if (action === 'join') {
    if (room.status !== 'lobby') return send(res, 409, { error: 'La partie a deja commence.' });
    if (room.players.length >= 40) return send(res, 409, { error: 'La partie est pleine.' });
    const player = {
      id: crypto.randomUUID(),
      name: playerName(room, body.name),
      score: 0,
    };
    room.players.push(player);
    return send(res, 201, { player, room: publicRoom(room, player.id) });
  }

  if (action === 'start') {
    if (room.players.length === 0) return send(res, 409, { error: 'Ajoutez au moins un joueur.' });
    room.status = 'question';
    room.currentQ = 0;
    room.answers = {};
    room.questionStartedAt = Date.now();
    return send(res, 200, publicRoom(room));
  }

  if (action === 'answer') {
    if (room.status !== 'question') return send(res, 409, { error: 'Aucune question active.' });
    const player = room.players.find(p => p.id === body.playerId);
    if (!player) return send(res, 404, { error: 'Joueur introuvable.' });
    if (room.answers[player.id]) return send(res, 200, publicRoom(room, player.id));

    const result = scoreAnswer(currentQuestion(room), body.answer, body.timeLeft);
    player.score += result.points;
    room.answers[player.id] = { answer: body.answer, ...result };
    if (Object.keys(room.answers).length >= room.players.length) room.status = 'reveal';
    return send(res, 200, publicRoom(room, player.id));
  }

  if (action === 'reveal') {
    if (room.status === 'question') room.status = 'reveal';
    return send(res, 200, publicRoom(room));
  }

  if (action === 'next') {
    if (room.status === 'results') return send(res, 200, publicRoom(room));
    nextRoomStep(room);
    return send(res, 200, publicRoom(room));
  }

  return send(res, 404, { error: 'Action introuvable.' });
}

function serveStatic(req, res, url) {
  const filePath = path.join(ROOT, url.pathname === '/' ? 'index.html' : url.pathname);
  const normalized = path.normalize(filePath);
  if (!normalized.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(normalized, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const ext = path.extname(normalized).toLowerCase();
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
    };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    serveStatic(req, res, url);
  } catch (err) {
    send(res, 500, { error: err.message || 'Erreur serveur.' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Quiz Retrouvailles disponible sur http://localhost:${PORT}`);
});
