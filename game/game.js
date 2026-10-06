import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged, connectAuthEmulator } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
    getDatabase, ref, onValue, runTransaction, set, onDisconnect, connectDatabaseEmulator
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { buildCharacterSprites, frameIndex, OUTLINE } from "./sprites.js";
import { buildWorld, moveWithCollisions, SPAWN, WORLD_W, WORLD_H } from "./world.js";

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
const ROLES = ["cat", "fox"];
const NAME = { cat: "Кіт", fox: "Лис" };
const other = (role) => (role === "cat" ? "fox" : "cat");

const SPEED = 64; // world pixels per second
const SEND_EVERY = 100; // ms between position updates
const JOY_RADIUS = 46; // CSS px

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const sprites = buildCharacterSprites();

let uid = null;
let code = null;
let roomRef = null;
let room = null;
let myRole = null; // "cat" | "fox" | null (spectator)
let joining = false;
let presenceStarted = false;

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
    for (const id of ["lobby", "pick", "waiting", "play"]) $(id).hidden = id !== section;
    document.body.classList.toggle("playing", section === "play");
}

// Little looping walk animation for previews outside the meadow.
function animatePreview(canvas, role) {
    const ctx = canvas.getContext("2d");
    const step = (t) => {
        if (!canvas.isConnected) return;
        if (canvas.offsetParent !== null) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(sprites[role].down[frameIndex(true, t / 1000)], 2, 2);
        }
        requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
}

// ---------- Lobby ----------

