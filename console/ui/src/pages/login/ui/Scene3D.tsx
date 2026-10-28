import { FC, useEffect, useRef, useState } from 'react';
import { Box } from '@mui/material';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { BrandLogo } from '@shared/ui/brand';
import logoSrc from '@shared/assets/keenpgLogo.png';

/**
 * The sign-in scene in real 3D (WebGL), on a light background: the KeenPG logo on a white glass badge at the
 * centre, inside a protective lattice, and the six things KeenPG does for you on glass tiles that orbit it
 * in one steady ring - secure, automated, backups, high availability, insights, upgrades. Thin links run from the
 * core to every tile with a pulse travelling out, the camera follows the mouse a little. Slow machines get fewer
 * pixels and no shadows; reduced motion gets a still frame; without WebGL the logo is shown instead.
 */

// icon outlines (Material icons, 24 x 24)
const ICON = {
  secure: 'M12 1 3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5zm-2 16-4-4 1.41-1.41L10 14.17l6.59-6.59L18 9z',
  auto: 'M17.41 6.59 15 5.5l2.41-1.09L18.5 2l1.09 2.41L22 5.5l-2.41 1.09L18.5 9zm3.87 6.13L20.5 11l-.78 1.72-1.72.78 1.72.78.78 1.72.78-1.72L23 13.5zm-5.04 1.65 1.94 1.47-2.5 4.33-2.24-.94c-.2.13-.42.26-.64.37l-.3 2.4h-5l-.3-2.41c-.22-.11-.43-.23-.64-.37l-2.24.94-2.5-4.33 1.94-1.47c-.01-.11-.01-.24-.01-.36s0-.25.01-.37l-1.94-1.47 2.5-4.33 2.24.94c.2-.13.42-.26.64-.37L7.5 6h5l.3 2.41c.22.11.43.23.64.37l2.24-.94 2.5 4.33-1.94 1.47c.01.12.01.24.01.37s0 .24-.01.36M13 14c0-1.66-1.34-3-3-3s-3 1.34-3 3 1.34 3 3 3 3-1.34 3-3',
  backup:
    'M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96M14 13v4h-4v-4H7l5-5 5 5z',
  ha: 'M8.4 18.2c.38.5.6 1.12.6 1.8 0 1.66-1.34 3-3 3s-3-1.34-3-3 1.34-3 3-3c.44 0 .85.09 1.23.26l1.41-1.77c-.92-1.03-1.29-2.39-1.09-3.69l-2.03-.68c-.54.83-1.46 1.38-2.52 1.38-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3c0 .07 0 .14-.01.21l2.03.68c.64-1.21 1.82-2.09 3.22-2.32V5.91C9.96 5.57 9 4.4 9 3c0-1.66 1.34-3 3-3s3 1.34 3 3c0 1.4-.96 2.57-2.25 2.91v2.16c1.4.23 2.58 1.11 3.22 2.32L18 9.71V9.5c0-1.66 1.34-3 3-3s3 1.34 3 3-1.34 3-3 3c-1.06 0-1.98-.55-2.52-1.37l-2.03.68c.2 1.29-.16 2.65-1.09 3.69l1.41 1.77Q17.34 17 18 17c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3c0-.68.22-1.3.6-1.8l-1.41-1.77c-1.35.75-3.01.76-4.37 0z',
  insights:
    'M21 8c-1.45 0-2.26 1.44-1.93 2.51l-3.55 3.56c-.3-.09-.74-.09-1.04 0l-2.55-2.55C12.27 10.45 11.46 9 10 9c-1.45 0-2.27 1.44-1.93 2.52l-4.56 4.55C2.44 15.74 1 16.55 1 18c0 1.1.9 2 2 2 1.45 0 2.26-1.44 1.93-2.51l4.55-4.56c.3.09.74.09 1.04 0l2.55 2.55C12.73 16.55 13.54 18 15 18c1.45 0 2.27-1.44 1.93-2.52l3.56-3.55c1.07.33 2.51-.48 2.51-1.93 0-1.1-.9-2-2-2m-6 1 .94-2.07L18 6l-2.06-.93L15 3l-.92 2.07L12 6l2.08.93zM3.5 11 4 9l2-.5L4 8l-.5-2L3 8l-2 .5L3 9z',
  upgrade: 'M16 18v2H8v-2zM11 7.99V16h2V7.99h3L12 4 8 7.99z',
};

