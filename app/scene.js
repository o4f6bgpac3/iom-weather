/**
 * 3D weather scene
 *
 * One small island per forecast day, each under its own weather. The sea
 * rises and falls with the tide at the selected time, the sun or moon crosses
 * the sky, and wind drives the windsocks, clouds, rain slant and trees.
 *
 * The scene only reads `view` ({t, sel, playing}); the app owns that state.
 */

import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";
import { TIDE_MAX } from "./forecastModel.js";

const SPACING = 5.6;            // distance between islands
const TIME_SCALE = 95;          // timeline minutes per second while playing
const MID_TIDE = TIDE_MAX / 2;

const TONES = {
    white: { top: 0xffffff, base: 0xe3e9f2, height: 3.3, sky: 0x4fa3e8, sea: 0x1f97a8, sunlight: 3.2 },
    light: { top: 0xf2f4f8, base: 0xa9b2c0, height: 3.1, sky: 0x6189b3, sea: 0x2a8794, sunlight: 2.2 },
    grey: { top: 0xc9ced6, base: 0x8f97a3, height: 3.0, sky: 0x77828f, sea: 0x3d7f88, sunlight: 1.3 },
    dark: { top: 0x8e95a1, base: 0x4b525f, height: 2.85, sky: 0x4a5566, sea: 0x35666f, sunlight: 1.1 },
};
const RAIN_DROPS = [0, 40, 110, 240];
const SNOW_FLAKES = 170;

const C = (hex) => new THREE.Color(hex);
const fade = (t) => t * t * (3 - 2 * t);
const smooth = (a, b, x) => fade(Math.min(1, Math.max(0, (x - a) / (b - a))));

/* ---------- terrain: a hill with a long shallow beach, so the tide visibly moves the shoreline ---------- */
const hash = (x, y) => { const v = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return v - Math.floor(v); };
function valueNoise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y), xf = fade(x - xi), yf = fade(y - yi);
    const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
    return (a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf) * 2 - 1;
}
const fbm = (x, y) => valueNoise(x, y) * 0.6 + valueNoise(x * 2.1 + 5, y * 2.1 + 3) * 0.28 + valueNoise(x * 4.3 + 9, y * 4.3 + 1) * 0.12;

function terrainHeight(x, z) {
    const a = Math.atan2(z, x);
    let r = Math.hypot(x, z / 0.82);
    r /= 1 + 0.1 * Math.sin(3 * a + 1) + 0.05 * Math.sin(5 * a + 2.5);
    const hill = 1.35 * Math.exp(-Math.pow(r / 0.85, 2)) * (1 + 0.35 * fbm(x * 1.6 + 3, z * 1.6));
    const beach = r < 1.25 ? 0.3 : 0.3 - (r - 1.25) / 1.35 * 0.72;
    return hill + beach + fbm(x * 2.2, z * 2.2) * 0.03 + (r < 1.25 ? 0.05 * fbm(x * 3 + 7, z * 3) : 0);
}

/** Sea surface height for a tide in metres: low and high water both land on the beach slope. */
const seaLevel = (metres) => -0.42 + Math.min(TIDE_MAX, Math.max(0, metres)) / TIDE_MAX * 0.62;

