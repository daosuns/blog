// Mouse behaviour. Exactly one player's device runs this simulation and shares
// the result through the database, so both players see the same mouse.
import { blocked, moveWithCollisions } from "./world.js";

export const WIN_SCORE = 5;
export const AMBUSH_MS = 3000; // after leaving cover the mouse still can't see you for this long
export const CATCH_DIST = 9;

const VISION = 72; // how far a mouse notices a visible cat or fox
const SPAWN_MIN_DIST = 130; // never appear this close to a player
const GRAZE_SPEED = 14;
const FLEE_SPEED = 136; // twice as fast as the cat and the fox: an open chase never works
const OUT_SPEED = 30;
const CALM_AFTER = 1.8; // seconds without seeing anyone before the mouse calms down
const BURROW_TIME = 0.8;
const MAX_CHASE = 6; // chased this long, the mouse gives up running and digs in
const BOX_W = 6;
const BOX_H = 3;

// States shared over the network:
//   out    – popping out from behind a rock
//   graze  – walking around calmly
//   eat    – standing still, nibbling
//   flee   – saw a cat or a fox and runs away
//   burrow – nowhere left to run, digging into the ground
//   gone   – no mouse right now; a new one appears at `next` (server time, ms)
export const ALIVE = new Set(["out", "graze", "eat", "flee"]);

