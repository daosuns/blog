// The meadow: layout, collisions and the pre-rendered ground layer.
import { rng, buildGrassTiles, buildFlowers, buildTree, buildBush, buildRock } from "./sprites.js";

export const TILE = 16;
export const WORLD_W = 40 * TILE;
export const WORLD_H = 30 * TILE;

// Player "feet" box used for collisions, relative to the feet point (x, y).
const FEET_W = 10;
const FEET_H = 5;
const EDGE = 28; // players can't walk into the forest around the meadow

export const SPAWN = {
    cat: { x: WORLD_W / 2 - 20, y: WORLD_H / 2 + 8 },
    fox: { x: WORLD_W / 2 + 20, y: WORLD_H / 2 + 8 }
};

const POND = { x: 470, y: 330, rx: 62, ry: 38 };

function inPond(x, y, k = 1) {
    return ((x - POND.x) / (POND.rx * k)) ** 2 + ((y - POND.y) / (POND.ry * k)) ** 2 <= 1;
}

export function buildWorld() {
    const rand = rng(42);
    const treeImgs = [buildTree(1), buildTree(2), buildTree(3)];
    const bushImgs = [buildBush(4), buildBush(5)];
    const rockImgs = [buildRock(6), buildRock(7)];
    const props = []; // drawable things that can hide players: { img, x, y, base }
    const solids = []; // collision rectangles: { x, y, w, h }

    const center = { x: WORLD_W / 2, y: WORLD_H / 2 };
    const free = (x, y, r) =>
        Math.hypot(x - center.x, y - center.y) > 80 &&
        !inPond(x, y, 1.5) &&
        props.every((p) => Math.hypot(p.cx - x, p.base - y) > r);

    function addTree(x, y, solid = true) {
        // (x, y) — the bottom-center of the trunk
        const img = treeImgs[Math.floor(rand() * treeImgs.length)];
        props.push({ img, x: Math.round(x - 16), y: Math.round(y - 39), base: y, cx: x });
        if (solid) solids.push({ x: x - 5, y: y - 7, w: 10, h: 7 });
    }

    // Forest around the meadow: two staggered rows on every side.
    for (let x = -8; x < WORLD_W + 16; x += 22) {
        addTree(x + rand() * 6, 34 + rand() * 4, false);
        addTree(x + 11 + rand() * 6, 18 + rand() * 4, false);
        addTree(x + rand() * 6, WORLD_H + 10 + rand() * 4, false);
        addTree(x + 11 + rand() * 6, WORLD_H - 6 + rand() * 4, false);
    }
    for (let y = 30; y < WORLD_H; y += 24) {
        addTree(4 + rand() * 4, y + rand() * 6, false);
        addTree(-10 + rand() * 4, y + 12 + rand() * 6, false);
        addTree(WORLD_W - 4 - rand() * 4, y + rand() * 6, false);
        addTree(WORLD_W + 10 - rand() * 4, y + 12 + rand() * 6, false);
    }

    const scatter = (count, minDist, place) => {
        for (let i = 0, tries = 0; i < count && tries < 500; tries++) {
            const x = EDGE + 20 + rand() * (WORLD_W - 2 * EDGE - 40);
            const y = EDGE + 40 + rand() * (WORLD_H - 2 * EDGE - 50);
            if (!free(x, y, minDist)) continue;
            place(x, y);
            i++;
        }
    };
    scatter(9, 44, (x, y) => addTree(x, y));
    scatter(10, 26, (x, y) => {
        const img = bushImgs[Math.floor(rand() * bushImgs.length)];
        props.push({ img, x: Math.round(x - 9), y: Math.round(y - 13), base: y, cx: x });
        solids.push({ x: x - 7, y: y - 6, w: 14, h: 6 });
    });
    scatter(8, 22, (x, y) => {
        const img = rockImgs[Math.floor(rand() * rockImgs.length)];
        props.push({ img, x: Math.round(x - 7), y: Math.round(y - 10), base: y, cx: x });
        solids.push({ x: x - 5, y: y - 5, w: 10, h: 5 });
    });

    const ground = renderGround(rand, props);
    props.sort((a, b) => a.base - b.base);
    return { ground, props, solids };
}