function buildIslandGeometry(snow) {
    const g = new THREE.PlaneGeometry(7, 7, 88, 88);
    g.rotateX(-Math.PI / 2);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) p.setY(i, terrainHeight(p.getX(i), p.getZ(i)));
    g.computeVertexNormals();

    // Drop the deep seabed so nothing square shows through the water.
    const ix = g.index.array, keep = [];
    for (let i = 0; i < ix.length; i += 3) {
        if (Math.min(p.getY(ix[i]), p.getY(ix[i + 1]), p.getY(ix[i + 2])) > -0.66) keep.push(ix[i], ix[i + 1], ix[i + 2]);
    }
    g.setIndex(keep);

    const n = g.attributes.normal, col = new Float32Array(p.count * 3), c = new THREE.Color();
    const G1 = C(0x74b356), G2 = C(0x4f8f3f), ROCK = C(0x8d877a), SAND = C(0xead9ad), WET = C(0xc2a876), BED = C(0x8d8a70), DEEP = C(0x1c6672), SNOW = C(0xf4f7fb);
    for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
        c.copy(DEEP).lerp(BED, smooth(-0.8, -0.45, y)).lerp(WET, smooth(-0.5, -0.3, y)).lerp(SAND, smooth(0.1, 0.2, y));
        c.lerp(G2.clone().lerp(G1, 0.5 + 0.5 * fbm(x * 3, z * 3)), smooth(0.25, 0.36, y));
        if (y > 0.36) c.lerp(ROCK, smooth(0.86, 0.6, n.getY(i)) * smooth(0.5, 0.9, y));
        if (snow) c.lerp(SNOW, smooth(0.95, 1.3, y));
        c.toArray(col, i * 3);
    }
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    return g;
}

/**
 * @param {object} options
 * @param {HTMLCanvasElement} options.canvas
 * @param {HTMLElement} options.stage  Element behind the canvas; receives the sky gradient.
 * @param {{t:number, sel:number, playing:boolean}} options.view  Shared, app-owned state.
 * @param {MediaQueryList} options.narrow  Matches when the layout shows one day at a time.
 * @param {boolean} options.reduceMotion
 * @param {(dtSeconds:number, minutesPerSecond:number) => void} options.onTick  Called each frame while animating.
 */
