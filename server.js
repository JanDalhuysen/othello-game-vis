const fs = require("fs");
const path = require("path");
const express = require("express");

const app = express();
const port = process.env.PORT || 3000;
const gameLogPath = path.join(__dirname, "game.log");

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));

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
    res.render("index", { game });
  } catch (error) {
    res.status(500).send(`Failed to load game log: ${error.message}`);
  }
});

app.listen(port, () => {
  console.log(`Othello visualiser running at http://localhost:${port}`);
});