function renderGround(rand, props) {
    const canvas = document.createElement("canvas");
    canvas.width = WORLD_W;
    canvas.height = WORLD_H;
    const ctx = canvas.getContext("2d");
    const grass = buildGrassTiles();
    for (let ty = 0; ty < WORLD_H / TILE; ty++) {
        for (let tx = 0; tx < WORLD_W / TILE; tx++) {
            ctx.drawImage(grass[Math.floor(rand() * grass.length)], tx * TILE, ty * TILE);
        }
    }

    // Pond with a sandy shore
    const img = ctx.getImageData(0, 0, WORLD_W, WORLD_H);
    const put = (x, y, hex) => {
        const i = (y * WORLD_W + x) * 4;
        img.data[i] = parseInt(hex.slice(1, 3), 16);
        img.data[i + 1] = parseInt(hex.slice(3, 5), 16);
        img.data[i + 2] = parseInt(hex.slice(5, 7), 16);
    };
    for (let y = POND.y - POND.ry - 6; y <= POND.y + POND.ry + 6; y++) {
        for (let x = POND.x - POND.rx - 6; x <= POND.x + POND.rx + 6; x++) {
            const d = Math.sqrt(((x + 0.5 - POND.x) / POND.rx) ** 2 + ((y + 0.5 - POND.y) / POND.ry) ** 2);
            if (d <= 0.86) put(x, y, d < 0.55 ? "#3b7fc4" : "#4a95d6");
            else if (d <= 0.93) put(x, y, "#8fd0f0");
            else if (d <= 1.0) put(x, y, "#2b2433");
            else if (d <= 1.09) put(x, y, (x + y) % 5 === 0 ? "#c9b178" : "#dcc68e");
        }
    }
    ctx.putImageData(img, 0, 0);
    // ripples and lily pads
    ctx.fillStyle = "#a9def5";
    for (let i = 0; i < 7; i++) {
        const x = POND.x - 40 + Math.floor(rand() * 80);
        const y = POND.y - 20 + Math.floor(rand() * 40);
        if (inPond(x, y, 0.75)) ctx.fillRect(x, y, 3 + Math.floor(rand() * 3), 1);
    }
    for (const [x, y] of [[POND.x - 30, POND.y + 8], [POND.x + 22, POND.y - 14], [POND.x + 34, POND.y + 12]]) {
        ctx.fillStyle = "#2b2433";
        ctx.fillRect(x - 1, y - 1, 8, 6);
        ctx.fillStyle = "#4f9a3a";
        ctx.fillRect(x, y, 6, 4);
        ctx.fillStyle = "#3b7fc4";
        ctx.fillRect(x + 3, y, 1, 2);
    }

    // Flowers
    const flowers = buildFlowers();
    for (let i = 0; i < 140; i++) {
        const x = Math.floor(rand() * (WORLD_W - 8)) + 2;
        const y = Math.floor(rand() * (WORLD_H - 8)) + 2;
        if (inPond(x, y, 1.15)) continue;
        ctx.drawImage(flowers[Math.floor(rand() * flowers.length)], x, y);
    }

    // Soft shadows under props
    ctx.fillStyle = "rgba(20, 40, 10, 0.28)";
    for (const p of props) {
        const w = p.img.width >= 32 ? 22 : p.img.width - 2;
        ctx.beginPath();
        ctx.ellipse(p.cx, p.base - 1, w / 2, 3, 0, 0, Math.PI * 2);
        ctx.fill();
    }
    return canvas;
}

export function blocked(world, x, y) {
    const left = x - FEET_W / 2;
    const top = y - FEET_H;
    if (left < EDGE || left + FEET_W > WORLD_W - EDGE || top < EDGE + 22 || y > WORLD_H - EDGE) return true;
    for (const s of world.solids) {
        if (left < s.x + s.w && left + FEET_W > s.x && top < s.y + s.h && y > s.y) return true;
    }
    const corners = [[left, top], [left + FEET_W, top], [left, y], [left + FEET_W, y]];
    return corners.some(([cx, cy]) => inPond(cx, cy, 0.95));
}

// Moves (x, y) by (dx, dy), sliding along obstacles.
export function moveWithCollisions(world, x, y, dx, dy) {
    if (dx && !blocked(world, x + dx, y)) x += dx;
    if (dy && !blocked(world, x, y + dy)) y += dy;
    return { x, y };
}
