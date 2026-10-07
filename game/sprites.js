// Pixel-art sprites. Characters are drawn as fill-only pixel maps;
// the dark outline is added automatically around every filled shape.

const OUTLINE = "#2b2433";

const CHARACTERS = {
    cat: {
        palette: { g: "#a3a8bb", G: "#767c92", w: "#f5f1e8", p: "#f2a0b0", e: OUTLINE },
        down: [
            "................",
            "................",
            "...p........p...",
            "...gp......pg...",
            "...ggggGGgggg...",
            "..gggggggggggg..",
            "..ggeggggggegg..",
            "..ggeggggggegg..",
            "..ggggwppwgggg..",
            "...ggwwwwwwgg...",
            ".....gggggg..g..",
            ".....gwwwwg..g..",
            "....ggwwwwgggg..",
            "....gggggggg....",
            ".....gg..gg.....",
            "................"
        ],
        up: [
            "................",
            "................",
            "...g........g...",
            "...gg......gg...",
            "...gggggggggg...",
            "..gggggggggggg..",
            "..gggGGGGGGggg..",
            "..gggggggggggg..",
            "..gggGGGGGGggg..",
            "...gggggggggg...",
            ".....gggggg..g..",
            ".....ggGGgg..g..",
            "....gggggggggg..",
            "....ggGGGGgg....",
            ".....gg..gg.....",
            "................"
        ],
        right: [
            "................",
            "................",
            ".........p..p...",
            ".........gggg...",
            "........gggggg..",
            "........gGGggeg.",
            "........ggggggpg",
            ".g......gggwwww.",
            ".g.......gwwww..",
            ".gg..gggggg.....",
            "..gggGgGgggw....",
            "...gggggggww....",
            "....gggggggg....",
            "....g.g..g.g....",
            "....g.g..g.g....",
            "................"
        ],
        walk: {
            down: [{ 14: ".....gg........." }, { 14: ".........gg....." }],
            up: [{ 14: ".....gg........." }, { 14: ".........gg....." }],
            right: [
                { 13: "....g..g.g..g...", 14: "...g....g....g.." },
                { 13: ".....gg...gg....", 14: ".....gg...gg...." }
            ]
        }
    },
    fox: {
        palette: { o: "#ee7d2f", O: "#c45c1d", w: "#fbf5ea", d: "#3a2b30", e: OUTLINE },
        down: [
            "................",
            "...d........d...",
            "...dd......dd...",
            "...owo....owo...",
            "...oooooooooo...",
            "..oooooooooooo..",
            "..ooeooooooeoo..",
            "..wweooooooeww..",
            "..wwwoooooowww..",
            "...wwwwddwwww...",
            ".....wwwwww.....",
            ".....owwwwo.oo..",
            "....oowwwwooOow.",
            "....oooooooo.ww.",
            ".....dd..dd.....",
            "................"
        ],
        up: [
            "................",
            "...d........d...",
            "...dd......dd...",
            "...oo......oo...",
            "...oooooooooo...",
            "..oooooooooooo..",
            "..oooooooooooo..",
            "..oooooooooooo..",
            "..wooooooooooow.",
            "...oooooooooo...",
            ".....oooooo.....",
            ".....oOOOOo.....",
            "....oOOOOOOo....",
            "....oOOOOOOo....",
            ".....dwwwwd.....",
            "......wwww......"
        ],
        right: [
            "................",
            ".........d..d...",
            ".........o..o...",
            ".........oooo...",
            "........oooooo..",
            "........ooooeo..",
            "........ooooooo.",
            "oo......wwwwwwd.",
            "ooo......wwww...",
            "Oooo.oooooo.....",
            ".OOoooooooow....",
            "..wOoooooow.....",
            "....oooooooo....",
            "....d.d..d.d....",
            "....d.d..d.d....",
            "................"
        ],
        walk: {
            down: [{ 14: ".....dd........." }, { 14: ".........dd....." }],
            up: [{ 14: ".....dwwwwd.....", 15: "......wwww......" }, { 14: ".....dwwwwd.....", 15: "......wwww......" }],
            right: [
                { 13: "....d..d.d..d...", 14: "...d....d....d.." },
                { 13: ".....dd...dd....", 14: ".....dd...dd...." }
            ]
        }
    }
};

