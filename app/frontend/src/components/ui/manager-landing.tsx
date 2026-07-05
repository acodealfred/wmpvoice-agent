import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { apiFetch } from "@/lib/api";
import { ManagerAnalytics } from "./manager-analytics";
import { ManagerScoreTrend } from "./manager-score-trend";
import { ManagerChat } from "./manager-chat";
import "./manager-landing.css";

interface AssessmentNode {
    updated_at: string;
    riskLevel: string;
    totalScore: number | null;
    maxScore: number | null;
}

interface Department {
    name: string;
    eligible: number;
    completed: number;
    participationPct: number;
    riskCounts: { Low: number; Moderate: number; High: number };
    atRiskPct: number;
    dominantRisk: string;
    avgScore: number | null;
}

interface OverviewData {
    totalGuests: number;
    participants: number;
    surveysCompleted: number;
    riskCounts: { Low: number; Moderate: number; High: number };
    recentAssessments: AssessmentNode[];
    nodes: AssessmentNode[];
    departments: Department[];
}

// ── risk → colour helpers (shared by cards + 3D scene) ─────────────────
// Neon-leaning hexes for the 3D scene; the cards keep the softer theme vars.
const RISK_HEX: Record<string, number> = { Low: 0x2bf5b0, Moderate: 0xffcc4d, High: 0xff4d7d };
function riskHex(level: string): number { return RISK_HEX[level] ?? 0x54a7dd; }
function riskFill(level: string): string {
    if (level === "High") return "ml-rfill-high";
    if (level === "Moderate") return "ml-rfill-mod";
    return "ml-rfill-low";
}

// ── per-theme palette for the 3D map (one per app colour mode) ─────────
type ThemeMode = "light" | "dark" | "ocean";
const MAP_THEME: Record<ThemeMode, {
    bg: number; fog: number; fogD: number; amb: number; ambI: number; key: number; keyI: number;
    rim: number; rimI: number; grid1: number; gridFine: number; plate: number; plateO: number;
    body: number; bodyMetal: number; bodyRough: number; accent: number; emI: number;
}> = {
    // Bluish digital-twin look (the dashboard's signature)
    ocean: {
        bg: 0x040d16, fog: 0x05111d, fogD: 0.01, amb: 0x6fa8cc, ambI: 0.55, key: 0xbfe6ff, keyI: 1.1,
        rim: 0x16e0d6, rimI: 0.85, grid1: 0x1f7fb0, gridFine: 0x35d6ff, plate: 0x06141f, plateO: 0.92,
        body: 0x0e2436, bodyMetal: 0.7, bodyRough: 0.22, accent: 0x0a1f30, emI: 0.55,
    },
    // Green-tinted dark, matching the app's existing dark mode
    dark: {
        bg: 0x080d0b, fog: 0x0a120e, fogD: 0.01, amb: 0x88b0a0, ambI: 0.55, key: 0xd8f0e4, keyI: 1.1,
        rim: 0x39f5b0, rimI: 0.8, grid1: 0x1f7a5c, gridFine: 0x36f0a8, plate: 0x0c1813, plateO: 0.9,
        body: 0x12241c, bodyMetal: 0.65, bodyRough: 0.25, accent: 0x0c1a14, emI: 0.55,
    },
    light: {
        bg: 0xe9f2fb, fog: 0xe9f2fb, fogD: 0.008, amb: 0xffffff, ambI: 0.85, key: 0xffffff, keyI: 1.1,
        rim: 0x35c8e0, rimI: 0.5, grid1: 0x7fb4dc, gridFine: 0x35a6d6, plate: 0xdfeaf6, plateO: 0.55,
        body: 0xc9dcef, bodyMetal: 0.35, bodyRough: 0.4, accent: 0xb9d0e6, emI: 0.32,
    },
};

interface Props {
    theme: ThemeMode;
}

