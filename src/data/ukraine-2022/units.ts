/**
 * 俄乌冲突 2022 — units.json 数据（初始部署）。
 *
 * 史实部署（查证自维基/百科/新闻）：
 * - 乌军：约 20 万正规军 + 领土防卫。基辅/哈尔科夫城市防御步兵（标枪反坦克）；
 *   机械化旅（BMP + NLAW）；炮兵（M777 榴弹炮 + HIMARS 火箭炮）；防空（S-300）；
 *   无人机（Bayraktar TB2）。
 * - 俄军：约 19 万入侵部队。装甲旅（T-72/T-90 主战坦克）；机械化（BMP 步战车）；
 *   炮兵（2S19 自行榴弹炮）；空降兵（VDV，基辅霍斯托梅尔机场突袭）；防空（Pantsir）；
 *   无人机（Orlan-10 侦察）。
 *
 * 坐标对齐 map.ts（16×12，第聂伯河 col=7）。
 * - 乌军主力在基辅(cell-7-2)/哈尔科夫(cell-12-4)城市防御；利沃夫(cell-1-6)方向后勤。
 * - 俄军北线从白俄罗斯边境(row 0-1)南下攻基辅；东线从别尔哥罗德(cell-15-2)攻哈尔科夫；
 *   南线从克里米亚(cell-13-11)北上攻赫尔松/马里乌波尔。
 *
 * 类型映射（schema 无 mechanized/air-defense/drone 专用类型）：
 * - 机械化/装甲 → armor；步兵 → infantry；炮兵 → artillery；
 * - 防空/后勤 → support；无人机 → recon 或 air（侦察型用 recon，打击型用 air）。
 *
 * @module data/ukraine-2022/units
 */

import type { CampaignUnit } from '@/types'

