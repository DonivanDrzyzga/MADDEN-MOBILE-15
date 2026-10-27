import * as THREE from 'three';
import { Actor, JUKE_TIME, PlayEngine, SPIN_TIME } from './engine';

/**
 * Jointed football player: hips → thighs → knees → shins → cleats, chest → shoulders → elbows →
 * gloves, and a glossy helmet with a facemask. Jerseys, helmets and pants are canvas textures
 * (fabric weave, stripes, name and number). The pose is driven every frame from the physics
 * state, so lean, bank, stride and falls come from how the body is actually moving.
 */

export interface TeamLook {
  jersey: string;
  trim: string;
  pants: string;
  helmet: string;
  stripe: string;
  numberFill: string;
  numberOutline: string;
  socks: string;
  logo: string;
}

export const HOME_LOOK: TeamLook = {
  jersey: '#1d4fa8', trim: '#f5c542', pants: '#e8e2d2', helmet: '#16346f', stripe: '#f5c542',
  numberFill: '#ffffff', numberOutline: '#f5c542', socks: '#1d4fa8', logo: 'P',
};
export const AWAY_LOOK: TeamLook = {
  jersey: '#f4f4f2', trim: '#b21f2c', pants: '#b21f2c', helmet: '#b21f2c', stripe: '#ffffff',
  numberFill: '#b21f2c', numberOutline: '#1b1b1b', socks: '#b21f2c', logo: 'R',
};

const SKIN = ['#f1c7a5', '#d9a47e', '#b77a52', '#8d5a3b', '#6b4029', '#4e2d1d'];

export interface PlayerRig {
  root: THREE.Group;
  body: THREE.Group;
  hips: THREE.Group;
  chest: THREE.Group;
  thighL: THREE.Group;
  thighR: THREE.Group;
  kneeL: THREE.Group;
  kneeR: THREE.Group;
  shoulderL: THREE.Group;
  shoulderR: THREE.Group;
  elbowL: THREE.Group;
  elbowR: THREE.Group;
  handL: THREE.Object3D;
  handR: THREE.Object3D;
  key: string;
  /** Animation state. */
  phase: number;
  yaw: number;
  lean: number;
  bank: number;
  fall: number;
  fallYaw: number;
}