function drawPixels(rows, palette) {
    const h = rows.length;
    const w = rows[0].length;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    const filled = (x, y) => x >= 0 && y >= 0 && x < w && y < h && rows[y][x] !== ".";
    for (let y = 0; y < h; y++) {
        if (rows[y].length !== w) throw new Error("Sprite row " + y + " has wrong length");
        for (let x = 0; x < w; x++) {
            const ch = rows[y][x];
            let color = null;
            if (ch !== ".") color = palette[ch];
            else if (filled(x - 1, y) || filled(x + 1, y) || filled(x, y - 1) || filled(x, y + 1)) color = OUTLINE;
            if (color) {
                ctx.fillStyle = color;
                ctx.fillRect(x, y, 1, 1);
            }
        }
    }
    return canvas;
}

function mirror(canvas) {
    const out = document.createElement("canvas");
    out.width = canvas.width;
    out.height = canvas.height;
    const ctx = out.getContext("2d");
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(canvas, 0, 0);
    return out;
}

function withRows(rows, overrides) {
    return rows.map((row, i) => overrides[i] ?? row);
}

// Returns { cat: { down: [stand, walkA, walkB], up: [...], right: [...], left: [...] }, fox: ... }
export function buildCharacterSprites() {
    const result = {};
    for (const [name, def] of Object.entries(CHARACTERS)) {
        const frames = {};
        for (const dir of ["down", "up", "right"]) {
            frames[dir] = [
                drawPixels(def[dir], def.palette),
                drawPixels(withRows(def[dir], def.walk[dir][0]), def.palette),
                drawPixels(withRows(def[dir], def.walk[dir][1]), def.palette)
            ];
        }
        frames.left = frames.right.map(mirror);
        result[name] = frames;
    }
    return result;
}

// Walk cycle: stand → A → stand → B
export function frameIndex(moving, time) {
    if (!moving) return 0;
    return [1, 0, 2, 0][Math.floor(time * 8) % 4];
}

// ---------- Mouse ----------

const MOUSE = {
    palette: { m: "#b8a48e", M: "#94806c", p: "#f4a6b6", P: "#e07f95", w: "#efe6da", e: OUTLINE },
    down: [
        ".............",
        "..ppp...ppp..",
        "..pPp...pPp..",
        "..ppmmmmmpp..",
        "...mmmmmmm...",
        "...memmmem...",
        "...mmmpmmm...",
        "....mwwwm....",
        "....m...m....",
        "............."
    ],
    up: [
        ".............",
        "..ppp...ppp..",
        "..pPp...pPp..",
        "..ppmmmmmpp..",
        "...mmmmmmm...",
        "...mmMMMmm...",
        "...mmmmmmm...",
        "....m.p.m....",
        "......p......",
        "............."
    ],
    right: [
        ".............",
        ".............",
        ".......ppp...",
        "....mmmpPpm..",
        "...mmmmmmmem.",
        "p.mmmmmmmmmp.",
        ".pmmmmmmwww..",
        "...m....m....",
        ".............",
        "............."
    ],
    walk: {
        down: [{ 8: "....m........" }, { 8: "........m...." }],
        up: [{ 7: "....m.p......" }, { 7: "......p.m...." }],
        right: [{ 7: "..m......m..." }, { 7: "....m..m....." }]
    }
};

// The zombie mouse: same shape, black fur and glowing red eyes.
const ZOMBIE_PALETTE = { m: "#423c4c", M: "#2f2a37", p: "#5e4a58", P: "#9b2f3f", w: "#5f5868", e: "#ff3030" };

// { down: [stand, runA, runB], up, right, left } — 13×10 pixels, feet on row 8.
export function buildMouseSprites(zombie = false) {
    const palette = zombie ? ZOMBIE_PALETTE : MOUSE.palette;
    const frames = {};
    for (const dir of ["down", "up", "right"]) {
        frames[dir] = [
            drawPixels(MOUSE[dir], palette),
            drawPixels(withRows(MOUSE[dir], MOUSE.walk[dir][0]), palette),
            drawPixels(withRows(MOUSE[dir], MOUSE.walk[dir][1]), palette)
        ];
    }
    frames.left = frames.right.map(mirror);
    return frames;
}

// ---------- Scenery ----------

// Small deterministic random generator so every player sees the same meadow.
export function rng(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function canvasOf(w, h, draw) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    draw(c.getContext("2d"));
    return c;
}

