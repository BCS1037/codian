// Portions of this file are adapted from thinking-orbs by Jakub Antalik
// (MIT License, Copyright 2026 Jakub Antalik). See THIRD_PARTY_NOTICES.md.

import { t } from '../../../i18n/i18n';

const ORB_SIZE = 112;
const PIXEL_RATIO_CAP = 2;
const SOLVING_SPEED = 1.82;

interface Dot {
  x: number;
  y: number;
  z: number;
  r: number;
  white: number;
}

interface Move {
  axis: 0 | 1 | 2;
  lo: number;
  hi: number;
  ang: number;
}

function deterministicUnitHash(seedA: number, seedB: number): number {
  const h = Math.sin(seedA * 12.9898 + seedB * 78.233) * 43758.5453;
  return h - Math.floor(h);
}

function makeProj(yaw: number, tilt: number, cx: number, cy: number, scale: number) {
  const st = Math.sin(tilt);
  const ct = Math.cos(tilt);
  const sy = Math.sin(yaw);
  const cyw = Math.cos(yaw);
  return (x: number, y: number, z: number): [number, number, number] => {
    const x1 = x * cyw + z * sy;
    const z1 = -x * sy + z * cyw;
    const y1 = y * ct - z1 * st;
    const z2 = y * st + z1 * ct;
    return [cx + x1 * scale, cy - y1 * scale, z2];
  };
}

function radiusScale(size: number): number {
  return (size / 300) ** 0.6;
}

function paint(ctx: CanvasRenderingContext2D, dots: Dot[], dark: boolean): void {
  dots.sort((a, b) => a.z - b.z);
  for (const dot of dots) {
    const gray = Math.round((dark ? 1 - dot.white : dot.white) * 255);
    ctx.fillStyle = `rgb(${gray}, ${gray}, ${gray})`;
    ctx.beginPath();
    ctx.arc(dot.x, dot.y, Math.max(0.3, dot.r), 0, Math.PI * 2);
    ctx.fill();
  }
}

function solveCycle(time: number, count: number): { amount: number[]; active: number } {
  const slotDuration = 0.42;
  const cycle = 2 * count * slotDuration + 1.2;
  const cycleTime = time % cycle;
  const amount = new Array<number>(count).fill(0);
  let active = -1;
  if (cycleTime < 2 * count * slotDuration) {
    const slot = Math.floor(cycleTime / slotDuration);
    const progress = (cycleTime - slot * slotDuration) / slotDuration;
    const clamped = Math.min(1, progress / 0.7);
    const eased = 1 - (1 - clamped) ** 3;
    if (slot < count) {
      for (let index = 0; index < slot; index += 1) amount[index] = 1;
      amount[slot] = eased;
      active = slot;
    } else {
      const undo = 2 * count - 1 - slot;
      for (let index = 0; index < undo; index += 1) amount[index] = 1;
      amount[undo] = 1 - eased;
      active = undo;
    }
  }
  return { amount, active };
}

function applyMoves(
  point: [number, number, number],
  moves: Move[],
  state: { amount: number[]; active: number },
): [number, number, number, boolean] {
  let [x, y, z] = point;
  let inActive = false;
  for (let index = 0; index < moves.length; index += 1) {
    if (state.amount[index] <= 0) continue;
    const move = moves[index];
    const coordinate = move.axis === 0 ? x : move.axis === 1 ? y : z;
    if (coordinate < move.lo || coordinate >= move.hi) continue;
    if (index === state.active) inActive = true;
    const angle = move.ang * state.amount[index];
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    if (move.axis === 0) {
      const y2 = y * cosine - z * sine;
      z = y * sine + z * cosine;
      y = y2;
    } else if (move.axis === 1) {
      const x2 = x * cosine + z * sine;
      z = -x * sine + z * cosine;
      x = x2;
    } else {
      const x2 = x * cosine - y * sine;
      y = x * sine + y * cosine;
      x = x2;
    }
  }
  return [x, y, z, inActive];
}

function makeMoves(count: number): Move[] {
  const moves: Move[] = [];
  for (let index = 0; index < count; index += 1) {
    const axis = Math.min(2, Math.floor(deterministicUnitHash(index, 2.3) * 3)) as 0 | 1 | 2;
    const lo = -1 + 0.5 * Math.min(3, Math.floor(deterministicUnitHash(index, 5.9) * 4));
    const direction = deterministicUnitHash(index, 7.7) < 0.5 ? 1 : -1;
    moves.push({ axis, lo, hi: lo + 0.5, ang: (direction * Math.PI) / 2 });
  }
  return moves;
}

