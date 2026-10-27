import { Actor, FIELD_W, PlayEngine, Vec } from './engine';

export const USER_COLOR = '#1e6fd9';
export const USER_TRIM = '#f5c542';
export const CPU_COLOR = '#d63c3c';
export const CPU_TRIM = '#ffffff';

export const RECEIVER_ICONS: Record<string, { label: string; color: string }> = {
  WR1: { label: 'A', color: '#2ecc71' },
  WR2: { label: 'B', color: '#e74c3c' },
  WR3: { label: 'C', color: '#3498db' },
  TE: { label: 'D', color: '#f1c40f' },
  HB: { label: 'E', color: '#9b59b6' },
};

export interface Hud {
  firstDownY: number | null;
  userTeam: string;
  cpuTeam: string;
}

/**
 * Draws the field and players. Portrait screens show the offense driving up the screen;
 * landscape screens rotate the field so the offense drives to the right.
 */
export class FieldRenderer {
  private ctx: CanvasRenderingContext2D;
  private camX = FIELD_W / 2;
  private camY = 30;
  private w = 0;
  private h = 0;
  private dpr = 1;
  scale = 10;
  landscape = false;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = rect.width;
    this.h = rect.height;
    this.canvas.width = Math.round(rect.width * this.dpr);
    this.canvas.height = Math.round(rect.height * this.dpr);
    this.landscape = this.w > this.h;
    this.scale = this.landscape ? Math.max(9, this.h / 34) : Math.max(9, this.w / 34);
  }

  /** World (yards) to CSS pixels. */
  toScreen(x: number, y: number): { sx: number; sy: number } {
    const s = this.scale;
    if (this.landscape) return { sx: this.w * 0.4 + (y - this.camY) * s, sy: this.h / 2 + (x - this.camX) * s };
    return { sx: this.w / 2 + (x - this.camX) * s, sy: this.h * 0.62 - (y - this.camY) * s };
  }

  /** Convert a joystick direction in screen space (dy down) to a world-space direction. */
  screenDirToWorld(dx: number, dy: number): Vec {
    return this.landscape ? { x: dy, y: dx } : { x: dx, y: -dy };
  }

  /** Snap the camera to the play (used before the snap). */
  focus(x: number, y: number): void {
    this.camX = this.clampCamX(x);
    this.camY = y;
  }

  private clampCamX(x: number): number {
    const half = (this.landscape ? this.h : this.w) / 2 / this.scale;
    if (half * 2 >= FIELD_W + 6) return FIELD_W / 2;
    return Math.max(half - 3, Math.min(FIELD_W + 3 - half, x));
  }

  draw(engine: PlayEngine | null, hud: Hud, dt: number, showRoutes: boolean): void {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (engine) {
      const b = engine.ballPos();
      const k = Math.min(1, dt * 4);
      this.camX += (this.clampCamX(b.x) - this.camX) * k;
      this.camY += (b.y + (engine.t === 0 ? 4 : 2) - this.camY) * k;
    }
    this.drawField(engine, hud);
    if (!engine) return;
    if (showRoutes) this.drawRoutes(engine);
    for (const a of engine.actors) this.drawShadow(a);
    for (const a of engine.actors) this.drawActor(engine, a);
    this.drawBall(engine);
    this.drawReceiverIcons(engine);
    this.drawFloats(engine);
  }

  private line(x1: number, y1: number, x2: number, y2: number): void {
    const a = this.toScreen(x1, y1);
    const b = this.toScreen(x2, y2);
    this.ctx.beginPath();
    this.ctx.moveTo(a.sx, a.sy);
    this.ctx.lineTo(b.sx, b.sy);
    this.ctx.stroke();
  }

  private rect(x1: number, y1: number, x2: number, y2: number, fill: string): void {
    const a = this.toScreen(x1, y1);
    const b = this.toScreen(x2, y2);
    this.ctx.fillStyle = fill;
    this.ctx.fillRect(Math.min(a.sx, b.sx), Math.min(a.sy, b.sy), Math.abs(b.sx - a.sx), Math.abs(b.sy - a.sy));
  }

  private drawField(engine: PlayEngine | null, hud: Hud): void {
    const ctx = this.ctx;
    ctx.fillStyle = '#1d5e2a';
    ctx.fillRect(0, 0, this.w, this.h);
    // Out-of-bounds border.
    this.rect(-6, -14, FIELD_W + 6, 114, '#1a4f24');
    // Grass stripes every 5 yards.
    for (let y = 0; y < 100; y += 5) this.rect(0, y, FIELD_W, y + 5, (y / 5) % 2 ? '#2f7d3a' : '#2a7335');
    // End zones (the user's colors at the end they defend when on offense).
    const userOff = !engine || engine.userSide === 'off';
    this.rect(0, -10, FIELD_W, 0, userOff ? '#174a96' : '#9e2b2b');
    this.rect(0, 100, FIELD_W, 110, userOff ? '#9e2b2b' : '#174a96');
    this.drawEndzoneText(userOff ? hud.userTeam : hud.cpuTeam, -5);
    this.drawEndzoneText(userOff ? hud.cpuTeam : hud.userTeam, 105);

    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 2;
    this.line(0, -10, 0, 110);
    this.line(FIELD_W, -10, FIELD_W, 110);
    for (let y = 0; y <= 100; y += 5) {
      ctx.lineWidth = y % 10 === 0 ? 2 : 1;
      this.line(0, y, FIELD_W, y);
    }
    // Hash marks.
    ctx.lineWidth = 1;
    for (let y = 1; y < 100; y++) {
      if (y % 5 === 0) continue;
      for (const hx of [0.3, 23.6, 29.7, FIELD_W - 0.3]) this.line(hx - 0.4, y, hx + 0.4, y);
    }
    // Yard numbers.
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.font = `bold ${Math.round(this.scale * 1.8)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let y = 10; y <= 90; y += 10) {
      const n = y > 50 ? 100 - y : y;
      for (const nx of [9, FIELD_W - 9]) {
        const p = this.toScreen(nx, y);
        ctx.save();
        ctx.translate(p.sx, p.sy);
        if (this.landscape) ctx.rotate(nx < FIELD_W / 2 ? Math.PI : 0);
        if (!this.landscape) ctx.rotate(nx < FIELD_W / 2 ? Math.PI / 2 : -Math.PI / 2);
        ctx.fillText(String(n), 0, 0);
        ctx.restore();
      }
    }
    if (engine) {
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#4aa3ff';
      this.line(0, engine.los, FIELD_W, engine.los);
      if (hud.firstDownY !== null && hud.firstDownY < 100) {
        ctx.strokeStyle = '#ffd400';
        this.line(0, hud.firstDownY, FIELD_W, hud.firstDownY);
      }
    }
  }

  private drawEndzoneText(text: string, y: number): void {
    const ctx = this.ctx;
    const p = this.toScreen(FIELD_W / 2, y);
    ctx.save();
    ctx.translate(p.sx, p.sy);
    if (this.landscape) ctx.rotate(y < 50 ? -Math.PI / 2 : Math.PI / 2);
    else if (y < 50) ctx.rotate(Math.PI);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = `900 ${Math.round(this.scale * 2.6)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text.toUpperCase(), 0, 0);
    ctx.restore();
  }

  private drawRoutes(engine: PlayEngine): void {
    const ctx = this.ctx;
    ctx.lineWidth = 2.5;
    ctx.setLineDash([6, 5]);
    for (const a of engine.eligibleReceivers()) {
      if (!a.route) continue;
      ctx.strokeStyle = RECEIVER_ICONS[a.slot]?.color ?? '#fff';
      ctx.globalAlpha = 0.75;
      let prev: Vec = a;
      for (const p of a.route) {
        this.line(prev.x, prev.y, p.x, p.y);
        prev = p;
      }
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  private drawShadow(a: Actor): void {
    const p = this.toScreen(a.x + 0.25, a.y - 0.25);
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.arc(p.sx, p.sy, this.scale * 0.8, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawActor(engine: PlayEngine, a: Actor): void {
    const ctx = this.ctx;
    const p = this.toScreen(a.x, a.y);
    const r = this.scale * 0.8;
    const isUser = a.side === engine.userSide;
    if (a === engine.controlled && !engine.over) {
      ctx.strokeStyle = '#ffe94a';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(p.sx, p.sy, r + 5, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = isUser ? USER_COLOR : CPU_COLOR;
    ctx.globalAlpha = a.stun > 0 ? 0.55 : 1;
    ctx.beginPath();
    ctx.arc(p.sx, p.sy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = isUser ? USER_TRIM : CPU_TRIM;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${Math.round(r * 1.05)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(a.card.number), p.sx, p.sy + 0.5);
  }

  private drawBall(engine: PlayEngine): void {
    const b = engine.ballPos();
    const ctx = this.ctx;
    const ground = this.toScreen(b.x, b.y);
    if (b.h > 0.1) {
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.beginPath();
      ctx.ellipse(ground.sx, ground.sy, this.scale * 0.35, this.scale * 0.22, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    const lift = b.h * this.scale * 0.6;
    const sx = ground.sx + (engine.ball.state === 'held' ? this.scale * 0.55 : 0);
    const sy = ground.sy - lift;
    ctx.fillStyle = '#8b4a1c';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(sx, sy, this.scale * 0.42, this.scale * 0.26, -0.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  /** Receiver target icons, tinted by how open each receiver is. */
  private drawReceiverIcons(engine: PlayEngine): void {
    if (engine.userSide !== 'off' || !engine.canThrow()) return;
    const ctx = this.ctx;
    for (const a of engine.eligibleReceivers()) {
      const icon = RECEIVER_ICONS[a.slot];
      if (!icon) continue;
      const p = this.iconPos(a);
      const open = openness(engine, a);
      ctx.fillStyle = icon.color;
      ctx.strokeStyle = open > 3 ? '#ffffff' : open > 1.6 ? '#ffd400' : '#222';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(p.sx, p.sy, 13, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 15px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(icon.label, p.sx, p.sy + 1);
    }
  }

  iconPos(a: Actor): { sx: number; sy: number } {
    const p = this.toScreen(a.x, a.y);
    return { sx: p.sx, sy: p.sy - (this.scale * 0.8 + 16) };
  }

  private drawFloats(engine: PlayEngine): void {
    const ctx = this.ctx;
    for (const f of engine.floats) {
      const p = this.toScreen(f.x, f.y);
      ctx.globalAlpha = Math.max(0, 1 - f.t / 1.2);
      ctx.fillStyle = '#ffe94a';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 3;
      ctx.font = '900 16px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.strokeText(f.text, p.sx, p.sy - 24 - f.t * 30);
      ctx.fillText(f.text, p.sx, p.sy - 24 - f.t * 30);
    }
    ctx.globalAlpha = 1;
  }
}

export function openness(engine: PlayEngine, a: Actor): number {
  let open = Infinity;
  for (const d of engine.def) open = Math.min(open, Math.hypot(d.x - a.x, d.y - a.y));
  return open;
}
