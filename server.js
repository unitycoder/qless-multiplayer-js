const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*", // For production, restrict to your client's origin.
    methods: ["GET", "POST"]
  }
});

const PORT = 3000;

// Grid dimensions (10x10)
const ROWS = 10;
const COLS = 10;

// The grid holds either null or a block object:
// { id, letter, row, col, lockedBy }
const grid = Array.from({ length: ROWS }, () => new Array(COLS).fill(null));

let nextBlockId = 1;

// Check if a cell is free.
function isFree(r, c) {
  return r >= 0 && r < ROWS && c >= 0 && c < COLS && grid[r][c] === null;
}

// Find the nearest free cell to the requested (row, col)
// using an expanding Manhattan-distance search.
function findNearestFreeCell(startRow, startCol) {
  if (isFree(startRow, startCol)) {
    return { row: startRow, col: startCol };
  }
  for (let d = 1; d < Math.max(ROWS, COLS); d++) {
    for (let dr = -d; dr <= d; dr++) {
      const dc = d - Math.abs(dr);
      const candidates = [
        { r: startRow + dr, c: startCol + dc },
        { r: startRow + dr, c: startCol - dc }
      ];
      for (let candidate of candidates) {
        if (isFree(candidate.r, candidate.c)) {
          return { row: candidate.r, col: candidate.c };
        }
      }
    }
  }
  return null; // No free cell found.
}

function generateRandomLetters(n) {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split('');
  const selected = [];
  while (selected.length < n && letters.length > 0) {
    const index = Math.floor(Math.random() * letters.length);
    selected.push(letters.splice(index, 1)[0]);
  }
  return selected;
}

// --- Round Timer and Reset Logic ---
const roundDuration = 60*10;
const breakDuration = 1*60;
let roundState = "running";
let remainingTime = roundDuration;

// Call this to reset the board and start a new round.
function startRound() {
  // Clear the grid.
  for (let r = 0; r < ROWS; r++) {
    grid[r] = new Array(COLS).fill(null);
  }
  nextBlockId = 1;
  const initialLetters = generateRandomLetters(12);
  for (let letter of initialLetters) {
    let pos;
    do {
      pos = {
        row: Math.floor(Math.random() * ROWS),
        col: Math.floor(Math.random() * COLS)
      };
    } while (!isFree(pos.row, pos.col));
    grid[pos.row][pos.col] = { id: nextBlockId++, letter, row: pos.row, col: pos.col, lockedBy: null };
  }
  roundState = "running";
  remainingTime = roundDuration;
  io.emit('newRound', { grid, remainingTime, roundState });
}

// This tick function runs every second.
function tick() {
  remainingTime--;
  io.emit('roundUpdate', { remainingTime, roundState });
  if (remainingTime <= 0) {
    if (roundState === "running") {
      console.log("round over, restarting in 1 minute!");
      roundState = "break";
      remainingTime = breakDuration;
      io.emit('roundOver'); // Notifies clients to lock the board.
    } else if (roundState === "break") {
      startRound();
    }
  }
}

// Start the round timer.
setInterval(tick, 1000);
// Optionally start the first round.
startRound();

// --- Socket.IO Game Logic ---
io.on('connection', (socket) => {
  console.log('Client connected: ' + socket.id);

  // Send current grid state and round info to the newly connected client.
  socket.emit('initialState', { grid, remainingTime, roundState });

  // Client requests to lock a block before moving it.
  socket.on('lockBlock', (data) => {
    const { blockId } = data;
    let block = null;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (grid[r][c] && grid[r][c].id === blockId) {
          block = grid[r][c];
          break;
        }
      }
      if (block) break;
    }
    if (!block) {
      socket.emit('lockFailed', { message: 'Block not found', blockId });
      return;
    }
    if (block.lockedBy && block.lockedBy !== socket.id) {
      socket.emit('lockFailed', { message: 'Block already locked by another player', blockId });
    } else {
      block.lockedBy = socket.id;
      io.emit('blockLocked', { blockId, lockedBy: socket.id });
    }
  });

  // Client moves a block.
  socket.on('moveBlock', (data) => {
    const { blockId, row, col } = data;
    let block = null;
    let oldRow, oldCol;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (grid[r][c] && grid[r][c].id === blockId) {
          block = grid[r][c];
          oldRow = r;
          oldCol = c;
          break;
        }
      }
      if (block) break;
    }
    if (!block) {
      socket.emit('error', { message: 'Block not found for moving', blockId });
      return;
    }
    if (block.lockedBy !== socket.id) {
      socket.emit('error', { message: 'You do not hold the lock for this block', blockId });
      return;
    }
    // Remove block from its current cell.
    grid[oldRow][oldCol] = null;
    const cell = findNearestFreeCell(row, col);
    if (cell) {
      block.row = cell.row;
      block.col = cell.col;
      block.lockedBy = null; // Unlock after moving.
      grid[cell.row][cell.col] = block;
      io.emit('blockPlaced', block);
    } else {
      block.lockedBy = null;
      grid[oldRow][oldCol] = block;
      socket.emit('error', { message: 'No free cell available', blockId });
    }
  });

  // Optionally, client can cancel a move.
  socket.on('unlockBlock', (data) => {
    const { blockId } = data;
    let block = null;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (grid[r][c] && grid[r][c].id === blockId) {
          block = grid[r][c];
          break;
        }
      }
      if (block) break;
    }
    if (block && block.lockedBy === socket.id) {
      block.lockedBy = null;
      io.emit('blockUnlocked', { blockId });
    }
  });

  // When a client disconnects, unlock any blocks it had locked.
  socket.on('disconnect', () => {
    console.log('Client disconnected: ' + socket.id);
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (grid[r][c] && grid[r][c].lockedBy === socket.id) {
          grid[r][c].lockedBy = null;
          io.emit('blockUnlocked', { blockId: grid[r][c].id });
        }
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