function drawSolvingOrb(ctx: CanvasRenderingContext2D, size: number, time: number, dark: boolean): void {
  const center = size / 2;
  const radius = center * 0.82;
  const project = makeProj(time * 0.55, 0.35 + 0.1 * Math.sin(time * 0.9), center, center, radius);
  const scale = radiusScale(size);
  const moves = makeMoves(14);
  const solvingState = solveCycle(time, moves.length);
  const dots: Dot[] = [];
  const latRings = 9;
  const lonDensity = 24;

  for (let latitudeIndex = 0; latitudeIndex <= latRings; latitudeIndex += 1) {
    const latitude = -Math.PI / 2 + (latitudeIndex / latRings) * Math.PI;
    const cosLatitude = Math.cos(latitude);
    const sinLatitude = Math.sin(latitude);
    const longitudeCount = Math.max(1, Math.round(Math.abs(cosLatitude) * lonDensity));
    for (let longitudeIndex = 0; longitudeIndex < longitudeCount; longitudeIndex += 1) {
      const longitude = (longitudeIndex / longitudeCount) * 2 * Math.PI;
      const [x, y, z, inActive] = applyMoves(
        [cosLatitude * Math.cos(longitude), sinLatitude, cosLatitude * Math.sin(longitude)],
        moves,
        solvingState,
      );
      const [screenX, screenY, depthZ] = project(x, y, z);
      const depth = (depthZ + 1) / 2;
      dots.push({
        x: screenX,
        y: screenY,
        z: depthZ,
        r: (0.6 + 1.7 * depth + (inActive ? 0.3 : 0)) * scale * 1.05,
        white: 0.62 - 0.54 * depth - (inActive ? 0.14 : 0),
      });
    }
  }
  paint(ctx, dots, dark);
}

function isDarkTheme(canvas: HTMLCanvasElement): boolean {
  return canvas.ownerDocument.body.classList.contains('theme-dark');
}

export function renderWelcomeOrb(container: HTMLElement): HTMLCanvasElement {
  const ownerDocument = container.ownerDocument;
  const ownerWindow = ownerDocument.defaultView ?? window;
  const canvas = container.createEl('canvas', {
    cls: 'claudian-welcome-orb',
    attr: {
      role: 'img',
      'aria-label': t('chat.welcomeOrb.solving'),
      width: String(ORB_SIZE),
      height: String(ORB_SIZE),
    },
  });
  const context = canvas.getContext?.('2d');
  if (!context) return canvas;

  const pixelRatio = Math.min(ownerWindow.devicePixelRatio || 1, PIXEL_RATIO_CAP);
  canvas.width = Math.round(ORB_SIZE * pixelRatio);
  canvas.height = Math.round(ORB_SIZE * pixelRatio);
  const motionQuery = ownerWindow.matchMedia?.('(prefers-reduced-motion: reduce)');
  let frameId: number | null = null;
  let observer: MutationObserver | null = null;

  const cleanup = (): void => {
    if (frameId !== null) ownerWindow.cancelAnimationFrame(frameId);
    frameId = null;
    ownerDocument.removeEventListener('visibilitychange', onVisibilityChange);
    motionQuery?.removeEventListener('change', onMotionChange);
    observer?.disconnect();
    observer = null;
  };

  const draw = (timestamp: number): void => {
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, ORB_SIZE, ORB_SIZE);
    drawSolvingOrb(context, ORB_SIZE, (timestamp / 1000) * SOLVING_SPEED, isDarkTheme(canvas));
  };

  const animate = (timestamp: number): void => {
    frameId = null;
    if (!canvas.isConnected) {
      cleanup();
      return;
    }
    draw(timestamp);
    if (!motionQuery?.matches && ownerDocument.visibilityState === 'visible') {
      frameId = ownerWindow.requestAnimationFrame(animate);
    }
  };

  const resume = (): void => {
    if (frameId !== null || !canvas.isConnected) return;
    if (motionQuery?.matches) {
      draw(600);
      return;
    }
    frameId = ownerWindow.requestAnimationFrame(animate);
  };

  const onVisibilityChange = (): void => {
    if (ownerDocument.visibilityState === 'visible') resume();
  };
  const onMotionChange = (): void => {
    if (motionQuery.matches) {
      if (frameId !== null) ownerWindow.cancelAnimationFrame(frameId);
      frameId = null;
      draw(600);
      return;
    }
    resume();
  };
  ownerDocument.addEventListener('visibilitychange', onVisibilityChange);
  motionQuery?.addEventListener('change', onMotionChange);
  if (container.parentElement) {
    observer = new ownerWindow.MutationObserver(() => {
      if (!canvas.isConnected) cleanup();
    });
    observer.observe(container.parentElement, { childList: true });
  }
  draw(600);
  resume();
  return canvas;
}

export function renderWelcomeContent(container: HTMLElement, greeting: string): void {
  renderWelcomeOrb(container);
  container.createDiv({ cls: 'claudian-welcome-greeting', text: greeting });
}
