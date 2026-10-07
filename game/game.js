import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged, connectAuthEmulator } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
    getDatabase, ref, onValue, runTransaction, set, onDisconnect, connectDatabaseEmulator
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { buildCharacterSprites, buildMouseSprites, frameIndex, OUTLINE } from "./sprites.js";
import { buildWorld, moveWithCollisions, inCover, SPAWN, WORLD_W, WORLD_H } from "./world.js";
import { MouseSim, ALIVE, WIN_SCORE, AMBUSH_MS, CATCH_DIST } from "./mouse.js";

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
const TESTING = location.hostname === "localhost" && new URLSearchParams(location.search).has("emulator");
if (TESTING) {
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
const HIDE_TIME = 0.2; // seconds you have to stand still next to a bush or a tree to hide
const ACC = { cat: "Кота", fox: "Лиса" };

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

function headIcon(role) {
    const c = document.createElement("canvas");
    c.width = 16;
    c.height = 12;
    c.getContext("2d").drawImage(sprites[role].down[0], 0, -1);
    return c.toDataURL();
}

let toastTimer = null;
function showToast(text, ms = 2200) {
    const el = $("toast");
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function startGame() {
    show("play");
    setStatus("");
    const canvas = $("stage");
    const ctx = canvas.getContext("2d");
    const world = buildWorld();
    const normalSprites = buildMouseSprites();
    const zombieSprites = buildMouseSprites(true);
    const base = "rooms/" + code;
    const posRef = myRole && ref(db, base + "/pos/" + myRole);
    const mouseRef = ref(db, base + "/game/mouse");

    let serverOffset = 0;
    onValue(ref(db, ".info/serverTimeOffset"), (snap) => { serverOffset = snap.val() || 0; });
    const serverNow = () => Date.now() + serverOffset;

    // Every character: shown position (x, y) and, for remote ones, the target from the network.
    const chars = {};
    for (const role of ROLES) {
        const p = (room.pos && room.pos[role]) || startPos(role);
        chars[role] = { role, x: p.x, y: p.y, tx: p.x, ty: p.y, d: p.d || "down", m: false, h: false, t: 0 };
    }

    // Hiding: standing still next to a bush or a tree, plus a few seconds after stepping out.
    let myCover = false;
    let coverStill = 0; // seconds spent standing still next to cover
    let lastCover = -Infinity; // performance.now() of the last moment in cover

    // The mouse as this device shows it.
    const mouse = { id: 0, x: 0, y: 0, tx: 0, ty: 0, d: "down", s: "gone", z: false, since: 0, t: 0 };
    let sim = null; // MouseSim when this device runs the mouse
    let simSent = "";
    let simLastSent = 0;
    let mound = null; // little pile of earth where a mouse dug in: { x, y, at }
    const claimed = new Set();
    const effects = []; // catch puffs and "+1" texts
    let round = -1;
    let knownCatches = null;
    let knownZaps = null;
    let oldMice = 0; // mice from before the current round can't be caught any more

    const keys = new Set();
    const joy = { active: false, id: null, ox: 0, oy: 0, x: 0, y: 0 };
    let lastSent = 0;
    let sentState = "";
    let last = performance.now();
    let hintShown = true;

    $("icon-cat").src = headIcon("cat");
    $("icon-fox").src = headIcon("fox");

    // ----- game data helpers -----
    const gameData = () => room.game || {};
    const catchesOf = (r) => (gameData().catches || {})[r] || {};
    const zapsOf = (r) => (gameData().zaps || {})[r] || {}; // zombie mice that caught a player
    const idOf = (key) => Number(key.slice(1));
    function score() {
        // A zombie mouse resets its victim's score: only mice caught after it count.
        const since = { cat: 0, fox: 0 };
        for (const [key, role] of Object.entries(zapsOf(round))) if (role in since) since[role] = Math.max(since[role], idOf(key));
        const s = { cat: 0, fox: 0 };
        for (const [key, role] of Object.entries(catchesOf(round))) if (role in s && idOf(key) > since[role]) s[role] += 1;
        return s;
    }
    function winner() {
        const s = score();
        return ROLES.find((role) => s[role] >= WIN_SCORE) || null;
    }
    // The cat's device runs the mouse; if the cat is offline, the fox's does.
    function simulatorRole() {
        const online = room.online || {};
        return online.cat ? "cat" : online.fox ? "fox" : null;
    }

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

    $("again").addEventListener("click", () => {
        const r = round;
        runTransaction(ref(db, base + "/game/round"), (cur) => ((cur || 0) === r ? r + 1 : undefined)).catch(showError);
    });

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

    // ----- mouse display -----
    function showMouseState(s, id, z) {
        mouse.z = z;
        if (id !== mouse.id) {
            mouse.id = id;
            if (s === "out" || s === "graze" || s === "eat") {
                if (z) showToast("Обережно: зомбі-мишка! 🧟 Ховайся біля кущів!", 2600);
                else showToast("З'явилась мишка! 🐭", 1800);
            }
        }
        if (s === mouse.s) return;
        if (s === "gone" && mouse.s === "burrow") mound = { x: mouse.x, y: mouse.y, at: performance.now() };
        mouse.s = s;
        mouse.since = performance.now();
    }

    function onCatch(id, role) {
        const at = performance.now();
        if (id === mouse.id) {
            effects.push({ x: mouse.x, y: mouse.y - 4, at, role });
            mouse.s = "gone";
        }
        if (role === myRole) showToast("Ти спіймав мишку! +1", 1800);
        else showToast(NAME[role] + " спіймав мишку!", 1800);
    }

    function onZap(id, role) {
        if (id === mouse.id) {
            effects.push({ x: mouse.x, y: mouse.y - 4, at: performance.now(), role, zap: true });
            mouse.s = "gone";
        }
        if (role === myRole) showToast("Зомбі-мишка тебе спіймала! Твій рахунок — 0 😱", 2600);
        else showToast("Зомбі-мишка спіймала " + ACC[role] + "! Його рахунок — 0", 2600);
    }

    // ----- network -----
    function sync() {
        const players = room.players || {};
        const online = room.online || {};

        for (const role of ROLES) {
            if (role === myRole) continue;
            const p = room.pos && room.pos[role];
            if (!p) continue;
            const c = chars[role];
            c.tx = p.x;
            c.ty = p.y;
            c.d = p.d || c.d;
            c.m = Boolean(p.m);
            c.h = Boolean(p.h);
        }

        // New round: clear the score and the overlay.
        const r = gameData().round || 0;
        if (r !== round) {
            round = r;
            oldMice = mouse.id;
            claimed.clear();
            knownCatches = null;
            knownZaps = null;
            if (sim) sim.reset(serverNow());
        }

        // Catches that happened since the last update.
        const caught = catchesOf(round);
        if (knownCatches) {
            for (const key of Object.keys(caught)) if (!(key in knownCatches)) onCatch(idOf(key), caught[key]);
        }
        knownCatches = { ...caught };
        const zapped = zapsOf(round);
        if (knownZaps) {
            for (const key of Object.keys(zapped)) if (!(key in knownZaps)) onZap(idOf(key), zapped[key]);
        }
        knownZaps = { ...zapped };
        const finished = (id) => Boolean(caught["m" + id] || zapped["m" + id]);

        // Who runs the mouse.
        const amSim = myRole && simulatorRole() === myRole;
        if (amSim && !sim) {
            const nm = gameData().mouse;
            sim = new MouseSim(world, nm || { next: serverNow() + 3000 });
        } else if (!amSim && sim) {
            sim = null;
        }
        if (sim && finished(sim.m.id) && ALIVE.has(sim.m.s)) sim.caught(serverNow());

        // Mouse from the network (when another device runs it).
        const nm = gameData().mouse;
        if (!sim && nm) {
            if (nm.id !== mouse.id || Math.hypot(nm.x - mouse.x, nm.y - mouse.y) > 40) {
                mouse.x = nm.x;
                mouse.y = nm.y;
            }
            mouse.tx = nm.x;
            mouse.ty = nm.y;
            mouse.d = nm.d;
            showMouseState(finished(nm.id) ? "gone" : nm.s, nm.id, Boolean(nm.z));
        }

        // HUD
        const s = score();
        $("score-cat").textContent = s.cat;
        $("score-fox").textContent = s.fox;
        const status = $("hud-status");
        if (myRole && !online[other(myRole)]) {
            status.textContent = NAME[other(myRole)] + " не в мережі";
            status.hidden = false;
        } else if (!myRole) {
            status.textContent = "Ти глядач";
            status.hidden = false;
        } else {
            status.hidden = true;
        }

        const win = winner();
        $("win").hidden = !win;
        if (win) {
            $("win-title").textContent = win === myRole ? "Ти переміг! 🎉" : NAME[win] + " переміг!";
            $("win-score").textContent = "Кіт " + s.cat + " : " + s.fox + " Лис";
            $("again").hidden = !myRole;
            const wctx = $("win-sprite").getContext("2d");
            wctx.clearRect(0, 0, 20, 20);
            wctx.drawImage(sprites[win].down[0], 2, 2);
        }
    }

    function sendPosition(now, hidden) {
        if (!myRole) return;
        const me = chars[myRole];
        const state = { x: Math.round(me.x), y: Math.round(me.y), d: me.d, m: me.m, h: hidden };
        const key = JSON.stringify(state);
        if (key === sentState) return;
        const changedFlags = !sentState || JSON.parse(sentState).m !== state.m || JSON.parse(sentState).h !== state.h;
        if (!changedFlags && now - lastSent < SEND_EVERY) return;
        sentState = key;
        lastSent = now;
        set(posRef, state).catch(console.error);
    }

    function sendMouse(now) {
        const st = sim.state();
        const key = JSON.stringify(st);
        if (key === simSent) return;
        const stateChanged = !simSent || JSON.parse(simSent).s !== st.s;
        if (!stateChanged && now - simLastSent < SEND_EVERY) return;
        simSent = key;
        simLastSent = now;
        set(mouseRef, st).catch(console.error);
    }

    // ----- simulation -----
    function tick(now) {
        // The first animation frame can be stamped slightly before `last`.
        const dt = Math.max(0, Math.min(0.05, (now - last) / 1000));
        last = now;
        const players = room.players || {};
        const online = room.online || {};
        let myHidden = false;

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
            // Hiding takes a moment: stand still next to cover. Running past a bush doesn't count.
            const nearCover = inCover(world, me.x, me.y);
            if (!nearCover) {
                myCover = false;
                coverStill = 0;
            } else if (!myCover) {
                coverStill = me.m ? 0 : coverStill + dt;
                if (coverStill >= HIDE_TIME) myCover = true;
            }
            if (myCover) lastCover = now;
            myHidden = now - lastCover < AMBUSH_MS;
            me.h = myHidden;
            sendPosition(now, myHidden);

            const stealth = $("stealth");
            if (myHidden && hintShown) {
                hintShown = false;
                $("touch-hint").classList.add("gone");
            }
            if (nearCover && !myCover) {
                stealth.textContent = "🌿 Зупинись, щоб сховатися";
                stealth.hidden = false;
            } else if (myCover) {
                stealth.textContent = "🌿 Ти в укритті — мишка тебе не бачить";
                stealth.hidden = false;
            } else if (myHidden) {
                stealth.textContent = "🐾 Засідка: ще " + ((AMBUSH_MS - (now - lastCover)) / 1000).toFixed(1) + " с";
                stealth.hidden = false;
            } else {
                stealth.hidden = true;
            }
        }

        for (const role of ROLES) {
            const c = chars[role];
            if (role !== myRole) follow(c, dt, 80);
            c.t += dt;
        }

        // The mouse
        if (sim) {
            const seen = ROLES
                .filter((role) => players[role] && (role === myRole || online[role]))
                .map((role) => role === myRole
                    ? { x: chars[role].x, y: chars[role].y, hidden: myHidden }
                    : { x: chars[role].tx, y: chars[role].ty, hidden: chars[role].h });
            sim.step(dt, serverNow(), seen, Boolean(winner()));
            mouse.x = sim.m.x;
            mouse.y = sim.m.y;
            mouse.d = sim.m.d;
            showMouseState(sim.m.s, sim.m.id, sim.m.z);
            sendMouse(now);
        } else {
            follow(mouse, dt, 40);
        }
        mouse.t += dt;

        // Catching: just bump into the mouse. A zombie mouse bumping into you catches *you* —
        // unless you're hidden. Each player checks this on their own device, where hiding is exact.
        if (myRole && ALIVE.has(mouse.s) && mouse.id > oldMice && !winner() && !claimed.has(mouse.id)) {
            const me = chars[myRole];
            const touching = Math.hypot(me.x - mouse.x, me.y - mouse.y) < CATCH_DIST;
            if (touching && (!mouse.z || !myHidden)) {
                const id = mouse.id;
                claimed.add(id);
                const list = mouse.z ? "/game/zaps/" : "/game/catches/";
                runTransaction(ref(db, base + list + round + "/m" + id), (cur) => (cur === null ? myRole : undefined))
                    .catch(console.error);
            }
        }

        draw(now);
        requestAnimationFrame(tick);
    }

    function follow(c, dt, snap) {
        const dist = Math.hypot(c.tx - c.x, c.ty - c.y);
        if (dist > snap) {
            c.x = c.tx;
            c.y = c.ty;
        } else {
            const k = 1 - Math.exp(-dt * 12);
            c.x += (c.tx - c.x) * k;
            c.y += (c.ty - c.y) * k;
        }
    }

    // ----- rendering -----
    function drawMouse(now) {
        const mouseSprites = mouse.z ? zombieSprites : normalSprites;
        const x = Math.round(mouse.x);
        const y = Math.round(mouse.y);
        const dir = mouse.d || "down";
        if (mouse.s === "burrow") {
            const p = Math.min(1, (now - mouse.since) / 800);
            drawHole(x, y);
            const sink = Math.round(p * 9);
            if (sink < 10) {
                const spr = mouseSprites[dir][Math.floor(now / 80) % 2 + 1];
                ctx.drawImage(spr, 0, 0, 13, 10 - sink, x - 6, y - 8 + sink, 13, 10 - sink);
            }
            // flying bits of earth
            ctx.fillStyle = "#7a5432";
            for (let i = 0; i < 4; i++) {
                const a = (i / 4) * Math.PI * 2 + now / 200;
                ctx.fillRect(x + Math.round(Math.cos(a) * 6 * p), y - 2 - Math.round(Math.abs(Math.sin(a)) * 5 * p), 1, 1);
            }
            return;
        }
        ctx.fillStyle = "rgba(20, 40, 10, 0.3)";
        ctx.fillRect(x - 3, y - 1, 7, 2);
        let frame = 0;
        let bob = 0;
        if (mouse.s === "eat") bob = Math.floor(now / 220) % 2;
        if (mouse.s === "graze" || mouse.s === "out") frame = frameIndex(true, mouse.t);
        if (mouse.s === "flee") frame = frameIndex(true, mouse.t * 2);
        if (mouse.s === "hunt") frame = frameIndex(true, mouse.t * 1.5);
        ctx.drawImage(mouseSprites[dir][frame], x - 6, y - 8 + bob);
        if ((mouse.s === "flee" || mouse.s === "hunt") && now - mouse.since < 900 && Math.floor(now / 120) % 2 === 0) {
            // "!" — the mouse noticed someone (red: a zombie mouse goes hunting)
            ctx.fillStyle = OUTLINE;
            ctx.fillRect(x - 1, y - 19, 3, 8);
            ctx.fillStyle = mouse.s === "hunt" ? "#ff3030" : "#ffffff";
            ctx.fillRect(x, y - 18, 1, 4);
            ctx.fillRect(x, y - 13, 1, 1);
        }
    }

    function drawHole(x, y) {
        ctx.fillStyle = OUTLINE;
        ctx.fillRect(x - 4, y - 2, 9, 3);
        ctx.fillRect(x - 3, y - 3, 7, 5);
        ctx.fillStyle = "#4a3220";
        ctx.fillRect(x - 3, y - 2, 7, 3);
    }

    function drawMound(now) {
        if (!mound) return;
        const age = now - mound.at;
        if (age > 3000) { mound = null; return; }
        const x = Math.round(mound.x);
        const y = Math.round(mound.y);
        ctx.globalAlpha = Math.min(1, (3000 - age) / 600);
        ctx.fillStyle = OUTLINE;
        ctx.fillRect(x - 4, y - 3, 9, 4);
        ctx.fillRect(x - 3, y - 4, 7, 1);
        ctx.fillStyle = "#8a6038";
        ctx.fillRect(x - 3, y - 3, 7, 3);
        ctx.fillStyle = "#a87a4a";
        ctx.fillRect(x - 2, y - 3, 3, 1);
        ctx.globalAlpha = 1;
    }

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
        drawMound(now);

        // Draw props and characters from back to front so trees can hide whoever walks behind them.
        const players = room.players || {};
        const online = room.online || {};
        const visibleChars = ROLES.filter((role) => players[role]).map((role) => chars[role]);
        const items = world.props
            .filter((p) => p.x < camX + viewW && p.x + p.img.width > camX && p.y < camY + viewH && p.y + p.img.height > camY)
            .concat(visibleChars.map((c) => ({ char: c, base: c.y })));
        if (ALIVE.has(mouse.s) || mouse.s === "burrow") items.push({ mouse: true, base: mouse.y });
        items.sort((a, b) => a.base - b.base);

        for (const item of items) {
            if (item.mouse) {
                drawMouse(now);
                continue;
            }
            if (!item.char) {
                ctx.drawImage(item.img, item.x, item.y);
                continue;
            }
            const c = item.char;
            const x = Math.round(c.x);
            const y = Math.round(c.y);
            let alpha = 1;
            if (c.role !== myRole && !online[c.role]) alpha = 0.4;
            else if (c.role === myRole ? myCover : c.h) alpha = 0.6;
            ctx.globalAlpha = alpha;
            ctx.fillStyle = "rgba(20, 40, 10, 0.3)";
            ctx.fillRect(x - 5, y - 1, 10, 2);
            ctx.fillRect(x - 4, y - 2, 8, 4);
            ctx.drawImage(sprites[c.role][c.d][frameIndex(c.m, c.t)], x - 8, y - 15);
            ctx.globalAlpha = 1;
        }

        // Catch puffs
        for (let i = effects.length - 1; i >= 0; i--) {
            const e = effects[i];
            const age = (now - e.at) / 1000;
            if (age > 1.2) { effects.splice(i, 1); continue; }
            if (age < 0.5) {
                ctx.fillStyle = e.zap ? "#ff3030" : "#ffffff";
                for (let k = 0; k < 8; k++) {
                    const a = (k / 8) * Math.PI * 2;
                    const r = 3 + age * 22;
                    ctx.fillRect(Math.round(e.x + Math.cos(a) * r), Math.round(e.y + Math.sin(a) * r * 0.7), 2, 2);
                }
            }
        }

        // A small bouncing arrow above "me", and the ambush timer under it.
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
            if (me.h) {
                const left = myCover ? 1 : Math.max(0, 1 - (now - lastCover) / AMBUSH_MS);
                const by = Math.round(me.y) - 26;
                ctx.fillStyle = OUTLINE;
                ctx.fillRect(x - 7, by, 15, 3);
                ctx.fillStyle = "#7cc451";
                ctx.fillRect(x - 6, by + 1, Math.round(13 * left), 1);
            }
        }

        // Screen-space overlays
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const cssW = cw / dpr;
        const cssH = ch / dpr;
        const toScreen = (wx, wy) => ({ x: ((wx - camX) * scale) / dpr, y: ((wy - camY) * scale) / dpr });

        ctx.textAlign = "center";
        ctx.font = "800 18px system-ui, sans-serif";
        ctx.lineWidth = 4;
        ctx.strokeStyle = OUTLINE;
        for (const e of effects) {
            const age = (now - e.at) / 1000;
            const p = toScreen(e.x, e.y);
            ctx.globalAlpha = Math.max(0, 1 - age / 1.2);
            const label = e.zap ? "0!" : "+1";
            ctx.strokeText(label, p.x, p.y - 18 - age * 30);
            ctx.fillStyle = e.zap ? "#ff4a4a" : e.role === "fox" ? "#ffb072" : "#e3e6f0";
            ctx.fillText(label, p.x, p.y - 18 - age * 30);
        }
        ctx.globalAlpha = 1;

        // Where is the mouse? An arrow at the screen edge when it's out of view.
        if (ALIVE.has(mouse.s)) {
            const m = toScreen(mouse.x, mouse.y - 4);
            const margin = 30;
            if (m.x < 0 || m.y < 0 || m.x > cssW || m.y > cssH) {
                const cx = cssW / 2;
                const cy = cssH / 2;
                let dx = m.x - cx;
                let dy = m.y - cy;
                const len = Math.hypot(dx, dy) || 1;
                dx /= len;
                dy /= len;
                const top = 84;
                const tx = dx > 0 ? (cssW - margin - cx) / dx : dx < 0 ? (margin - cx) / dx : Infinity;
                const ty = dy > 0 ? (cssH - margin - cy) / dy : dy < 0 ? (top - cy) / dy : Infinity;
                const t = Math.min(tx, ty);
                const px = cx + dx * t;
                const py = cy + dy * t;
                const r = 16;
                // pointer (red-rimmed for a zombie mouse)
                ctx.fillStyle = "#ffffff";
                ctx.strokeStyle = mouse.z ? "#d42020" : OUTLINE;
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(px + dx * (r + 10), py + dy * (r + 10));
                ctx.lineTo(px + dx * r - dy * 7, py + dy * r + dx * 7);
                ctx.lineTo(px + dx * r + dy * 7, py + dy * r - dx * 7);
                ctx.closePath();
                ctx.fill();
                ctx.stroke();
                // badge with the mouse face
                ctx.beginPath();
                ctx.arc(px, py, r, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();
                ctx.imageSmoothingEnabled = false;
                ctx.drawImage((mouse.z ? zombieSprites : normalSprites).down[0], 0, 0, 13, 9, px - 13, py - 10, 26, 18);
            }
        }

        // Touch joystick
        if (joy.active) {
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
    if (myRole) showToast("Лови мишок! Ховайся біля кущів і дерев — звідти мишка тебе не бачить. Хто перший спіймає 5, той переміг.", 7000);
    if (TESTING) {
        // Hooks for automated tests only.
        window.__game = {
            chars, mouse, world,
            get sim() { return sim; },
            teleport(x, y) { Object.assign(chars[myRole], { x, y }); },
            get hidden() { return chars[myRole].h; },
            get cover() { return myCover; },
            ambush() { lastCover = performance.now(); }
        };
    }
    sync();
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