const px = (ctx, color, x, y, w = 1, h = 1) => {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
};

export const GRASS = "#62a83c";

export function buildGrassTiles(count = 4) {
    const tiles = [];
    for (let i = 0; i < count; i++) {
        const rand = rng(1000 + i);
        tiles.push(canvasOf(16, 16, (ctx) => {
            px(ctx, GRASS, 0, 0, 16, 16);
            for (let k = 0; k < 10; k++) px(ctx, "#57993a", Math.floor(rand() * 16), Math.floor(rand() * 16));
            for (let k = 0; k < 2 + Math.floor(rand() * 2); k++) {
                // little "v" tuft
                const x = 1 + Math.floor(rand() * 13);
                const y = 2 + Math.floor(rand() * 12);
                px(ctx, "#4b8a33", x, y);
                px(ctx, "#4b8a33", x + 2, y);
                px(ctx, "#4b8a33", x + 1, y + 1);
                px(ctx, "#7fc451", x + 1, y);
            }
        }));
    }
    return tiles;
}

export function buildFlowers() {
    const colors = [["#ffffff", "#f6d743"], ["#f7a8c4", "#fff3a0"], ["#ffe066", "#e08a1e"], ["#b9a6ff", "#fff3a0"]];
    return colors.map(([petal, center]) => canvasOf(5, 5, (ctx) => {
        px(ctx, "#3f7d2b", 2, 3, 1, 2);
        px(ctx, petal, 1, 1, 3, 1);
        px(ctx, petal, 2, 0, 1, 3);
        px(ctx, center, 2, 1);
    }));
}

function shadedBlob(ctx, cx, cy, rx, ry, colors, rand, outline = OUTLINE) {
    // colors: [dark, mid, light, highlight]
    const inside = (x, y) => ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 <= 1;
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (inside(x, y)) {
                // light comes from the top-left
                const lx = (x + 0.5 - cx) / rx;
                const ly = (y + 0.5 - cy) / ry;
                const shade = lx * 0.45 + ly * 0.75 + (rand() - 0.5) * 0.35;
                let c = colors[1];
                if (shade > 0.45) c = colors[0];
                else if (shade < -0.55) c = colors[3];
                else if (shade < -0.15) c = colors[2];
                px(ctx, c, x, y);
            } else if (inside(x - 1, y) || inside(x + 1, y) || inside(x, y - 1) || inside(x, y + 1)) {
                px(ctx, outline, x, y);
            }
        }
    }
}

export function buildTree(seed) {
    const rand = rng(seed);
    return canvasOf(32, 40, (ctx) => {
        // trunk
        px(ctx, OUTLINE, 12, 26, 8, 13);
        px(ctx, "#7a4b2a", 13, 26, 6, 12);
        px(ctx, "#5e3820", 17, 26, 2, 12);
        px(ctx, "#9a6338", 14, 28, 1, 6);
        px(ctx, OUTLINE, 11, 37, 10, 2);
        px(ctx, "#7a4b2a", 12, 37, 8, 1);
        // canopy
        const leaves = document.createElement("canvas");
        leaves.width = 32;
        leaves.height = 30;
        const lctx = leaves.getContext("2d");
        shadedBlob(lctx, 16, 14, 14.5, 13, ["#2f6b2c", "#3f8a35", "#57a83f", "#7cc451"], rand);
        ctx.drawImage(leaves, 0, 0);
    });
}

export function buildBush(seed) {
    const rand = rng(seed);
    return canvasOf(18, 14, (ctx) => {
        shadedBlob(ctx, 9, 7.5, 8, 6, ["#2f6b2c", "#3f8a35", "#57a83f", "#7cc451"], rand);
        for (let i = 0; i < 4; i++) {
            const x = 4 + Math.floor(rand() * 10);
            const y = 3 + Math.floor(rand() * 7);
            px(ctx, "#d63a3a", x, y);
            px(ctx, "#ff8080", x, y - 1 < 0 ? y : y);
        }
    });
}

export function buildRock(seed) {
    const rand = rng(seed);
    return canvasOf(14, 11, (ctx) => {
        shadedBlob(ctx, 7, 6, 6, 4.5, ["#6b6876", "#8c8999", "#aaa7b6", "#cfccd9"], rand);
    });
}

export { OUTLINE };
