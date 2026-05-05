const game = window.__GAME_DATA__;

const boardEl = document.getElementById("board");
const stepTitleEl = document.getElementById("stepTitle");
const stepCounterEl = document.getElementById("stepCounter");
const timelineEl = document.getElementById("timeline");
const prevBtn = document.getElementById("prevBtn");
const playBtn = document.getElementById("playBtn");
const nextBtn = document.getElementById("nextBtn");
const speedSelect = document.getElementById("speedSelect");
const atomToggle = document.getElementById("atomToggle");

let snapshots = Array.isArray(game?.snapshots) ? game.snapshots : [];
let currentStep = 0;
let isPlaying = false;
let playTimer = null;
let lastRenderedStep = null;
const atomModeStorageKey = "atomOneDarkMode";
let liveMode = false;
let liveState = null;
let liveLegalMoves = [];
let lastLiveSnapshotCount = null;
let liveStepTimer = null;

const opponentPathInput = document.getElementById("opponentPath");
const opponentColorSelect = document.getElementById("opponentColor");
const useRefereeToggle = document.getElementById("useReferee");
const liveStartBtn = document.getElementById("startLiveBtn");
const liveStatusEl = document.getElementById("liveStatus");
const passBtn = document.getElementById("passBtn");

function setAtomOneDarkMode(isEnabled) {
  document.body.classList.toggle("theme-atom", isEnabled);
  if (atomToggle) {
    atomToggle.checked = isEnabled;
  }
  try {
    localStorage.setItem(atomModeStorageKey, JSON.stringify(isEnabled));
  } catch (error) {
    // Ignore storage errors (private mode, blocked storage, etc.).
  }
}

function loadAtomOneDarkMode() {
  if (!atomToggle) {
    return;
  }

  let stored = null;
  try {
    stored = localStorage.getItem(atomModeStorageKey);
  } catch (error) {
    stored = null;
  }

  if (stored !== null) {
    setAtomOneDarkMode(stored === "true");
  }
}

