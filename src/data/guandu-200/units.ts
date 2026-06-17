/**
 * 官渡之战（公元 200 年）— units.json 数据（初始部署）。
 *
 * 史实部署（查证自《三国志》《资治通鉴》/百科）：
 * - 曹军：约 2 万（一说数万），兵少粮乏。精锐步兵据守官渡大营；弓弩手后方纵深压制；
 *   虎豹骑（曹操亲军精锐）侧翼机动；补给队维系许都→官渡生命线。
 * - 袁军：约 10 万，步兵主力屯官渡北岸/南岸桥头；弓弩手远程压制；
 *   骑兵（颜良/文丑所部）机动；攻城器械（棼橹高楼/投石）攻坚曹营；
 *   乌巢守备（淳于琼部）护粮；补给队屯乌巢。
 *
 * 坐标对齐 map.ts（12×9，col 0-11，row 0-8）。
 * - 曹军核心在官渡大营 cell-5-4 一带；后方许都 cell-1-7。
 * - 袁军主力在官渡北岸（row 2-3，col 6-7）；乌巢在 cell-8-2。
 *
 * @module data/guandu-200/units
 */

import type { CampaignUnit } from '@/types'

/** 官渡初始单位部署 */
export const guanduUnits: CampaignUnit[] = [
  // ============================================================
  // 曹操军（守，约 2 万，7 单位）
  // ============================================================
  // === 精锐步兵 ×3：据守官渡大营周边 ===
  {
    id: 'cao-infantry-1',
    factionId: 'caocao',
    type: 'infantry',
    // 官渡大营正前方（曹军一线守备）
    coord: { col: 6, row: 4 },
    strength: 85,
    personnel: 6000,
    maxPersonnel: 8000,
    fuel: 50,
    ammo: 60,
    morale: 70,
    fatigue: 30,
    status: [],
    // 装备：环首刀（汉军制式）+ 大盾（结阵抗骑兵）
    equipment: [
      { type: 'sword', count: 5000, quality: 0.75 },
      { type: 'shield', count: 4000, quality: 0.7 },
    ],
  },
  {
    id: 'cao-infantry-2',
    factionId: 'caocao',
    type: 'infantry',
    // 官渡大营左翼
    coord: { col: 5, row: 5 },
    strength: 80,
    personnel: 5500,
    maxPersonnel: 8000,
    fuel: 50,
    ammo: 58,
    morale: 68,
    fatigue: 32,
    status: [],
    equipment: [
      { type: 'sword', count: 4500, quality: 0.75 },
      { type: 'shield', count: 3500, quality: 0.7 },
    ],
  },
  {
    id: 'cao-infantry-3',
    factionId: 'caocao',
    type: 'infantry',
    // 官渡大营右翼
    coord: { col: 6, row: 5 },
    strength: 75,
    personnel: 5000,
    maxPersonnel: 8000,
    fuel: 48,
    ammo: 55,
    morale: 65,
    fatigue: 35,
    status: [],
    equipment: [
      { type: 'sword', count: 4000, quality: 0.75 },
      { type: 'shield', count: 3000, quality: 0.7 },
    ],
  },
  // === 弓弩手 ×2：后方纵深压制 ===
  {
    id: 'cao-crossbow-1',
    factionId: 'caocao',
    type: 'infantry',
    // 官渡大营后方纵深（弩阵压制袁军冲锋）
    coord: { col: 4, row: 4 },
    strength: 60,
    personnel: 2000,
    maxPersonnel: 3000,
    fuel: 45,
    ammo: 80, // 弩手弹药充足
    morale: 65,
    fatigue: 25,
    status: [],
    // 装备：弩机（汉军强弩，射程远、穿透力强）
    equipment: [{ type: 'crossbow', count: 1800, quality: 0.8 }],
  },
  {
    id: 'cao-crossbow-2',
    factionId: 'caocao',
    type: 'infantry',
    // 大营后方另一翼弩阵
    coord: { col: 4, row: 5 },
    strength: 60,
    personnel: 2000,
    maxPersonnel: 3000,
    fuel: 45,
    ammo: 80,
    morale: 65,
    fatigue: 25,
    status: [],
    equipment: [{ type: 'crossbow', count: 1800, quality: 0.8 }],
  },
  // === 虎豹骑 ×1：侧翼机动（曹操亲军精锐） ===
  {
    id: 'cao-hubao-cavalry',
    factionId: 'caocao',
    type: 'armor', // schema 无 cavalry，虎豹骑为重装骑兵，归 armor
    // 侧翼机动（待机奇袭乌巢方向）
    coord: { col: 5, row: 6 },
    strength: 90,
    personnel: 1500,
    maxPersonnel: 2000,
    fuel: 70,
    ammo: 50,
    morale: 85, // 亲军精锐，士气高昂
    fatigue: 20,
    status: [],
    // 装备：马铠（重装骑兵标配）+ 长槊（冲击兵器）
    equipment: [
      { type: 'horse-armor', count: 1500, quality: 0.85 },
      { type: 'long-spear', count: 1500, quality: 0.8 },
    ],
  },
  // === 补给队 ×1：许都方向（维系曹军生命线） ===
  {
    id: 'cao-supply-1',
    factionId: 'caocao',
    type: 'support',
    // 许都→官渡补给线上（押运粮草辎重）
    coord: { col: 3, row: 6 },
    strength: 40,
    personnel: 1000,
    maxPersonnel: 1500,
    fuel: 60,
    ammo: 20,
    morale: 60,
    fatigue: 40, // 长途押运疲劳较高
    status: [],
  },

  // ============================================================
  // 袁绍军（攻，约 10 万，14 单位）
  // ============================================================
  // === 步兵 ×6：官渡北岸/南岸桥头主力 ===
  {
    id: 'yuan-infantry-1',
    factionId: 'yuanshao',
    type: 'infantry',
    // 官渡北岸袁军主力（正对曹营主攻方向）
    coord: { col: 6, row: 3 },
    strength: 70,
    personnel: 12000,
    maxPersonnel: 15000,
    fuel: 50,
    ammo: 65,
    morale: 65,
    fatigue: 30,
    status: [],
    equipment: [
      { type: 'spear', count: 10000, quality: 0.65 },
      { type: 'shield', count: 6000, quality: 0.6 },
    ],
  },
  {
    id: 'yuan-infantry-2',
    factionId: 'yuanshao',
    type: 'infantry',
    coord: { col: 7, row: 3 },
    strength: 68,
    personnel: 11000,
    maxPersonnel: 15000,
    fuel: 48,
    ammo: 62,
    morale: 64,
    fatigue: 32,
    status: [],
    equipment: [
      { type: 'spear', count: 9000, quality: 0.65 },
      { type: 'shield', count: 5000, quality: 0.6 },
    ],
  },
  {
    id: 'yuan-infantry-3',
    factionId: 'yuanshao',
    type: 'infantry',
    coord: { col: 5, row: 3 },
    strength: 70,
    personnel: 12000,
    maxPersonnel: 15000,
    fuel: 50,
    ammo: 65,
    morale: 65,
    fatigue: 30,
    status: [],
    equipment: [
      { type: 'spear', count: 10000, quality: 0.65 },
      { type: 'shield', count: 6000, quality: 0.6 },
    ],
  },
  {
    id: 'yuan-infantry-4',
    factionId: 'yuanshao',
    type: 'infantry',
    coord: { col: 6, row: 2 },
    strength: 65,
    personnel: 10000,
    maxPersonnel: 15000,
    fuel: 46,
    ammo: 60,
    morale: 62,
    fatigue: 34,
    status: [],
    equipment: [
      { type: 'spear', count: 8500, quality: 0.65 },
      { type: 'shield', count: 4500, quality: 0.6 },
    ],
  },
  {
    id: 'yuan-infantry-5',
    factionId: 'yuanshao',
    type: 'infantry',
    coord: { col: 7, row: 2 },
    strength: 62,
    personnel: 9500,
    maxPersonnel: 15000,
    fuel: 45,
    ammo: 58,
    morale: 60,
    fatigue: 36,
    status: [],
    equipment: [
      { type: 'spear', count: 8000, quality: 0.65 },
      { type: 'shield', count: 4000, quality: 0.6 },
    ],
  },
  {
    id: 'yuan-infantry-6',
    factionId: 'yuanshao',
    type: 'infantry',
    coord: { col: 8, row: 3 },
    strength: 60,
    personnel: 9000,
    maxPersonnel: 15000,
    fuel: 44,
    ammo: 56,
    morale: 58,
    fatigue: 38,
    status: [],
    equipment: [
      { type: 'spear', count: 7500, quality: 0.65 },
      { type: 'shield', count: 3800, quality: 0.6 },
    ],
  },
  // === 弓弩手 ×3：远程压制曹营 ===
  {
    id: 'yuan-crossbow-1',
    factionId: 'yuanshao',
    type: 'infantry',
    coord: { col: 7, row: 4 },
    strength: 55,
    personnel: 3000,
    maxPersonnel: 4000,
    fuel: 45,
    ammo: 75,
    morale: 60,
    fatigue: 30,
    status: [],
    equipment: [{ type: 'crossbow', count: 2800, quality: 0.7 }],
  },
  {
    id: 'yuan-crossbow-2',
    factionId: 'yuanshao',
    type: 'infantry',
    coord: { col: 8, row: 4 },
    strength: 55,
    personnel: 3000,
    maxPersonnel: 4000,
    fuel: 45,
    ammo: 75,
    morale: 60,
    fatigue: 30,
    status: [],
    equipment: [{ type: 'crossbow', count: 2800, quality: 0.7 }],
  },
  {
    id: 'yuan-crossbow-3',
    factionId: 'yuanshao',
    type: 'infantry',
    coord: { col: 6, row: 2 },
    strength: 55,
    personnel: 3000,
    maxPersonnel: 4000,
    fuel: 45,
    ammo: 75,
    morale: 60,
    fatigue: 32,
    status: [],
    equipment: [{ type: 'crossbow', count: 2800, quality: 0.7 }],
  },
  // === 骑兵 ×2：颜良/文丑所部，机动突击 ===
  {
    id: 'yuan-cavalry-1',
    factionId: 'yuanshao',
    type: 'armor', // schema 无 cavalry，骑兵归 armor
    coord: { col: 8, row: 2 },
    strength: 70,
    personnel: 2500,
    maxPersonnel: 3000,
    fuel: 65,
    ammo: 45,
    morale: 65,
    fatigue: 28,
    status: [],
    equipment: [
      { type: 'horse-armor', count: 1500, quality: 0.65 },
      { type: 'long-spear', count: 2500, quality: 0.7 },
    ],
  },
  {
    id: 'yuan-cavalry-2',
    factionId: 'yuanshao',
    type: 'armor',
    coord: { col: 9, row: 2 },
    strength: 70,
    personnel: 2500,
    maxPersonnel: 3000,
    fuel: 65,
    ammo: 45,
    morale: 65,
    fatigue: 28,
    status: [],
    equipment: [
      { type: 'horse-armor', count: 1500, quality: 0.65 },
      { type: 'long-spear', count: 2500, quality: 0.7 },
    ],
  },
  // === 攻城器械 ×1：棼橹高楼/投石，攻坚曹营 ===
  {
    id: 'yuan-siege-engine',
    factionId: 'yuanshao',
    type: 'artillery',
    // 袁军后阵（操作棼橹高楼俯射曹营、投石破坏营垒）
    coord: { col: 7, row: 1 },
    strength: 40,
    personnel: 1500,
    maxPersonnel: 2000,
    fuel: 30,
    ammo: 70,
    morale: 55,
    fatigue: 35,
    status: [],
    // 装备：棼橹高楼（高架箭楼）+ 投石车（破垒器）
    equipment: [
      { type: 'siege-tower', count: 8, quality: 0.7 },
      { type: 'traction-trebuchet', count: 12, quality: 0.7 },
    ],
  },
  // === 乌巢守备 ×1：淳于琼部护粮 ===
  {
    id: 'yuan-wuchao-guard',
    factionId: 'yuanshao',
    type: 'infantry',
    // 乌巢粮仓守备（淳于琼部，史实"性嗜酒、备弛"）
    coord: { col: 8, row: 2 },
    strength: 50,
    personnel: 3000,
    maxPersonnel: 5000,
    fuel: 55,
    ammo: 50,
    morale: 50, // 守备松弛、士气一般
    fatigue: 25,
    status: [],
    equipment: [
      { type: 'spear', count: 2500, quality: 0.6 },
      { type: 'shield', count: 1500, quality: 0.55 },
    ],
  },
  // === 补给队 ×1：屯乌巢（袁军辎重核心） ===
  {
    id: 'yuan-supply-wuchao',
    factionId: 'yuanshao',
    type: 'support',
    // 乌巢粮仓（袁军粮草辎重囤积核心，淳于琼押运）
    coord: { col: 8, row: 2 },
    strength: 40,
    personnel: 2000,
    maxPersonnel: 3000,
    fuel: 60,
    ammo: 15,
    morale: 55,
    fatigue: 30,
    status: [],
    // 装备：辎重车（运粮车辆）—史实被曹军焚毁
    equipment: [{ type: 'supply-cart', count: 200, quality: 0.5 }],
  },

  // ============================================================
  // 刘表军（第 3 批新增中立第三方，2 单位，南方荆州守备）
  // ============================================================
  // 史实：刘表荆州军在南方（荆襄），与官渡主战场相距甚远，仅作守备，不主动出击。
  // 部署在网格南方边缘（row 8），象征荆州方向，不动。
  // === 荆州守备步兵 ×2：南方据守（不参战，保境安民） ===
  {
    id: 'biaojiao-infantry-1',
    factionId: 'biaojiao',
    type: 'infantry',
    // 荆州北部守备（南阳方向，监视官渡战局但不介入）
    coord: { col: 3, row: 8 },
    strength: 65,
    personnel: 6000,
    maxPersonnel: 8000,
    fuel: 50,
    ammo: 60,
    morale: 60, // 中立守备，士气一般（无战意）
    fatigue: 20,
    status: [],
    equipment: [
      { type: 'spear', count: 5000, quality: 0.65 },
      { type: 'shield', count: 3000, quality: 0.6 },
    ],
  },
  {
    id: 'biaojiao-infantry-2',
    factionId: 'biaojiao',
    type: 'infantry',
    // 荆州北部守备（新野方向）
    coord: { col: 4, row: 8 },
    strength: 63,
    personnel: 5500,
    maxPersonnel: 8000,
    fuel: 48,
    ammo: 58,
    morale: 60,
    fatigue: 22,
    status: [],
    equipment: [
      { type: 'spear', count: 4500, quality: 0.65 },
      { type: 'shield', count: 2800, quality: 0.6 },
    ],
  },
]