const dirOf = (dx, dy) => (Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up"));
const free = (world, x, y) => !blocked(world, x, y, BOX_W, BOX_H);

export class MouseSim {
    constructor(world, state) {
        this.world = world;
        this.m = { id: 0, x: 0, y: 0, d: "down", s: "gone", next: 0, ...state };
        this.timer = 0; // seconds spent in the current state / sub-step
        this.goal = null; // { x, y } for "out"
        this.heading = { x: 0, y: 0 };
        this.calm = 0;
        this.pause = 1;
        this.walkFor = 1;
        // Taking over from another device mid-way: "out" needs a goal we don't have.
        if (this.m.s === "out") this.m.s = "eat";
    }

    state() {
        const { id, x, y, d, s, next } = this.m;
        return { id, x: Math.round(x), y: Math.round(y), d, s, next: Math.round(next) };
    }

    // The mouse was caught: remove it and schedule the next one.
    caught(now) {
        this.set("gone");
        this.m.next = now + 2500 + Math.random() * 2500;
    }

    // A new round starts: clear the meadow, first mouse soon.
    reset(now) {
        this.set("gone");
        this.m.next = now + 2500;
    }

    set(s) {
        this.m.s = s;
        this.timer = 0;
    }

    // players: [{ x, y, hidden }]; now: server time in ms; paused: someone already won
    step(dt, now, players, paused) {
        const m = this.m;
        this.timer += dt;

        if (m.s === "gone") {
            if (!paused && now >= m.next) this.spawn(players);
            return;
        }
        if (paused) {
            // Somebody has won: the mouse runs off until the next round.
            this.set("gone");
            return;
        }
        if (m.s === "burrow") {
            if (this.timer >= BURROW_TIME) {
                this.set("gone");
                m.next = now + 3000 + Math.random() * 3000;
            }
            return;
        }

        const threat = this.nearestThreat(players);
        if (threat) {
            if (m.s !== "flee") this.set("flee");
            this.calm = 0;
            if (this.timer > MAX_CHASE) this.set("burrow");
            else this.flee(dt, threat);
            return;
        }
        if (m.s === "flee") {
            this.calm += dt;
            if (this.calm < CALM_AFTER) {
                // keep running a bit in the same direction
                this.run(dt, this.heading.x, this.heading.y, FLEE_SPEED * 0.6);
                return;
            }
            this.set("eat");
        }

        if (m.s === "out") {
            const dx = this.goal.x - m.x;
            const dy = this.goal.y - m.y;
            const dist = Math.hypot(dx, dy);
            if (dist < 1 || this.timer > 1.5) {
                this.set("eat");
                this.pause = 0.6 + Math.random() * 1.2;
                return;
            }
            this.run(dt, dx / dist, dy / dist, OUT_SPEED);
            return;
        }
        if (m.s === "eat") {
            if (this.timer >= (this.pause ?? 1.5)) this.startWandering();
            return;
        }
        if (m.s === "graze") {
            if (this.timer >= this.walkFor || !this.run(dt, this.heading.x, this.heading.y, GRAZE_SPEED)) {
                this.set("eat");
                this.pause = 1 + Math.random() * 2;
            }
        }
    }

    startWandering() {
        const m = this.m;
        for (let i = 0; i < 8; i++) {
            const a = Math.random() * Math.PI * 2;
            const hx = Math.cos(a);
            const hy = Math.sin(a);
            if (free(this.world, m.x + hx * 10, m.y + hy * 10)) {
                this.heading = { x: hx, y: hy };
                this.walkFor = 0.6 + Math.random() * 1.4;
                this.set("graze");
                return;
            }
        }
        this.set("eat");
        this.pause = 1;
    }

    nearestThreat(players) {
        let best = null;
        let bestDist = VISION;
        for (const p of players) {
            if (p.hidden) continue;
            const dist = Math.hypot(p.x - this.m.x, p.y - this.m.y);
            if (dist < bestDist) {
                best = p;
                bestDist = dist;
            }
        }
        return best;
    }

    flee(dt, threat) {
        const m = this.m;
        let ax = m.x - threat.x;
        let ay = m.y - threat.y;
        const len = Math.hypot(ax, ay) || 1;
        ax /= len;
        ay /= len;
        // Run away; veer a little around obstacles, but never sideways towards the threat.
        for (const deg of [0, 20, -20, 40, -40, 60, -60]) {
            const r = (deg * Math.PI) / 180;
            const hx = ax * Math.cos(r) - ay * Math.sin(r);
            const hy = ax * Math.sin(r) + ay * Math.cos(r);
            if (free(this.world, m.x + hx * 12, m.y + hy * 12)) {
                this.heading = { x: hx, y: hy };
                this.run(dt, hx, hy, FLEE_SPEED);
                return;
            }
        }
        // Cornered: dig into the ground and disappear.
        this.set("burrow");
    }

    // Returns false when the mouse couldn't move at all.
    run(dt, hx, hy, speed) {
        const m = this.m;
        const next = moveWithCollisions(this.world, m.x, m.y, hx * speed * dt, hy * speed * dt, BOX_W, BOX_H);
        const moved = next.x !== m.x || next.y !== m.y;
        m.x = next.x;
        m.y = next.y;
        if (moved) m.d = dirOf(hx, hy);
        return moved;
    }

    // Pops out from behind a rock that is far from both players.
    spawn(players) {
        const world = this.world;
        const farFromPlayers = (x, y) => players.every((p) => Math.hypot(p.x - x, p.y - y) > SPAWN_MIN_DIST);
        const rocks = world.rocks.slice().sort(() => Math.random() - 0.5);
        for (const rock of rocks) {
            const start = { x: rock.x, y: rock.y - 6 }; // just behind the rock
            if (!farFromPlayers(start.x, start.y) || !free(world, start.x, start.y)) continue;
            const exits = [[0, -16], [16, -4], [-16, -4], [12, -14], [-12, -14]].sort(() => Math.random() - 0.5);
            const exit = exits.find(([dx, dy]) => free(world, start.x + dx, start.y + dy));
            if (!exit) continue;
            this.place(start, { x: start.x + exit[0], y: start.y + exit[1] });
            return;
        }
        // No suitable rock — appear in the grass somewhere far away.
        for (let i = 0; i < 200; i++) {
            const x = 60 + Math.random() * 520;
            const y = 80 + Math.random() * 360;
            if (free(world, x, y) && farFromPlayers(x, y)) {
                this.place({ x, y }, { x, y });
                return;
            }
        }
    }

    place(start, goal) {
        const m = this.m;
        m.id += 1;
        m.x = start.x;
        m.y = start.y;
        m.d = dirOf(goal.x - start.x, goal.y - start.y || 1);
        this.goal = goal;
        this.calm = 0;
        this.set("out");
    }
}
