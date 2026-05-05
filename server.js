const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const readline = require("readline");
const express = require("express");

const app = express();
const port = process.env.PORT || 3000;

const gameLogPath = path.join(__dirname, "game.log");
const adapterSourcePath = path.join(__dirname, "tools", "opponent_adapter", "opponent_cli.c");
const refereeAdapterSourcePath = path.join(__dirname, "tools", "opponent_adapter", "referee_cli.c");
const adapterBinDir = path.join(__dirname, "tools", "opponent_adapter", "bin");
const adapterCommsHeader = path.join(__dirname, "tools", "opponent_adapter", "comms.h");
const defaultOpponentSource = path.join(__dirname, "tools", "te-local-test-harness", "src", "local_opponent.c");
const localRefereeSource = path.join(__dirname, "tools", "te-local-test-harness", "src", "local_referee.c");
const localCommsHeader = path.join(__dirname, "tools", "te-local-test-harness", "src", "comms.h");

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

let liveGame = null;
let opponentProcess = null;
let opponentReader = null;
let pendingOpponentMoves = [];
let pendingOpponentLines = [];
let opponentMode = "adapter";
let opponentConfig = null;

function createEmptyBoard(size) {
  const board = [];
  for (let r = 0; r < size; r += 1) {
    const row = [];
    for (let c = 0; c < size; c += 1) {
      row.push(".");
    }
    board.push(row);
  }
  return board;
}

function createInitialBoard(size) {
  const board = createEmptyBoard(size);
  const mid = size / 2;
  board[mid - 1][mid - 1] = "W";
  board[mid][mid] = "W";
  board[mid - 1][mid] = "B";
  board[mid][mid - 1] = "B";
  return board;
}

function inBounds(size, row, col) {
  return row >= 0 && row < size && col >= 0 && col < size;
}

function collectFlips(board, row, col, color) {
  if (board[row][col] !== ".") {
    return [];
  }

  const size = board.length;
  const other = color === "B" ? "W" : "B";
  const flips = [];
  const directions = [
    [-1, -1],
    [-1, 0],
    [-1, 1],
    [0, -1],
    [0, 1],
    [1, -1],
    [1, 0],
    [1, 1],
  ];

  for (const [dr, dc] of directions) {
    const line = [];
    let r = row + dr;
    let c = col + dc;

    while (inBounds(size, r, c) && board[r][c] === other) {
      line.push([r, c]);
      r += dr;
      c += dc;
    }

    if (line.length && inBounds(size, r, c) && board[r][c] === color) {
      flips.push(...line);
    }
  }

  return flips;
}

function getLegalMoves(board, color) {
  const moves = [];
  const size = board.length;

  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      const flips = collectFlips(board, r, c, color);
      if (flips.length) {
        moves.push({ row: r, col: c, index: r * size + c });
      }
    }
  }

  return moves;
}

function applyMove(board, row, col, color) {
  const flips = collectFlips(board, row, col, color);
  if (!flips.length) {
    return false;
  }

  board[row][col] = color;
  for (const [r, c] of flips) {
    board[r][c] = color;
  }

  return true;
}

function cloneBoard(board) {
  return board.map((row) => row.slice());
}

function computeCounts(board) {
  const counts = { black: 0, white: 0 };
  for (const row of board) {
    for (const cell of row) {
      if (cell === "B") counts.black += 1;
      if (cell === "W") counts.white += 1;
    }
  }
  return counts;
}

function createSnapshot(board, title, move) {
  return {
    index: 0,
    title,
    move,
    board: cloneBoard(board),
  };
}

function normalizeSnapshotIndexes(snapshots) {
  return snapshots.map((snapshot, index) => ({ ...snapshot, index }));
}

function buildLiveResponse() {
  if (!liveGame) {
    return null;
  }

  const legalMoves = liveGame.status === "in-progress" ? getLegalMoves(liveGame.board, liveGame.currentPlayer) : [];
  const counts = computeCounts(liveGame.board);

  return {
    status: liveGame.status,
    message: liveGame.message,
    currentPlayer: liveGame.currentPlayer,
    humanColor: liveGame.humanColor,
    opponentColor: liveGame.opponentColor,
    board: liveGame.board,
    counts,
    legalMoves,
    snapshots: normalizeSnapshotIndexes(liveGame.snapshots),
  };
}

