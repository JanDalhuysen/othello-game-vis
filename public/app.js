const game = window.__GAME_DATA__;

const boardEl = document.getElementById("board");
const stepTitleEl = document.getElementById("stepTitle");
const stepCounterEl = document.getElementById("stepCounter");
const timelineEl = document.getElementById("timeline");
const prevBtn = document.getElementById("prevBtn");
const playBtn = document.getElementById("playBtn");
const nextBtn = document.getElementById("nextBtn");
const speedSelect = document.getElementById("speedSelect");

const snapshots = Array.isArray(game?.snapshots) ? game.snapshots : [];
let currentStep = 0;
let isPlaying = false;
let playTimer = null;
let lastRenderedStep = null;

function renderBoard(snapshot, previousSnapshot, shouldAnimateTransition) {
  boardEl.innerHTML = "";

  for (let row = 0; row < snapshot.board.length; row += 1) {
    for (let col = 0; col < snapshot.board[row].length; col += 1) {
      const cell = document.createElement("div");
      cell.className = "cell";

      if (snapshot.move && snapshot.move.row === row && snapshot.move.col === col) {
        cell.classList.add("last-move");
      }

      const value = snapshot.board[row][col];
      if (value === "B" || value === "W") {
        const previousValue = previousSnapshot?.board?.[row]?.[col] ?? ".";
        const isPlacedDisc = shouldAnimateTransition && previousValue === ".";
        const isFlippedDisc = !isPlacedDisc && previousValue !== "." && previousValue !== value;

        if (shouldAnimateTransition && isFlippedDisc) {
          // Create a single-face disc and animate collapse -> swap color -> expand
          const oldClass = previousValue === "B" ? "black" : "white";
          const newClass = value === "B" ? "black" : "white";
          const disc = document.createElement("span");
          disc.className = `disc ${oldClass} flip`;
          cell.appendChild(disc);

          // timings (ms)
          const delayBeforeFlip = 240; // wait after placement animation
          const collapseDuration = 220;
          const expandDuration = 220;

          // Start collapse after delay; then swap color and expand
          setTimeout(() => {
            disc.classList.add("collapse");
            setTimeout(() => {
              disc.classList.remove(oldClass);
              disc.classList.add(newClass);
              disc.classList.remove("collapse");
              disc.classList.add("expand");
              setTimeout(() => {
                disc.classList.remove("expand");
                disc.classList.remove("flip");
              }, expandDuration);
            }, collapseDuration);
          }, delayBeforeFlip);
        } else {
          const disc = document.createElement("span");
          disc.className = `disc ${value === "B" ? "black" : "white"}`;

          if (shouldAnimateTransition && isPlacedDisc) {
            disc.classList.add("placed");
          }

          cell.appendChild(disc);
        }
      }

      boardEl.appendChild(cell);
    }
  }
}

function computeCounts(snapshot) {
  const counts = { black: 0, white: 0 };
  for (let r = 0; r < snapshot.board.length; r += 1) {
    for (let c = 0; c < snapshot.board[r].length; c += 1) {
      const v = snapshot.board[r][c];
      if (v === "B") counts.black += 1;
      else if (v === "W") counts.white += 1;
    }
  }
  return counts;
}

function renderStep(index) {
  if (!snapshots.length) {
    stepTitleEl.textContent = "No snapshots found in game.log";
    stepCounterEl.textContent = "";
    boardEl.innerHTML = "";
    const bs = document.getElementById("blackScore");
    const ws = document.getElementById("whiteScore");
    if (bs) bs.textContent = "0";
    if (ws) ws.textContent = "0";
    return;
  }

  currentStep = Math.max(0, Math.min(index, snapshots.length - 1));
  const snapshot = snapshots[currentStep];

  stepTitleEl.textContent = snapshot.title;
  stepCounterEl.textContent = `Step ${currentStep + 1}/${snapshots.length}`;
  timelineEl.value = String(currentStep);

  const shouldAnimateTransition = lastRenderedStep !== null && currentStep === lastRenderedStep + 1;
  const previousSnapshot = shouldAnimateTransition && currentStep > 0 ? snapshots[currentStep - 1] : null;

  renderBoard(snapshot, previousSnapshot, shouldAnimateTransition);
  lastRenderedStep = currentStep;

  // Update scores
  const counts = computeCounts(snapshot);
  const bs = document.getElementById("blackScore");
  const ws = document.getElementById("whiteScore");
  if (bs) bs.textContent = String(counts.black);
  if (ws) ws.textContent = String(counts.white);
}

function stopPlayback() {
  isPlaying = false;
  playBtn.textContent = "Play";
  if (playTimer) {
    clearInterval(playTimer);
    playTimer = null;
  }
}

function startPlayback() {
  if (snapshots.length <= 1) {
    return;
  }

  stopPlayback();
  isPlaying = true;
  playBtn.textContent = "Pause";

  const intervalMs = Number.parseInt(speedSelect.value, 10) || 950;
  playTimer = setInterval(() => {
    if (currentStep >= snapshots.length - 1) {
      stopPlayback();
      return;
    }

    renderStep(currentStep + 1);
  }, intervalMs);
}

prevBtn.addEventListener("click", () => {
  stopPlayback();
  renderStep(currentStep - 1);
});

nextBtn.addEventListener("click", () => {
  stopPlayback();
  renderStep(currentStep + 1);
});

playBtn.addEventListener("click", () => {
  if (isPlaying) {
    stopPlayback();
  } else {
    startPlayback();
  }
});

speedSelect.addEventListener("change", () => {
  if (isPlaying) {
    startPlayback();
  }
});

timelineEl.addEventListener("input", (event) => {
  stopPlayback();
  renderStep(Number.parseInt(event.target.value, 10));
});

if (snapshots.length > 0) {
  timelineEl.max = String(snapshots.length - 1);
  renderStep(0);
} else {
  timelineEl.max = "0";
  renderStep(0);
}
