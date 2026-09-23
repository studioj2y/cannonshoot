export type BrickShape = 'box' | 'cylinder' | 'wedge';

export interface BrickDef {
  shape: BrickShape;
  pos: [number, number, number];
  size: [number, number, number]; // box: half? no -> full dims; cylinder: [radius, height, radius]
  color: ColorKey;
  static?: boolean;
  mass?: number;
  target?: boolean;
  score?: number;
  rotY?: number;
}

export type ColorKey = 'red' | 'yellow' | 'blue' | 'green' | 'purple' | 'orange' | 'gray';

export const COLORS: Record<ColorKey, number> = {
  red: 0xff5a5f,
  yellow: 0xffd23f,
  blue: 0x4cb5f5,
  green: 0x5bd68a,
  purple: 0xb07cf0,
  orange: 0xff9f43,
  gray: 0xb8c2cc,
};

export interface Objective {
  kind: 'knockCount' | 'knockAll' | 'color' | 'targets' | 'score';
  count?: number;
  color?: ColorKey;
  text: string;
}

export interface LevelDef {
  name: string;
  hint: string;
  ammo: number;
  targetScore: number;
  twoStarAmmoLeft: number; // ammo remaining required for 2 stars
  objective: Objective;
  ground: 'grass' | 'sand';
  bricks: BrickDef[];
}

const rainbow: ColorKey[] = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'];

function wall(x0: number, y0: number, z: number, cols: number, rows: number, bw = 1.6, bh = 0.8, bd = 0.9): BrickDef[] {
  const out: BrickDef[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const off = r % 2 === 0 ? 0 : bw / 2;
      out.push({
        shape: 'box',
        pos: [x0 + c * bw + off, y0 + bh / 2 + r * bh, z],
        size: [bw * 0.97, bh * 0.95, bd],
        color: rainbow[(r + c) % rainbow.length],
        mass: 1.4,
      });
    }
  }
  return out;
}

function tower(x: number, z: number, layers: number, base = 2.2): BrickDef[] {
  const out: BrickDef[] = [];
  let y = 0;
  for (let i = 0; i < layers; i++) {
    const w = base * (1 - i * 0.06);
    // two pillars + plate
    out.push({ shape: 'box', pos: [x - w / 2, y + 0.6, z], size: [0.6, 1.2, 0.8], color: rainbow[i % 6], mass: 1.2 });
    out.push({ shape: 'box', pos: [x + w / 2, y + 0.6, z], size: [0.6, 1.2, 0.8], color: rainbow[i % 6], mass: 1.2 });
    out.push({ shape: 'box', pos: [x, y + 1.35, z], size: [w + 1.0, 0.3, 1.2], color: rainbow[(i + 3) % 6], mass: 1.0 });
    y += 1.5;
  }
  out.push({ shape: 'cylinder', pos: [x, y + 0.5, z], size: [0.6, 1.0, 0.6], color: 'purple', mass: 1.0, target: true, score: 300 });
  return out;
}

function arch(x: number, z: number, h: number, span: number, color: ColorKey): BrickDef[] {
  const out: BrickDef[] = [];
  const cols = Math.round(h / 0.9);
  for (let i = 0; i < cols; i++) {
    out.push({ shape: 'box', pos: [x - span / 2, 0.45 + i * 0.9, z], size: [0.9, 0.9, 0.9], color, mass: 1.3 });
    out.push({ shape: 'box', pos: [x + span / 2, 0.45 + i * 0.9, z], size: [0.9, 0.9, 0.9], color, mass: 1.3 });
  }
  const top = cols * 0.9;
  out.push({ shape: 'box', pos: [x, top + 0.2, z], size: [span + 1.1, 0.4, 1.0], color: 'yellow', mass: 1.6 });
  return out;
}