function resolveExecutable(cmd) {
  if (path.isAbsolute(cmd) && fs.existsSync(cmd)) {
    return cmd;
  }

  const locator = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(locator, [cmd], { encoding: "utf8" });
  if (result.status === 0) {
    const first = result.stdout.split(/\r?\n/).find(Boolean);
    return first || null;
  }
  return null;
}

function resolveCompiler() {
  const candidates = [];
  if (process.env.CC) {
    candidates.push(process.env.CC);
  }
  candidates.push("gcc", "clang", "cc");

  for (const candidate of candidates) {
    const resolved = resolveExecutable(candidate);
    if (!resolved) {
      continue;
    }

    const check = spawnSync(resolved, ["--version"], { encoding: "utf8" });
    if (!check.error) {
      return resolved;
    }
  }

  return null;
}

function ensureOpponentBinary(sourcePath) {
  if (!sourcePath) {
    throw new Error("Opponent path is required.");
  }

  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Opponent path not found: ${sourcePath}`);
  }

  if (!sourcePath.toLowerCase().endsWith(".c")) {
    return sourcePath;
  }

  if (!fs.existsSync(adapterSourcePath)) {
    throw new Error("Missing opponent adapter source. Ensure tools/opponent_adapter/opponent_cli.c exists.");
  }

  fs.mkdirSync(adapterBinDir, { recursive: true });

  const baseName = path.basename(sourcePath, ".c");
  const outputPath = path.join(adapterBinDir, `${baseName}${process.platform === "win32" ? ".exe" : ""}`);

  const sourceStat = fs.statSync(sourcePath);
  const outputStat = fs.existsSync(outputPath) ? fs.statSync(outputPath) : null;
  if (outputStat && outputStat.mtimeMs >= sourceStat.mtimeMs) {
    return outputPath;
  }

  const compiler = resolveCompiler();
  if (!compiler) {
    throw new Error("No C compiler found. Set CC or install gcc/clang to compile opponent sources.");
  }

  const compile = spawnSync(compiler, ["-O2", "-o", outputPath, adapterSourcePath, sourcePath], { encoding: "utf8" });

  if (compile.status !== 0) {
    const errorText = compile.stderr || compile.stdout || "Unknown compiler error";
    throw new Error(`Failed to compile opponent source.\n${errorText}`);
  }

  return outputPath;
}

function ensureRefereeBinary(sourcePath) {
  if (!sourcePath) {
    throw new Error("Opponent source path is required for referee mode.");
  }

  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Opponent source path not found: ${sourcePath}`);
  }

  if (!sourcePath.toLowerCase().endsWith(".c")) {
    throw new Error("Referee mode requires a .c opponent source file.");
  }

  if (!fs.existsSync(refereeAdapterSourcePath)) {
    throw new Error("Missing referee adapter source. Ensure tools/opponent_adapter/referee_cli.c exists.");
  }

  if (!fs.existsSync(localRefereeSource)) {
    throw new Error("Missing local referee source. Ensure tools/te-local-test-harness/src/local_referee.c exists.");
  }

  if (!fs.existsSync(localCommsHeader)) {
    throw new Error("Missing comms.h. Ensure tools/te-local-test-harness/src/comms.h exists.");
  }

  fs.mkdirSync(adapterBinDir, { recursive: true });
  fs.copyFileSync(localCommsHeader, adapterCommsHeader);

  const baseName = path.basename(sourcePath, ".c");
  const outputPath = path.join(adapterBinDir, `${baseName}_referee${process.platform === "win32" ? ".exe" : ""}`);

  const sourceStat = fs.statSync(sourcePath);
  const outputStat = fs.existsSync(outputPath) ? fs.statSync(outputPath) : null;
  if (outputStat && outputStat.mtimeMs >= sourceStat.mtimeMs) {
    return outputPath;
  }

  const compiler = resolveCompiler();
  if (!compiler) {
    throw new Error("No C compiler found. Set CC or install gcc/clang to compile opponent sources.");
  }

  const compile = spawnSync(compiler, ["-O2", "-o", outputPath, refereeAdapterSourcePath, localRefereeSource, sourcePath], { encoding: "utf8" });

  if (compile.status !== 0) {
    const errorText = compile.stderr || compile.stdout || "Unknown compiler error";
    throw new Error(`Failed to compile referee adapter.\n${errorText}`);
  }

  return outputPath;
}

