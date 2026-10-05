import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged, connectAuthEmulator } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
    getDatabase, ref, onValue, runTransaction, set, onDisconnect, connectDatabaseEmulator
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";

const firebaseConfig = {
    apiKey: "AIzaSyDyQ3Vda1dd-lCsPSZ0Cnb8qZHEQrZ9pH8",
    authDomain: "game-cf.firebaseapp.com",
    databaseURL: "https://game-cf-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "game-cf",
    storageBucket: "game-cf.firebasestorage.app",
    messagingSenderId: "732429096837",
    appId: "1:732429096837:web:bf2c71c6433586c28896ec"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

// Local testing against the Firebase emulators: open http://localhost:…/game/?emulator
if (location.hostname === "localhost" && new URLSearchParams(location.search).has("emulator")) {
    connectAuthEmulator(auth, "http://localhost:9099", { disableWarnings: true });
    connectDatabaseEmulator(db, "localhost", 9000);
}

// Room codes avoid look-alike characters (0/O, 1/I).
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_RE = /^[A-HJ-NP-Z2-9]{4}$/;
const EMPTY_BOARD = "---------";
const LINES = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6]
];
const MARKS = { X: "✕", O: "◯" };

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const boardEl = $("board");

let uid = null;
let code = null;
let roomRef = null;
let room = null;
let presenceStarted = false;

// ---------- Game rules ----------

function findWin(board) {
    for (const line of LINES) {
        const [a, b, c] = line;
        if (board[a] !== "-" && board[a] === board[b] && board[a] === board[c]) {
            return { winner: board[a], line };
        }
    }
    return board.includes("-") ? null : { winner: "draw", line: [] };
}

function mySymbol(r) {
    if (!r || !r.players) return null;
    if (r.players.X === uid) return "X";
    if (r.players.O === uid) return "O";
    return null;
}

const other = (sym) => (sym === "X" ? "O" : "X");

// ---------- UI helpers ----------

function setStatus(text, isError = false) {
    statusEl.textContent = text;
    statusEl.classList.toggle("error", isError);
}

function showError(err) {
    console.error(err);
    const msg = String(err && (err.code || err.message) || err);
    if (/permission/i.test(msg)) {
        setStatus("Немає доступу до бази. Перевірте правила (Rules) у Firebase.", true);
    } else if (/operation-not-allowed|admin-restricted/i.test(msg)) {
        setStatus("У Firebase не ввімкнено анонімний вхід (Authentication → Anonymous).", true);
    } else {
        setStatus("Щось пішло не так. Оновіть сторінку.", true);
    }
}

function show(section) {
    $("lobby").hidden = section !== "lobby";
    $("room").hidden = section !== "room";
}

function roomUrl() {
    return location.origin + location.pathname + "#" + code;
}

// ---------- Lobby ----------

