/**
 * 凡尔登战役 1916 — units.json 数据（初始部署）。
 *
 * 史实部署（查证自维基/百科）：
 * - 法军：默兹河西岸及要塞守备。要塞守备（fortress）固守杜奥蒙/沃/苏维尔；' +
 *   步兵师（infantry）部署前沿；炮兵（artillery）纵深支援。
 * - 德军：默兹河东岸集结，步兵师（infantry）主攻，重炮兵（artillery）压制，' +
 *   侦察（recon）前出。
 *
 * 坐标对齐 map.ts（10×8，默兹河 col=5）。
 *
 * @module data/verdun-1916/units
 */

import type { CampaignUnit } from '@/types'

/** 凡尔登初始单位部署 */
export const verdunUnits: CampaignUnit[] = [
  // === 法国（守，西岸 + 要塞） ===
  {
    id: 'fr-fortress-douaumont',
    factionId: 'france',
    type: 'fortress',
    // 杜奥蒙堡（cell-7-2）——史实 2/25 陷落，开局仍由法军守备
    coord: { col: 7, row: 2 },
    strength: 90,
    personnel: 1200,
    maxPersonnel: 1500,
    fuel: 100,
    ammo: 90,
    morale: 75,
    fatigue: 20,
    status: [],
  },
  {
    id: 'fr-fortress-vaux',
    factionId: 'france',
    type: 'fortress',
    // 沃堡（cell-8-3）
    coord: { col: 8, row: 3 },
    strength: 85,
    personnel: 900,
    maxPersonnel: 1500,
    fuel: 100,
    ammo: 85,
    morale: 70,
    fatigue: 25,
    status: [],
    // 第 5 批装备：沃堡守备——哈奇开斯机枪 + 75mm 野炮
    equipment: [
      { type: 'machine-gun', count: 8, quality: 0.7 },
      { type: 'field-gun', count: 6, quality: 0.75 },
    ],
  },
  {
    id: 'fr-fortress-souville',
    factionId: 'france',
    type: 'fortress',
    // 苏维尔堡（cell-7-4）
    coord: { col: 7, row: 4 },
    strength: 88,
    personnel: 1000,
    maxPersonnel: 1500,
    fuel: 100,
    ammo: 88,
    morale: 72,
    fatigue: 22,
    status: [],
  },
  {
    id: 'fr-infantry-37',
    factionId: 'france',
    type: 'infantry',
    // 法军前沿步兵师（东岸西缘，临近默兹河）
    coord: { col: 4, row: 3 },
    strength: 75,
    personnel: 8000,
    maxPersonnel: 12000,
    fuel: 60,
    ammo: 70,
    morale: 65,
    fatigue: 35,
    status: [],
    // 第 5 批装备：法军步兵师——勒贝尔步枪 + 马克沁机枪
    equipment: [
      { type: 'rifle', count: 6000, quality: 0.6 },
      { type: 'machine-gun', count: 12, quality: 0.7 },
    ],
  },
  {
    id: 'fr-infantry-2',
    factionId: 'france',
    type: 'infantry',
    // 第二集团军步兵师（西岸纵深）
    coord: { col: 3, row: 4 },
    strength: 78,
    personnel: 10000,
    maxPersonnel: 12000,
    fuel: 55,
    ammo: 72,
    morale: 68,
    fatigue: 30,
    status: [],
  },
  {
    id: 'fr-artillery-1',
    factionId: 'france',
    type: 'artillery',
    // 西岸炮兵阵地（支援要塞守备）
    coord: { col: 3, row: 5 },
    strength: 80,
    personnel: 3000,
    maxPersonnel: 4000,
    fuel: 40,
    ammo: 85,
    morale: 70,
    fatigue: 25,
    status: [],
    // 第 5 批装备：法军炮兵——法制 75mm 野炮（"75 小姐"，射速快精度高）
    equipment: [{ type: 'field-gun', count: 36, quality: 0.85 }],
  },
  {
    id: 'fr-recon-1',
    factionId: 'france',
    type: 'recon',
    // 骑兵/侦察前出东岸观察德军动向
    coord: { col: 6, row: 5 },
    strength: 50,
    personnel: 800,
    maxPersonnel: 1500,
    fuel: 80,
    ammo: 40,
    morale: 65,
    fatigue: 40,
    status: [],
  },
  // === 德国（攻，东岸集结） ===
  {
    id: 'de-infantry-21',
    factionId: 'germany',
    type: 'infantry',
    // 德军主攻步兵师（东岸前沿，正对杜奥蒙）
    coord: { col: 9, row: 2 },
    strength: 82,
    personnel: 11000,
    maxPersonnel: 12000,
    fuel: 55,
    ammo: 80,
    morale: 75,
    fatigue: 25,
    status: [],
    // 第 5 批装备：德军主攻步兵——毛瑟 98 步枪 + MG08 马克沁机枪
    equipment: [
      { type: 'rifle', count: 9000, quality: 0.7 },
      { type: 'machine-gun', count: 12, quality: 0.75 },
    ],
  },
  {
    id: 'de-infantry-7',
    factionId: 'germany',
    type: 'infantry',
    // 第七预备军步兵师（东岸中部）
    coord: { col: 9, row: 4 },
    strength: 80,
    personnel: 10500,
    maxPersonnel: 12000,
    fuel: 50,
    ammo: 78,
    morale: 73,
    fatigue: 28,
    status: [],
  },
  {
    id: 'de-infantry-12',
    factionId: 'germany',
    type: 'infantry',
    // 第十二后备师（东岸南部）
    coord: { col: 8, row: 6 },
    strength: 78,
    personnel: 9500,
    maxPersonnel: 12000,
    fuel: 48,
    ammo: 76,
    morale: 72,
    fatigue: 30,
    status: [],
  },
  {
    id: 'de-artillery-heavy',
    factionId: 'germany',
    type: 'artillery',
    // 德军重炮兵阵地（东岸纵深，史实 210mm/420mm 重炮"大贝尔莎"压制要塞）
    coord: { col: 9, row: 0 },
    strength: 88,
    personnel: 4000,
    maxPersonnel: 5000,
    fuel: 35,
    ammo: 92,
    morale: 78,
    fatigue: 20,
    status: [],
    // 第 5 批装备：德军重炮——210mm 榴弹炮 + 420mm"大贝尔莎"攻城臼炮（压要塞）
    equipment: [
      { type: 'howitzer', count: 12, quality: 0.85 },
      { type: 'siege-mortar', count: 2, quality: 0.95 },
    ],
  },
  {
    id: 'de-recon-1',
    factionId: 'germany',
    type: 'recon',
    // 德军侦察前出（探查法军要塞火力点）
    coord: { col: 8, row: 2 },
    strength: 52,
    personnel: 900,
    maxPersonnel: 1500,
    fuel: 75,
    ammo: 45,
    morale: 70,
    fatigue: 38,
    status: [],
  },
  {
    id: 'de-support-1',
    factionId: 'germany',
    type: 'support',
    // 德军后勤支援（维持重炮弹药补给）
    coord: { col: 9, row: 1 },
    strength: 40,
    personnel: 2000,
    maxPersonnel: 3000,
    fuel: 90,
    ammo: 30,
    morale: 70,
    fatigue: 15,
    status: [],
  },
]