function stopOpponentProcess() {
  if (opponentReader) {
    opponentReader.close();
    opponentReader = null;
  }

  if (opponentProcess) {
    if (opponentProcess.stdin && opponentProcess.stdin.writable) {
      opponentProcess.stdin.write("quit\n");
    }
    opponentProcess.kill();
    opponentProcess = null;
  }

  pendingOpponentMoves = [];
  pendingOpponentLines = [];
  opponentMode = "adapter";
  opponentConfig = null;
}

function startOpponentProcess(opponentPath, mode, opponentColor) {
  stopOpponentProcess();

  opponentProcess = spawn(opponentPath, [], { stdio: ["pipe", "pipe", "pipe"] });
  opponentReader = readline.createInterface({ input: opponentProcess.stdout });
  pendingOpponentMoves = [];
  pendingOpponentLines = [];
  opponentMode = mode;
  opponentConfig = { path: opponentPath, color: opponentColor, mode };

  opponentReader.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "OK") {
      return;
    }

    if (pendingOpponentMoves.length) {
      const pending = pendingOpponentMoves.shift();
      pending.resolve(trimmed);
    } else {
      pendingOpponentLines.push(trimmed);
    }
  });

  opponentProcess.on("exit", () => {
    pendingOpponentMoves.forEach((pending) => pending.reject(new Error("Opponent process exited.")));
    pendingOpponentMoves = [];
  });

  if (mode === "adapter") {
    opponentProcess.stdin.write(`init ${opponentColor}\n`);
  } else {
    opponentProcess.stdin.write("init\n");
  }
}

function waitForOpponentLine() {
  if (pendingOpponentLines.length) {
    return Promise.resolve(pendingOpponentLines.shift());
  }
  return new Promise((resolve, reject) => {
    pendingOpponentMoves.push({ resolve, reject });
  });
}

function sendPlayerMove(moveIndex) {
  if (!opponentProcess) {
    return;
  }
  if (opponentMode === "adapter") {
    opponentProcess.stdin.write(`apply ${moveIndex}\n`);
  } else {
    opponentProcess.stdin.write(`move ${moveIndex}\n`);
  }
}

function requestOpponentMove() {
  if (!opponentProcess) {
    return Promise.reject(new Error("Opponent process is not running."));
  }

  if (opponentMode === "adapter") {
    opponentProcess.stdin.write("gen\n");
    return waitForOpponentLine().then((line) => ({ kind: "move", moveIndex: Number.parseInt(line, 10) }));
  }

  opponentProcess.stdin.write("poll\n");
  return waitForOpponentLine().then((line) => {
    if (line === "YOUR_TURN") {
      return { kind: "your-turn" };
    }
    if (line.startsWith("OPPONENT_MOVE ")) {
      const moveIndex = Number.parseInt(line.replace("OPPONENT_MOVE ", ""), 10);
      return { kind: "move", moveIndex };
    }
    if (line === "GAME_OVER") {
      return { kind: "game-over" };
    }
    return { kind: "unknown", detail: line };
  });
}

function createNewLiveGame(humanColor, opponentColor) {
  const board = createInitialBoard(8);
  const snapshots = [createSnapshot(board, "Opening", null)];

  liveGame = {
    status: "in-progress",
    message: "Game started.",
    board,
    snapshots,
    currentPlayer: "B",
    humanColor,
    opponentColor,
    passCount: 0,
  };
}

function addSnapshot(title, move) {
  liveGame.snapshots.push(createSnapshot(liveGame.board, title, move));
}

function swapTurn() {
  liveGame.currentPlayer = liveGame.currentPlayer === "B" ? "W" : "B";
}

function handlePass(by) {
  liveGame.passCount += 1;
  addSnapshot(`${by} pass`, null);

  if (liveGame.passCount >= 2) {
    liveGame.status = "game-over";
    const counts = computeCounts(liveGame.board);
    if (counts.black === counts.white) {
      liveGame.message = "Game over. Draw.";
    } else {
      const winner = counts.black > counts.white ? "Black" : "White";
      liveGame.message = `Game over. ${winner} wins.`;
    }
  }
}