export function ManagerLanding({ theme }: Props) {
    const mountRef = useRef<HTMLDivElement>(null);
    const holoRef = useRef<HTMLDivElement>(null);
    const [data, setData] = useState<OverviewData | null>(null);
    const [loading, setLoading] = useState(true);

    // Bridges so the imperative Three.js code can read the latest theme and the
    // React zoom buttons can call into the scene, without rebuilding the scene.
    const themeRef = useRef(theme);
    const applyThemeRef = useRef<(t: ThemeMode) => void>();
    const zoomRef = useRef<(delta: number) => void>();

    // ── Fetch overview data ─────────────────────────────────────────────
    useEffect(() => {
        apiFetch("/manager/overview", { credentials: "same-origin" })
            .then(r => r.json())
            .then((d: OverviewData) => { setData(d); setLoading(false); })
            .catch(() => setLoading(false));
    }, []);

    // ── Push theme changes into the live scene (no rebuild) ──────────────
    useEffect(() => {
        themeRef.current = theme;
        applyThemeRef.current?.(theme);
    }, [theme]);

    // ── Build the 3D campus once data has loaded ─────────────────────────
    useEffect(() => {
        const mount = mountRef.current;
        if (!mount || !data) return;

        const W = mount.clientWidth || 1;
        const H = mount.clientHeight || 1;

        const renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.setSize(W, H);
        const dom = renderer.domElement;
        dom.style.display = "block";
        mount.appendChild(dom);

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(50, W / H, 0.1, 600);

        const amb = new THREE.AmbientLight(0x6fa8cc, 0.5); scene.add(amb);
        const key = new THREE.DirectionalLight(0xbfe6ff, 0.95); key.position.set(22, 40, 16); scene.add(key);
        const rim = new THREE.DirectionalLight(0x25b5ad, 0.55); rim.position.set(-24, 12, -20); scene.add(rim);

        // ground
        const grid = new THREE.GridHelper(220, 90, 0x2f6f8c, 0x16384a) as THREE.GridHelper;
        (grid.material as THREE.Material).transparent = true; (grid.material as THREE.Material).opacity = 0.3; scene.add(grid);
        const plate = new THREE.Mesh(
            new THREE.CircleGeometry(110, 80),
            new THREE.MeshBasicMaterial({ color: 0x081d2c, transparent: true, opacity: 0.9 }),
        );
        plate.rotation.x = -Math.PI / 2; plate.position.y = -0.02; scene.add(plate);

        let curTheme: ThemeMode = themeRef.current;
        const accentMats: THREE.MeshStandardMaterial[] = [];

        function bodyMat(col: number) {
            const T = MAP_THEME[curTheme];
            return new THREE.MeshStandardMaterial({
                color: T.body, metalness: T.bodyMetal, roughness: T.bodyRough,
                emissive: new THREE.Color(col), emissiveIntensity: T.emI, transparent: true, opacity: 0.95,
            });
        }
        function edgeMat(col: number, op: number) { return new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: op }); }
        function accentMat(opts: THREE.MeshStandardMaterialParameters) {
            const m = new THREE.MeshStandardMaterial(Object.assign({ color: MAP_THEME[curTheme].accent }, opts));
            accentMats.push(m); return m;
        }

        interface Reg { bodies: THREE.Mesh[]; edges: THREE.LineSegments[] }

        function addMass(group: THREE.Group, col: number, w: number, h: number, d: number, x: number, y: number, z: number, pick: THREE.Mesh[], R: Reg) {
            const geo = new THREE.BoxGeometry(w, h, d);
            const m = new THREE.Mesh(geo, bodyMat(col)); m.position.set(x, y + h / 2, z);
            group.add(m); pick.push(m); R.bodies.push(m);
            const e = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat(col, 0.85));
            e.position.copy(m.position); group.add(e); R.edges.push(e);
            return m;
        }
        function addFloorLines(group: THREE.Group, col: number, w: number, d: number, baseY: number, topY: number, x: number, z: number, step: number) {
            const lineMat = new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.22 });
            const hw = w / 2 + 0.02, hd = d / 2 + 0.02;
            for (let y = baseY + step; y < topY - 0.3; y += step) {
                const g = new THREE.BufferGeometry();
                const pts = [-hw, y, -hd, hw, y, -hd, hw, y, -hd, hw, y, hd, hw, y, hd, -hw, y, hd, -hw, y, hd, -hw, y, -hd];
                g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
                const seg = new THREE.LineSegments(g, lineMat); seg.position.set(x, 0, z); group.add(seg);
            }
        }

        // ── archetype builders (return top Y for label placement) ────────
        const ARCH: Record<string, (g: THREE.Group, col: number, P: THREE.Mesh[], R: Reg) => number> = {
            hospital(group, col, P, R) {
                addMass(group, col, 14, 4, 12, 0, 0, 0, P, R); addFloorLines(group, col, 14, 12, 0, 4, 0, 0, 2);
                addMass(group, col, 9, 16, 7, 0, 4, -0.5, P, R); addFloorLines(group, col, 9, 7, 4, 20, 0, -0.5, 2.2);
                addMass(group, col, 5, 9, 5, 5.5, 4, 3, P, R); addFloorLines(group, col, 5, 5, 4, 13, 5.5, 3, 2.2);
                const heli = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.6, 0.4, 28),
                    accentMat({ metalness: 0.4, roughness: 0.6, emissive: new THREE.Color(col), emissiveIntensity: 0.25 }));
                heli.position.set(0, 20.2, -0.5); group.add(heli);
                const hring = new THREE.Mesh(new THREE.RingGeometry(1.7, 2.0, 28),
                    new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.7, side: THREE.DoubleSide }));
                hring.rotation.x = -Math.PI / 2; hring.position.set(0, 20.42, -0.5); group.add(hring);
                return 20.6;
            },
            emergency(group, col, P, R) {
                addMass(group, col, 11, 7, 9, 0, 0, 0, P, R); addFloorLines(group, col, 11, 9, 0, 7, 0, 0, 2.2);
                addMass(group, col, 7, 4, 6, -1.5, 7, -1, P, R);
                const canopy = new THREE.Mesh(new THREE.BoxGeometry(9, 0.4, 4),
                    accentMat({ metalness: 0.5, roughness: 0.4, emissive: new THREE.Color(col), emissiveIntensity: 0.3 }));
                canopy.position.set(0, 3.4, 7.2); group.add(canopy);
                [-3.6, 3.6].forEach(px => {
                    const pil = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 3.4, 10), accentMat({ metalness: 0.6, roughness: 0.4 }));
                    pil.position.set(px, 1.7, 8.8); group.add(pil);
                });
                const crossV = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.2, 3), new THREE.MeshBasicMaterial({ color: col }));
                crossV.position.set(0, 7.12, 1); group.add(crossV);
                const crossH = new THREE.Mesh(new THREE.BoxGeometry(3, 0.2, 0.7), new THREE.MeshBasicMaterial({ color: col }));
                crossH.position.set(0, 7.12, 1); group.add(crossH);
                return 11.4;
            },
            pavilion(group, col, P, R) {
                addMass(group, col, 14, 4.5, 9, 0, 0, 0, P, R); addFloorLines(group, col, 14, 9, 0, 4.5, 0, 0, 1.6);
                for (let i = -2; i <= 2; i++) {
                    const tooth = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.6, 9), bodyMat(col));
                    tooth.position.set(i * 2.6, 5.3, 0); tooth.rotation.z = 0.5; group.add(tooth); P.push(tooth); R.bodies.push(tooth);
                    const te = new THREE.LineSegments(new THREE.EdgesGeometry(tooth.geometry), edgeMat(col, 0.7));
                    te.position.copy(tooth.position); te.rotation.copy(tooth.rotation); group.add(te); R.edges.push(te);
                }
                return 6.6;
            },
            tower(group, col, P, R) {
                addMass(group, col, 7, 8, 7, 0, 0, 0, P, R); addFloorLines(group, col, 7, 7, 0, 8, 0, 0, 2);
                addMass(group, col, 5.6, 7, 5.6, 0, 8, 0, P, R); addFloorLines(group, col, 5.6, 5.6, 8, 15, 0, 0, 2);
                addMass(group, col, 4.2, 6, 4.2, 0, 15, 0, P, R); addFloorLines(group, col, 4.2, 4.2, 15, 21, 0, 0, 2);
                const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 4, 8), new THREE.MeshBasicMaterial({ color: col }));
                mast.position.set(0, 25, 0); group.add(mast);
                return 27;
            },
            curve(group, col, P, R) {
                const tiers: [number, number, number][] = [[6, 3, 0], [5, 3, 3], [4, 3, 6], [3, 2.4, 9]];
                tiers.forEach(([r, h, y]) => {
                    const t = new THREE.Mesh(new THREE.CylinderGeometry(r, r + 0.4, h, 40, 1, false, 0, Math.PI * 1.35), bodyMat(col));
                    t.position.set(0, y + h / 2, 0); t.rotation.y = -0.5; group.add(t); P.push(t); R.bodies.push(t);
                    const e = new THREE.LineSegments(new THREE.EdgesGeometry(t.geometry), edgeMat(col, 0.5));
                    e.position.copy(t.position); e.rotation.copy(t.rotation); group.add(e); R.edges.push(e);
                });
                return 11.6;
            },
        };
        const ARCH_KEYS = ["hospital", "emergency", "pavilion", "tower", "curve"];

        // ── label sprite ─────────────────────────────────────────────────
        function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
            g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r);
            g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
        }
        function makeLabel(text: string, accent: number) {
            const cv = document.createElement("canvas"); cv.width = 640; cv.height = 160;
            const g = cv.getContext("2d")!;
            const hex = "#" + accent.toString(16).padStart(6, "0");
            g.fillStyle = "rgba(6,18,28,0.88)"; roundRect(g, 8, 40, 624, 80, 22); g.fill();
            g.strokeStyle = hex; g.lineWidth = 4; roundRect(g, 8, 40, 624, 80, 22); g.stroke();
            // accent glow underline
            g.shadowColor = hex; g.shadowBlur = 18;
            g.font = "800 56px Inter, sans-serif"; g.fillStyle = "#eaf6ff";
            g.textBaseline = "middle"; g.textAlign = "center";
            g.fillText(text, 320, 84);
            const tex = new THREE.CanvasTexture(cv);
            const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
            spr.scale.set(15, 3.75, 1); return spr;
        }

        // Soft white radial texture, tinted per building for a neon ground-glow.
        const glowCv = document.createElement("canvas"); glowCv.width = glowCv.height = 128;
        const gg = glowCv.getContext("2d")!;
        const grad = gg.createRadialGradient(64, 64, 0, 64, 64, 64);
        grad.addColorStop(0, "rgba(255,255,255,1)");
        grad.addColorStop(0.35, "rgba(255,255,255,0.4)");
        grad.addColorStop(1, "rgba(255,255,255,0)");
        gg.fillStyle = grad; gg.fillRect(0, 0, 128, 128);
        const glowTex = new THREE.CanvasTexture(glowCv);

        // ── One building per department, laid out on a centred grid ──────
        interface B { dept: Department; x: number; z: number; topY: number; ring: THREE.Mesh; glow: THREE.Mesh; reg: Reg; col: number }
        const buildings: B[] = [];
        const pickables: THREE.Mesh[] = [];
        const depts = data.departments ?? [];
        const n = depts.length;
        const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
        const rowsN = Math.max(1, Math.ceil(n / cols));
        const spacing = 24;

        depts.forEach((dept, i) => {
            const col = riskHex(dept.dominantRisk);
            const cx = (i % cols - (cols - 1) / 2) * spacing;
            const cz = (Math.floor(i / cols) - (rowsN - 1) / 2) * spacing;
            const group = new THREE.Group();
            group.position.set(cx, 0, cz);
            group.rotation.y = (i % 5) * 0.12 - 0.24;
            const R: Reg = { bodies: [], edges: [] };
            const topY = ARCH[ARCH_KEYS[i % ARCH_KEYS.length]](group, col, pickables, R);
            const b: B = { dept, x: cx, z: cz, topY, reg: R, col, ring: null as unknown as THREE.Mesh, glow: null as unknown as THREE.Mesh };
            R.bodies.forEach(m => { (m.userData as { b: B }).b = b; });

            // Neon ground-glow pool (additive — reads as bloom on the dark plate).
            const glow = new THREE.Mesh(
                new THREE.PlaneGeometry(40, 40),
                new THREE.MeshBasicMaterial({ map: glowTex, color: col, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.85 }),
            );
            glow.rotation.x = -Math.PI / 2; glow.position.y = 0.05; group.add(glow); b.glow = glow;

            const ring = new THREE.Mesh(new THREE.RingGeometry(9, 9.6, 64),
                new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.7, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
            ring.rotation.x = -Math.PI / 2; ring.position.y = 0.08; group.add(ring); b.ring = ring;

            const pl = new THREE.PointLight(col, 1.3, 46); pl.position.set(0, topY * 0.6, 0); group.add(pl);
            const lbl = makeLabel(dept.name, col); lbl.position.set(0, topY + 4, 0); group.add(lbl);
            scene.add(group);
            buildings.push(b);
        });

        // floating data motes
        const motes = new THREE.Group();
        for (let i = 0; i < 90; i++) {
            const m = new THREE.Mesh(new THREE.SphereGeometry(0.08, 6, 6),
                new THREE.MeshBasicMaterial({ color: 0x54a7dd, transparent: true, opacity: 0.5 }));
            m.position.set((Math.random() - 0.5) * 120, Math.random() * 26 + 1, (Math.random() - 0.5) * 120);
            (m.userData as { sp: number }).sp = 0.2 + Math.random() * 0.5; motes.add(m);
        }
        scene.add(motes);

        // ── theme application ────────────────────────────────────────────
        function applyMapTheme(name: ThemeMode) {
            curTheme = name;
            const T = MAP_THEME[curTheme];
            scene.background = new THREE.Color(T.bg);
            scene.fog = new THREE.FogExp2(T.fog, T.fogD);
            amb.color.setHex(T.amb); amb.intensity = T.ambI;
            key.color.setHex(T.key); key.intensity = T.keyI;
            rim.color.setHex(T.rim); rim.intensity = T.rimI;
            (grid.material as THREE.LineBasicMaterial).color.setHex(T.grid1);
            (grid.material as THREE.Material).opacity = curTheme === "light" ? 0.5 : 0.3;
            (plate.material as THREE.MeshBasicMaterial).color.setHex(T.plate);
            (plate.material as THREE.Material).opacity = T.plateO;
            buildings.forEach(b => {
                b.reg.bodies.forEach(m => {
                    const mat = m.material as THREE.MeshStandardMaterial;
                    mat.color.setHex(T.body); mat.metalness = T.bodyMetal; mat.roughness = T.bodyRough;
                    if (selected !== b) mat.emissiveIntensity = T.emI;
                });
            });
            accentMats.forEach(m => m.color.setHex(T.accent));
        }
        applyThemeRef.current = applyMapTheme;

        // ── orbit camera (auto-spin + drag), zoom via buttons ────────────
        const target = new THREE.Vector3(0, 8, 0);
        let theta = 0.7, phi = 1.02;
        let radius = Math.min(130, Math.max(46, spacing * Math.max(cols, rowsN) * 0.62 + 26));
        const minR = 32, maxR = 180, minPhi = 0.18, maxPhi = 1.5;
        function applyCam() {
            camera.position.x = target.x + radius * Math.sin(phi) * Math.cos(theta);
            camera.position.y = target.y + radius * Math.cos(phi);
            camera.position.z = target.z + radius * Math.sin(phi) * Math.sin(theta);
            camera.lookAt(target);
        }
        applyCam();

        let dragging = false, lastX = 0, lastY = 0, moved = 0, auto = true;
        let idle: ReturnType<typeof setTimeout> | null = null;
        function pauseAuto() { auto = false; if (idle) clearTimeout(idle); idle = setTimeout(() => { auto = true; }, 2600); }
        function onDown(x: number, y: number) { dragging = true; lastX = x; lastY = y; moved = 0; auto = false; if (idle) clearTimeout(idle); }
        function onMove(x: number, y: number) {
            if (!dragging) return;
            const dx = x - lastX, dy = y - lastY; lastX = x; lastY = y; moved += Math.abs(dx) + Math.abs(dy);
            theta -= dx * 0.005; phi = Math.max(minPhi, Math.min(maxPhi, phi - dy * 0.005)); applyCam();
        }
        function onUp() { if (dragging) { dragging = false; pauseAuto(); } }
        const mdown = (e: MouseEvent) => onDown(e.clientX, e.clientY);
        const mmove = (e: MouseEvent) => onMove(e.clientX, e.clientY);
        dom.addEventListener("mousedown", mdown);
        window.addEventListener("mousemove", mmove);
        window.addEventListener("mouseup", onUp);
        dom.addEventListener("touchstart", e => onDown(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
        dom.addEventListener("touchmove", e => onMove(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
        dom.addEventListener("touchend", onUp);

        zoomRef.current = (delta: number) => { radius = Math.max(minR, Math.min(maxR, radius + delta)); applyCam(); pauseAuto(); };

        // ── picking + holo card ──────────────────────────────────────────
        const ray = new THREE.Raycaster(), mouse = new THREE.Vector2();
        let selected: B | null = null;
        const holo = holoRef.current;

        function toNdc(e: MouseEvent) {
            const rect = dom.getBoundingClientRect();
            mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
            mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        }
        function setAllDim(dim: boolean) {
            buildings.forEach(b => {
                if (b === selected) return;
                b.reg.bodies.forEach(m => ((m.material as THREE.MeshStandardMaterial).emissiveIntensity = dim ? 0.05 : MAP_THEME[curTheme].emI));
                b.reg.edges.forEach(e => ((e.material as THREE.Material).opacity = dim ? 0.28 : 0.85));
                (b.ring.material as THREE.Material).opacity = dim ? 0.15 : 0.45;
            });
        }
        function clearSelect() {
            if (selected) {
                selected.reg.bodies.forEach(m => ((m.material as THREE.MeshStandardMaterial).emissiveIntensity = MAP_THEME[curTheme].emI));
                selected.reg.edges.forEach(e => ((e.material as THREE.Material).opacity = 0.85));
                selected = null;
            }
            setAllDim(false);
        }
        function selectBuilding(b: B) {
            clearSelect(); selected = b; setAllDim(true);
            b.reg.bodies.forEach(m => ((m.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.72));
            b.reg.edges.forEach(e => ((e.material as THREE.Material).opacity = 1));
            if (!holo) return;
            const d = b.dept;
            const hex = "#" + b.col.toString(16).padStart(6, "0");
            holo.style.setProperty("--hc", hex);
            (holo.querySelector(".ml-tag") as HTMLElement).textContent = `${d.dominantRisk} risk`;
            (holo.querySelector("h2") as HTMLElement).textContent = d.name;
            (holo.querySelector(".ml-hsub") as HTMLElement).textContent = "Department · aggregate, de-identified";
            const cells = holo.querySelectorAll(".ml-cell .ml-cv");
            (cells[0] as HTMLElement).textContent = `${d.participationPct}%`;
            (cells[1] as HTMLElement).textContent = `${d.atRiskPct}%`;
            (cells[2] as HTMLElement).textContent = `${d.completed}/${d.eligible}`;
            (holo.querySelectorAll(".ml-cell .ml-ck")[0] as HTMLElement).textContent = "Participation";
            (holo.querySelectorAll(".ml-cell .ml-ck")[1] as HTMLElement).textContent = "At-Risk";
            (holo.querySelectorAll(".ml-cell .ml-ck")[2] as HTMLElement).textContent = "Assessed";
            (holo.querySelector(".ml-meter i") as HTMLElement).style.width = d.participationPct + "%";
            (holo.querySelector(".ml-desc") as HTMLElement).textContent =
                `${d.completed} of ${d.eligible} staff assessed · ${d.atRiskPct}% in Moderate/High burnout${d.avgScore != null ? ` · avg score ${d.avgScore}` : ""}.`;
            holo.classList.add("show");
        }
        function closeHolo() { holo?.classList.remove("show"); clearSelect(); }

        const clickHandler = (e: MouseEvent) => {
            if (moved >= 6) return;
            toNdc(e); ray.setFromCamera(mouse, camera);
            const hit = ray.intersectObjects(pickables, false)[0];
            if (hit && (hit.object.userData as { b?: B }).b) {
                selectBuilding((hit.object.userData as { b: B }).b);
            } else if (selected) { closeHolo(); }
        };
        dom.addEventListener("click", clickHandler);
        const hoverHandler = (e: MouseEvent) => {
            if (dragging) { dom.style.cursor = "grabbing"; return; }
            toNdc(e); ray.setFromCamera(mouse, camera);
            dom.style.cursor = ray.intersectObjects(pickables, false)[0] ? "pointer" : "grab";
        };
        dom.addEventListener("mousemove", hoverHandler);
        const closeBtn = holo?.querySelector(".ml-close") as HTMLElement | null;
        const closeFn = (e: Event) => { e.stopPropagation(); closeHolo(); };
        closeBtn?.addEventListener("click", closeFn);

        // ── render loop ──────────────────────────────────────────────────
        const clock = new THREE.Clock();
        let raf = 0;
        function animate() {
            raf = requestAnimationFrame(animate);
            const t = clock.getElapsedTime();
            if (auto) { theta += 0.0022; applyCam(); }
            buildings.forEach((b, i) => {
                const pulse = 0.5 + Math.sin(t * 1.5 + i) * 0.2;
                if (selected === b) { (b.ring.material as THREE.Material).opacity = 0.95; (b.glow.material as THREE.Material).opacity = 1; }
                else if (selected) { (b.ring.material as THREE.Material).opacity = 0.12; (b.glow.material as THREE.Material).opacity = 0.3; }
                else { (b.ring.material as THREE.Material).opacity = pulse; (b.glow.material as THREE.Material).opacity = 0.6 + Math.sin(t * 1.2 + i) * 0.2; }
            });
            motes.children.forEach(m => {
                const mm = m as THREE.Mesh;
                mm.position.y += (mm.userData as { sp: number }).sp * 0.01;
                if (mm.position.y > 28) mm.position.y = 1;
                (mm.material as THREE.Material).opacity = 0.3 + Math.sin(t * 2 + mm.position.x) * 0.25;
            });
            renderer.render(scene, camera);
        }
        applyMapTheme(themeRef.current);
        animate();

        const onResize = () => {
            const nW = mount.clientWidth, nH = mount.clientHeight;
            camera.aspect = nW / nH; camera.updateProjectionMatrix(); renderer.setSize(nW, nH);
        };
        window.addEventListener("resize", onResize);

        return () => {
            cancelAnimationFrame(raf);
            window.removeEventListener("resize", onResize);
            window.removeEventListener("mousemove", mmove);
            window.removeEventListener("mouseup", onUp);
            closeBtn?.removeEventListener("click", closeFn);
            applyThemeRef.current = undefined;
            zoomRef.current = undefined;
            glowTex.dispose();
            renderer.dispose();
            scene.traverse(obj => {
                const any = obj as THREE.Mesh;
                if (any.geometry) any.geometry.dispose();
                const mat = (any as THREE.Mesh).material;
                if (Array.isArray(mat)) mat.forEach(m => m.dispose());
                else if (mat) (mat as THREE.Material).dispose();
            });
            if (mount.contains(dom)) mount.removeChild(dom);
        };
    }, [data]);

    // ── derived stats for the cards ──────────────────────────────────────
    const total = data?.totalGuests ?? 0;
    const done = data?.surveysCompleted ?? 0;
    const participants = data?.participants ?? 0;
    const participation = total > 0 ? Math.round((participants / total) * 100) : 0;
    const rc = data?.riskCounts ?? { Low: 0, Moderate: 0, High: 0 };
    const atRisk = rc.High + rc.Moderate;
    const riskTotal = rc.Low + rc.Moderate + rc.High;
    const atRiskPct = riskTotal > 0 ? Math.round((atRisk / riskTotal) * 100) : 0;
    const maxBand = Math.max(1, rc.Low, rc.Moderate, rc.High);
    const departments = data?.departments ?? [];
    const isEmpty = departments.length === 0;

    const donutR = 50, donutCirc = 2 * Math.PI * donutR;
    const donutDash = (participation / 100) * donutCirc;

    // "Where to Focus" derived purely from real risk/participation numbers
    const focus: { title: string; detail: string }[] = [];
    if (rc.High > 0) focus.push({ title: "Prioritise High-risk outreach", detail: `${rc.High} ${rc.High === 1 ? "person is" : "people are"} in the High burnout band — schedule check-ins first.` });
    if (rc.Moderate > 0) focus.push({ title: "Monitor Moderate-risk staff", detail: `${rc.Moderate} ${rc.Moderate === 1 ? "person sits" : "people sit"} in the Moderate band — watch for escalation.` });
    if (total > participants) focus.push({ title: "Lift participation", detail: `${total - participants} of ${total} staff have not completed an assessment yet.` });
    if (focus.length === 0) focus.push({ title: riskTotal > 0 ? "All assessed staff are Low-risk" : "Awaiting first assessment", detail: riskTotal > 0 ? "No Moderate or High burnout detected in current data." : "Encourage staff to complete the voice assessment to populate this view." });

    return (
        <div className={`ml${theme === "light" ? " ml-light" : theme === "dark" ? " ml-dark" : ""}`}>
            {loading && (
                <div className="ml-loader">
                    <div className="ml-ring" />
                    <p>Initializing digital twin</p>
                </div>
            )}

            {/* Scroll container — cards scroll over the sticky campus canvas */}
            <div className="ml-scroll">
                {/* Three.js campus canvas (sticky full-frame background) */}
                <div ref={mountRef} className="ml-canvas" />

                {/* Content overlay (transparent; drags fall through to the canvas) */}
                <div className="ml-overlay">
                <section className="ml-hero">
                    <div className="ml-map-head">
                        <div>
                            <p className="ml-eyebrow">Live Assessment Map</p>
                            <h2>Wellbeing across the organisation</h2>
                        </div>
                        <span className="ml-badge ml-b-cyan">Interactive · click a building</span>
                    </div>
                    <div className="ml-map-controls">
                        <div className="ml-map-legend">
                            <span><i style={{ background: "var(--green)", color: "var(--green)" }} />Low</span>
                            <span><i style={{ background: "var(--amber)", color: "var(--amber)" }} />Moderate</span>
                            <span><i style={{ background: "var(--rose)", color: "var(--rose)" }} />High</span>
                        </div>
                        <div className="ml-zoom-controls">
                            <span className="ml-drag-note">Drag to rotate</span>
                            <button className="ml-zoom-btn" aria-label="Zoom out" onClick={() => zoomRef.current?.(14)}>−</button>
                            <button className="ml-zoom-btn" aria-label="Zoom in" onClick={() => zoomRef.current?.(-14)}>+</button>
                        </div>
                    </div>
                    {isEmpty && !loading && (
                        <div style={{ position: "absolute", left: "50%", top: "42%", transform: "translate(-50%,-50%)", textAlign: "center", pointerEvents: "none" }}>
                            <p style={{ color: "var(--bright)", fontSize: 18, fontWeight: 700, margin: 0 }}>Awaiting first assessment</p>
                            <p style={{ color: "var(--muted)", fontSize: 12, margin: "6px 0 0" }}>Buildings appear here as staff complete the voice assessment.</p>
                        </div>
                    )}

                    {/* Holographic detail card — floats over the map (top-right), filled imperatively on building click */}
                    <div ref={holoRef} className="ml-holo">
                        <div className="ml-holo-card">
                            <div className="ml-close">×</div>
                            <span className="ml-tag">—</span>
                            <h2>—</h2>
                            <p className="ml-hsub">—</p>
                            <div className="ml-stats">
                                <div className="ml-cell"><span className="ml-ck">Risk</span><span className="ml-cv">—</span></div>
                                <div className="ml-cell"><span className="ml-ck">Score</span><span className="ml-cv">—</span></div>
                                <div className="ml-cell"><span className="ml-ck">Date</span><span className="ml-cv">—</span></div>
                            </div>
                            <div className="ml-meter"><i style={{ width: "0%" }} /></div>
                            <p className="ml-desc">—</p>
                            <p className="ml-foot">Aggregate, de-identified signal — no individual reports.</p>
                        </div>
                    </div>
                </section>

                <div className="ml-cards">
                    <div className="ml-grid">
                        {/* Where to Focus */}
                        <div className="ml-card ml-pad ml-span12">
                            <div className="ml-sec-h">
                                <h2>Where to Focus</h2>
                                <span className="ml-badge ml-b-amber">Actions · aggregate</span>
                            </div>
                            <div className="ml-focus-grid">
                                {focus.map((f, i) => (
                                    <div className="ml-act" key={i}>
                                        <div className="ml-n">{i + 1}</div>
                                        <div><b>{f.title}</b><span>{f.detail}</span></div>
                                    </div>
                                ))}
                            </div>
                        </div>

                        {/* Risk distribution */}
                        <div className="ml-card ml-pad ml-span4">
                            <div className="ml-sec-h">
                                <h2>Risk Distribution</h2>
                                <span className="ml-badge ml-b-muted">{riskTotal} assessed</span>
                            </div>
                            {(["High", "Moderate", "Low"] as const).map(level => {
                                const count = rc[level];
                                const widthPct = Math.round((count / maxBand) * 100);
                                const sharePct = riskTotal > 0 ? Math.round((count / riskTotal) * 100) : 0;
                                return (
                                    <div className="ml-risk" key={level}>
                                        <label>{level}</label>
                                        <div className="ml-rtrack">
                                            <div className={`ml-rfill ${riskFill(level)}`} style={{ width: `${widthPct}%` }} />
                                        </div>
                                        <b>{count} <small>{sharePct}%</small></b>
                                    </div>
                                );
                            })}
                        </div>

                        {/* Participation donut */}
                        <div className="ml-card ml-pad ml-span4">
                            <div className="ml-sec-h"><h2>Participation</h2><span className="ml-badge ml-b-cyan">Took vs not</span></div>
                            <div className="ml-donut-wrap">
                                <div className="ml-donut" style={{ position: "relative" }}>
                                    <svg width="112" height="112" viewBox="0 0 112 112" style={{ display: "block" }}>
                                        <circle cx="56" cy="56" r={donutR} fill="none" stroke="rgba(84,167,221,.14)" strokeWidth="10" />
                                        <circle cx="56" cy="56" r={donutR} fill="none"
                                            stroke={participation >= 75 ? "var(--green)" : participation >= 40 ? "var(--amber)" : "var(--rose)"}
                                            strokeWidth="10" strokeDasharray={`${donutDash} ${donutCirc}`} strokeLinecap="round" transform="rotate(-90 56 56)" />
                                    </svg>
                                    <div className="ml-inner" style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)" }}>
                                        <b>{participation}%</b><span>completed</span>
                                    </div>
                                </div>
                                <div>
                                    <p className="ml-pcov"><b>{participants}</b> of <b>{total}</b> staff have completed at least one assessment.</p>
                                    <div className="ml-leg">
                                        <span><i style={{ background: "var(--green)" }} />Assessed</span>
                                        <span><i style={{ background: "rgba(255,112,136,.4)" }} />Not yet</span>
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* Org snapshot — headline totals consolidated into one card */}
                        <div className="ml-card ml-pad ml-span4">
                            <div className="ml-sec-h"><h2>Org Snapshot</h2><span className="ml-badge ml-b-muted">Totals</span></div>
                            <div className="ml-snap">
                                <div className="ml-snap-row">
                                    <div>
                                        <p className="ml-snap-k">Total Staff</p>
                                        <p className="ml-snap-t">Active employees in system</p>
                                    </div>
                                    <b className="ml-snap-v">{total}</b>
                                </div>
                                <div className="ml-snap-row">
                                    <div>
                                        <p className="ml-snap-k">Surveys Completed</p>
                                        <p className="ml-snap-t">Total assessment runs</p>
                                    </div>
                                    <b className="ml-snap-v" style={{ color: "var(--cyan)" }}>{done}</b>
                                </div>
                                <div className="ml-snap-row">
                                    <div>
                                        <p className="ml-snap-k">At-Risk Share</p>
                                        <p className="ml-snap-t">{atRisk} of {riskTotal} · mod + high</p>
                                    </div>
                                    <b className="ml-snap-v" style={{ color: atRisk > 0 ? "var(--rose)" : "var(--green)" }}>{atRiskPct}%</b>
                                </div>
                            </div>
                        </div>

                        {/* Assessment analytics — filterable visualization */}
                        <ManagerAnalytics />

                        {/* Monthly burnout trend (wide) + wellbeing chat (narrow), 6:4 */}
                        <div className="ml-span12 ml-duo">
                            <ManagerScoreTrend />
                            <ManagerChat />
                        </div>
                    </div>

                    <p className="ml-note">
                        Grouped, anonymised signals only — never personal reports, biometrics, transcripts or identities.
                        Risk levels come from the deterministic BAT scoring pipeline. A wellness tool; it does not diagnose, treat or prescribe.
                    </p>
                </div>
                </div>
            </div>
        </div>
    );
}
