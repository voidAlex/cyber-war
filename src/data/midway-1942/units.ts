/**
 * 中途岛海战 1942 — units.json 数据（初始部署）。
 *
 * 史实部署（查证自维基/百科）：
 * - 美军：3 艘航母（企业 CV-6/约克城 CV-5/大黄蜂 CV-8）+ 巡洋舰 + 驱逐舰 + 中途岛岸基航空
 *   （B-17/PBY/SBD）。约克城珊瑚海受损后 72 小时抢修参战。
 * - 日军：4 艘主力航母（赤城/加贺/苍龙/飞龙）+ 战列舰（含雾岛/榛名）+ 巡洋舰 + 驱逐舰庞大舰队。
 *
 * 坐标对齐 map.ts（14×10）。
 * - 美军特混舰队在东北机动海域（col 9-11,row 3-4）设伏；中途岛岸基航空在 cell-7-5。
 * - 日军第一航空舰队从西北逼近（col 2-4,row 3-4），主攻中途岛。
 *
 * 类型映射（schema 无 carrier 专用类型）：航母/战列舰/巡洋舰/驱逐舰 → naval；
 * 岸基航空 → air。装备槽区分载机/主炮。
 *
 * @module data/midway-1942/units
 */

import type { CampaignUnit } from '@/types'

