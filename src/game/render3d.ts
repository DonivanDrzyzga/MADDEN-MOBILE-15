import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { Actor, CENTER_X, FIELD_W, PlayEngine, Side, Vec } from './engine';
import { GameRenderer, Hud, RECEIVER_ICONS } from './render';
import { AWAY_LOOK, HOME_LOOK, PlayerRig, buildRig, poseRig } from './playerModel';

/**
 * Broadcast-style 3D view in the spirit of 2015 mobile football: the camera sits high behind
 * the user's side of the ball and looks downfield. World yards map to three.js units 1:1 with
 * x across the field, y up, and z = -(yards from the offense's goal line).
 */

const toZ = (y: number) => -y;

export class Field3DRenderer implements GameRenderer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(48, 1, 0.5, 600);
  private w = 1;
  private h = 1;
  private camX = CENTER_X;
  private camY = 30;
  private camSide: Side = 'off';
  private rigs = new Map<number, PlayerRig>();
  private rigEngine: PlayEngine | null = null;
  private ball: THREE.Mesh;
  private ballShadow: THREE.Mesh;
  private losLine: THREE.Mesh;
  private fdLine: THREE.Mesh;
  private ring: THREE.Mesh;
  private routes = new THREE.Group();
  private posts: { mesh: THREE.Group; y: number }[] = [];
  private routesFor: PlayEngine | null = null;
  private fieldTex: THREE.CanvasTexture;
  private fieldCanvas = document.createElement('canvas');
  private fieldKey = '';
  private matCache = new Map<string, THREE.Material>();
  private sun: THREE.DirectionalLight;
  private handPos = new THREE.Vector3();

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene.background = new THREE.Color('#7da7d9');
    this.scene.fog = new THREE.Fog('#7da7d9', 120, 260);
    // Soft image-based light gives helmets and jerseys real highlights.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this.scene.add(new THREE.HemisphereLight('#dfefff', '#3a5a2a', 0.9));
    // Stadium light: casts the player shadows. Its shadow box follows the play.
    const sun = new THREE.DirectionalLight('#fff1dc', 2.4);
    sun.castShadow = true;
    const small = Math.min(window.innerWidth, window.innerHeight) < 600;
    sun.shadow.mapSize.set(small ? 1024 : 2048, small ? 1024 : 2048);
    const sc = sun.shadow.camera;
    sc.left = -26;
    sc.right = 26;
    sc.top = 26;
    sc.bottom = -26;
    sc.near = 1;
    sc.far = 140;
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.02;
    this.scene.add(sun);
    this.scene.add(sun.target);
    this.sun = sun;

    // Field: one canvas texture with stripes, lines, numbers and end zones.
    this.fieldCanvas.width = 1024;
    this.fieldCanvas.height = 2304;
    this.fieldTex = new THREE.CanvasTexture(this.fieldCanvas);
    this.fieldTex.colorSpace = THREE.SRGBColorSpace;
    this.fieldTex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    const field = new THREE.Mesh(new THREE.PlaneGeometry(FIELD_W + 4, 124), new THREE.MeshLambertMaterial({ map: this.fieldTex }));
    field.rotation.x = -Math.PI / 2;
    field.position.set(CENTER_X, 0, toZ(50));
    field.receiveShadow = true;
    this.scene.add(field);
    this.drawFieldTexture('Home', 'Away', true);

    this.buildStadium();

    const lineGeo = new THREE.PlaneGeometry(FIELD_W, 0.28);
    this.losLine = new THREE.Mesh(lineGeo, new THREE.MeshBasicMaterial({ color: '#3d8bff' }));
    this.fdLine = new THREE.Mesh(lineGeo, new THREE.MeshBasicMaterial({ color: '#ffd400' }));
    for (const l of [this.losLine, this.fdLine]) {
      l.rotation.x = -Math.PI / 2;
      l.position.set(CENTER_X, 0.03, 0);
      this.scene.add(l);
    }

    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.62, 0.82, 32),
      new THREE.MeshBasicMaterial({ color: '#4cff6a', transparent: true, opacity: 0.95 }),
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.04;
    this.scene.add(this.ring);

    this.ball = new THREE.Mesh(new THREE.SphereGeometry(0.16, 20, 12), new THREE.MeshStandardMaterial({ map: footballTexture(), roughness: 0.55 }));
    this.ball.scale.set(1.0, 0.62, 0.62);
    this.ball.castShadow = true;
    this.scene.add(this.ball);
    this.ballShadow = new THREE.Mesh(new THREE.CircleGeometry(0.5, 20), new THREE.MeshBasicMaterial({ color: '#000', transparent: true, opacity: 0.3, depthWrite: false }));
    this.ballShadow.rotation.x = -Math.PI / 2;
    this.ballShadow.scale.setScalar(0.35);
    this.scene.add(this.ballShadow);
    this.scene.add(this.routes);
  }

  static supported(): boolean {
    try {
      const c = document.createElement('canvas');
      return !!(c.getContext('webgl2') || c.getContext('webgl'));
    } catch {
      return false;
    }
  }

  dispose(): void {
    this.renderer.dispose();
  }

  // ------------------------------------------------------------ camera

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.w = Math.max(1, rect.width);
    this.h = Math.max(1, rect.height);
    this.renderer.setSize(this.w, this.h, false);
    this.camera.aspect = this.w / this.h;
    // Portrait screens need a taller field of view to show enough of the play.
    this.camera.fov = this.w >= this.h ? 50 : 78;
    this.camera.updateProjectionMatrix();
  }

  focus(x: number, y: number): void {
    this.camX = this.targetCamX(x);
    this.camY = y;
  }

  private targetCamX(x: number): number {
    return CENTER_X + (x - CENTER_X) * 0.55;
  }

  private placeCamera(): void {
    const portrait = this.w < this.h;
    // Landscape matches the classic behind-the-QB broadcast angle; portrait climbs higher to fit more width.
    const back = portrait ? 13 : 15.5;
    const height = portrait ? 21 : 9.5;
    const ahead = portrait ? 9 : 11;
    const dir = this.camSide === 'off' ? 1 : -1;
    const camWorldY = this.camY - back * dir;
    this.camera.position.set(this.camX, height, toZ(camWorldY));
    this.camera.lookAt(this.camX, 0, toZ(this.camY + ahead * dir));
    // Near the goal line the camera sits in the end zone; hide that goal post so it doesn't block the play.
    for (const p of this.posts) p.mesh.visible = Math.abs(camWorldY - p.y) > 12;
    // Keep the shadow box centred on the action.
    const fz = toZ(this.camY + 4 * dir);
    this.sun.target.position.set(this.camX, 0, fz);
    this.sun.position.set(this.camX - 30, 70, fz + 25);
  }

  screenDirToWorld(dx: number, dy: number): Vec {
    // The camera always looks straight downfield from behind the user's side.
    return this.camSide === 'off' ? { x: dx, y: -dy } : { x: -dx, y: dy };
  }

  toScreen(x: number, y: number, h = 0): { sx: number; sy: number } {
    const v = new THREE.Vector3(x, h, toZ(y)).project(this.camera);
    return { sx: (v.x * 0.5 + 0.5) * this.w, sy: (-v.y * 0.5 + 0.5) * this.h };
  }

  iconPos(a: Actor): { sx: number; sy: number } {
    return this.toScreen(a.x, a.y, 2.9);
  }

  // ------------------------------------------------------------ frame

  draw(engine: PlayEngine | null, hud: Hud, dt: number, showRoutes: boolean): void {
    const side = engine?.userSide ?? hud.userSide;
    this.camSide = side;
    const key = `${side}|${hud.userTeam}|${hud.cpuTeam}`;
    if (key !== this.fieldKey) {
      this.fieldKey = key;
      // The user always defends the end zone behind the camera.
      this.drawFieldTexture(side === 'off' ? hud.userTeam : hud.cpuTeam, side === 'off' ? hud.cpuTeam : hud.userTeam, side === 'off');
    }
    if (engine) {
      const b = engine.ballPos();
      const k = Math.min(1, dt * 3);
      const lead = engine.t === 0 ? 0 : side === 'off' ? 3 : -3;
      this.camX += (this.targetCamX(b.x) - this.camX) * k;
      this.camY += (b.y + lead - this.camY) * k;
      this.losLine.position.z = toZ(engine.los);
      const fd = hud.firstDownY;
      this.fdLine.visible = fd !== null && fd < 100;
      if (fd !== null) this.fdLine.position.z = toZ(fd);
      this.syncPlayers(engine, dt);
      this.syncBall(engine);
      this.syncRoutes(engine, showRoutes);
      const c = engine.controlled;
      this.ring.visible = !!c && !engine.over;
      if (c) this.ring.position.set(c.x, 0.04, toZ(c.y));
      this.ring.rotation.z += dt * 2;
    } else {
      this.ring.visible = false;
      this.fdLine.visible = false;
    }
    this.placeCamera();
    this.renderer.render(this.scene, this.camera);
  }

  // ------------------------------------------------------------ players

  private mat(color: string): THREE.Material {
    let m = this.matCache.get(color);
    if (!m) {
      m = new THREE.MeshLambertMaterial({ color });
      this.matCache.set(color, m);
    }
    return m;
  }

  private syncPlayers(engine: PlayEngine, dt: number): void {
    if (this.rigEngine !== engine) {
      // Rebuild rigs only when the lineup on the field changes; reuse them between plays.
      const wanted = new Set<number>();
      for (const a of engine.actors) {
        const look = a.side === engine.userSide ? HOME_LOOK : AWAY_LOOK;
        const key = `${a.card.id}|${look.jersey}`;
        let rig = this.rigs.get(a.id);
        if (rig && rig.key !== key) {
          this.scene.remove(rig.root);
          rig = undefined;
        }
        if (!rig) {
          rig = buildRig(a, look);
          this.scene.add(rig.root);
          this.rigs.set(a.id, rig);
        }
        rig.fall = 0;
        rig.lean = 0;
        rig.bank = 0;
        rig.yaw = a.side === 'off' ? Math.PI : 0;
        wanted.add(a.id);
      }
      for (const [id, rig] of this.rigs) if (!wanted.has(id)) { this.scene.remove(rig.root); this.rigs.delete(id); }
      this.rigEngine = engine;
    }
    for (const a of engine.actors) poseRig(this.rigs.get(a.id)!, a, engine, dt);
  }

  private syncBall(engine: PlayEngine): void {
    const b = engine.ballPos();
    const ball = engine.ball;
    let y = 1.15;
    if (ball.state === 'air') {
      const k = ball.t / ball.dur;
      y = 1.9 + (1.3 - 1.9) * k + b.h;
      const dx = ball.to.x - ball.from.x;
      const dz = toZ(ball.to.y) - toZ(ball.from.y);
      // Nose follows the arc; the ball spirals around its long axis.
      const climb = Math.atan(((1 - 2 * k) * 4 * Math.min(12, Math.hypot(dx, dz) * 0.25)) / Math.max(1, Math.hypot(dx, dz)));
      this.ball.rotation.set(ball.t * 40, Math.atan2(dx, dz) - Math.PI / 2, climb, 'YZX');
    } else if (ball.state === 'dead') {
      y = 0.2;
    }
    let x = b.x;
    let z = toZ(b.y);
    if (ball.state === 'held') {
      // The ball sits in the carrier's tucking hand, so it moves with the arm and the body.
      const rig = this.rigs.get(ball.carrier.id);
      if (rig) {
        rig.root.updateMatrixWorld(true);
        rig.handL.getWorldPosition(this.handPos);
        x = this.handPos.x;
        y = this.handPos.y + 0.04;
        z = this.handPos.z;
        this.ball.rotation.set(0, rig.root.rotation.y + Math.PI / 2, 0.5, 'YZX');
      }
    }
    this.ball.position.set(x, y, z);
    this.ballShadow.position.set(x, 0.025, z);
    this.ballShadow.visible = ball.state === 'air';
  }

  private syncRoutes(engine: PlayEngine, show: boolean): void {
    if (this.routesFor !== engine) {
      this.routes.clear();
      for (const a of engine.eligibleReceivers()) {
        if (!a.route) continue;
        const color = RECEIVER_ICONS[a.slot]?.color ?? '#ffffff';
        const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthWrite: false });
        let prev: Vec = { x: a.x, y: a.y };
        for (const p of a.route) {
          const len = Math.hypot(p.x - prev.x, p.y - prev.y);
          const seg = new THREE.Mesh(new THREE.PlaneGeometry(0.32, len), m);
          seg.rotation.x = -Math.PI / 2;
          seg.rotation.z = Math.atan2(p.x - prev.x, p.y - prev.y) * -1;
          seg.position.set((p.x + prev.x) / 2, 0.035, toZ((p.y + prev.y) / 2));
          this.routes.add(seg);
          prev = p;
        }
      }
      this.routesFor = engine;
    }
    this.routes.visible = show;
  }

  // ------------------------------------------------------------ static scenery

  /** Paint the field: x across 0..FIELD_W plus 2 yd of sideline each side, y from -12 to 112. */
  private drawFieldTexture(nearTeam: string, farTeam: string, userNear: boolean): void {
    const c = this.fieldCanvas;
    const g = c.getContext('2d')!;
    const W = c.width;
    const H = c.height;
    const ppyX = W / (FIELD_W + 4);
    const ppyY = H / 124;
    const px = (x: number) => (x + 2) * ppyX;
    // Canvas row 0 is the far end (y=112); the texture's top maps to -z on the plane.
    const py = (y: number) => (112 - y) * ppyY;
    g.fillStyle = '#2b6d33';
    g.fillRect(0, 0, W, H);
    for (let y = 0; y < 100; y += 5) {
      g.fillStyle = (y / 5) % 2 ? '#3a8a42' : '#347f3c';
      g.fillRect(px(0), py(y + 5), px(FIELD_W) - px(0), py(y) - py(y + 5));
    }
    const nearColor = userNear ? '#1f5fbf' : '#b8202b';
    const farColor = userNear ? '#b8202b' : '#1f5fbf';
    g.fillStyle = nearColor;
    g.fillRect(px(0), py(0), px(FIELD_W) - px(0), py(-10) - py(0));
    g.fillStyle = farColor;
    g.fillRect(px(0), py(110), px(FIELD_W) - px(0), py(100) - py(110));
    const endzoneText = (text: string, y: number, flip: boolean) => {
      g.save();
      g.translate(px(CENTER_X), py(y));
      if (flip) g.rotate(Math.PI);
      g.fillStyle = 'rgba(255,255,255,0.92)';
      g.font = `900 ${Math.round(ppyY * 4.6)}px Arial Narrow, Arial, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      const t = text.toUpperCase();
      const maxW = (FIELD_W - 6) * ppyX;
      const wd = g.measureText(t).width;
      if (wd > maxW) g.scale(maxW / wd, 1);
      g.fillText(t, 0, 0);
      g.restore();
    };
    endzoneText(nearTeam, -5, true);
    endzoneText(farTeam, 105, false);

    g.strokeStyle = '#ffffff';
    g.lineWidth = Math.max(2, ppyY * 0.33);
    g.strokeRect(px(0), py(110), px(FIELD_W) - px(0), py(-10) - py(110));
    for (let y = 0; y <= 100; y += 5) {
      g.lineWidth = Math.max(2, ppyY * (y % 10 === 0 ? 0.3 : 0.22));
      g.beginPath();
      g.moveTo(px(0), py(y));
      g.lineTo(px(FIELD_W), py(y));
      g.stroke();
    }
    g.lineWidth = Math.max(1.5, ppyY * 0.15);
    for (let y = 1; y < 100; y++) {
      if (y % 5 === 0) continue;
      for (const hx of [0.6, 23.6, 29.7, FIELD_W - 0.6]) {
        g.beginPath();
        g.moveTo(px(hx - 0.5), py(y));
        g.lineTo(px(hx + 0.5), py(y));
        g.stroke();
      }
    }
    // Yard numbers, read from each sideline like a real field.
    g.fillStyle = 'rgba(255,255,255,0.92)';
    g.font = `bold ${Math.round(ppyY * 2.2)}px Arial Narrow, Arial, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (let y = 10; y <= 90; y += 10) {
      const n = y > 50 ? 100 - y : y;
      for (const [nx, rot] of [[8, Math.PI / 2], [FIELD_W - 8, -Math.PI / 2]] as const) {
        g.save();
        g.translate(px(nx), py(y));
        g.rotate(rot);
        g.fillText(String(n).split('').join(' '), 0, 0);
        g.restore();
      }
    }
    // Midfield shield logo (original).
    g.save();
    g.translate(px(CENTER_X), py(50));
    g.fillStyle = 'rgba(12,26,52,0.85)';
    g.beginPath();
    g.moveTo(0, -ppyY * 3.4);
    g.lineTo(ppyY * 2.8, -ppyY * 2.2);
    g.lineTo(ppyY * 2.4, ppyY * 1.6);
    g.lineTo(0, ppyY * 3.4);
    g.lineTo(-ppyY * 2.4, ppyY * 1.6);
    g.lineTo(-ppyY * 2.8, -ppyY * 2.2);
    g.closePath();
    g.fill();
    g.strokeStyle = '#f5c542';
    g.lineWidth = ppyY * 0.35;
    g.stroke();
    g.fillStyle = '#f5c542';
    g.font = `900 ${Math.round(ppyY * 2.6)}px Arial Narrow, Arial, sans-serif`;
    g.fillText('GP', 0, ppyY * 0.1);
    g.restore();
    this.fieldTex.needsUpdate = true;
  }

  private buildStadium(): void {
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshLambertMaterial({ color: '#2a5f30' }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(CENTER_X, -0.02, toZ(50));
    this.scene.add(ground);

    // Padded wall with sponsor boards around the field.
    const boards = document.createElement('canvas');
    boards.width = 1024;
    boards.height = 64;
    const bg = boards.getContext('2d')!;
    const labels = ['GRIDIRON PRIME', 'PRIME TIME', 'LIVE EVENTS', 'SEASON MODE'];
    for (let i = 0; i < 4; i++) {
      bg.fillStyle = i % 2 ? '#0e2a5c' : '#11203d';
      bg.fillRect(i * 256, 0, 256, 64);
      bg.fillStyle = i % 2 ? '#f5c542' : '#ffffff';
      bg.font = '900 30px Arial Narrow, Arial, sans-serif';
      bg.textAlign = 'center';
      bg.textBaseline = 'middle';
      bg.fillText(labels[i], i * 256 + 128, 34);
    }
    const boardTex = new THREE.CanvasTexture(boards);
    boardTex.colorSpace = THREE.SRGBColorSpace;
    boardTex.wrapS = THREE.RepeatWrapping;

    const crowd = document.createElement('canvas');
    crowd.width = 512;
    crowd.height = 256;
    const cg = crowd.getContext('2d')!;
    cg.fillStyle = '#2b2f3a';
    cg.fillRect(0, 0, 512, 256);
    const colors = ['#1f5fbf', '#f2f2f2', '#b8202b', '#f5c542', '#3a3f4d', '#d9c3a5', '#6b4a32', '#16397a'];
    for (let row = 0; row < 32; row++) {
      cg.fillStyle = row % 2 ? '#262a33' : '#30353f';
      cg.fillRect(0, row * 8, 512, 2);
      for (let i = 0; i < 90; i++) {
        cg.fillStyle = colors[(Math.random() * colors.length) | 0];
        cg.fillRect(Math.random() * 512, row * 8 + 2, 4, 5);
      }
    }
    const crowdTex = new THREE.CanvasTexture(crowd);
    crowdTex.colorSpace = THREE.SRGBColorSpace;
    crowdTex.wrapS = crowdTex.wrapT = THREE.RepeatWrapping;

    const x0 = -9;
    const x1 = FIELD_W + 9;
    const y0 = -20;
    const y1 = 120;
    const wallH = 1.4;
    const addWall = (len: number, cx: number, cy: number, rotY: number) => {
      const tex = boardTex.clone();
      tex.repeat.set(len / 40, 1);
      tex.needsUpdate = true;
      const wall = new THREE.Mesh(new THREE.PlaneGeometry(len, wallH), new THREE.MeshBasicMaterial({ map: tex }));
      wall.position.set(cx, wallH / 2, toZ(cy));
      wall.rotation.y = rotY;
      this.scene.add(wall);
    };
    // Planes face +z by default; rotate each wall to face the field.
    addWall(y1 - y0, x0, (y0 + y1) / 2, Math.PI / 2);
    addWall(y1 - y0, x1, (y0 + y1) / 2, -Math.PI / 2);
    addWall(x1 - x0, (x0 + x1) / 2, y1, 0);
    addWall(x1 - x0, (x0 + x1) / 2, y0, Math.PI);

    const stand = (len: number, cx: number, cy: number, rotY: number) => {
      const depth = 34;
      const tex = crowdTex.clone();
      tex.repeat.set(len / 30, depth / 12);
      tex.needsUpdate = true;
      const g = new THREE.Group();
      const seats = new THREE.Mesh(new THREE.PlaneGeometry(len, depth), new THREE.MeshLambertMaterial({ map: tex, side: THREE.DoubleSide }));
      // Tilt the seating bowl up and away from the field.
      seats.rotation.x = -Math.PI / 2 + 0.62;
      seats.position.set(0, wallH + Math.sin(0.62) * depth / 2, -Math.cos(0.62) * depth / 2);
      g.add(seats);
      const rim = new THREE.Mesh(new THREE.BoxGeometry(len, 2.5, 1.5), this.mat('#1b2333'));
      rim.position.set(0, wallH + Math.sin(0.62) * depth + 1.2, -Math.cos(0.62) * depth);
      g.add(rim);
      g.position.set(cx, 0, toZ(cy));
      g.rotation.y = rotY;
      this.scene.add(g);
    };
    stand(y1 - y0 + 40, x0 - 0.5, (y0 + y1) / 2, Math.PI / 2);
    stand(y1 - y0 + 40, x1 + 0.5, (y0 + y1) / 2, -Math.PI / 2);
    stand(x1 - x0, (x0 + x1) / 2, y1 + 0.5, 0);
    stand(x1 - x0, (x0 + x1) / 2, y0 - 0.5, Math.PI);

    // Goal posts at the back of each end zone.
    const yellow = this.mat('#ffd21f');
    for (const gy of [-10, 110]) {
      const post = new THREE.Group();
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 3.3, 10), yellow);
      base.position.y = 1.65;
      post.add(base);
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 6.2, 10), yellow);
      bar.rotation.z = Math.PI / 2;
      bar.position.y = 3.33;
      post.add(bar);
      for (const ux of [-3.1, 3.1]) {
        const up = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 10, 10), yellow);
        up.position.set(ux, 3.33 + 5, 0);
        post.add(up);
      }
      post.position.set(CENTER_X, 0, toZ(gy + (gy < 0 ? -0.5 : 0.5)));
      this.scene.add(post);
      this.posts.push({ mesh: post, y: gy });
    }
    // End zone pylons.
    const orange = this.mat('#ff7a1a');
    for (const py of [-10, 0, 100, 110]) {
      for (const px of [0, FIELD_W]) {
        const p = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.6, 0.35), orange);
        p.position.set(px, 0.3, toZ(py));
        this.scene.add(p);
      }
    }
  }
}

/** Pebbled leather with white laces and stripes. Sphere UVs: u wraps the long axis' girth. */
function footballTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#6e3416';
  g.fillRect(0, 0, 256, 128);
  for (let i = 0; i < 1600; i++) {
    g.fillStyle = Math.random() < 0.5 ? 'rgba(0,0,0,0.12)' : 'rgba(255,220,180,0.06)';
    g.fillRect(Math.random() * 256, Math.random() * 128, 2, 2);
  }
  // Seams and stripes near the ends of the ball (top and bottom of the texture).
  g.fillStyle = '#f2efe8';
  g.fillRect(0, 16, 256, 5);
  g.fillRect(0, 107, 256, 5);
  // Laces across the top.
  g.fillRect(52, 52, 5, 24);
  for (let i = 0; i < 8; i++) g.fillRect(44, 54 + i * 3, 21, 1.6);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