export function createScene({ canvas, stage, view, narrow, reduceMotion, onTick }) {
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, narrow.matches ? 1.5 : 2));
    renderer.setClearColor(0x000000, 0);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x8899aa, 26, 82);
    const cam = new THREE.PerspectiveCamera(30, 2, 0.1, 300);
    const hemi = new THREE.HemisphereLight(0xdfeaff, 0x6b6a55, 1);
    const sunLight = new THREE.DirectionalLight(0xfff0d8, 2);
    sunLight.castShadow = true;
    const mapSize = narrow.matches ? 1024 : 2048;
    sunLight.shadow.mapSize.set(mapSize, mapSize);
    sunLight.shadow.bias = -0.0004;
    sunLight.shadow.normalBias = 0.03;
    scene.add(hemi, sunLight, sunLight.target);

    const std = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.85, ...o });
    const shadow = (m) => { m.castShadow = true; m.receiveShadow = true; return m; };
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

    // Soft sprite texture for clouds, glows, stars and snow.
    const cv = document.createElement("canvas");
    cv.width = cv.height = 128;
    const cx = cv.getContext("2d");
    const gradient = cx.createRadialGradient(64, 64, 0, 64, 64, 64);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.45, "rgba(255,255,255,.55)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    cx.fillStyle = gradient;
    cx.fillRect(0, 0, 128, 128);
    const soft = new THREE.CanvasTexture(cv);
    soft.colorSpace = THREE.SRGBColorSpace;
    const glowMaterial = (color, opacity = 1) => new THREE.SpriteMaterial({ map: soft, color, opacity, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });

    // Sea.
    const seaGeo = new THREE.PlaneGeometry(120, 56, 150, 64);
    seaGeo.rotateX(-Math.PI / 2);
    const sea = new THREE.Mesh(seaGeo, new THREE.MeshStandardMaterial({ color: 0x2a8794, roughness: 0.16, metalness: 0.05, transparent: true, opacity: 0.87 }));
    sea.receiveShadow = true;
    scene.add(sea);
    const seaBase = seaGeo.attributes.position.array.slice();

    // Foam where the sea meets the beach. Every island has the same outline, so one shared geometry.
    const FOAM_STEPS = 96;
    const foamGeo = new THREE.BufferGeometry();
    const foamPos = new Float32Array((FOAM_STEPS + 1) * 6);
    const foamIndex = [];
    for (let i = 0; i < FOAM_STEPS; i++) { const a = i * 2; foamIndex.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    foamGeo.setAttribute("position", new THREE.BufferAttribute(foamPos, 3));
    foamGeo.setIndex(foamIndex);
    const foamMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide });
    function updateFoam(level, clock) {
        for (let i = 0; i <= FOAM_STEPS; i++) {
            const a = (i % FOAM_STEPS) / FOAM_STEPS * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
            let lo = 0.9, hi = 3.2;
            for (let k = 0; k < 11; k++) { const m = (lo + hi) / 2; if (terrainHeight(ca * m, sa * m) > level) lo = m; else hi = m; }
            const r0 = lo - 0.03, r1 = lo + 0.11 + 0.05 * Math.sin(clock * 1.6 + a * 7);
            foamPos.set([ca * r0, level + 0.012, sa * r0, ca * r1, level + 0.012, sa * r1], i * 6);
        }
        foamGeo.attributes.position.needsUpdate = true;
        foamGeo.computeBoundingSphere();
    }

    // Geometry and materials shared by every island.
    const islandGeo = { plain: null, snow: null };
    const islandMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
    const shared = {
        tower: new THREE.CylinderGeometry(0.075, 0.115, 0.62, 20), band: new THREE.CylinderGeometry(0.098, 0.106, 0.15, 20),
        gallery: new THREE.CylinderGeometry(0.11, 0.11, 0.025, 20), lamp: new THREE.CylinderGeometry(0.06, 0.06, 0.1, 14), cap: new THREE.ConeGeometry(0.095, 0.1, 20),
        walls: new THREE.BoxGeometry(0.3, 0.16, 0.2), roof: new THREE.ConeGeometry(0.235, 0.13, 4), window: new THREE.PlaneGeometry(0.05, 0.05),
        trunk: new THREE.CylinderGeometry(0.018, 0.028, 0.14, 6), foliage1: new THREE.ConeGeometry(0.13, 0.3, 10), foliage2: new THREE.ConeGeometry(0.095, 0.24, 10),
        pole: new THREE.CylinderGeometry(0.014, 0.014, 0.75, 8), sunBall: new THREE.SphereGeometry(0.36, 24, 16),
        white: std(0xf6f3ea), red: std(0xc7402f), slate: std(0x2c313c), wall: std(0xf3efe4), roofSlate: std(0x4a5160), roofSnow: std(0xe9eef4),
        trunkMat: std(0x6b4a33), leaf: std(0x2f6f3c), leafFrost: std(0x9fbfae), poleMat: std(0xe8e8e8),
        sock: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, side: THREE.DoubleSide }),
        drop: new THREE.LineBasicMaterial({ color: 0xd6e8ff, transparent: true, opacity: 0.62 }),
        flake: new THREE.PointsMaterial({ color: 0xffffff, size: 0.11, map: soft, transparent: true, depthWrite: false }),
        streak: new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 }),
    };
    const beamGeo = new THREE.BufferGeometry();
    beamGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array([0, 0, 0, 3.4, 0.05, -0.55, 3.4, 0.05, 0.55]), 3));
    beamGeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array([1, 0.9, 0.6, 0, 0, 0, 0, 0, 0]), 3));
    const beamMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.7, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, fog: false });
    const sockGeo = (() => {
        const g = new THREE.ConeGeometry(0.13, 0.75, 12, 5, true).toNonIndexed();
        const p = g.attributes.position, col = new Float32Array(p.count * 3), orange = C(0xff6a1f), white = C(0xffffff);
        for (let i = 0; i < p.count; i += 3) {
            const band = Math.floor(((p.getY(i) + p.getY(i + 1) + p.getY(i + 2)) / 3 + 0.375) / 0.15);
            for (let j = 0; j < 3; j++) (band % 2 ? white : orange).toArray(col, (i + j) * 3);
        }
        g.setAttribute("color", new THREE.BufferAttribute(col, 3));
        g.rotateZ(-Math.PI / 2);
        g.translate(0.375, 0, 0);
        return g;
    })();
    const treeSpots = [];
    for (let tries = 0; treeSpots.length < 9 && tries < 200; tries++) {
        const a = rnd() * 6.28, r = 0.5 + rnd() * 0.7, x = Math.cos(a) * r, z = Math.sin(a) * r * 0.8;
        if (Math.hypot(x + 0.8, z - 0.5) < 0.3 || Math.hypot(x - 0.6, z - 0.62) < 0.34 || Math.hypot(x, z) < 0.3 || terrainHeight(x, z) < 0.36) continue;
        treeSpots.push([x, z, 0.75 + rnd() * 0.6]);
    }

    // Sun or moon for the time of day, and stars.
    const orb = new THREE.Mesh(new THREE.SphereGeometry(0.9, 28, 18), new THREE.MeshBasicMaterial({ color: 0xfff0c0, fog: false }));
    const orbGlow = new THREE.Sprite(glowMaterial(0xffd9a0, 0.8));
    orbGlow.scale.setScalar(7);
    orb.add(orbGlow);
    const starCount = 320, starPos = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) { starPos[i * 3] = (rnd() - 0.5) * 110; starPos[i * 3 + 1] = 1 + rnd() * 26; starPos[i * 3 + 2] = -44; }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute("position", new THREE.BufferAttribute(starPos, 3));
    const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.2, map: soft, transparent: true, depthWrite: false, fog: false }));
    scene.add(orb, stars);

    let isles = [];
    let days = [];
    let tideAt = () => null;
    let mid = 0;

    /** Direction the wind blows towards. North is away from the camera. */
    function windVector(day) {
        const b = (day.windBearing ?? 270) * Math.PI / 180;
        return new THREE.Vector3(-Math.sin(b), 0, Math.cos(b));
    }

    function buildIsland(day, index) {
        const g = new THREE.Group();
        g.position.x = index * SPACING;
        const wx = day.weather, tone = TONES[wx.tone], w = windVector(day), frosty = day.snowcap;
        const owned = [];   // per-island geometries and materials, disposed when the days change

        const geoKey = frosty ? "snow" : "plain";
        islandGeo[geoKey] ??= buildIslandGeometry(frosty);
        g.add(shadow(new THREE.Mesh(islandGeo[geoKey], islandMat)));
        g.add(new THREE.Mesh(foamGeo, foamMat));

        // Lighthouse with a sweeping beam after dark.
        const lighthouse = new THREE.Group();
        lighthouse.position.set(-0.8, terrainHeight(-0.8, 0.5) - 0.02, 0.5);
        const add = (parent, geo, mat, y, cast = true) => { const m = new THREE.Mesh(geo, mat); m.position.y = y; if (cast) shadow(m); parent.add(m); return m; };
        add(lighthouse, shared.tower, shared.white, 0.31);
        add(lighthouse, shared.band, shared.red, 0.27, false);
        add(lighthouse, shared.gallery, shared.slate, 0.63, false);
        const lampMat = new THREE.MeshBasicMaterial({ color: 0xffe9a8 });
        add(lighthouse, shared.lamp, lampMat, 0.69, false);
        add(lighthouse, shared.cap, shared.slate, 0.79, false);
        const beam = add(lighthouse, beamGeo, beamMat, 0.69, false);
        const lampGlowMat = glowMaterial(0xffdf90, 0.9);
        const lampGlow = new THREE.Sprite(lampGlowMat);
        lampGlow.scale.setScalar(0.7);
        lampGlow.position.y = 0.69;
        lighthouse.add(lampGlow);
        g.add(lighthouse);

        // Cottage with windows that light up at night.
        const cottage = new THREE.Group();
        cottage.position.set(0.6, terrainHeight(0.6, 0.62) - 0.02, 0.62);
        cottage.rotation.y = -0.4;
        add(cottage, shared.walls, shared.wall, 0.08);
        const roof = add(cottage, shared.roof, frosty ? shared.roofSnow : shared.roofSlate, 0.225);
        roof.rotation.y = Math.PI / 4;
        roof.scale.z = 0.74;
        const windowMat = new THREE.MeshBasicMaterial({ color: 0x39424f });
        [-0.08, 0.08].forEach((x) => { const pane = new THREE.Mesh(shared.window, windowMat); pane.position.set(x, 0.09, 0.101); cottage.add(pane); });
        g.add(cottage);

        const trees = treeSpots.map(([x, z, scale]) => {
            const t = new THREE.Group();
            t.position.set(x, terrainHeight(x, z) - 0.02, z);
            t.scale.setScalar(scale);
            add(t, shared.trunk, shared.trunkMat, 0.07);
            add(t, shared.foliage1, frosty ? shared.leafFrost : shared.leaf, 0.25);
            add(t, shared.foliage2, frosty ? shared.leafFrost : shared.leaf, 0.4);
            g.add(t);
            return t;
        });

        // Windsock on the summit: points downwind, droops when calm.
        const summit = terrainHeight(0, 0);
        const pole = shadow(new THREE.Mesh(shared.pole, shared.poleMat));
        pole.position.set(0, summit + 0.36, 0);
        const sockPivot = new THREE.Group();
        sockPivot.position.set(0, summit + 0.7, 0);
        sockPivot.rotation.y = Math.atan2(-w.z, w.x);
        const sock = shadow(new THREE.Mesh(sockGeo, shared.sock));
        sockPivot.add(sock);
        g.add(pole, sockPivot);

        // Clouds: soft billboards, darker underneath.
        const cloudTop = new THREE.SpriteMaterial({ map: soft, color: tone.top, transparent: true, opacity: 0.95, depthWrite: false });
        const cloudBase = new THREE.SpriteMaterial({ map: soft, color: tone.base, transparent: true, opacity: 0.9, depthWrite: false });
        const clouds = [];
        for (let c = 0; c < wx.clouds; c++) {
            const cloud = new THREE.Group(), width = 0.9 + rnd() * 0.5;
            for (let j = 0; j < 16; j++) {
                const u = rnd() * 2 - 1, low = j < 7, puff = new THREE.Sprite(low ? cloudBase : cloudTop), size = (0.75 + rnd() * 0.6) * (1 - 0.45 * u * u);
                puff.position.set(u * width, low ? -0.08 + rnd() * 0.1 : 0.08 + rnd() * 0.34 * (1 - u * u), (rnd() - 0.5) * 0.5 + (low ? -0.05 : 0.05));
                puff.scale.set(size * 1.25, size, 1);
                cloud.add(puff);
            }
            const base = new THREE.Vector3((wx.clouds === 1 ? 1.3 : (c - (wx.clouds - 1) / 2) * 1.45 + (rnd() - 0.5) * 0.3) + (wx.sun === 2 && wx.clouds > 1 ? 0.8 : 0), tone.height + rnd() * 0.4, (rnd() - 0.5) * 1.4);
            cloud.userData = { base, phase: rnd() * 6.28 };
            cloud.position.copy(base);
            g.add(cloud);
            clouds.push(cloud);
        }

        // Sun: out for bright days, peeking from behind cloud otherwise.
        let sunMat = null, sunGlowMat = null;
        if (wx.sun) {
            const sun = new THREE.Group();
            sunMat = new THREE.MeshBasicMaterial({ color: 0xffd15a, fog: false });
            sunGlowMat = glowMaterial(0xffc45a, 0.9);
            const glow = new THREE.Sprite(sunGlowMat);
            glow.scale.setScalar(2.1);
            sun.add(new THREE.Mesh(shared.sunBall, sunMat), glow);
            // In front of the clouds when the sun is out, tucked behind them when it is only peeking through.
            sun.position.set(wx.sun === 2 ? -1.4 : -1.25, wx.sun === 2 ? 3.6 : 3.55, wx.sun === 2 ? 1 : -1);
            if (wx.sun === 1) sun.scale.setScalar(0.72);
            g.add(sun);
        }

        // Rain or snow falling from the cloud base.
        let fall = null;
        const count = wx.snowfall ? SNOW_FLAKES : RAIN_DROPS[wx.rain];
        if (count) {
            const particles = [];
            for (let j = 0; j < count; j++) particles.push({ x: (rnd() - 0.5) * 4.2, z: (rnd() - 0.5) * 3, y: rnd() * tone.height, v: wx.snowfall ? 0.5 + rnd() * 0.4 : 3.4 + rnd() * 2.2, phase: rnd() * 6.28 });
            const geo = new THREE.BufferGeometry();
            geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * (wx.snowfall ? 3 : 6)), 3));
            const object = wx.snowfall ? new THREE.Points(geo, shared.flake) : new THREE.LineSegments(geo, shared.drop);
            object.frustumCulled = false;
            g.add(object);
            owned.push(geo);
            fall = { object, particles, top: tone.height, snow: wx.snowfall };
        }

        // Wind streaks.
        const speed = day.windSpeed ?? 0;
        const streaks = [];
        for (let j = 0; j < Math.round(speed / 4); j++) streaks.push({ origin: new THREE.Vector3((rnd() - 0.5) * 4.5, 0.7 + rnd() * 1.8, (rnd() - 0.5) * 3), phase: rnd(), length: 0.5 + rnd() * 0.6 });
        const streakGeo = new THREE.BufferGeometry();
        streakGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(streaks.length * 6), 3));
        const streakObj = new THREE.LineSegments(streakGeo, shared.streak);
        streakObj.frustumCulled = false;
        g.add(streakObj);

        owned.push(streakGeo, lampMat, lampGlowMat, windowMat, cloudTop, cloudBase);
        if (sunMat) owned.push(sunMat, sunGlowMat);
        return { group: g, day, w, tone, gust: Math.min(1, speed / 30), clouds, cloudTop, cloudBase, sunMat, sunGlowMat, fall, streakObj, streaks, sockPivot, sock, lampMat, lampGlow, beam, windowMat, trees, owned };
    }

    const NIGHT = C(0x0e1638), NIGHT_SEA = C(0x0f3346), DUSK = C(0xf08a52), WHITE = C(0xffffff), NIGHT_HORIZON = C(0x18214a);
    const skyColor = C(0x4a5566), topColor = new THREE.Color(), horizonColor = new THREE.Color(), seaColor = new THREE.Color(), tmp = new THREE.Color();
    let camX = 0, camDist = 20, seaY = seaLevel(MID_TIDE);
    let lastW = 0, lastH = 0, clock = 0, prev = performance.now(), pending = false, snap = true, visible = true, lastBackground = "";

    function frame(now) {
        pending = false;
        if (!visible || document.hidden || !days.length) return;
        const w = canvas.clientWidth, h = canvas.clientHeight;
        if (!w || !h) return;
        const dt = Math.min(0.05, (now - prev) / 1000);
        prev = now;
        if (!reduceMotion) clock += dt;
        onTick(dt, TIME_SCALE);
        if (w !== lastW || h !== lastH) { renderer.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix(); lastW = w; lastH = h; }

        const sel = Math.min(days.length - 1, Math.max(0, view.sel));
        const day = days[sel], tone = TONES[day.weather.tone], minuteOfDay = view.t - sel * 1440;
        const ease = snap || reduceMotion ? 1 : 1 - Math.pow(0.002, dt);

        // Camera: every day in view when wide, one island (neighbours peeking in) when narrow.
        const all = !narrow.matches;
        const targetX = all ? mid : sel * SPACING;
        const width = all ? (days.length - 1) * SPACING + 6.2 : 9.2;
        const targetDist = Math.min(40, Math.max(all ? 15 : 11, width / (0.536 * cam.aspect)));
        camX += (targetX - camX) * ease;
        camDist += (targetDist - camDist) * ease;
        cam.position.set(camX, all ? 5.2 : 4.6, camDist);
        cam.lookAt(camX, 1.15, 0);

        // Time of day.
        const isDay = minuteOfDay >= day.sunrise && minuteOfDay <= day.sunset;
        const dayLength = Math.max(1, day.sunset - day.sunrise);
        const f = isDay ? (minuteOfDay - day.sunrise) / dayLength
            : (minuteOfDay > day.sunset ? minuteOfDay - day.sunset : minuteOfDay + 1440 - day.sunset) / (1440 - dayLength);
        const elevation = isDay ? Math.sin(Math.PI * f) : -Math.sin(Math.PI * f);
        const dayness = smooth(-0.12, 0.22, elevation);
        const dusk = Math.max(0, 1 - Math.abs(elevation) / 0.24);
        const clear = day.weather.tone === "white";
        const span = camDist * 0.536 * cam.aspect * 0.8;
        orb.position.set(camX + (f - 0.5) * span, 2.2 + Math.sin(Math.PI * f) * 5, -20);
        orb.scale.setScalar(isDay ? 1 : 0.55);
        orb.material.color.set(isDay ? 0xfff0c0 : 0xe6ecf8);
        orbGlow.material.color.set(isDay ? 0xffd9a0 : 0x8fa3d8);
        orbGlow.material.opacity = clear || !isDay ? 0.8 : 0.35;
        stars.position.x = camX;
        stars.material.opacity = (1 - dayness) * 0.95;

        skyColor.lerp(tmp.copy(NIGHT).lerp(C(tone.sky), dayness), ease);
        topColor.copy(skyColor).multiplyScalar(0.7);
        horizonColor.copy(skyColor).lerp(dayness > 0.5 ? WHITE : NIGHT_HORIZON, 0.4).lerp(DUSK, dusk * (clear ? 0.6 : 0.3));
        const background = `linear-gradient(#${topColor.getHexString()},#${horizonColor.getHexString()} 62%)`;
        if (background !== lastBackground) { stage.style.background = background; lastBackground = background; }
        scene.fog.color.copy(horizonColor);
        hemi.intensity = 0.75 + 1.1 * dayness;
        sunLight.intensity = 0.9 + tone.sunlight * dayness;
        sunLight.color.set(isDay ? 0xfff0d8 : 0x9fb4ff).lerp(DUSK, dusk * 0.5);
        sunLight.position.set(mid + (f - 0.5) * 26, 6 + Math.sin(Math.PI * f) * 16, 14);

        // Sea: level follows the tide, chop follows the wind.
        const targetSea = seaLevel(tideAt(view.t) ?? MID_TIDE);
        seaY += (targetSea - seaY) * ease;
        sea.position.y = seaY;
        const sp = seaGeo.attributes.position, amp = 0.012 + (day.windSpeed ?? 0) / 30 * 0.05;
        for (let i = 0; i < sp.count; i++) {
            const x = seaBase[i * 3], z = seaBase[i * 3 + 2];
            sp.array[i * 3 + 1] = Math.sin(x * 0.7 + z * 0.25 + clock * 1.1) * amp + Math.sin(z * 1.15 - x * 0.2 + clock * 0.8) * amp * 0.8 + Math.sin((x + z) * 2.3 + clock * 1.9) * amp * 0.35;
        }
        sp.needsUpdate = true;
        seaGeo.computeVertexNormals();
        sea.material.color.lerp(seaColor.copy(NIGHT_SEA).lerp(C(tone.sea), dayness), ease);
        updateFoam(seaY, clock);

        const dark = dayness < 0.45, dim = 0.3 + 0.7 * dayness;
        isles.forEach((o, i) => {
            const k = o.gust;
            o.clouds.forEach((c) => { const u = Math.sin(clock * (0.2 + k * 0.7) + c.userData.phase); c.position.copy(c.userData.base).addScaledVector(o.w, u * (0.25 + k * 0.5)); });
            o.cloudTop.color.set(o.tone.top).multiplyScalar(dim);
            o.cloudBase.color.set(o.tone.base).multiplyScalar(dim);
            if (o.sunMat) { o.sunMat.color.set(0xffd15a).multiplyScalar(0.25 + 0.75 * dayness); o.sunGlowMat.opacity = 0.05 + 0.65 * dayness; }
            o.sockPivot.rotation.z = -(1 - k) * 1.1 + Math.sin(clock * (5 + k * 9) + i) * 0.06;
            o.sock.rotation.y = Math.sin(clock * (7 + k * 8) + i) * 0.1;
            o.trees.forEach((t, j) => { const a = Math.sin(clock * (2 + k * 4) + j * 1.7 + i) * 0.03 * (0.4 + k) + 0.05 * k; t.rotation.set(o.w.z * a, 0, -o.w.x * a); });
            o.lampMat.color.set(dark ? 0xffe9a8 : 0x8a8676);
            o.lampGlow.visible = dark;
            o.beam.visible = dark;
            o.beam.rotation.y = clock * 1.1 + i;
            o.windowMat.color.set(dark ? 0xffcf7a : 0x39424f);
            if (o.fall) {
                const a = o.fall.object.geometry.attributes.position, top = o.fall.top;
                o.fall.particles.forEach((p, j) => {
                    if (!reduceMotion) p.y -= p.v * dt;
                    if (p.y < -0.3) p.y = top;
                    const drift = (top - p.y) * k * 0.55, ox = o.w.x * drift, oz = o.w.z * drift;
                    if (o.fall.snow) a.setXYZ(j, p.x + ox + Math.sin(clock * 1.3 + p.phase) * 0.08, p.y, p.z + oz);
                    else { a.setXYZ(j * 2, p.x + ox, p.y, p.z + oz); a.setXYZ(j * 2 + 1, p.x + ox - o.w.x * k * 0.14, p.y + 0.22, p.z + oz - o.w.z * k * 0.14); }
                });
                a.needsUpdate = true;
            }
            const sa = o.streakObj.geometry.attributes.position;
            o.streaks.forEach((q, j) => {
                const u = ((clock * (0.15 + k * 0.55) + q.phase) % 1) * 5 - 2.5;
                sa.setXYZ(j * 2, q.origin.x + o.w.x * u, q.origin.y, q.origin.z + o.w.z * u);
                sa.setXYZ(j * 2 + 1, q.origin.x + o.w.x * (u + q.length), q.origin.y, q.origin.z + o.w.z * (u + q.length));
            });
            sa.needsUpdate = true;
        });

        renderer.render(scene, cam);
        snap = false;
        const settling = Math.abs(targetX - camX) > 0.01 || Math.abs(targetDist - camDist) > 0.01 || Math.abs(targetSea - seaY) > 0.002;
        if (!reduceMotion || view.playing || settling) requestRender();
    }

    function requestRender() {
        if (pending) return;
        pending = true;
        prev = Math.max(prev, performance.now() - 50);
        requestAnimationFrame(frame);
    }

    new ResizeObserver(requestRender).observe(canvas);
    // Stop drawing when the scene is scrolled out of view or the tab is hidden.
    new IntersectionObserver((entries) => { visible = entries[0].isIntersecting; if (visible) requestRender(); }).observe(stage);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) requestRender(); });

    return {
        requestRender,
        /** Replaces the islands with one per day. */
        setDays(nextDays, nextTideAt) {
            isles.forEach((o) => { scene.remove(o.group); o.owned.forEach((item) => item.dispose()); });
            days = nextDays;
            tideAt = nextTideAt;
            mid = (days.length - 1) / 2 * SPACING;
            isles = days.map(buildIsland);
            isles.forEach((o) => scene.add(o.group));
            sea.position.set(mid, seaY, -10);
            sunLight.target.position.set(mid, 0, 0);
            const reach = mid + 5;
            Object.assign(sunLight.shadow.camera, { left: -reach, right: reach, top: 10, bottom: -10, near: 1, far: 90 });
            sunLight.shadow.camera.updateProjectionMatrix();
            snap = true;
            requestRender();
        },
    };
}