/** 中途岛海战初始单位部署 */
export const midwayUnits: CampaignUnit[] = [
  // ============================================================
  // 美国（守，8 单位）
  // ============================================================
  // === 航母 ×3（企业/约克城/大黄蜂） ===
  {
    id: 'us-carrier-enterprise',
    factionId: 'usa',
    type: 'naval',
    // 第 16 特混舰队旗舰（企业 CV-6，东北机动海域设伏）
    coord: { col: 10, row: 3 },
    strength: 100,
    personnel: 2200,
    maxPersonnel: 2200,
    fuel: 70,
    ammo: 80,
    morale: 75,
    fatigue: 20,
    status: [],
    // 装备：F4F 野猫战斗机 + SBD 无畏俯冲轰炸机 + TBD/TBF 鱼雷机
    equipment: [
      { type: 'carrier-fighter', count: 36, quality: 0.8 },
      { type: 'dive-bomber', count: 36, quality: 0.85 },
      { type: 'torpedo-bomber', count: 18, quality: 0.7 },
    ],
  },
  {
    id: 'us-carrier-yorktown',
    factionId: 'usa',
    type: 'naval',
    // 约克城 CV-5（珊瑚海受损后 72 小时抢修参战，第 17 特混舰队）
    coord: { col: 9, row: 4 },
    strength: 95, // 抢修后战力略降
    personnel: 2200,
    maxPersonnel: 2200,
    fuel: 65,
    ammo: 75,
    morale: 72,
    fatigue: 25, // 抢修参战疲劳较高
    status: [],
    equipment: [
      { type: 'carrier-fighter', count: 36, quality: 0.8 },
      { type: 'dive-bomber', count: 35, quality: 0.85 },
      { type: 'torpedo-bomber', count: 17, quality: 0.7 },
    ],
  },
  {
    id: 'us-carrier-hornet',
    factionId: 'usa',
    type: 'naval',
    // 大黄蜂 CV-8（第 16 特混舰队，搭载杜立特 B-25 后转战中途岛）
    coord: { col: 11, row: 3 },
    strength: 100,
    personnel: 2200,
    maxPersonnel: 2200,
    fuel: 70,
    ammo: 80,
    morale: 75,
    fatigue: 20,
    status: [],
    equipment: [
      { type: 'carrier-fighter', count: 36, quality: 0.8 },
      { type: 'dive-bomber', count: 36, quality: 0.85 },
      { type: 'torpedo-bomber', count: 18, quality: 0.7 },
    ],
  },
  // === 巡洋舰 ×3 ===
  {
    id: 'us-cruiser-1',
    factionId: 'usa',
    type: 'naval',
    // 第 16 特混舰队巡洋舰（防空/屏护航母）
    coord: { col: 10, row: 4 },
    strength: 75,
    personnel: 900,
    maxPersonnel: 900,
    fuel: 75,
    ammo: 70,
    morale: 72,
    fatigue: 18,
    status: [],
    // 装备：203mm 主炮 + 防空炮
    equipment: [{ type: 'cruiser-main-gun', count: 9, quality: 0.8 }],
  },
  {
    id: 'us-cruiser-2',
    factionId: 'usa',
    type: 'naval',
    coord: { col: 9, row: 3 },
    strength: 75,
    personnel: 900,
    maxPersonnel: 900,
    fuel: 75,
    ammo: 70,
    morale: 72,
    fatigue: 18,
    status: [],
    equipment: [{ type: 'cruiser-main-gun', count: 9, quality: 0.8 }],
  },
  {
    id: 'us-cruiser-3',
    factionId: 'usa',
    type: 'naval',
    // 第 17 特混舰队巡洋舰
    coord: { col: 8, row: 5 },
    strength: 72,
    personnel: 900,
    maxPersonnel: 900,
    fuel: 72,
    ammo: 68,
    morale: 70,
    fatigue: 20,
    status: [],
    equipment: [{ type: 'cruiser-main-gun', count: 9, quality: 0.8 }],
  },
  // === 驱逐舰编队 ×1（5 艘简化为 1 组，屏护航母/反潜） ===
  {
    id: 'us-destroyer-group',
    factionId: 'usa',
    type: 'naval',
    // 驱逐舰编队（反潜/防空屏护 + 鱼雷突击）
    coord: { col: 11, row: 4 },
    strength: 50,
    personnel: 1200,
    maxPersonnel: 1500,
    fuel: 80,
    ammo: 60,
    morale: 70,
    fatigue: 15,
    status: [],
    // 装备：127mm 主炮 + 鱼雷发射管
    equipment: [
      { type: 'destroyer-gun', count: 25, quality: 0.75 },
      { type: 'torpedo', count: 40, quality: 0.7 },
    ],
  },
  // === 中途岛岸基航空 ×1（B-17/SBD/PBY） ===
  {
    id: 'us-midway-air',
    factionId: 'usa',
    type: 'air', // 岸基航空
    // 中途岛机场（B-17 水平轰炸 + SBD 俯冲 + PBY 侦察）
    coord: { col: 7, row: 5 },
    strength: 70,
    personnel: 1500,
    maxPersonnel: 2000,
    fuel: 65,
    ammo: 75,
    morale: 70,
    fatigue: 25,
    status: [],
    // 装备：B-17 重型轰炸机 + SBD 俯冲轰炸机 + PBY 巡逻侦察机
    equipment: [
      { type: 'heavy-bomber', count: 17, quality: 0.75 },
      { type: 'dive-bomber', count: 16, quality: 0.8 },
      { type: 'recon-plane', count: 6, quality: 0.7 },
    ],
  },

  // ============================================================
  // 日本（攻，10 单位）
  // ============================================================
  // === 主力航母 ×4（赤城/加贺/苍龙/飞龙） ===
  {
    id: 'jp-carrier-akagi',
    factionId: 'japan',
    type: 'naval',
    // 赤城（第一航空舰队旗舰，南云座舰，西北逼近中途岛）
    coord: { col: 4, row: 4 },
    strength: 100,
    personnel: 2000,
    maxPersonnel: 2000,
    fuel: 70,
    ammo: 85,
    morale: 80,
    fatigue: 15,
    status: [],
    // 装备：零式舰战 + 九九舰爆 + 九七舰攻
    equipment: [
      { type: 'carrier-fighter', count: 24, quality: 0.9 },
      { type: 'dive-bomber', count: 24, quality: 0.85 },
      { type: 'torpedo-bomber', count: 18, quality: 0.85 },
    ],
  },
  {
    id: 'jp-carrier-kaga',
    factionId: 'japan',
    type: 'naval',
    // 加贺（第一航空舰队，弹药/载机量大）
    coord: { col: 3, row: 4 },
    strength: 100,
    personnel: 2000,
    maxPersonnel: 2000,
    fuel: 68,
    ammo: 85,
    morale: 80,
    fatigue: 15,
    status: [],
    equipment: [
      { type: 'carrier-fighter', count: 24, quality: 0.9 },
      { type: 'dive-bomber', count: 27, quality: 0.85 },
      { type: 'torpedo-bomber', count: 18, quality: 0.85 },
    ],
  },
  {
    id: 'jp-carrier-soryu',
    factionId: 'japan',
    type: 'naval',
    // 苍龙（第二航空战队）
    coord: { col: 4, row: 3 },
    strength: 100,
    personnel: 1500,
    maxPersonnel: 1500,
    fuel: 70,
    ammo: 80,
    morale: 78,
    fatigue: 18,
    status: [],
    equipment: [
      { type: 'carrier-fighter', count: 21, quality: 0.9 },
      { type: 'dive-bomber', count: 21, quality: 0.85 },
      { type: 'torpedo-bomber', count: 18, quality: 0.85 },
    ],
  },
  {
    id: 'jp-carrier-hiryu',
    factionId: 'japan',
    type: 'naval',
    // 飞龙（第二航空战队，史实反击重创约克城后沉没）
    coord: { col: 5, row: 3 },
    strength: 100,
    personnel: 1500,
    maxPersonnel: 1500,
    fuel: 70,
    ammo: 80,
    morale: 80,
    fatigue: 18,
    status: [],
    equipment: [
      { type: 'carrier-fighter', count: 21, quality: 0.9 },
      { type: 'dive-bomber', count: 21, quality: 0.85 },
      { type: 'torpedo-bomber', count: 18, quality: 0.85 },
    ],
  },
  // === 战列舰 ×2（雾岛/榛名） ===
  {
    id: 'jp-battleship-1',
    factionId: 'japan',
    type: 'naval',
    // 雾岛（战列舰，炮击中途岛/屏护航母）
    coord: { col: 3, row: 3 },
    strength: 90,
    personnel: 1400,
    maxPersonnel: 1400,
    fuel: 65,
    ammo: 90,
    morale: 78,
    fatigue: 15,
    status: [],
    // 装备：356mm 主炮（战列舰巨炮）
    equipment: [{ type: 'battleship-main-gun', count: 8, quality: 0.9 }],
  },
  {
    id: 'jp-battleship-2',
    factionId: 'japan',
    type: 'naval',
    // 榛名（战列舰）
    coord: { col: 2, row: 3 },
    strength: 90,
    personnel: 1400,
    maxPersonnel: 1400,
    fuel: 65,
    ammo: 90,
    morale: 78,
    fatigue: 15,
    status: [],
    equipment: [{ type: 'battleship-main-gun', count: 8, quality: 0.9 }],
  },
  // === 巡洋舰 ×3 ===
  {
    id: 'jp-cruiser-1',
    factionId: 'japan',
    type: 'naval',
    coord: { col: 4, row: 5 },
    strength: 75,
    personnel: 900,
    maxPersonnel: 900,
    fuel: 72,
    ammo: 72,
    morale: 75,
    fatigue: 18,
    status: [],
    equipment: [{ type: 'cruiser-main-gun', count: 10, quality: 0.82 }],
  },
  {
    id: 'jp-cruiser-2',
    factionId: 'japan',
    type: 'naval',
    coord: { col: 5, row: 5 },
    strength: 75,
    personnel: 900,
    maxPersonnel: 900,
    fuel: 72,
    ammo: 72,
    morale: 75,
    fatigue: 18,
    status: [],
    equipment: [{ type: 'cruiser-main-gun', count: 10, quality: 0.82 }],
  },
  {
    id: 'jp-cruiser-3',
    factionId: 'japan',
    type: 'naval',
    coord: { col: 2, row: 4 },
    strength: 72,
    personnel: 900,
    maxPersonnel: 900,
    fuel: 70,
    ammo: 70,
    morale: 73,
    fatigue: 20,
    status: [],
    equipment: [{ type: 'cruiser-main-gun', count: 10, quality: 0.82 }],
  },
  // === 驱逐舰编队 ×1（12 艘简化为 1 组，反潜/屏护/鱼雷） ===
  {
    id: 'jp-destroyer-group',
    factionId: 'japan',
    type: 'naval',
    coord: { col: 5, row: 4 },
    strength: 50,
    personnel: 1800,
    maxPersonnel: 2000,
    fuel: 78,
    ammo: 65,
    morale: 75,
    fatigue: 18,
    status: [],
    // 装备：127mm 主炮 + 九三式长矛鱼雷（氧气鱼雷，射程威力大）
    equipment: [
      { type: 'destroyer-gun', count: 60, quality: 0.78 },
      { type: 'torpedo', count: 96, quality: 0.85 },
    ],
  },
]
