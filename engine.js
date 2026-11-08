// Server-side Stockfish wrapper. One engine process, requests are queued.
const { spawn } = require('child_process');
const stockfish = require('stockfish');

const enginePath = stockfish.findEngine('lite-single');
const child = spawn(process.execPath, [enginePath], { stdio: 'pipe' });

let buffer = '';
let current = null; // { resolve, info }
const queue = [];

child.stdout.on('data', (d) => {
  buffer += d.toString();
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    handle(line);
  }
});
child.on('error', (e) => console.error('engine error', e));

function send(cmd) { child.stdin.write(cmd + '\n'); }

function handle(line) {
  if (!current) return;
  if (line.startsWith('info') && line.includes(' score ') && line.includes(' pv ')) {
    const cp = line.match(/score cp (-?\d+)/);
    const mate = line.match(/score mate (-?\d+)/);
    const pv = line.match(/ pv (.+)$/);
    const depth = line.match(/depth (\d+)/);
    current.info = {
      cp: cp ? parseInt(cp[1], 10) : null,
      mate: mate ? parseInt(mate[1], 10) : null,
      pv: pv ? pv[1].split(' ').slice(0, 5) : [],
      depth: depth ? parseInt(depth[1], 10) : 0,
    };
  } else if (line.startsWith('bestmove')) {
    const best = line.split(' ')[1];
    const done = current;
    current = null;
    done.resolve({ best, ...(done.info || {}) });
    next();
  }
}

function next() {
  if (current || !queue.length) return;
  current = queue.shift();
  send('ucinewgame');
  send('position fen ' + current.fen);
  send(`go movetime ${current.ms}`);
}

send('uci');
send('isready');

// Analyse a FEN. Returns { best, cp, mate, pv, depth } from the side-to-move's view.
function analyse(fen, ms = 600) {
  return new Promise((resolve) => {
    queue.push({ fen, ms, resolve, info: null });
    next();
  });
}

module.exports = { analyse };