const TILES: { icon: keyof typeof ICON; title: string; sub: string; from: string; to: string }[] = [
  { icon: 'secure', title: 'Secure', sub: 'Access policies and audit', from: '#4B3AC4', to: '#7B5CF0' },
  { icon: 'auto', title: 'Automated', sub: 'Build and run clusters', from: '#F5A10F', to: '#F07A1A' },
  { icon: 'backup', title: 'Backups', sub: 'Restore to any second', from: '#F07A1A', to: '#4B3AC4' },
  { icon: 'ha', title: 'High Availability', sub: 'Failover in seconds', from: '#F5A10F', to: '#F07A1A' },
  { icon: 'insights', title: 'Insights', sub: 'Health and forecasts', from: '#4B3AC4', to: '#7B5CF0' },
  { icon: 'upgrade', title: 'Upgrades', sub: 'Always with a rollback', from: '#F07A1A', to: '#4B3AC4' },
];

/** the front of a tile: an icon on a coloured chip, the title and one line under it */
const tileTexture = (t: (typeof TILES)[number]) => {
  const c = document.createElement('canvas');
  c.width = 640;
  c.height = 400;
  const g = c.getContext('2d')!;
  // a clean white face (the glass body shows only at the edges)
  g.fillStyle = '#FFFFFF';
  g.beginPath();
  g.roundRect(2, 2, 636, 396, 40);
  g.fill();
  const chip = 128;
  const cx = 64;
  const cy = 64;
  const grad = g.createLinearGradient(cx, cy, cx + chip, cy + chip);
  grad.addColorStop(0, t.from);
  grad.addColorStop(1, t.to);
  g.fillStyle = grad;
  g.beginPath();
  g.roundRect(cx, cy, chip, chip, 32);
  g.fill();
  g.save();
  g.translate(cx + 22, cy + 22);
  g.scale(3.5, 3.5);
  g.fillStyle = '#FFFFFF';
  g.fill(new Path2D(ICON[t.icon]));
  g.restore();
  g.fillStyle = '#261C51';
  g.font = '700 54px "Plus Jakarta Sans", system-ui, sans-serif';
  g.fillText(t.title, 64, 270);
  g.fillStyle = '#5E5880';
  g.font = '500 34px "Plus Jakarta Sans", system-ui, sans-serif';
  g.fillText(t.sub, 64, 328);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
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
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    } catch {
      setFailed(true);
      return;
    }
    let disposed = false;
    const W = () => el.clientWidth || 1;
    const H = () => el.clientHeight || 1;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(W(), H());
    renderer.setClearColor(0x000000, 0);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.95;
    renderer.shadowMap.enabled = true;
    renderer.localClippingEnabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.domElement.style.display = 'block';
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.5;
    const camera = new THREE.PerspectiveCamera(34, W() / H(), 0.1, 100);
    const look = new THREE.Vector3(0, -0.7, 0);

    scene.add(new THREE.HemisphereLight(0xffffff, 0xe6e0ff, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 1.8);
    key.position.set(4, 10, 7);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = -8;
    key.shadow.camera.right = 8;
    key.shadow.camera.top = 8;
    key.shadow.camera.bottom = -8;
    key.shadow.radius = 8;
    scene.add(key);

    // the shadow on an invisible floor grounds the scene on the light background
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.ShadowMaterial({ opacity: 0.07 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -3.4;
    floor.receiveShadow = true;
    scene.add(floor);

    // the core: the KeenPG logo on a round white glass badge, always facing you, everything else turns around it
    const core = new THREE.Group();
    const badge = new THREE.Mesh(
      new THREE.CylinderGeometry(2.05, 2.05, 0.22, 96, 1),
      new THREE.MeshPhysicalMaterial({
        color: 0xffffff,
        emissive: 0xffffff,
        emissiveIntensity: 0.35,
        roughness: 0.2,
        clearcoat: 1,
        clearcoatRoughness: 0.1,
      }),
    );
    badge.rotation.x = Math.PI / 2;
    badge.castShadow = true;
    core.add(badge);
    // a thin gradient rim, blue to green like the logo
    const rimCanvas = document.createElement('canvas');
    rimCanvas.width = 256;
    rimCanvas.height = 4;
    const rg = rimCanvas.getContext('2d')!;
    const rgrad = rg.createLinearGradient(0, 0, 256, 0);
    ['#4B3AC4', '#7B5CF0', '#F5A10F', '#7B5CF0', '#4B3AC4'].forEach((c, i) => rgrad.addColorStop(i / 4, c));
    rg.fillStyle = rgrad;
    rg.fillRect(0, 0, 256, 4);
    const rimTex = new THREE.CanvasTexture(rimCanvas);
    rimTex.colorSpace = THREE.SRGBColorSpace;
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(2.08, 0.06, 16, 160),
      new THREE.MeshPhysicalMaterial({ map: rimTex, roughness: 0.3, metalness: 0.2, clearcoat: 1 }),
    );
    rim.position.z = 0.1;
    core.add(rim);
    const logoMat = new THREE.MeshBasicMaterial({ transparent: true, toneMapped: false, opacity: 0 });
    new THREE.TextureLoader().load(logoSrc, (tex) => {
      if (disposed) return tex.dispose();
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
      logoMat.map = tex;
      logoMat.opacity = 1;
      logoMat.needsUpdate = true;
      if (still) frame(); // the still frame is drawn again with the logo
    });
    const logo = new THREE.Mesh(new THREE.PlaneGeometry(3.3, 3.3 * (501 / 900)), logoMat);
    logo.position.set(0, 0.04, 0.125);
    core.add(logo);
    // a soft halo behind the badge
    const haloCanvas = document.createElement('canvas');
    haloCanvas.width = haloCanvas.height = 256;
    const hg = haloCanvas.getContext('2d')!;
    const hgrad = hg.createRadialGradient(128, 128, 60, 128, 128, 128);
    hgrad.addColorStop(0, 'rgba(123,92,240,0.28)');
    hgrad.addColorStop(1, 'rgba(123,92,240,0)');
    hg.fillStyle = hgrad;
    hg.fillRect(0, 0, 256, 256);
    const haloTex = new THREE.CanvasTexture(haloCanvas);
    const halo = new THREE.Mesh(
      new THREE.PlaneGeometry(7, 7),
      new THREE.MeshBasicMaterial({ map: haloTex, transparent: true, depthWrite: false }),
    );
    halo.position.z = -0.4;
    core.add(halo);
    scene.add(core);
    // the protective lattice around it
    const shell = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(2.9, 1)),
      // only the half behind the badge, like a cage around the logo
      new THREE.LineBasicMaterial({
        color: 0x9c8cf2,
        transparent: true,
        opacity: 0.4,
        clippingPlanes: [new THREE.Plane(new THREE.Vector3(0, 0, -1), 0)],
      }),
    );
    scene.add(shell);

    // the orbit: a tilted ring the tiles travel on
    const orbit = new THREE.Group();
    orbit.rotation.x = 0.3;
    orbit.rotation.z = -0.12;
    scene.add(orbit);
    const R = 4.6;
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(R, 0.018, 8, 200),
      new THREE.MeshBasicMaterial({ color: 0xa898f5, transparent: true, opacity: 0.7 }),
    );
    ring.rotation.x = Math.PI / 2;
    ring.scale.set(1.12, 0.8, 1);
    orbit.add(ring);

    // the tiles: glossy white glass with the capability on the front
    const bodyMat = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      roughness: 0.25,
      metalness: 0,
      clearcoat: 1,
      clearcoatRoughness: 0.15,
    });
    const tiles = TILES.map((t) => {
      const g = new THREE.Group();
      const body = new THREE.Mesh(new RoundedBoxGeometry(2.3, 1.44, 0.16, 5, 0.14), bodyMat);
      g.add(body);
      const face = new THREE.Mesh(
        new THREE.PlaneGeometry(2.3, 1.44),
        new THREE.MeshBasicMaterial({ map: tileTexture(t), transparent: true, toneMapped: false }),
      );
      face.position.z = 0.085;
      g.add(face);
      scene.add(g);
      return g;
    });
    // titles are drawn again once the web font is ready (canvas does not wait for it)
    void document.fonts?.ready.then(() => {
      if (disposed) return;
      tiles.forEach((g, i) => {
        const m = (g.children[1] as THREE.Mesh).material as THREE.MeshBasicMaterial;
        m.map?.dispose();
        m.map = tileTexture(TILES[i]);
        m.needsUpdate = true;
      });
    });

    // links from the core to each tile, with a pulse travelling out
    const linkMat = new THREE.LineBasicMaterial({ color: 0x9c8cf2, transparent: true, opacity: 0.5 });
    const pulseMat = new THREE.MeshBasicMaterial({ color: 0xf5a10f });
    const links = tiles.map(() => {
      const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
      const line = new THREE.Line(geo, linkMat);
      scene.add(line);
      const pulse = new THREE.Mesh(new THREE.SphereGeometry(0.07, 16, 16), pulseMat);
      scene.add(pulse);
      return { geo, pulse };
    });

    // fine dust drifting upwards, for depth
    const dustN = 140;
    const dustPos = new Float32Array(dustN * 3);
    for (let i = 0; i < dustN; i++) {
      dustPos[i * 3] = (Math.random() - 0.5) * 18;
      dustPos[i * 3 + 1] = (Math.random() - 0.5) * 9;
      dustPos[i * 3 + 2] = (Math.random() - 0.5) * 10;
    }
    const dustGeo = new THREE.BufferGeometry();
    dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
    const dust = new THREE.Points(
      dustGeo,
      new THREE.PointsMaterial({ color: 0x9c8cf2, size: 0.045, transparent: true, opacity: 0.55 }),
    );
    scene.add(dust);

    const mouse = { x: 0, y: 0, tx: 0, ty: 0 };
    const onMove = (e: MouseEvent) => {
      const r = el.getBoundingClientRect();
      mouse.tx = (e.clientX - r.left) / r.width - 0.5;
      mouse.ty = (e.clientY - r.top) / r.height - 0.5;
    };
    window.addEventListener('mousemove', onMove);

    const tmp = new THREE.Vector3();
    const edge = new THREE.Vector3();
    const clock = new THREE.Clock();
    let raf = 0;
    // a slow machine (no graphics card): fewer pixels and no shadows, so the page stays smooth
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
          renderer.shadowMap.enabled = false;
        }
      }
      last = now;
      const t = still ? 3 : clock.getElapsedTime();
      mouse.x += (mouse.tx - mouse.x) * 0.05;
      mouse.y += (mouse.ty - mouse.y) * 0.05;
      camera.position.set(mouse.x * 3, 2.2 - mouse.y * 1.8, 15);
      camera.lookAt(look);

      // the badge faces you, with a slow gentle sway so it reads as a solid object
      core.quaternion.copy(camera.quaternion);
      core.rotateY(Math.sin(t * 0.5) * 0.22);
      core.rotateX(Math.sin(t * 0.37) * 0.08);
      core.position.y = Math.sin(t * 0.8) * 0.1;
      shell.rotation.y = -t * 0.08;
      shell.rotation.z = t * 0.05;

      tiles.forEach((g, i) => {
        const a = t * 0.12 + (i / tiles.length) * Math.PI * 2;
        tmp.set(Math.cos(a) * R * 1.12, 0, Math.sin(a) * R * 0.8);
        orbit.localToWorld(tmp);
        g.position.copy(tmp);
        g.position.y += Math.sin(t * 0.9 + i) * 0.08;
        // tiles at the back rise over the core instead of hiding behind it
        g.position.y += Math.max(0, -Math.sin(a)) * 1.5;
        // a little towards the camera, so the ring and the links pass behind the tile
        g.position.lerp(camera.position, 0.05);
        g.quaternion.copy(camera.quaternion); // always readable
        // the same size on screen wherever the tile is, so every title stays readable
        g.scale.setScalar(g.position.distanceTo(camera.position) / 14.5);
        const { geo, pulse } = links[i];
        const p = geo.getAttribute('position') as THREE.BufferAttribute;
        // links leave from the badge's rim, so nothing crosses the logo
        edge.set(g.position.x - core.position.x, g.position.y - core.position.y, 0).setLength(2.14).add(core.position);
        p.setXYZ(0, edge.x, edge.y, edge.z);
        p.setXYZ(1, g.position.x, g.position.y, g.position.z);
        p.needsUpdate = true;
        const u = (t * 0.45 + i / tiles.length) % 1;
        pulse.position.lerpVectors(edge, g.position, u);
      });

      const d = dustGeo.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < dustN; i++) {
        let y = d.getY(i) + (still ? 0 : 0.004);
        if (y > 4.5) y = -4.5;
        d.setY(i, y);
      }
      d.needsUpdate = true;

      renderer.render(scene, camera);
      if (!still) raf = requestAnimationFrame(frame);
    };

    const resize = () => {
      camera.aspect = W() / H();
      // keep the ring in view on narrow screens
      camera.fov = camera.aspect < 1.3 ? 50 : 34;
      camera.updateProjectionMatrix();
      renderer.setSize(W(), H());
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
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('mousemove', onMove);
      document.removeEventListener('visibilitychange', onVisible);
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        (Array.isArray(mat) ? mat : mat ? [mat] : []).forEach((x) => {
          (x as THREE.MeshBasicMaterial).map?.dispose();
          x.dispose();
        });
      });
      pmrem.dispose();
      renderer.dispose();
      el.innerHTML = '';
    };
  }, []);

  if (failed) {
    return (
      <Box sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
        <BrandLogo width={360} />
      </Box>
    );
  }
  return <Box ref={host} aria-hidden sx={{ position: 'absolute', inset: 0, overflow: 'hidden' }} />;
};

export default Scene3D;
