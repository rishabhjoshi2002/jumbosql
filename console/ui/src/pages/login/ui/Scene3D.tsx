import { FC, useEffect, useRef, useState } from 'react';
import { Box } from '@mui/material';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import ClusterScene from './ClusterScene.tsx';

/**
 * The sign-in scene in real 3D (WebGL): a KeenPG cluster on a glossy floor - the primary database in the middle,
 * two replicas and a backup vault around it - lit like a product shot. WAL flows from the primary to the others
 * along arched glass tubes in one steady rhythm, the primary sends a heartbeat across the floor, and the camera
 * drifts slowly and follows the mouse a little. Without WebGL (or with reduced motion asked for) it falls back to
 * the vector drawing / a still frame.
 */

const C = {
  bg: 0x07172a,
  floor: 0x0b2238,
  grid: 0x184466,
  body: 0x0f4fb8,
  bodyDark: 0x0a347a,
  cap: 0x2a74de,
  teal: 0x14d0e0,
  green: 0x2bd18b,
  vault: 0x0e2c4a,
};

type Node = { name: string; sub: string; pos: THREE.Vector3; accent: number };

const label = (name: string, sub: string, accent: string) => {
  const el = document.createElement('div');
  el.style.cssText =
    'padding:6px 12px;border-radius:999px;background:rgba(7,23,42,.72);border:1px solid rgba(120,180,255,.25);' +
    'backdrop-filter:blur(6px);color:#E6EEF8;font:600 12.5px "Plus Jakarta Sans",system-ui,sans-serif;' +
    'white-space:nowrap;display:flex;gap:8px;align-items:center;box-shadow:0 6px 18px rgba(0,0,0,.35);pointer-events:none';
  el.innerHTML = `<span style="width:8px;height:8px;border-radius:50%;background:${accent};box-shadow:0 0 10px ${accent}"></span><span>${name}</span><span style="color:#93A9C6;font-weight:500;margin-left:2px">${sub}</span>`;
  return new CSS2DObject(el);
};

/** a database: stacked glossy discs with glowing seams, like the cylinder in the logo */
const database = (radius: number, discs: number, accent: number) => {
  const g = new THREE.Group();
  const body = new THREE.MeshPhysicalMaterial({
    color: C.body,
    metalness: 0.35,
    roughness: 0.22,
    clearcoat: 1,
    clearcoatRoughness: 0.12,
  });
  const dark = new THREE.MeshPhysicalMaterial({ color: C.bodyDark, metalness: 0.4, roughness: 0.3, clearcoat: 0.6 });
  const glow = new THREE.MeshStandardMaterial({
    color: accent,
    emissive: accent,
    emissiveIntensity: 1.6,
    roughness: 0.4,
  });
  const h = 0.62;
  for (let i = 0; i < discs; i++) {
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, h, 72, 1), i % 2 ? dark : body);
    disc.position.y = h / 2 + i * (h + 0.07);
    disc.castShadow = true;
    disc.receiveShadow = true;
    g.add(disc);
    if (i < discs - 1) {
      const seam = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.985, radius * 0.985, 0.07, 72, 1, true), glow);
      seam.position.y = h + i * (h + 0.07) + 0.035;
      g.add(seam);
    }
  }
  const top = discs * (h + 0.07) - 0.07;
  const cap = new THREE.Mesh(
    new THREE.CylinderGeometry(radius * 1.0, radius * 1.0, 0.06, 72),
    new THREE.MeshPhysicalMaterial({ color: C.cap, metalness: 0.2, roughness: 0.15, clearcoat: 1 }),
  );
  cap.position.y = top + 0.03;
  g.add(cap);
  // a status ring on the top
  const ring = new THREE.Mesh(new THREE.TorusGeometry(radius * 0.55, 0.035, 12, 96), glow);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = top + 0.07;
  g.add(ring);
  return { group: g, height: top + 0.1 };
};

/** the backup vault: a rounded block with glowing drive slots */
const vault = () => {
  const g = new THREE.Group();
  const box = new THREE.Mesh(
    new RoundedBoxGeometry(2.1, 1.25, 1.5, 6, 0.14),
    new THREE.MeshPhysicalMaterial({ color: C.vault, metalness: 0.5, roughness: 0.45, clearcoat: 0.2 }),
  );
  box.position.y = 0.625;
  box.castShadow = true;
  box.receiveShadow = true;
  g.add(box);
  const slot = new THREE.MeshStandardMaterial({ color: C.green, emissive: C.green, emissiveIntensity: 1.8 });
  for (let i = 0; i < 3; i++) {
    const s = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.06, 0.02), slot);
    s.position.set(0, 0.32 + i * 0.3, 0.76);
    g.add(s);
  }
  return { group: g, height: 1.3 };
};

