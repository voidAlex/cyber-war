/**
 * 美以伊冲突 2026 — units.json 数据（初始部署）。
 *
 * 部署设定（虚构近未来剧本）：
 * - 美以联军：美军波斯湾航母战斗群（cell-6-10 海域）+ F-35（以色列 cell-1-5 出发）+
 *   驱逐舰 + 战斧导弹驱逐舰 + 特种部队。先发制人精确打击。
 * - 伊朗：弹道导弹阵地（纳坦兹/福特罗周边）+ 革命卫队（IRGC）+ 防空（S-300/Bavar-373）+
 *   导弹快艇（霍尔木兹海峡 cell-8-11）+ Shahed-136 无人机。
 *
 * 坐标对齐 map.ts（16×12）。
 * - 美以航母在波斯湾（cell-6-10 water）；F-35 从以色列（cell-1-5）出发。
 * - 伊朗导弹阵地在核设施周边（cell-12-4/cell-13-6）；快艇在霍尔木兹（cell-8-11）。
 *
 * 类型映射（schema）：航母/驱逐舰 → naval；F-35/无人机 → air；弹道导弹 → missile；
 * 革命卫队 → infantry；防空 → support；战斧导弹驱逐舰 → missile。
 *
 * @module data/iran-2026/units
 */

import type { CampaignUnit } from '@/types'