async function maybeAdvanceOpponentTurn() {
  while (liveGame && liveGame.status === "in-progress" && liveGame.currentPlayer === liveGame.opponentColor) {
    if (opponentMode !== "referee") {
      const legal = getLegalMoves(liveGame.board, liveGame.opponentColor);
      if (!legal.length) {
        handlePass("Opponent");
        swapTurn();
        continue;
      }
    }

    const response = await requestOpponentMove();
    if (response.kind === "game-over") {
      liveGame.status = "game-over";
      liveGame.message = "Game over.";
      return;
    }

    if (response.kind !== "move") {
      liveGame.status = "game-over";
      liveGame.message = "Opponent returned an invalid response.";
      return;
    }

    const moveIndex = response.moveIndex;

    if (moveIndex === -1) {
      handlePass("Opponent");
      swapTurn();
      continue;
    }

    if (!Number.isInteger(moveIndex) || moveIndex < 0 || moveIndex >= 64) {
      console.log(moveIndex, response);
      liveGame.status = "game-over";
      liveGame.message = "Opponent returned an invalid move.";
      return;
    }

    const row = Math.floor(moveIndex / 8);
    const col = moveIndex % 8;
    const applied = applyMove(liveGame.board, row, col, liveGame.opponentColor);
    if (!applied) {
      liveGame.status = "game-over";
      liveGame.message = "Opponent returned an illegal move.";
      return;
    }

    liveGame.passCount = 0;
    addSnapshot(`Opponent move (${row}, ${col})`, { row, col, by: "opponent" });
    swapTurn();
  }
}

async function handleHumanMove(row, col, isPass) {
  if (!liveGame || liveGame.status !== "in-progress") {
    throw new Error("No active game.");
  }

  if (liveGame.currentPlayer !== liveGame.humanColor) {
    throw new Error("It is not your turn.");
  }

  const legalMoves = getLegalMoves(liveGame.board, liveGame.humanColor);
  if (!legalMoves.length) {
    handlePass("You");
    sendPlayerMove(-1);
    swapTurn();
    await maybeAdvanceOpponentTurn();
    return;
  }

  if (isPass) {
    throw new Error("You have legal moves available.");
  }

  const applied = applyMove(liveGame.board, row, col, liveGame.humanColor);
  if (!applied) {
    throw new Error("Illegal move.");
  }

  liveGame.passCount = 0;
  addSnapshot(`My move (${row}, ${col})`, { row, col, by: "me" });
  sendPlayerMove(row * 8 + col);
  swapTurn();

  await maybeAdvanceOpponentTurn();
}

function parseMetadata(lines) {
  const metadata = {
    myName: "Unknown",
    myColour: "Unknown",
    boardSize: 8,
    timeLimit: "Unknown",
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("My name:")) {
      metadata.myName = trimmed.replace("My name:", "").trim();
    } else if (trimmed.startsWith("My colour:")) {
      const rawColour = trimmed.replace("My colour:", "").trim();
      metadata.myColour = rawColour === "0" ? "Black (B)" : rawColour === "1" ? "White (W)" : rawColour;
    } else if (trimmed.startsWith("Board size:")) {
      const boardSize = Number.parseInt(trimmed.replace("Board size:", "").trim(), 10);
      if (Number.isInteger(boardSize) && boardSize > 0) {
        metadata.boardSize = boardSize;
      }
    } else if (trimmed.startsWith("Time limit:")) {
      metadata.timeLimit = trimmed.replace("Time limit:", "").trim();
    }
  }

  return metadata;
}

function getSnapshotEvent(lines, boardHeaderIndex) {
  const maxLookback = 24;

  for (let i = boardHeaderIndex - 1; i >= 0 && boardHeaderIndex - i <= maxLookback; i -= 1) {
    const line = lines[i].trim();
    if (!line) {
      continue;
    }

    const myMove = line.match(/^Placing piece in row:\s*(\d+),\s*column:\s*(\d+)$/);
    if (myMove) {
      return {
        title: `My move (${myMove[1]}, ${myMove[2]})`,
        move: { row: Number.parseInt(myMove[1], 10), col: Number.parseInt(myMove[2], 10), by: "me" },
      };
    }

    const opponentMove = line.match(/^Opponent placing piece in row:\s*(\d+),\s*column:\s*(\d+)$/);
    if (opponentMove) {
      return {
        title: `Opponent move (${opponentMove[1]}, ${opponentMove[2]})`,
        move: { row: Number.parseInt(opponentMove[1], 10), col: Number.parseInt(opponentMove[2], 10), by: "opponent" },
      };
    }

    if (/^Only move is to pass$/i.test(line) || /^No legal moves, passing\.$/i.test(line)) {
      return {
        title: ".",
        move: null,
      };
    }
  }

  return {
    title: ".",
    move: null,
  };
}