const Scene3D: FC = () => {
  const host = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    } catch {
      setFailed(true);
      return;
    }
    const W = () => el.clientWidth || 1;
    const H = () => el.clientHeight || 1;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(W(), H());
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.92;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.domElement.style.display = 'block';
    el.appendChild(renderer.domElement);

    const labels = new CSS2DRenderer();
    labels.setSize(W(), H());
    labels.domElement.style.cssText = 'position:absolute;inset:0;pointer-events:none';
    el.appendChild(labels.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(C.bg);
    scene.fog = new THREE.FogExp2(C.bg, 0.05);
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.32;

    const camera = new THREE.PerspectiveCamera(34, W() / H(), 0.1, 100);
    const target = new THREE.Vector3(0, 1.5, 0.4);

    // light: a soft sky, a key light with shadows, a blue rim from behind, a green glow under the primary
    scene.add(new THREE.HemisphereLight(0x7fbaff, 0x061220, 0.35));
    const key = new THREE.DirectionalLight(0xffffff, 1.7);
    key.position.set(6, 11, 6);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -9;
    key.shadow.camera.right = 9;
    key.shadow.camera.top = 9;
    key.shadow.camera.bottom = -9;
    key.shadow.radius = 6;
    key.shadow.bias = -0.0004;
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x3aa0ff, 1.6);
    rim.position.set(-6, 5, -8);
    scene.add(rim);
    const under = new THREE.PointLight(C.green, 2.2, 5, 2);
    under.position.set(0, 0.4, 0);
    scene.add(under);

    // the floor: glossy, with a fine grid that fades into the fog
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(30, 96),
      new THREE.MeshStandardMaterial({ color: C.floor, metalness: 0.45, roughness: 0.55 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);
    const grid = new THREE.GridHelper(40, 40, C.grid, C.grid);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.55;
    grid.position.y = 0.002;
    scene.add(grid);

    // the cluster
    const nodes: Node[] = [
      { name: 'Primary', sub: 'read · write', pos: new THREE.Vector3(0, 0, 0), accent: C.green },
      { name: 'Replica', sub: 'streaming', pos: new THREE.Vector3(3.7, 0, -2.2), accent: C.teal },
      { name: 'Replica', sub: 'streaming', pos: new THREE.Vector3(-3.2, 0, 2.8), accent: C.teal },
      { name: 'Backup', sub: 'pgBackRest', pos: new THREE.Vector3(-4.2, 0, -1.4), accent: C.green },
    ];
    const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;
    nodes.forEach((n, i) => {
      const m = i === 3 ? vault() : database(i === 0 ? 1.15 : 0.85, i === 0 ? 4 : 3, n.accent);
      m.group.position.copy(n.pos);
      if (i === 3) m.group.rotation.y = 0.72; // the vault faces the camera
      scene.add(m.group);
      const l = label(n.name, n.sub, hex(n.accent));
      l.position.set(n.pos.x, m.height + (i === 0 ? 0.9 : 0.5), n.pos.z);
      scene.add(l);
    });

    // WAL: arched glass tubes from the primary, with packets moving in one rhythm
    const tubeMat = new THREE.MeshPhysicalMaterial({
      color: 0x6fc8ff,
      transparent: true,
      opacity: 0.18,
      roughness: 0.05,
      metalness: 0,
      transmission: 0.6,
      thickness: 0.2,
    });
    const flows = nodes.slice(1).map((n, i) => {
      const from = new THREE.Vector3(0, 1.2, 0);
      const to = new THREE.Vector3(n.pos.x, i === 2 ? 0.7 : 1.0, n.pos.z);
      const dir = to.clone().sub(from).setY(0).normalize();
      const start = from.clone().add(dir.clone().multiplyScalar(1.2));
      const end = to.clone().sub(dir.clone().multiplyScalar(i === 2 ? 1.2 : 0.95));
      const mid = start
        .clone()
        .lerp(end, 0.5)
        .add(new THREE.Vector3(0, 1.4, 0));
      const curve = new THREE.QuadraticBezierCurve3(start, mid, end);
      scene.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 64, 0.06, 12, false), tubeMat));
      const color = i === 2 ? C.green : C.teal;
      const packetMat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 3 });
      const packets = Array.from({ length: 5 }, () => {
        const p = new THREE.Mesh(new THREE.SphereGeometry(0.075, 16, 16), packetMat);
        scene.add(p);
        return p;
      });
      return { curve, packets };
    });

    // the primary's heartbeat: a ring spreading on the floor
    const pulseMat = new THREE.MeshBasicMaterial({
      color: C.green,
      transparent: true,
      opacity: 0.6,
      side: THREE.DoubleSide,
    });
    const pulse = new THREE.Mesh(new THREE.RingGeometry(1.25, 1.33, 96), pulseMat);
    pulse.rotation.x = -Math.PI / 2;
    pulse.position.y = 0.01;
    scene.add(pulse);

    // glow on the bright parts
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(W(), H()), 0.55, 0.45, 0.72);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());

    const mouse = { x: 0, y: 0, tx: 0, ty: 0 };
    const onMove = (e: MouseEvent) => {
      const r = el.getBoundingClientRect();
      mouse.tx = (e.clientX - r.left) / r.width - 0.5;
      mouse.ty = (e.clientY - r.top) / r.height - 0.5;
    };
    window.addEventListener('mousemove', onMove);

    const clock = new THREE.Clock();
    let raf = 0;
    // a slow machine (no graphics card): fewer pixels and no glow, so the page stays smooth
    let frames = 0;
    let spent = 0;
    let light = false;
    let last = performance.now();
    const frame = () => {
      const now = performance.now();
      if (!light && frames++ > 5 && frames < 25) {
        spent += now - last;
        if (frames === 24 && spent / 18 > 34) {
          light = true;
          renderer.setPixelRatio(1);
          composer.setPixelRatio(1);
          bloom.enabled = false;
          renderer.shadowMap.enabled = false;
        }
      }
      last = now;
      const t = still ? 2 : clock.getElapsedTime();
      mouse.x += (mouse.tx - mouse.x) * 0.05;
      mouse.y += (mouse.ty - mouse.y) * 0.05;
      const angle = 0.72 + Math.sin(t * 0.07) * 0.18 + mouse.x * 0.35;
      const dist = 16;
      camera.position.set(Math.sin(angle) * dist, 7.4 - mouse.y * 1.6, Math.cos(angle) * dist);
      camera.lookAt(target);

      flows.forEach((f, k) => {
        f.packets.forEach((p, i) => {
          const u = (t * 0.32 + i / f.packets.length + k * 0.11) % 1;
          p.position.copy(f.curve.getPoint(u));
          p.scale.setScalar(0.6 + Math.sin(u * Math.PI) * 0.6);
        });
      });
      const ph = (t % 2.4) / 2.4;
      pulse.scale.setScalar(1 + ph * 1.6);
      pulseMat.opacity = 0.55 * (1 - ph);
      under.intensity = 2 + Math.sin(t * 2.6) * 0.5;

      composer.render();
      labels.render(scene, camera);
      if (!still) raf = requestAnimationFrame(frame);
    };

    const resize = () => {
      camera.aspect = W() / H();
      // keep the whole cluster in view on narrow screens
      camera.fov = camera.aspect < 1.3 ? 44 : 34;
      camera.updateProjectionMatrix();
      renderer.setSize(W(), H());
      composer.setSize(W(), H());
      labels.setSize(W(), H());
      // on a phone the names would crowd the picture
      labels.domElement.style.display = W() < 600 ? 'none' : 'block';
      if (still) frame();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    const onVisible = () => {
      cancelAnimationFrame(raf);
      if (!document.hidden && !still) raf = requestAnimationFrame(frame);
    };
    document.addEventListener('visibilitychange', onVisible);
    resize();
    frame();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('mousemove', onMove);
      document.removeEventListener('visibilitychange', onVisible);
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        (Array.isArray(mat) ? mat : mat ? [mat] : []).forEach((x) => x.dispose());
      });
      pmrem.dispose();
      composer.dispose();
      renderer.dispose();
      el.innerHTML = '';
    };
  }, []);

  if (failed) {
    return (
      <Box sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', p: 6 }}>
        <Box sx={{ width: '100%', maxWidth: 600 }}>
          <ClusterScene />
        </Box>
      </Box>
    );
  }
  return <Box ref={host} aria-hidden sx={{ position: 'absolute', inset: 0, overflow: 'hidden' }} />;
};

export default Scene3D;