/** 美以伊冲突初始单位部署 */
export const iranUnits: CampaignUnit[] = [
  // ============================================================
  // 美以联军（攻，8 单位）
  // ============================================================
  // === 航母 ×2（波斯湾航母战斗群） ===
  {
    id: 'us-carrier-1',
    factionId: 'usisrael',
    type: 'naval',
    // 波斯湾航母战斗群（核心海空打击平台，携舰载机 + 战斧）
    coord: { col: 6, row: 10 },
    strength: 100,
    personnel: 5000,
    maxPersonnel: 5000,
    fuel: 75,
    ammo: 85,
    morale: 80,
    fatigue: 15,
    status: [],
    // 装备：F/A-18 超级大黄蜂 + 战斧巡航导弹（航母打击群核心火力）
    equipment: [
      { type: 'carrier-strike-fighter', count: 48, quality: 0.9 },
      { type: 'cruise-missile', count: 60, quality: 0.95 },
    ],
  },
  {
    id: 'us-carrier-2',
    factionId: 'usisrael',
    type: 'naval',
    // 第二航母战斗群（波斯湾备份/防空指挥）
    coord: { col: 5, row: 10 },
    strength: 100,
    personnel: 5000,
    maxPersonnel: 5000,
    fuel: 72,
    ammo: 82,
    morale: 78,
    fatigue: 18,
    status: [],
    equipment: [
      { type: 'carrier-strike-fighter', count: 48, quality: 0.9 },
      { type: 'cruise-missile', count: 50, quality: 0.95 },
    ],
  },
  // === F-35 隐身战机 ×2（以色列出发，突防摧毁深埋工事） ===
  {
    id: 'us-f35-1',
    factionId: 'usisrael',
    type: 'air',
    // F-35I Adir（以色列空军，突防摧毁福特罗深埋工事）
    coord: { col: 1, row: 5 },
    strength: 90,
    personnel: 0,
    maxPersonnel: 1, // schema 要求 maxPersonnel>=1；飞机以 sorties 代理，personnel 给占位
    fuel: 80,
    ammo: 75,
    morale: 85,
    fatigue: 15,
    status: [],
    // 装备：F-35 隐身战机 + 钻地弹（GBU-28/Bunker Buster，摧毁深埋工事）
    equipment: [
      { type: 'stealth-fighter', count: 24, quality: 0.95 },
      { type: 'bunker-buster', count: 48, quality: 0.9 },
    ],
  },
  {
    id: 'us-f35-2',
    factionId: 'usisrael',
    type: 'air',
    // F-35 第二编队（美军，从波斯湾航母/海湾国家基地出发）
    coord: { col: 4, row: 8 },
    strength: 88,
    personnel: 0,
    maxPersonnel: 1,
    fuel: 78,
    ammo: 72,
    morale: 82,
    fatigue: 18,
    status: [],
    equipment: [
      { type: 'stealth-fighter', count: 24, quality: 0.95 },
      { type: 'bunker-buster', count: 48, quality: 0.9 },
    ],
  },
  // === 驱逐舰 ×2（宙斯盾防空 + 反导） ===
  {
    id: 'us-destroyer-1',
    factionId: 'usisrael',
    type: 'naval',
    // 宙斯盾驱逐舰（防空反导，掩护航母抵御伊朗弹道导弹）
    coord: { col: 7, row: 10 },
    strength: 60,
    personnel: 300,
    maxPersonnel: 300,
    fuel: 78,
    ammo: 70,
    morale: 78,
    fatigue: 15,
    status: [],
    // 装备：标准系列防空/反导导弹（SM-3/SM-6，反导拦截伊朗弹道导弹）
    equipment: [{ type: 'sam', count: 90, quality: 0.92 }],
  },
  {
    id: 'us-destroyer-2',
    factionId: 'usisrael',
    type: 'naval',
    coord: { col: 4, row: 11 },
    strength: 60,
    personnel: 300,
    maxPersonnel: 300,
    fuel: 76,
    ammo: 68,
    morale: 76,
    fatigue: 18,
    status: [],
    equipment: [{ type: 'sam', count: 90, quality: 0.92 }],
  },
  // === 战斧导弹驱逐舰 ×2（远程精确打击核设施） ===
  {
    id: 'us-missile-ddg-1',
    factionId: 'usisrael',
    type: 'missile', // 战斧巡航导弹驱逐舰归 missile
    // 波斯湾海域（战斧远程精确打击纳坦兹核设施）
    coord: { col: 6, row: 11 },
    strength: 50,
    personnel: 300,
    maxPersonnel: 300,
    fuel: 72,
    ammo: 90, // 战斧弹药充足
    morale: 78,
    fatigue: 15,
    status: [],
    // 装备：战斧 Block V 巡航导弹（远程精确打击，命中核设施）
    equipment: [{ type: 'cruise-missile', count: 120, quality: 0.95 }],
  },
  {
    id: 'us-missile-ddg-2',
    factionId: 'usisrael',
    type: 'missile',
    coord: { col: 3, row: 11 },
    strength: 50,
    personnel: 300,
    maxPersonnel: 300,
    fuel: 70,
    ammo: 88,
    morale: 76,
    fatigue: 18,
    status: [],
    equipment: [{ type: 'cruise-missile', count: 120, quality: 0.95 }],
  },
  // === 特种部队 ×1（侦察/定点清除） ===
  {
    id: 'us-special-1',
    factionId: 'usisrael',
    type: 'infantry',
    // 伊朗境内渗透（激光指示核设施/定点清除核科学家，引导精确打击）
    coord: { col: 12, row: 5 },
    strength: 70,
    personnel: 120,
    maxPersonnel: 150,
    fuel: 60,
    ammo: 65,
    morale: 85,
    fatigue: 25,
    status: [],
    // 装备：特种部队轻武器 + 激光指示器（引导精确打击）
    equipment: [
      { type: 'rifle', count: 120, quality: 0.9 },
      { type: 'laser-designator', count: 12, quality: 0.95 },
    ],
  },

  // ============================================================
  // 伊朗（守反击，9 单位）
  // ============================================================
  // === 弹道导弹 ×3（Sejjil/Emad，反击以色列/美军） ===
  {
    id: 'iran-missile-1',
    factionId: 'iran',
    type: 'missile',
    // 纳坦兹周边导弹阵地（Sejjil-2 固体弹道导弹，反击以色列）
    coord: { col: 12, row: 4 },
    strength: 60,
    personnel: 400,
    maxPersonnel: 500,
    fuel: 60,
    ammo: 85,
    morale: 80,
    fatigue: 15,
    status: [],
    // 装备：Sejjil-2 中程弹道导弹（固体燃料，反应快，打击以色列/美军基地）
    equipment: [{ type: 'ballistic-missile', count: 24, quality: 0.85 }],
  },
  {
    id: 'iran-missile-2',
    factionId: 'iran',
    type: 'missile',
    // 福特罗周边导弹阵地（Emad 远程弹道导弹）
    coord: { col: 13, row: 6 },
    strength: 60,
    personnel: 400,
    maxPersonnel: 500,
    fuel: 58,
    ammo: 82,
    morale: 78,
    fatigue: 18,
    status: [],
    // 装备：Emad 远程弹道导弹（精确制导，打击高价值目标）
    equipment: [{ type: 'ballistic-missile', count: 20, quality: 0.85 }],
  },
  {
    id: 'iran-missile-3',
    factionId: 'iran',
    type: 'missile',
    // 德黑兰南郊导弹阵地（储备/二次反击）
    coord: { col: 14, row: 4 },
    strength: 58,
    personnel: 400,
    maxPersonnel: 500,
    fuel: 55,
    ammo: 80,
    morale: 76,
    fatigue: 20,
    status: [],
    equipment: [{ type: 'ballistic-missile', count: 20, quality: 0.85 }],
  },
  // === 革命卫队（IRGC）×2（地面防御/不对称作战） ===
  {
    id: 'iran-irgc-1',
    factionId: 'iran',
    type: 'infantry',
    // 纳坦兹核设施周边 IRGC 守备
    coord: { col: 11, row: 4 },
    strength: 65,
    personnel: 2500,
    maxPersonnel: 3000,
    fuel: 50,
    ammo: 65,
    morale: 82, // 革命卫队意识形态士气高
    fatigue: 22,
    status: [],
    // 装备：轻武器 + 反坦克导弹（不对称防御）
    equipment: [
      { type: 'rifle', count: 2500, quality: 0.75 },
      { type: 'anti-tank-missile', count: 80, quality: 0.7 },
    ],
  },
  {
    id: 'iran-irgc-2',
    factionId: 'iran',
    type: 'infantry',
    // 福特罗核设施周边 IRGC 守备
    coord: { col: 14, row: 6 },
    strength: 63,
    personnel: 2500,
    maxPersonnel: 3000,
    fuel: 48,
    ammo: 62,
    morale: 80,
    fatigue: 24,
    status: [],
    equipment: [
      { type: 'rifle', count: 2500, quality: 0.75 },
      { type: 'anti-tank-missile', count: 80, quality: 0.7 },
    ],
  },
  // === 防空 ×2（S-300/Bavar-373，拒止美以空中优势） ===
  {
    id: 'iran-air-defense-1',
    factionId: 'iran',
    type: 'support',
    // 纳坦兹防空阵地（S-300 远程防空，保护核设施拒止 F-35/战斧）
    coord: { col: 12, row: 3 },
    strength: 50,
    personnel: 500,
    maxPersonnel: 600,
    fuel: 40,
    ammo: 70,
    morale: 75,
    fatigue: 18,
    status: [],
    // 装备：S-300PMU2 远程地空导弹（拒止美以空中优势）
    equipment: [{ type: 'sam', count: 48, quality: 0.82 }],
  },
  {
    id: 'iran-air-defense-2',
    factionId: 'iran',
    type: 'support',
    // 福特罗防空阵地（Bavar-373 伊朗国产远程防空）
    coord: { col: 13, row: 7 },
    strength: 48,
    personnel: 500,
    maxPersonnel: 600,
    fuel: 38,
    ammo: 68,
    morale: 73,
    fatigue: 20,
    status: [],
    // 装备：Bavar-373 伊朗国产远程防空导弹
    equipment: [{ type: 'sam', count: 36, quality: 0.78 }],
  },
  // === 导弹快艇 ×1（霍尔木兹海峡封锁，swarm 战术） ===
  {
    id: 'iran-fastboat-1',
    factionId: 'iran',
    type: 'naval',
    // 霍尔木兹海峡（IRGC 导弹快艇群 swarm 攻击美军舰队/封锁油轮）
    coord: { col: 8, row: 11 },
    strength: 40,
    personnel: 200,
    maxPersonnel: 300,
    fuel: 85, // 快艇机动性强，燃料充足
    ammo: 70,
    morale: 85, // IRGC 海上革命卫队士气高
    fatigue: 12,
    status: [],
    // 装备：反舰导弹 + 速射炮（swarm 群狼战术，骚扰美军航母）
    equipment: [
      { type: 'anti-ship-missile', count: 16, quality: 0.75 },
      { type: 'fast-attack-gun', count: 30, quality: 0.7 },
    ],
  },
  // === 无人机 ×1（Shahed-136 饱和攻击） ===
  {
    id: 'iran-drone-1',
    factionId: 'iran',
    type: 'air', // 自杀式无人机归 air（打击型）
    // 波斯湾北岸（Shahed-136 自杀式无人机群饱和攻击美军舰队/以色列）
    coord: { col: 9, row: 9 },
    strength: 30,
    personnel: 0,
    maxPersonnel: 1,
    fuel: 90,
    ammo: 60,
    morale: 70,
    fatigue: 10,
    status: [],
    // 装备：Shahed-136 自杀式无人机（低空慢速，难拦截，饱和攻击消耗防空）
    equipment: [{ type: 'suicide-drone', count: 100, quality: 0.7 }],
  },
]