function randomCode() {
    const bytes = crypto.getRandomValues(new Uint8Array(4));
    return Array.from(bytes, (b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
}

async function createRoom() {
    $("create").disabled = true;
    setStatus("Створюємо кімнату…");
    try {
        for (let attempt = 0; attempt < 5; attempt++) {
            const candidate = randomCode();
            const result = await runTransaction(ref(db, "rooms/" + candidate), (current) => {
                if (current !== null) return; // code taken — abort and try another
                return {
                    createdAt: Date.now(),
                    players: { X: uid },
                    board: EMPTY_BOARD,
                    turn: "X",
                    round: 0,
                    score: { X: 0, O: 0 }
                };
            });
            if (result.committed) {
                history.pushState(null, "", "#" + candidate);
                enterRoom(candidate);
                return;
            }
        }
        setStatus("Не вдалося створити кімнату. Спробуйте ще раз.", true);
    } catch (err) {
        showError(err);
    } finally {
        $("create").disabled = false;
    }
}

function showLobby() {
    show("lobby");
    setStatus("");
}

// ---------- Room ----------

function enterRoom(roomCode) {
    code = roomCode;
    roomRef = ref(db, "rooms/" + code);
    $("room-code").textContent = code;
    show("room");
    setStatus("Завантаження…");
    buildBoard();

    let firstSnapshot = true;
    onValue(roomRef, (snap) => {
        room = snap.val();
        if (firstSnapshot) {
            firstSnapshot = false;
            if (!room) {
                setStatus("Кімнату " + code + " не знайдено. Перевірте код.", true);
                return;
            }
            if (mySymbol(room)) startPresence(mySymbol(room));
            else if (!room.players.O) joinRoom();
        }
        render();
    }, showError);
}

async function joinRoom() {
    try {
        const result = await runTransaction(roomRef, (r) => {
            if (!r || !r.players || r.players.O || r.players.X === uid) return;
            r.players.O = uid;
            return r;
        });
        // Only after the server has accepted us as a player may we mark ourselves online.
        if (result.committed && mySymbol(result.snapshot.val())) startPresence(mySymbol(result.snapshot.val()));
    } catch (err) {
        showError(err);
    }
}

// Marks this player online while the page is open; Firebase clears it on disconnect.
function startPresence(sym) {
    if (presenceStarted) return;
    presenceStarted = true;
    const meOnline = ref(db, "rooms/" + code + "/online/" + sym);
    onValue(ref(db, ".info/connected"), async (snap) => {
        if (snap.val() !== true) return;
        try {
            await onDisconnect(meOnline).remove();
            await set(meOnline, true);
        } catch (err) {
            console.error(err);
        }
    });
}

async function play(index) {
    try {
        await runTransaction(roomRef, (r) => {
            const sym = mySymbol(r);
            if (!sym || !r.players.O || r.winner || r.turn !== sym || r.board[index] !== "-") return;
            r.board = r.board.slice(0, index) + sym + r.board.slice(index + 1);
            const result = findWin(r.board);
            if (result) {
                r.winner = result.winner;
                if (result.winner !== "draw") {
                    r.score = r.score || { X: 0, O: 0 };
                    r.score[result.winner] = (r.score[result.winner] || 0) + 1;
                }
            } else {
                r.turn = other(sym);
            }
            return r;
        });
    } catch (err) {
        showError(err);
    }
}

async function rematch() {
    try {
        await runTransaction(roomRef, (r) => {
            if (!r || !r.winner || !mySymbol(r)) return;
            r.round = (r.round || 0) + 1;
            r.board = EMPTY_BOARD;
            r.turn = r.round % 2 ? "O" : "X"; // players take turns going first
            r.winner = null;
            return r;
        });
    } catch (err) {
        showError(err);
    }
}

async function share() {
    const url = roomUrl();
    const btn = $("share");
    if (navigator.share) {
        try {
            await navigator.share({ title: "Хрестики-нулики", text: "Зіграймо! Код кімнати: " + code, url });
        } catch (err) {
            if (err.name !== "AbortError") console.error(err);
        }
        return;
    }
    try {
        await navigator.clipboard.writeText(url);
        btn.textContent = "Скопійовано ✓";
        setTimeout(() => { btn.textContent = "Надіслати посилання"; }, 2000);
    } catch {
        window.prompt("Скопіюйте посилання:", url);
    }
}

// ---------- Rendering ----------

function buildBoard() {
    boardEl.innerHTML = "";
    for (let i = 0; i < 9; i++) {
        const cell = document.createElement("button");
        cell.className = "cell";
        cell.type = "button";
        cell.setAttribute("role", "gridcell");
        cell.addEventListener("click", () => play(i));
        boardEl.appendChild(cell);
    }
}

function render() {
    if (!room) return;
    const me = mySymbol(room);
    const opp = me && other(me);
    const players = room.players || {};
    const online = room.online || {};
    const score = room.score || {};
    const board = room.board || EMPTY_BOARD;
    const ready = Boolean(players.O);
    const win = room.winner ? findWin(board) : null;

    for (const sym of ["X", "O"]) {
        const el = $("player-" + sym);
        let who;
        if (!players[sym]) who = "чекаємо…";
        else if (sym === me) who = "Ви";
        else who = me ? "Суперник" : "Гравець";
        if (players[sym] && sym !== me && !online[sym]) who += " (офлайн)";
        el.querySelector(".who").textContent = who;
        el.querySelector(".score").textContent = score[sym] || 0;
        el.classList.toggle("active", ready && !room.winner && room.turn === sym);
    }

    const cells = boardEl.children;
    for (let i = 0; i < 9; i++) {
        const v = board[i];
        const cell = cells[i];
        cell.textContent = v === "-" ? "" : MARKS[v];
        cell.className = "cell" + (v === "-" ? "" : " " + v) + (win && win.line.includes(i) ? " win" : "");
        cell.disabled = !(me && ready && !room.winner && room.turn === me && v === "-");
        cell.setAttribute("aria-label", "Клітинка " + (i + 1) + (v === "-" ? ", порожня" : ", " + MARKS[v]));
    }

    $("rematch").hidden = !(room.winner && me);

    let text;
    if (!me) {
        text = room.winner ? resultText(room.winner, null) : "Кімната зайнята — ви дивитеся гру.";
    } else if (!ready) {
        text = "Надішліть посилання другу — чекаємо на нього.";
    } else if (room.winner) {
        text = resultText(room.winner, me);
    } else if (room.turn === me) {
        text = "Ваш хід (" + MARKS[me] + ")";
    } else {
        text = online[opp] ? "Хід суперника…" : "Суперник не в мережі — чекаємо…";
    }
    setStatus(text);
}

function resultText(winner, me) {
    if (winner === "draw") return "Нічия!";
    if (!me) return "Переміг " + MARKS[winner];
    return winner === me ? "Ви виграли! 🎉" : "Суперник виграв.";
}

// ---------- Start ----------

$("create").addEventListener("click", createRoom);
$("rematch").addEventListener("click", rematch);
$("share").addEventListener("click", share);
$("join-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const value = $("join-code").value.trim().toUpperCase();
    if (!CODE_RE.test(value)) {
        setStatus("Код — це 4 символи, наприклад K7F2.", true);
        return;
    }
    history.pushState(null, "", "#" + value);
    enterRoom(value);
});
// Back button or an edited link with another code: start fresh.
window.addEventListener("popstate", () => location.reload());

onAuthStateChanged(auth, (user) => {
    if (!user) return;
    if (uid) return; // already started
    uid = user.uid;
    const hashCode = location.hash.slice(1).toUpperCase();
    if (CODE_RE.test(hashCode)) enterRoom(hashCode);
    else showLobby();
});

signInAnonymously(auth).catch(showError);