// ------------------------------------------------------------------ textures

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function tex(c: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Fine mesh weave and soft folds so jerseys read as fabric up close. */
function weave(g: CanvasRenderingContext2D, w: number, h: number): void {
  g.save();
  g.globalAlpha = 0.07;
  g.fillStyle = '#000';
  for (let y = 0; y < h; y += 4) for (let x = (y / 4) % 2 ? 2 : 0; x < w; x += 4) g.fillRect(x, y, 1.5, 1.5);
  g.globalAlpha = 0.06;
  for (let i = 0; i < 18; i++) {
    const x = Math.random() * w;
    const grad = g.createLinearGradient(x - 20, 0, x + 20, 0);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(0.5, Math.random() < 0.5 ? '#000' : '#fff');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(x - 20, 0, 40, h);
  }
  g.restore();
}

function numberText(g: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, look: TeamLook): void {
  g.font = `900 ${size}px "Arial Narrow", Arial, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  g.lineWidth = size * 0.12;
  g.strokeStyle = look.numberOutline;
  g.strokeText(text, x, y);
  g.fillStyle = look.numberFill;
  g.fillText(text, x, y);
}

const jerseyCache = new Map<string, THREE.CanvasTexture>();
/**
 * Torso wrap. The cylinder starts its UVs at the player's right side, so u=0.25 is the back
 * and u=0.75 the chest.
 */
export function jerseyTexture(look: TeamLook, number: number, name: string): THREE.CanvasTexture {
  const key = `${look.jersey}|${number}|${name}`;
  const hit = jerseyCache.get(key);
  if (hit) return hit;
  const W = 512;
  const H = 256;
  const [c, g] = canvas(W, H);
  g.fillStyle = look.jersey;
  g.fillRect(0, 0, W, H);
  // Side panels under the arms.
  g.fillStyle = look.trim;
  for (const u of [0, 0.5, 1]) g.fillRect(u * W - 14, 0, 28, H);
  g.fillStyle = look.jersey;
  for (const u of [0, 0.5, 1]) g.fillRect(u * W - 8, 0, 16, H);
  // Collar.
  g.fillStyle = look.trim;
  g.fillRect(0, 0, W, 10);
  weave(g, W, H);
  // Back: name bar and big number.
  g.font = '900 26px "Arial Narrow", Arial, sans-serif';
  g.textAlign = 'center';
  g.fillStyle = look.numberFill;
  g.fillText(name.toUpperCase(), W * 0.25, 40, W * 0.22);
  numberText(g, String(number), W * 0.25, 140, 120, look);
  // Chest number.
  numberText(g, String(number), W * 0.75, 120, 100, look);
  const t = tex(c);
  jerseyCache.set(key, t);
  return t;
}

const helmetCache = new Map<string, THREE.CanvasTexture>();
/** Sphere wrap: u=0.25 faces forward, 0.75 back, 0.5 the right side, 0/1 the left side. */
export function helmetTexture(look: TeamLook): THREE.CanvasTexture {
  const key = look.helmet + look.logo;
  const hit = helmetCache.get(key);
  if (hit) return hit;
  const W = 512;
  const H = 256;
  const [c, g] = canvas(W, H);
  g.fillStyle = look.helmet;
  g.fillRect(0, 0, W, H);
  // Center stripe running front to back over the crown.
  g.fillStyle = look.stripe;
  for (const u of [0.25, 0.75]) g.fillRect(u * W - 9, 0, 18, H * 0.5);
  g.fillStyle = look.helmet;
  for (const u of [0.25, 0.75]) g.fillRect(u * W - 3, 0, 6, H * 0.5);
  // Side decals.
  for (const u of [0, 0.5, 1]) {
    g.fillStyle = look.stripe;
    g.beginPath();
    g.arc(u * W, H * 0.47, 30, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = look.helmet;
    g.font = '900 40px "Arial Narrow", Arial, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(look.logo, u * W, H * 0.49);
  }
  const t = tex(c);
  helmetCache.set(key, t);
  return t;
}

const pantsCache = new Map<string, THREE.CanvasTexture>();
export function pantsTexture(look: TeamLook): THREE.CanvasTexture {
  const hit = pantsCache.get(look.pants);
  if (hit) return hit;
  const [c, g] = canvas(256, 128);
  g.fillStyle = look.pants;
  g.fillRect(0, 0, 256, 128);
  g.fillStyle = look.trim;
  for (const u of [0, 0.5, 1]) g.fillRect(u * 256 - 6, 0, 12, 128);
  weave(g, 256, 128);
  const t = tex(c);
  pantsCache.set(look.pants, t);
  return t;
}

// ------------------------------------------------------------------ geometry

const GEO = {
  pelvis: new THREE.CylinderGeometry(0.21, 0.19, 0.22, 16, 1, false, Math.PI / 2),
  thigh: new THREE.CapsuleGeometry(0.105, 0.3, 4, 10),
  shin: new THREE.CapsuleGeometry(0.075, 0.33, 4, 10),
  cleat: new THREE.BoxGeometry(0.12, 0.07, 0.27),
  torso: new THREE.CylinderGeometry(0.27, 0.21, 0.56, 20, 1, false, Math.PI / 2),
  pads: new THREE.SphereGeometry(0.3, 16, 10),
  neck: new THREE.CylinderGeometry(0.07, 0.08, 0.14, 10),
  helmet: new THREE.SphereGeometry(0.17, 24, 16),
  bar: new THREE.CylinderGeometry(0.008, 0.008, 0.2, 5),
  upperArm: new THREE.CapsuleGeometry(0.075, 0.2, 4, 8),
  sleeve: new THREE.CylinderGeometry(0.1, 0.09, 0.12, 10),
  forearm: new THREE.CapsuleGeometry(0.06, 0.18, 4, 8),
  glove: new THREE.SphereGeometry(0.06, 10, 8),
};

const matCache = new Map<string, THREE.Material>();
function mat(key: string, make: () => THREE.Material): THREE.Material {
  let m = matCache.get(key);
  if (!m) {
    m = make();
    matCache.set(key, m);
  }
  return m;
}
const solid = (color: string, rough = 0.75, metal = 0) =>
  mat(`s|${color}|${rough}|${metal}`, () => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal }));

function skinFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return SKIN[Math.abs(h) % SKIN.length];
}

function mesh(geo: THREE.BufferGeometry, m: THREE.Material, parent: THREE.Object3D, y = 0, x = 0, z = 0): THREE.Mesh {
  const o = new THREE.Mesh(geo, m);
  o.position.set(x, y, z);
  o.castShadow = true;
  parent.add(o);
  return o;
}

function pivot(parent: THREE.Object3D, x: number, y: number, z = 0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  parent.add(g);
  return g;
}

/** Size the body by position: linemen are wide, receivers and corners are long and lean. */
function build(pos: string): { width: number; height: number } {
  if (pos === 'OL' || pos === 'DL') return { width: 1.22, height: 1.0 };
  if (pos === 'TE' || pos === 'LB') return { width: 1.1, height: 1.0 };
  if (pos === 'WR' || pos === 'CB') return { width: 0.92, height: 1.02 };
  if (pos === 'K') return { width: 0.9, height: 0.97 };
  return { width: 1.0, height: 1.0 };
}

export function buildRig(a: Actor, look: TeamLook): PlayerRig {
  const skin = skinFor(a.card.id);
  const { width, height } = build(a.card.pos);
  const root = new THREE.Group();
  const body = pivot(root, 0, 0);
  body.scale.set(width, height, width);

  const pantsMat = mat(`p|${look.pants}`, () => new THREE.MeshStandardMaterial({ map: pantsTexture(look), roughness: 0.7 }));
  const jerseyMat = new THREE.MeshStandardMaterial({ map: jerseyTexture(look, a.card.number, a.card.last), roughness: 0.82 });
  const helmetMat = mat(`h|${look.helmet}${look.logo}`, () =>
    new THREE.MeshStandardMaterial({ map: helmetTexture(look), roughness: 0.18, metalness: 0.25 }));
  const skinMat = solid(skin, 0.6);
  // Pads and sleeves use the plain jersey color; the textured wrap only fits the torso.
  const clothMat = solid(look.jersey, 0.82);
  const sockMat = solid(look.socks, 0.85);
  const cleatMat = solid('#111111', 0.4, 0.1);
  const maskMat = solid('#c9ccd1', 0.3, 0.6);
  const gloveMat = solid(look.trim, 0.55);

  // Legs.
  const hips = pivot(body, 0, 0.98);
  mesh(GEO.pelvis, pantsMat, hips, 0.02);
  const leg = (side: number) => {
    const thigh = pivot(hips, side * 0.115, -0.04);
    mesh(GEO.thigh, pantsMat, thigh, -0.22);
    const knee = pivot(thigh, 0, -0.45);
    mesh(GEO.shin, sockMat, knee, -0.22);
    mesh(GEO.cleat, cleatMat, knee, -0.47, 0, 0.06);
    return { thigh, knee };
  };
  const L = leg(-1);
  const R = leg(1);

  // Upper body.
  const chest = pivot(body, 0, 1.06);
  mesh(GEO.torso, jerseyMat, chest, 0.28).scale.set(1, 1, 0.7);
  const pads = mesh(GEO.pads, clothMat, chest, 0.52);
  pads.scale.set(1.38, 0.5, 0.95);
  mesh(GEO.neck, skinMat, chest, 0.66);
  const head = pivot(chest, 0, 0.82);
  const helmet = mesh(GEO.helmet, helmetMat, head, 0.02);
  helmet.scale.set(1, 1.04, 1.16);
  // Facemask: a cage of bars across the front.
  for (const [y, w] of [[-0.02, 1], [-0.07, 0.9], [-0.12, 0.7]] as const) {
    const bar = mesh(GEO.bar, maskMat, head, y, 0, 0.2);
    bar.rotation.z = Math.PI / 2;
    bar.scale.y = w * 1.25;
  }
  for (const x of [-0.06, 0.06]) {
    const v = mesh(GEO.bar, maskMat, head, -0.07, x, 0.2);
    v.scale.y = 0.6;
  }

  const arm = (side: number) => {
    const shoulder = pivot(chest, side * 0.36, 0.5);
    mesh(GEO.sleeve, clothMat, shoulder, -0.04);
    mesh(GEO.upperArm, skinMat, shoulder, -0.15);
    const elbow = pivot(shoulder, 0, -0.3);
    mesh(GEO.forearm, skinMat, elbow, -0.13);
    const hand = mesh(GEO.glove, gloveMat, elbow, -0.27);
    shoulder.rotation.z = side * 0.18;
    return { shoulder, elbow, hand };
  };
  const AL = arm(-1);
  const AR = arm(1);

  return {
    root, body, hips, chest,
    thighL: L.thigh, thighR: R.thigh, kneeL: L.knee, kneeR: R.knee,
    shoulderL: AL.shoulder, shoulderR: AR.shoulder, elbowL: AL.elbow, elbowR: AR.elbow,
    handL: AL.hand, handR: AR.hand,
    key: `${a.card.id}|${look.jersey}`,
    phase: Math.random() * 6,
    yaw: a.side === 'off' ? Math.PI : 0,
    lean: 0, bank: 0, fall: 0, fallYaw: 0,
  };
}

// ------------------------------------------------------------------ pose

const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const wrap = (a: number) => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};

/** World velocity (vx, vy) points along three.js (vx, 0, -vy); the model faces local +z. */
const yawOf = (vx: number, vy: number) => Math.atan2(vx, -vy);

export function poseRig(rig: PlayerRig, a: Actor, engine: PlayEngine, dt: number): void {
  const speed = Math.hypot(a.vx, a.vy);
  const carrier = engine.carrier();
  const k = Math.min(1, dt * 12);

  // ----- facing
  const preThrow = engine.ball.state === 'held' && engine.ball.carrier.slot === 'QB' && !engine.thrown;
  let target = rig.yaw;
  if (a.down > 0 || rig.fall > 0.3) {
    // Keep facing the way he went down.
  } else if (a.engaged) target = yawOf(a.engaged.x - a.x, a.engaged.y - a.y);
  else if (a.side === 'def' && preThrow && a.assign?.kind !== 'rush' && engine.t > 0) {
    // Coverage players backpedal and shuffle while watching the quarterback.
    const qb = engine.slot('QB');
    target = yawOf(qb.x - a.x, qb.y - a.y);
  } else if (speed > 0.8) target = yawOf(a.vx, a.vy);
  else if (engine.t === 0) target = a.side === 'off' ? Math.PI : 0;
  const turnRate = 7 + a.card.ratings.agi * 0.06;
  rig.yaw += wrap(target - rig.yaw) * Math.min(1, dt * turnRate);
  let yaw = rig.yaw;
  // Spin move: a real 360 on top of the direction of travel.
  if (a.spinT >= 0) yaw += a.spinDir * Math.PI * 2 * ease(Math.min(1, a.spinT / SPIN_TIME));
  rig.root.position.set(a.x, 0, -a.y);
  rig.root.rotation.y = yaw;

  // ----- acceleration in the body's frame: forward accel tips the chest, lateral accel banks it.
  const fx = Math.sin(rig.yaw);
  const fz = Math.cos(rig.yaw);
  const ax = a.ax;
  const az = -a.ay;
  const aFwd = ax * fx + az * fz;
  const aSide = ax * fz - az * fx; // positive = accelerating toward the body's left
  const moving = Math.min(1, speed / 7.5);

  // ----- stride: frequency rises with speed, amplitude with effort
  rig.phase += dt * (speed > 0.3 ? 5 + speed * 1.15 : 0);
  const amp = Math.min(1, speed / 7) * (a.stumble > 0 ? 1.2 : 1);
  const s = Math.sin(rig.phase);
  const c = Math.cos(rig.phase);
  let thighL = s * 0.95 * amp;
  let thighR = -s * 0.95 * amp;
  let kneeL = (c > 0 ? c * 1.5 : 0.15) * amp + 0.08;
  let kneeR = (c < 0 ? -c * 1.5 : 0.15) * amp + 0.08;
  let shL = -s * 0.85 * amp;
  let shR = s * 0.85 * amp;
  let elL = -1.25 + 0.35 * amp;
  let elR = -1.25 + 0.35 * amp;
  let shZL = -0.18;
  let shZR = 0.18;
  const bob = Math.abs(s) * 0.07 * amp;
  let leanTarget = 0.06 + moving * 0.22 + Math.max(-0.35, Math.min(0.45, aFwd * 0.035));
  // Bank into turns: rotation.z < 0 tips the body toward its left (+x).
  let bankTarget = Math.max(-0.5, Math.min(0.5, -aSide * 0.04));
  let drop = 0;

  // Backpedal: legs cycle but the body sits upright and a touch back.
  const movingBackward = speed > 0.8 && Math.cos(yawOf(a.vx, a.vy) - rig.yaw) < -0.3;
  if (movingBackward) leanTarget = -0.05;

  // ----- stances before the snap
  if (engine.t === 0) {
    const lineman = a.card.pos === 'OL' || a.card.pos === 'DL';
    if (lineman) {
      // Three-point stance: hips low, back flat, one hand in the dirt.
      leanTarget = 1.05;
      drop = 0.36;
      thighL = thighR = -1.05;
      kneeL = kneeR = 1.7;
      shR = -1.6;
      elR = 0;
      shL = -0.4;
      elL = -1.2;
    } else if (a.slot !== 'QB') {
      leanTarget = 0.35;
      drop = 0.12;
      thighL = thighR = -0.45;
      kneeL = kneeR = 0.8;
      shL = shR = -0.3;
    }
  }

  // ----- blocking: arms locked out, legs driving
  if (a.engaged) {
    leanTarget = 0.55;
    drop = 0.12;
    shL = shR = -1.45;
    elL = elR = -0.25;
    thighL = -0.6 + s * 0.35;
    thighR = -0.6 - s * 0.35;
    kneeL = kneeR = 0.9;
  }

  // ----- ball carrier: tuck the ball high and tight
  if (a === carrier && !engine.over) {
    if (a.slot === 'QB' && preThrow) {
      shL = shR = -0.75;
      elL = elR = -1.2;
      shZL = 0.3;
      shZR = -0.3;
    } else {
      shL = -0.35;
      elL = -2.0;
      shZL = 0.15;
    }
  }
  // QB throwing motion right after release.
  if (a.slot === 'QB' && engine.throwAt >= 0 && engine.t - engine.throwAt < 0.35) {
    const p = (engine.t - engine.throwAt) / 0.35;
    shR = lerp(-2.9, -0.6, ease(p));
    elR = lerp(-1.2, -0.1, p);
  }

  // ----- skill moves
  if (a.jukeT >= 0) {
    // Plant hard on the outside leg and lean into the cut.
    const p = a.jukeT / JUKE_TIME;
    const plant = Math.sin(Math.PI * Math.min(1, p));
    bankTarget = -a.jukeDir * 0.55 * plant;
    drop = Math.max(drop, 0.12 * plant);
    if (a.jukeDir > 0) { thighR = -0.2; kneeR = 0.6; thighL = 0.5; } else { thighL = -0.2; kneeL = 0.6; thighR = 0.5; }
  }
  if (a.spinT >= 0) {
    // Arms out for balance, low through the turn.
    shZL = -1.1;
    shZR = 1.1;
    elL = elR = -0.4;
    leanTarget = 0.3;
    drop = Math.max(drop, 0.1);
  }
  if (a.truck > 0) {
    // Shoulder down with a stiff off-arm.
    leanTarget = 0.65;
    drop = Math.max(drop, 0.08);
    shR = -1.5;
    elR = -0.05;
  }
  if (a.dive > 0) {
    leanTarget = 1.25;
    shL = shR = -2.8;
    elL = elR = -0.2;
    thighL = thighR = 0.6;
    kneeL = kneeR = 0.2;
  }
  // Touchdown: ball carrier throws his arms up.
  if (engine.over && engine.outcome?.kind === 'td' && a === carrier) {
    shL = shR = -2.9;
    elL = elR = -0.2;
    shZL = -0.3;
    shZR = 0.3;
    leanTarget = -0.1;
  }

  // ----- falling: tip over along the fall direction with a little bounce
  const onGround = a.down > 0;
  const fallTarget = onGround ? 1 : a.stun > 0.35 ? 0.25 : 0;
  rig.fall += (fallTarget - rig.fall) * Math.min(1, dt * (fallTarget > rig.fall ? 7 : 3));
  if (onGround) rig.fallYaw = yawOf(a.downDir.x, a.downDir.y) - yaw;
  if (rig.fall > 0.02) {
    const fwdFall = Math.cos(rig.fallYaw);
    const sideFall = Math.sin(rig.fallYaw);
    leanTarget = lerp(leanTarget, fwdFall * 1.5, rig.fall);
    bankTarget = lerp(bankTarget, -sideFall * 1.4, rig.fall);
    drop = lerp(drop, 0.78, rig.fall);
    shL = lerp(shL, -2.4, rig.fall);
    shR = lerp(shR, -2.0, rig.fall);
    thighL = lerp(thighL, 0.3, rig.fall);
    thighR = lerp(thighR, -0.2, rig.fall);
  }

  rig.lean += (leanTarget - rig.lean) * Math.min(1, dt * 10);
  rig.bank += (bankTarget - rig.bank) * Math.min(1, dt * 10);
  rig.body.rotation.set(rig.lean, 0, rig.bank, 'YXZ');
  rig.body.position.y = bob - drop;
  rig.chest.rotation.y = s * 0.18 * amp; // shoulders counter-rotate against the hips
  rig.hips.rotation.y = -s * 0.12 * amp;

  rig.thighL.rotation.x += (thighL - rig.thighL.rotation.x) * k;
  rig.thighR.rotation.x += (thighR - rig.thighR.rotation.x) * k;
  rig.kneeL.rotation.x += (kneeL - rig.kneeL.rotation.x) * k;
  rig.kneeR.rotation.x += (kneeR - rig.kneeR.rotation.x) * k;
  rig.shoulderL.rotation.x += (shL - rig.shoulderL.rotation.x) * k;
  rig.shoulderR.rotation.x += (shR - rig.shoulderR.rotation.x) * k;
  rig.shoulderL.rotation.z += (shZL - rig.shoulderL.rotation.z) * k;
  rig.shoulderR.rotation.z += (shZR - rig.shoulderR.rotation.z) * k;
  rig.elbowL.rotation.x += (elL - rig.elbowL.rotation.x) * k;
  rig.elbowR.rotation.x += (elR - rig.elbowR.rotation.x) * k;
}