function randomCode() {
    const bytes = crypto.getRandomValues(new Uint8Array(4));
    return Array.from(bytes, (b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
}

function startPos(role) {
    return { x: SPAWN[role].x, y: SPAWN[role].y, d: "down", m: false };
}

async function createRoom(role) {
    document.querySelectorAll(".char-card").forEach((b) => { b.disabled = true; });
    setStatus("Створюємо кімнату…");
    try {
        for (let attempt = 0; attempt < 5; attempt++) {
            const candidate = randomCode();
            const result = await runTransaction(ref(db, "rooms/" + candidate), (current) => {
                if (current !== null) return; // code taken — abort and try another
                return {
                    createdAt: Date.now(),
                    players: { [role]: uid },
                    pos: { [role]: startPos(role) }
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
        document.querySelectorAll(".char-card").forEach((b) => { b.disabled = false; });
    }
}

// ---------- Room ----------

function roleOf(r) {
    if (!r || !r.players) return null;
    return ROLES.find((role) => r.players[role] === uid) || null;
}

function enterRoom(roomCode) {
    code = roomCode;
    roomRef = ref(db, "rooms/" + code);
    document.querySelectorAll("[data-room-code]").forEach((el) => { el.textContent = code; });
    setStatus("Завантаження…");

    let firstSnapshot = true;
    onValue(roomRef, (snap) => {
        room = snap.val();
        if (firstSnapshot) {
            firstSnapshot = false;
            if (!room || !room.players) {
                show("lobby");
                setStatus("Кімнату " + code + " не знайдено. Перевірте код.", true);
                return;
            }
            myRole = roleOf(room);
            if (myRole) {
                startPresence(myRole);
            } else {
                const freeRole = ROLES.find((role) => !room.players[role]);
                if (freeRole) joinRoom(freeRole);
            }
        }
        if (room) update();
    }, showError);
}

async function joinRoom(role) {
    joining = true;
    try {
        const result = await runTransaction(ref(db, "rooms/" + code + "/players/" + role), (current) => {
            if (current !== null) return; // somebody was faster
            return uid;
        });
        if (!result.committed) return;
        myRole = role;
        // Only after the server has accepted us as a player may we write our position and presence.
        await set(ref(db, "rooms/" + code + "/pos/" + role), startPos(role));
        startPresence(role);
    } catch (err) {
        showError(err);
    } finally {
        joining = false;
        if (room) update();
    }
}

// Marks this player online while the page is open; Firebase clears it on disconnect.
function startPresence(role) {
    if (presenceStarted) return;
    presenceStarted = true;
    const meOnline = ref(db, "rooms/" + code + "/online/" + role);
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

// Decides which screen to show after every change in the room.
function update() {
    if (joining) {
        setStatus("Приєднуємося…");
        return;
    }
    const players = room.players || {};
    const bothJoined = Boolean(players.cat && players.fox);

    if (myRole && !bothJoined) {
        show("waiting");
        setStatus("");
        $("waiting-text").textContent = "Ти — " + NAME[myRole] + ". Надішли посилання другу — він гратиме за " +
            (myRole === "cat" ? "Лиса" : "Кота") + ".";
        return;
    }
    if (!myRole && !bothJoined) return;
    if (!game) startGame();
    game.sync();
}

async function share() {
    const url = location.origin + location.pathname + "#" + code;
    const btn = document.querySelector("[data-share]");
    if (navigator.share) {
        try {
            await navigator.share({ title: "Кіт і Лис", text: "Пограймо разом! Код кімнати: " + code, url });
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

// ---------- The meadow ----------

let game = null;

function startGame() {
    show("play");
    setStatus("");
    const canvas = $("stage");
    const ctx = canvas.getContext("2d");
    const world = buildWorld();
    const posRef = myRole && ref(db, "rooms/" + code + "/pos/" + myRole);

    // Every character: shown position (x, y) and, for remote ones, the target from the network.
    const chars = {};
    for (const role of ROLES) {
        const p = (room.pos && room.pos[role]) || startPos(role);
        chars[role] = { role, x: p.x, y: p.y, tx: p.x, ty: p.y, d: p.d || "down", m: false, t: 0 };
    }

    const keys = new Set();
    const joy = { active: false, id: null, ox: 0, oy: 0, x: 0, y: 0 };
    let lastSent = 0;
    let sentState = "";
    let last = performance.now();
    let hintShown = true;

    // ----- input -----
    const KEYMAP = {
        ArrowUp: "up", KeyW: "up", ArrowDown: "down", KeyS: "down",
        ArrowLeft: "left", KeyA: "left", ArrowRight: "right", KeyD: "right"
    };
    window.addEventListener("keydown", (e) => {
        if (KEYMAP[e.code]) { keys.add(KEYMAP[e.code]); e.preventDefault(); }
    });
    window.addEventListener("keyup", (e) => { keys.delete(KEYMAP[e.code]); });
    window.addEventListener("blur", () => keys.clear());

    canvas.addEventListener("pointerdown", (e) => {
        if (joy.active) return;
        canvas.setPointerCapture(e.pointerId);
        Object.assign(joy, { active: true, id: e.pointerId, ox: e.clientX, oy: e.clientY, x: e.clientX, y: e.clientY });
    });
    canvas.addEventListener("pointermove", (e) => {
        if (joy.active && e.pointerId === joy.id) { joy.x = e.clientX; joy.y = e.clientY; }
    });
    const release = (e) => { if (e.pointerId === joy.id) joy.active = false; };
    canvas.addEventListener("pointerup", release);
    canvas.addEventListener("pointercancel", release);

    function inputVector() {
        let vx = 0;
        let vy = 0;
        if (keys.has("left")) vx -= 1;
        if (keys.has("right")) vx += 1;
        if (keys.has("up")) vy -= 1;
        if (keys.has("down")) vy += 1;
        if (joy.active) {
            vx = (joy.x - joy.ox) / JOY_RADIUS;
            vy = (joy.y - joy.oy) / JOY_RADIUS;
        }
        const len = Math.hypot(vx, vy);
        if (len < 0.2) return { vx: 0, vy: 0 };
        return len > 1 ? { vx: vx / len, vy: vy / len } : { vx, vy };
    }

    // ----- network -----
    function sync() {
        for (const role of ROLES) {
            if (role === myRole) continue;
            const p = room.pos && room.pos[role];
            if (!p) continue;
            const c = chars[role];
            c.tx = p.x;
            c.ty = p.y;
            c.d = p.d || c.d;
            c.m = Boolean(p.m);
        }
        const players = room.players || {};
        const online = room.online || {};
        let text = "Кімната " + code;
        if (myRole) {
            const friend = other(myRole);
            text += " · " + (online[friend] ? NAME[friend] + " поруч" : NAME[friend] + " не в мережі");
        } else if (players.cat && players.fox) {
            text += " · ти глядач";
        }
        $("hud-status").textContent = text;
    }

    function send(now) {
        if (!myRole) return;
        const me = chars[myRole];
        const state = { x: Math.round(me.x), y: Math.round(me.y), d: me.d, m: me.m };
        const key = state.x + "," + state.y + "," + state.d + "," + state.m;
        if (key === sentState) return;
        const stoppedNow = !state.m && sentState.endsWith("true");
        if (!stoppedNow && now - lastSent < SEND_EVERY) return;
        sentState = key;
        lastSent = now;
        set(posRef, state).catch(console.error);
    }

    // ----- simulation -----
    function tick(now) {
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;

        if (myRole) {
            const me = chars[myRole];
            const { vx, vy } = inputVector();
            me.m = vx !== 0 || vy !== 0;
            if (me.m) {
                const next = moveWithCollisions(world, me.x, me.y, vx * SPEED * dt, vy * SPEED * dt);
                me.x = next.x;
                me.y = next.y;
                me.d = Math.abs(vx) > Math.abs(vy) ? (vx > 0 ? "right" : "left") : (vy > 0 ? "down" : "up");
                if (hintShown) {
                    hintShown = false;
                    $("touch-hint").classList.add("gone");
                }
            }
            send(now);
        }
        for (const role of ROLES) {
            const c = chars[role];
            if (role !== myRole) {
                const dist = Math.hypot(c.tx - c.x, c.ty - c.y);
                if (dist > 80) {
                    c.x = c.tx;
                    c.y = c.ty;
                } else {
                    const k = 1 - Math.exp(-dt * 12);
                    c.x += (c.tx - c.x) * k;
                    c.y += (c.ty - c.y) * k;
                }
            }
            c.t += dt;
        }
        draw(now);
        requestAnimationFrame(tick);
    }

    // ----- rendering -----
    function draw(now) {
        const dpr = window.devicePixelRatio || 1;
        const cw = Math.round(canvas.clientWidth * dpr);
        const ch = Math.round(canvas.clientHeight * dpr);
        if (canvas.width !== cw || canvas.height !== ch) {
            canvas.width = cw;
            canvas.height = ch;
        }
        // Whole-number zoom keeps the pixels crisp; the short side shows about 10 tiles.
        const scale = Math.max(1, Math.round(Math.min(cw, ch) / 170));
        const viewW = cw / scale;
        const viewH = ch / scale;

        const focus = myRole
            ? chars[myRole]
            : { x: (chars.cat.x + chars.fox.x) / 2, y: (chars.cat.y + chars.fox.y) / 2 };
        const cam = (center, view, size) =>
            size <= view ? Math.round((size - view) / 2) : Math.round(Math.min(Math.max(center - view / 2, 0), size - view));
        const camX = cam(focus.x, viewW, WORLD_W);
        const camY = cam(focus.y - 8, viewH, WORLD_H);

        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = "#2f6b2c";
        ctx.fillRect(0, 0, cw, ch);
        ctx.imageSmoothingEnabled = false;
        ctx.setTransform(scale, 0, 0, scale, -camX * scale, -camY * scale);
        ctx.drawImage(world.ground, 0, 0);

        // Draw props and characters from back to front so trees can hide whoever walks behind them.
        const players = room.players || {};
        const online = room.online || {};
        const visibleChars = ROLES.filter((role) => players[role]).map((role) => chars[role]);
        const items = world.props
            .filter((p) => p.x < camX + viewW && p.x + p.img.width > camX && p.y < camY + viewH && p.y + p.img.height > camY)
            .concat(visibleChars.map((c) => ({ char: c, base: c.y })));
        items.sort((a, b) => a.base - b.base);

        for (const item of items) {
            if (!item.char) {
                ctx.drawImage(item.img, item.x, item.y);
                continue;
            }
            const c = item.char;
            const x = Math.round(c.x);
            const y = Math.round(c.y);
            ctx.globalAlpha = c.role === myRole || online[c.role] ? 1 : 0.5;
            ctx.fillStyle = "rgba(20, 40, 10, 0.3)";
            ctx.fillRect(x - 5, y - 1, 10, 2);
            ctx.fillRect(x - 4, y - 2, 8, 4);
            ctx.drawImage(sprites[c.role][c.d][frameIndex(c.m, c.t)], x - 8, y - 15);
            ctx.globalAlpha = 1;
        }

        // A small bouncing arrow above "me".
        if (myRole) {
            const me = chars[myRole];
            const x = Math.round(me.x);
            const y = Math.round(me.y) - 21 + (Math.floor(now / 300) % 2);
            ctx.fillStyle = OUTLINE;
            ctx.fillRect(x - 3, y - 1, 7, 1);
            ctx.fillRect(x - 3, y, 7, 2);
            ctx.fillRect(x - 2, y + 2, 5, 1);
            ctx.fillRect(x - 1, y + 3, 3, 1);
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(x - 2, y, 5, 1);
            ctx.fillRect(x - 1, y + 1, 3, 1);
            ctx.fillRect(x, y + 2, 1, 1);
        }

        // Touch joystick
        if (joy.active) {
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            const r = JOY_RADIUS;
            let kx = joy.x - joy.ox;
            let ky = joy.y - joy.oy;
            const len = Math.hypot(kx, ky);
            if (len > r) { kx = (kx / len) * r; ky = (ky / len) * r; }
            const rect = canvas.getBoundingClientRect();
            const ox = joy.ox - rect.left;
            const oy = joy.oy - rect.top;
            ctx.fillStyle = "rgba(255, 255, 255, 0.18)";
            ctx.strokeStyle = "rgba(255, 255, 255, 0.55)";
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(ox, oy, r, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = "rgba(255, 255, 255, 0.75)";
            ctx.beginPath();
            ctx.arc(ox + kx, oy + ky, r * 0.45, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    if (!myRole) $("touch-hint").hidden = true;
    else if (!matchMedia("(pointer: coarse)").matches) $("touch-hint").textContent = "Ходи стрілками або WASD";

    game = { sync };
    requestAnimationFrame(tick);
}

// ---------- Start ----------

$("create").addEventListener("click", () => {
    show("pick");
    setStatus("");
});
document.querySelectorAll(".char-card").forEach((btn) => {
    btn.addEventListener("click", () => createRoom(btn.dataset.role));
});
document.querySelectorAll("[data-preview]").forEach((c) => animatePreview(c, c.dataset.preview));
document.querySelectorAll("[data-share]").forEach((b) => b.addEventListener("click", share));
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

let waitingPreviewStarted = false;
const waitingObserver = new MutationObserver(() => {
    if (!waitingPreviewStarted && myRole && !$("waiting").hidden) {
        waitingPreviewStarted = true;
        animatePreview($("waiting-preview"), myRole);
    }
});
waitingObserver.observe($("waiting"), { attributes: true, attributeFilter: ["hidden"] });

onAuthStateChanged(auth, (user) => {
    if (!user) return;
    if (uid) return; // already started
    uid = user.uid;
    const hashCode = location.hash.slice(1).toUpperCase();
    if (CODE_RE.test(hashCode)) {
        enterRoom(hashCode);
    } else {
        show("lobby");
        setStatus("");
    }
});

signInAnonymously(auth).catch(showError);