export const LEVELS: LevelDef[] = [
  {
    name: 'Basic Wall',
    hint: 'Aim at the middle of the wall and fire!',
    ammo: 5,
    targetScore: 900,
    twoStarAmmoLeft: 2,
    ground: 'grass',
    objective: { kind: 'knockCount', count: 8, text: 'Knock down 8 bricks' },
    bricks: [...wall(-4.8, 0, -26, 6, 4)],
  },
  {
    name: 'Brick Tower',
    hint: 'Hit the lower supports to topple the tower.',
    ammo: 5,
    targetScore: 1600,
    twoStarAmmoLeft: 2,
    ground: 'grass',
    objective: { kind: 'targets', text: 'Knock down the purple crown on top' },
    bricks: [
      { shape: 'box', pos: [0, 0.25, -27], size: [7, 0.5, 5], color: 'gray', static: true },
      ...tower(0, -27, 6),
    ],
  },
  {
    name: 'Unbalanced Arch',
    hint: 'Remove a leg and the whole arch collapses.',
    ammo: 4,
    targetScore: 2000,
    twoStarAmmoLeft: 2,
    ground: 'sand',
    objective: { kind: 'knockCount', count: 14, text: 'Knock down 14 bricks' },
    bricks: [
      ...arch(-4, -26, 3.6, 3.2, 'blue'),
      ...arch(4.5, -28, 4.5, 3.6, 'green'),
      { shape: 'box', pos: [0.2, 4.4, -27], size: [9.5, 0.5, 1.2], color: 'orange', mass: 2.0 },
      { shape: 'box', pos: [-1.5, 5.0, -27], size: [1.2, 0.8, 1.2], color: 'red', mass: 1.0 },
      { shape: 'box', pos: [1.5, 5.0, -27], size: [1.2, 0.8, 1.2], color: 'yellow', mass: 1.0 },
      { shape: 'cylinder', pos: [0, 5.2, -27], size: [0.55, 1.1, 0.55], color: 'purple', mass: 1.0, target: true, score: 300 },
    ],
  },
  {
    name: 'Platforms & Bridges',
    hint: 'Loft shots over the barrier onto the high platform.',
    ammo: 5,
    targetScore: 2600,
    twoStarAmmoLeft: 2,
    ground: 'grass',
    objective: { kind: 'color', color: 'red', count: 4, text: 'Knock down 4 RED bricks' },
    bricks: [
      { shape: 'box', pos: [-6, 2.0, -24], size: [6, 4, 4], color: 'gray', static: true },
      { shape: 'box', pos: [6, 3.0, -30], size: [6, 6, 4], color: 'gray', static: true },
      { shape: 'box', pos: [0, 1.6, -22], size: [4, 3.2, 0.8], color: 'gray', static: true },
      ...wall(-8.2, 4.0, -24, 4, 3, 1.6, 0.8, 0.9),
      { shape: 'box', pos: [5.0, 6.4, -30], size: [1.0, 0.8, 1.0], color: 'red', mass: 1.2 },
      { shape: 'box', pos: [6.5, 6.4, -30], size: [1.0, 0.8, 1.0], color: 'red', mass: 1.2 },
      { shape: 'box', pos: [5.7, 7.2, -30], size: [1.0, 0.8, 1.0], color: 'red', mass: 1.2 },
      { shape: 'box', pos: [7.5, 6.4, -29], size: [1.0, 0.8, 1.0], color: 'red', mass: 1.2 },
      { shape: 'box', pos: [0.5, 6.3, -27], size: [8, 0.4, 1.4], color: 'yellow', mass: 1.8 },
      { shape: 'cylinder', pos: [0.5, 7.0, -27], size: [0.55, 1.0, 0.55], color: 'purple', mass: 1.0, target: true, score: 300 },
    ],
  },
  {
    name: 'Complex Fortress',
    hint: 'Plan carefully — chain reactions are the key.',
    ammo: 6,
    targetScore: 4200,
    twoStarAmmoLeft: 2,
    ground: 'sand',
    objective: { kind: 'knockCount', count: 30, text: 'Knock down 30 bricks' },
    bricks: [
      { shape: 'box', pos: [0, 0.3, -30], size: [22, 0.6, 10], color: 'gray', static: true },
      ...tower(-7, -30, 5, 2.0),
      ...tower(7, -30, 5, 2.0),
      ...arch(0, -27, 2.7, 3.0, 'blue'),
      ...wall(-3.2, 3.4, -30, 4, 3),
      { shape: 'box', pos: [0, 8.2, -30], size: [15, 0.4, 1.6], color: 'orange', mass: 2.2 },
      { shape: 'box', pos: [-2, 8.9, -30], size: [1.2, 1.0, 1.2], color: 'red', mass: 1.2 },
      { shape: 'box', pos: [2, 8.9, -30], size: [1.2, 1.0, 1.2], color: 'green', mass: 1.2 },
      { shape: 'cylinder', pos: [0, 9.0, -30], size: [0.6, 1.2, 0.6], color: 'purple', mass: 1.1, target: true, score: 400 },
    ],
  },
];