/** 俄乌冲突初始单位部署 */
export const ukraineUnits: CampaignUnit[] = [
  // ============================================================
  // 乌克兰（守，10 单位）
  // ============================================================
  // === 城市防御步兵 ×4：基辅/哈尔科夫据守（标枪反坦克） ===
  {
    id: 'ukr-infantry-1',
    factionId: 'ukraine',
    type: 'infantry',
    // 基辅城市防御（标枪反坦克小组）
    coord: { col: 7, row: 2 },
    strength: 75,
    personnel: 4000,
    maxPersonnel: 5000,
    fuel: 40,
    ammo: 70,
    morale: 80, // 保家卫国士气高昂
    fatigue: 25,
    status: [],
    // 装备：标枪反坦克导弹（FGM-148 Javelin，顶攻模式克制主战坦克）
    equipment: [{ type: 'anti-tank-missile', count: 80, quality: 0.9 }],
  },
  {
    id: 'ukr-infantry-2',
    factionId: 'ukraine',
    type: 'infantry',
    // 基辅北郊防御（阻击俄军北线南下）
    coord: { col: 6, row: 1 },
    strength: 72,
    personnel: 3500,
    maxPersonnel: 5000,
    fuel: 40,
    ammo: 68,
    morale: 78,
    fatigue: 28,
    status: [],
    equipment: [{ type: 'anti-tank-missile', count: 70, quality: 0.9 }],
  },
  {
    id: 'ukr-infantry-3',
    factionId: 'ukraine',
    type: 'infantry',
    // 哈尔科夫城市防御
    coord: { col: 12, row: 4 },
    strength: 75,
    personnel: 4000,
    maxPersonnel: 5000,
    fuel: 40,
    ammo: 70,
    morale: 80,
    fatigue: 25,
    status: [],
    equipment: [{ type: 'anti-tank-missile', count: 80, quality: 0.9 }],
  },
  {
    id: 'ukr-infantry-4',
    factionId: 'ukraine',
    type: 'infantry',
    // 哈尔科夫东郊防御（阻击俄军东线）
    coord: { col: 11, row: 4 },
    strength: 70,
    personnel: 3500,
    maxPersonnel: 5000,
    fuel: 38,
    ammo: 65,
    morale: 75,
    fatigue: 30,
    status: [],
    equipment: [{ type: 'anti-tank-missile', count: 70, quality: 0.9 }],
  },
  // === 机械化旅 ×2（BMP + NLAW） ===
  {
    id: 'ukr-mechanized-1',
    factionId: 'ukraine',
    type: 'armor', // 机械化归 armor
    // 基辅方向机械化旅（机动反攻）
    coord: { col: 5, row: 3 },
    strength: 80,
    personnel: 3000,
    maxPersonnel: 4000,
    fuel: 65,
    ammo: 75,
    morale: 78,
    fatigue: 25,
    status: [],
    // 装备：BMP-2 步战车 + NLAW 反坦克导弹
    equipment: [
      { type: 'ifv', count: 60, quality: 0.75 },
      { type: 'anti-tank-missile', count: 150, quality: 0.85 },
    ],
  },
  {
    id: 'ukr-mechanized-2',
    factionId: 'ukraine',
    type: 'armor',
    // 哈尔科夫方向机械化旅
    coord: { col: 11, row: 5 },
    strength: 78,
    personnel: 3000,
    maxPersonnel: 4000,
    fuel: 62,
    ammo: 72,
    morale: 76,
    fatigue: 28,
    status: [],
    equipment: [
      { type: 'ifv', count: 55, quality: 0.75 },
      { type: 'anti-tank-missile', count: 140, quality: 0.85 },
    ],
  },
  // === 炮兵 ×2（M777 + HIMARS） ===
  {
    id: 'ukr-artillery-1',
    factionId: 'ukraine',
    type: 'artillery',
    // 中部炮兵阵地（HIMARS 远程精确打击俄军后方弹药库/指挥所）
    coord: { col: 5, row: 5 },
    strength: 70,
    personnel: 1200,
    maxPersonnel: 1500,
    fuel: 35,
    ammo: 80,
    morale: 75,
    fatigue: 20,
    status: [],
    // 装备：M777 牵引榴弹炮 + HIMARS 火箭炮（GMLRS 精确弹药，远程反制俄军后勤）
    equipment: [
      { type: 'howitzer', count: 24, quality: 0.85 },
      { type: 'mlrs', count: 8, quality: 0.95 },
    ],
  },
  {
    id: 'ukr-artillery-2',
    factionId: 'ukraine',
    type: 'artillery',
    // 东部炮兵阵地（支援哈尔科夫防御）
    coord: { col: 10, row: 6 },
    strength: 68,
    personnel: 1200,
    maxPersonnel: 1500,
    fuel: 35,
    ammo: 78,
    morale: 73,
    fatigue: 22,
    status: [],
    equipment: [
      { type: 'howitzer', count: 24, quality: 0.85 },
      { type: 'mlrs', count: 6, quality: 0.95 },
    ],
  },
  // === 防空 ×1（S-300） ===
  {
    id: 'ukr-air-defense-1',
    factionId: 'ukraine',
    type: 'support', // 防空归 support
    // 基辅方向防空阵地（S-300 远程防空，拒止俄军空中优势）
    coord: { col: 6, row: 3 },
    strength: 50,
    personnel: 800,
    maxPersonnel: 1000,
    fuel: 30,
    ammo: 60,
    morale: 70,
    fatigue: 20,
    status: [],
    // 装备：S-300 远程地空导弹（拒止俄军战机/巡航导弹）
    equipment: [{ type: 'sam', count: 8, quality: 0.8 }],
  },
  // === 无人机 ×1（Bayraktar TB2） ===
  {
    id: 'ukr-drone-1',
    factionId: 'ukraine',
    type: 'recon', // 侦察/打击无人机归 recon（非对称侦察优势）
    // 中部无人机基地（Bayraktar TB2 侦察 + 打击俄军装甲/补给）
    coord: { col: 4, row: 4 },
    strength: 30,
    personnel: 100,
    maxPersonnel: 200,
    fuel: 80,
    ammo: 50,
    morale: 80,
    fatigue: 15,
    status: [],
    // 装备：Bayraktar TB2 察打一体无人机（MAM-L 精确制导弹药）
    equipment: [{ type: 'strike-drone', count: 12, quality: 0.85 }],
  },

  // ============================================================
  // 俄罗斯（攻，14 单位）
  // ============================================================
  // === 主战坦克装甲旅 ×3（T-72/T-90） ===
  {
    id: 'rus-armor-1',
    factionId: 'russia',
    type: 'armor',
    // 北线装甲纵队（白俄罗斯南下攻基辅，途经切尔诺贝利）
    coord: { col: 5, row: 0 },
    strength: 85,
    personnel: 2000,
    maxPersonnel: 3000,
    fuel: 70,
    ammo: 80,
    morale: 70,
    fatigue: 25,
    status: [],
    // 装备：T-72B3 / T-90M 主战坦克
    equipment: [{ type: 'mbt', count: 90, quality: 0.8 }],
  },
  {
    id: 'rus-armor-2',
    factionId: 'russia',
    type: 'armor',
    // 东线装甲纵队（别尔哥罗德攻哈尔科夫）
    coord: { col: 14, row: 4 },
    strength: 85,
    personnel: 2000,
    maxPersonnel: 3000,
    fuel: 68,
    ammo: 80,
    morale: 70,
    fatigue: 25,
    status: [],
    equipment: [{ type: 'mbt', count: 90, quality: 0.8 }],
  },
  {
    id: 'rus-armor-3',
    factionId: 'russia',
    type: 'armor',
    // 南线装甲纵队（克里米亚北上攻赫尔松/马里乌波尔）
    coord: { col: 12, row: 11 },
    strength: 82,
    personnel: 2000,
    maxPersonnel: 3000,
    fuel: 65,
    ammo: 78,
    morale: 68,
    fatigue: 28,
    status: [],
    equipment: [{ type: 'mbt', count: 85, quality: 0.8 }],
  },
  // === 机械化步兵 ×3（BMP 步战车） ===
  {
    id: 'rus-mechanized-1',
    factionId: 'russia',
    type: 'armor',
    // 北线机械化（配合装甲纵队攻基辅）
    coord: { col: 6, row: 0 },
    strength: 75,
    personnel: 3500,
    maxPersonnel: 4000,
    fuel: 60,
    ammo: 72,
    morale: 68,
    fatigue: 28,
    status: [],
    equipment: [{ type: 'ifv', count: 80, quality: 0.75 }],
  },
  {
    id: 'rus-mechanized-2',
    factionId: 'russia',
    type: 'armor',
    // 东线机械化（攻哈尔科夫）
    coord: { col: 15, row: 5 },
    strength: 75,
    personnel: 3500,
    maxPersonnel: 4000,
    fuel: 58,
    ammo: 70,
    morale: 68,
    fatigue: 30,
    status: [],
    equipment: [{ type: 'ifv', count: 80, quality: 0.75 }],
  },
  {
    id: 'rus-mechanized-3',
    factionId: 'russia',
    type: 'armor',
    // 南线机械化（攻马里乌波尔）
    coord: { col: 13, row: 10 },
    strength: 72,
    personnel: 3500,
    maxPersonnel: 4000,
    fuel: 55,
    ammo: 68,
    morale: 66,
    fatigue: 32,
    status: [],
    equipment: [{ type: 'ifv', count: 75, quality: 0.75 }],
  },
  // === 自行炮兵 ×3（2S19 Msta） ===
  {
    id: 'rus-artillery-1',
    factionId: 'russia',
    type: 'artillery',
    // 北线炮兵阵地（远程轰击基辅郊外）
    coord: { col: 7, row: 0 },
    strength: 75,
    personnel: 1500,
    maxPersonnel: 2000,
    fuel: 40,
    ammo: 85,
    morale: 70,
    fatigue: 20,
    status: [],
    // 装备：2S19 Msta-S 自行榴弹炮（152mm，远程压制）
    equipment: [{ type: 'self-propelled-howitzer', count: 36, quality: 0.8 }],
  },
  {
    id: 'rus-artillery-2',
    factionId: 'russia',
    type: 'artillery',
    // 东线炮兵阵地（轰击哈尔科夫）
    coord: { col: 15, row: 3 },
    strength: 75,
    personnel: 1500,
    maxPersonnel: 2000,
    fuel: 40,
    ammo: 85,
    morale: 70,
    fatigue: 20,
    status: [],
    equipment: [{ type: 'self-propelled-howitzer', count: 36, quality: 0.8 }],
  },
  {
    id: 'rus-artillery-3',
    factionId: 'russia',
    type: 'artillery',
    // 南线炮兵阵地（轰击马里乌波尔，围困亚速钢铁厂）
    coord: { col: 12, row: 10 },
    strength: 73,
    personnel: 1500,
    maxPersonnel: 2000,
    fuel: 38,
    ammo: 82,
    morale: 68,
    fatigue: 22,
    status: [],
    equipment: [{ type: 'self-propelled-howitzer', count: 36, quality: 0.8 }],
  },
  // === 空降兵 ×1（VDV，霍斯托梅尔机场突袭） ===
  {
    id: 'rus-airborne-1',
    factionId: 'russia',
    type: 'infantry', // 空降兵归 infantry
    // 基辅北郊霍斯托梅尔机场（VDV 突袭，史实遭乌军反冲击失利）
    coord: { col: 7, row: 1 },
    strength: 70,
    personnel: 2000,
    maxPersonnel: 2500,
    fuel: 45,
    ammo: 70,
    morale: 72,
    fatigue: 30,
    status: [],
    // 装备：BMD-2 伞兵战车 + 轻武器
    equipment: [
      { type: 'airborne-ifv', count: 40, quality: 0.7 },
      { type: 'rifle', count: 1800, quality: 0.75 },
    ],
  },
  // === 防空 ×2（Pantsir） ===
  {
    id: 'rus-air-defense-1',
    factionId: 'russia',
    type: 'support',
    // 北线防空（掩护装甲纵队，拒止乌军无人机/空军）
    coord: { col: 6, row: 1 },
    strength: 50,
    personnel: 600,
    maxPersonnel: 800,
    fuel: 35,
    ammo: 55,
    morale: 68,
    fatigue: 22,
    status: [],
    // 装备：Pantsir-S1 弹炮合一防空系统
    equipment: [{ type: 'sam', count: 12, quality: 0.75 }],
  },
  {
    id: 'rus-air-defense-2',
    factionId: 'russia',
    type: 'support',
    // 东线防空
    coord: { col: 14, row: 5 },
    strength: 50,
    personnel: 600,
    maxPersonnel: 800,
    fuel: 35,
    ammo: 55,
    morale: 68,
    fatigue: 22,
    status: [],
    equipment: [{ type: 'sam', count: 12, quality: 0.75 }],
  },
  // === 侦察无人机 ×1（Orlan-10） ===
  {
    id: 'rus-drone-1',
    factionId: 'russia',
    type: 'recon',
    // 东线无人机侦察（Orlan-10 校射炮兵）
    coord: { col: 13, row: 3 },
    strength: 30,
    personnel: 80,
    maxPersonnel: 150,
    fuel: 75,
    ammo: 40,
    morale: 65,
    fatigue: 18,
    status: [],
    // 装备：Orlan-10 侦察无人机（炮兵校射）
    equipment: [{ type: 'recon-drone', count: 15, quality: 0.7 }],
  },
]