function renderBoard(snapshot, previousSnapshot, shouldAnimateTransition, legalMoves) {
  boardEl.innerHTML = "";
  const legalSet = new Set((legalMoves || []).map((move) => `${move.row}-${move.col}`));

  for (let row = 0; row < snapshot.board.length; row += 1) {
    for (let col = 0; col < snapshot.board[row].length; col += 1) {
      const cell = document.createElement("div");
      cell.className = "cell";
      cell.dataset.row = String(row);
      cell.dataset.col = String(col);

      if (legalSet.has(`${row}-${col}`)) {
        cell.classList.add("legal-move");
      }

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

  const isLatestSnapshot = currentStep === snapshots.length - 1;
  const showLiveMoves = liveMode && liveState && isLatestSnapshot && liveState.status === "in-progress" && liveState.currentPlayer === liveState.humanColor;
  renderBoard(snapshot, previousSnapshot, shouldAnimateTransition, showLiveMoves ? liveLegalMoves : []);
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

if (atomToggle) {
  loadAtomOneDarkMode();
  atomToggle.addEventListener("change", (event) => {
    setAtomOneDarkMode(event.target.checked);
  });
}

function setLiveStatus(text, isError) {
  if (!liveStatusEl) {
    return;
  }
  liveStatusEl.textContent = text || "";
  liveStatusEl.classList.toggle("is-error", Boolean(isError));
}

function updateControlsForLiveMode() {
  const disablePlayback = liveMode;
  playBtn.disabled = disablePlayback;
  prevBtn.disabled = false;
  nextBtn.disabled = false;
}

function clearLiveStepTimer() {
  if (liveStepTimer) {
    clearTimeout(liveStepTimer);
    liveStepTimer = null;
  }
}

function playLiveSequence(startIndex, endIndex) {
  renderStep(startIndex);

  if (startIndex < endIndex) {
    liveStepTimer = setTimeout(() => {
      playLiveSequence(startIndex + 1, endIndex);
    }, 520);
  }
}

function applyLiveState(state) {
  const previousLiveCount = lastLiveSnapshotCount;
  liveState = state;
  liveMode = true;
  liveLegalMoves = Array.isArray(state?.legalMoves) ? state.legalMoves : [];
  snapshots = Array.isArray(state?.snapshots) ? state.snapshots : [];
  lastLiveSnapshotCount = snapshots.length;

  timelineEl.max = snapshots.length > 0 ? String(snapshots.length - 1) : "0";
  clearLiveStepTimer();

  const hasNewSnapshots = previousLiveCount !== null && snapshots.length > previousLiveCount;
  if (hasNewSnapshots) {
    const firstNew = previousLiveCount;
    const lastNew = snapshots.length - 1;
    lastRenderedStep = firstNew > 0 ? firstNew - 1 : null;
    playLiveSequence(firstNew, lastNew);
  } else {
    currentStep = Math.max(0, snapshots.length - 1);
    lastRenderedStep = null;
    renderStep(currentStep);
  }
  updateControlsForLiveMode();

  if (state?.status === "game-over") {
    setLiveStatus(state?.message || "Game over.");
  } else if (state?.currentPlayer === state?.humanColor) {
    setLiveStatus(`Your turn (${state.humanColor === "B" ? "Black" : "White"}).`);
  } else {
    setLiveStatus("Opponent thinking...");
  }

  if (passBtn) {
    passBtn.disabled = !(state?.status === "in-progress" && state?.currentPlayer === state?.humanColor && liveLegalMoves.length === 0);
  }
}

async function startLiveGame() {
  const opponentPath = opponentPathInput ? opponentPathInput.value.trim() : "";
  const useReferee = useRefereeToggle ? useRefereeToggle.checked : true;
  const humanColor = useReferee ? "B" : opponentColorSelect ? opponentColorSelect.value : "B";
  setLiveStatus("Starting game...");
  lastLiveSnapshotCount = null;
  clearLiveStepTimer();

  try {
    const response = await fetch("/api/live/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ opponentPath, humanColor, useReferee }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Failed to start live game.");
    }
    applyLiveState(data);
  } catch (error) {
    setLiveStatus(error.message, true);
  }
}

async function sendLiveMove(row, col, isPass) {
  try {
    const response = await fetch("/api/live/move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(isPass ? { pass: true } : { row, col }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Move rejected.");
    }
    applyLiveState(data);
  } catch (error) {
    setLiveStatus(error.message, true);
  }
}

boardEl.addEventListener("click", (event) => {
  if (!liveMode || !liveState || liveState.status !== "in-progress") {
    return;
  }
  if (currentStep !== snapshots.length - 1) {
    setLiveStatus("Go to the latest move to play.");
    return;
  }
  if (liveState.currentPlayer !== liveState.humanColor) {
    return;
  }

  const cell = event.target.closest(".cell");
  if (!cell) {
    return;
  }
  const row = Number.parseInt(cell.dataset.row, 10);
  const col = Number.parseInt(cell.dataset.col, 10);
  const isLegal = liveLegalMoves.some((move) => move.row === row && move.col === col);
  if (!isLegal) {
    return;
  }
  sendLiveMove(row, col, false);
});

if (liveStartBtn) {
  liveStartBtn.addEventListener("click", () => {
    startLiveGame();
  });
}

function syncRefereeMode() {
  if (!useRefereeToggle || !opponentColorSelect) {
    return;
  }
  if (useRefereeToggle.checked) {
    opponentColorSelect.value = "B";
    opponentColorSelect.disabled = true;
  } else {
    opponentColorSelect.disabled = false;
  }
}

if (useRefereeToggle) {
  syncRefereeMode();
  useRefereeToggle.addEventListener("change", () => {
    syncRefereeMode();
  });
}

if (passBtn) {
  passBtn.addEventListener("click", () => {
    sendLiveMove(-1, -1, true);
  });
}

if (snapshots.length > 0) {
  timelineEl.max = String(snapshots.length - 1);
  renderStep(0);
} else {
  timelineEl.max = "0";
  renderStep(0);
}