function tryParseBoard(lines, headerIndex, boardSize) {
  const board = [];
  const rowPattern = /^\s*([0-7])\s+([.BW](?:\s+[.BW]){7})\s*$/;

  for (let i = 1; i <= boardSize; i += 1) {
    const line = lines[headerIndex + i];
    if (!line) {
      return null;
    }

    const rowMatch = line.match(rowPattern);
    if (!rowMatch) {
      return null;
    }

    board.push(rowMatch[2].trim().split(/\s+/));
  }

  return board;
}

function parseGameLog(rawLog) {
  const lines = rawLog.split(/\r?\n/);
  const metadata = parseMetadata(lines);
  const headerPattern = /^\s*0\s+1\s+2\s+3\s+4\s+5\s+6\s+7\s*$/;
  const snapshots = [];

  for (let i = 0; i < lines.length; i += 1) {
    if (!headerPattern.test(lines[i])) {
      continue;
    }

    const board = tryParseBoard(lines, i, metadata.boardSize);
    if (!board) {
      continue;
    }

    const event = getSnapshotEvent(lines, i);
    snapshots.push({
      index: snapshots.length,
      title: event.title,
      move: event.move,
      board,
    });

    i += metadata.boardSize;
  }

  return {
    metadata,
    snapshots,
  };
}

app.get("/", (req, res) => {
  try {
    const rawLog = fs.readFileSync(gameLogPath, "utf8");
    const game = parseGameLog(rawLog);
    game.live = {
      defaultOpponentPath: defaultOpponentSource,
      defaultUseReferee: true,
    };
    res.render("index", { game });
  } catch (error) {
    res.status(500).send(`Failed to load game log: ${error.message}`);
  }
});

app.post("/api/live/start", async (req, res) => {
  try {
    const rawPath = typeof req.body?.opponentPath === "string" ? req.body.opponentPath.trim() : "";
    const useReferee = req.body?.useReferee !== false;
    const humanColor = useReferee ? "B" : req.body?.humanColor === "W" ? "W" : "B";
    const opponentColor = humanColor === "B" ? "W" : "B";
    const resolvedPath = rawPath ? (path.isAbsolute(rawPath) ? rawPath : path.join(__dirname, rawPath)) : defaultOpponentSource;
    const binaryPath = useReferee ? ensureRefereeBinary(resolvedPath) : ensureOpponentBinary(resolvedPath);

    startOpponentProcess(binaryPath, useReferee ? "referee" : "adapter", opponentColor === "B" ? 1 : 2);
    createNewLiveGame(humanColor, opponentColor);

    if (liveGame.currentPlayer === liveGame.opponentColor) {
      await maybeAdvanceOpponentTurn();
    }

    res.json(buildLiveResponse());
  } catch (error) {
    stopOpponentProcess();
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/live/move", async (req, res) => {
  try {
    const isPass = req.body?.pass === true;
    if (isPass) {
      await handleHumanMove(-1, -1, true);
    } else {
      const row = Number.parseInt(req.body?.row, 10);
      const col = Number.parseInt(req.body?.col, 10);
      if (!Number.isInteger(row) || !Number.isInteger(col)) {
        return res.status(400).json({ error: "Row and col are required." });
      }
      await handleHumanMove(row, col, false);
    }

    return res.json(buildLiveResponse());
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.get("/api/live/state", (req, res) => {
  const response = buildLiveResponse();
  if (!response) {
    return res.status(404).json({ error: "No active game." });
  }
  return res.json(response);
});

app.post("/api/live/stop", (req, res) => {
  stopOpponentProcess();
  liveGame = null;
  res.json({ ok: true });
});

app.listen(port, () => {
  console.log(`Othello visualiser running at http://localhost:${port}`);
});
