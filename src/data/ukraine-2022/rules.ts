/**
 * 俄乌冲突 2022 — rules.json 数据（现代机械化战争数值规则覆盖）。
 *
 * 史实特征（查证自维基/百科/新闻）：
 * - 城市防御战：乌军依托城市（基辅/哈尔科夫/马里乌波尔）固守，防御加成极高；俄军装甲纵队
 *   在城市战中损失惨重（地图 urban cell defenseBonus=0.85）。
 * - 远程精确打击：HIMARS 火箭炮远程反制俄军后方弹药库/指挥所/补给线；俄军 2S19 炮兵远程压制。
 *   （注：HIMARS 射程等专属字段不在 schema combat 内，由 units equipment + artillery 类型代理火力。）
 * - 反装甲作战：标枪/NLAW 顶攻导弹克制俄军主战坦克；乌军非对称反装甲优势。
 * - 无人机侦察/打击：Bayraktar TB2 与 Orlan-10 提供战场透明度 + 精确打击。
 * - 补给脆弱：俄军铁路补给线长且脆弱（北线 64 公里装甲车队僵滞），乌军多次打击俄军后勤；
 *   补给被切断时基线消耗倍率高（severedMultiplier=2.0）。
 * - 情报半衰：现代战场情报更新快，半衰较短（halfLifeTurns=2）。
 *
 * 注：schema combat 仅允许 attritionRate/artillerySuppression/fortressDefenseBonus/
 * trenchDefenseBonus（additionalProperties:false）。城市防御加成由 map urban cell
 * defenseBonus（0.85）承载；HIMARS/无人机等专属数值由 units equipment 代理。
 *
 * @module data/ukraine-2022/rules
 */

import type { CampaignRules } from '@/types'

/** 俄乌冲突现代机械化战争数值规则 */
export const ukraineRules: CampaignRules = {
  intelDecay: {
    // 情报半衰期 2 回合（现代战场情报更新快，侦察残影衰减较快）
    halfLifeTurns: 2,
    // 每半衰降级 1 级（Level 3 → 2 → 1）
    decayPerHalfLife: 1,
  },
  combat: {
    // 现代战争消耗损耗率（精确打击 + 重炮轰击，损耗较高）
    attritionRate: 0.08,
    // 远程炮兵压制强度（2S19/HIMARS 远程压制，被压制单位无法机动/减效）
    artillerySuppression: 0.55,
    // 城市防御加成（基辅/哈尔科夫等 urban cell，配合 map defenseBonus=0.85）
    fortressDefenseBonus: 0.85,
    // 野战工事防御加成（乌军阵地/俄军野战工事）
    trenchDefenseBonus: 0.4,
  },
  movement: {
    // 基础机动点数（机械化部队机动较快）
    baseMovementPoints: 3,
    // 渡第聂伯河惩罚（高移动消耗，渡河瓶颈）
    riverCrossingPenalty: 4,
    // 每次机动增加疲劳（装甲部队长途奔袭疲劳）
    fatiguePerMove: 6,
  },
  supply: {
    // 每回合维持消耗（现代战争燃料/弹药消耗大）
    sustainCostPerTurn: 5,
    // 低补给阈值（低于此值触发 low_supply 状态）
    lowSupplyThreshold: 25,
    // 补给回复率（西方军援持续注入，乌军回复较快）
    restockRate: 18,
    // 补给被切断时的基线消耗倍率（俄军长补给线脆弱，倍率高）
    severedMultiplier: 2.0,
  },
  // 第 2 批：战役随机事件（3 个模板）
  randomEvents: [
    // === 西方军援到达（reinforcement）：第 5/10 回合，HIMARS 增援 ===
    // 史实：西方军援持续注入，HIMARS 于 2022 年 6 月交付，改变战争态势。
    {
      id: 'western-aid',
      kind: 'reinforcement',
      weight: 0, // 不参与概率（turn_in 强制触发）
      triggerCondition: { kind: 'turn_in', turns: [5, 10] },
      label: '西方军援到达',
      description:
        '西方军援（HIMARS 火箭炮/M777 榴弹炮/弹药）抵达前线，乌军远程精确打击能力大幅增强。',
      // 援军单位定义（来自战役包，非伪造）：HIMARS 增援分队
      reinforcementUnits: [
        {
          id: 'ukr-himars-reinforcement',
          factionId: 'ukraine',
          type: 'artillery',
          coord: { col: 5, row: 5 },
          strength: 90,
          personnel: 800,
          maxPersonnel: 1000,
          fuel: 40,
          ammo: 90,
          morale: 85,
          fatigue: 15,
          status: [],
          equipment: [{ type: 'mlrs', count: 12, quality: 0.95 }],
        },
      ],
      effects: [
        // 增援注入即生效，effects 设定既有炮兵战力提升（HIMARS 战法扩散）
        {
          targetKind: 'specific',
          unitIds: ['ukr-artillery-1'],
          field: 'strength',
          op: 'set',
          value: 90,
          reason: 'HIMARS 增援，乌军炮兵战力与精确打击能力大幅提升',
        },
      ],
    },
    // === 无人机精确打击（surprise）：随机俄军装甲单位 strength -15 ===
    // 史实：Bayraktar TB2 与 Switchblade 巡飞弹精确打击俄军装甲/指挥所。
    {
      id: 'drone-strike',
      kind: 'surprise',
      weight: 0.15,
      turnRange: [2, 30],
      label: '无人机精确打击',
      description:
        '乌军 Bayraktar TB2 无人机锁定俄军装甲纵队/指挥所，实施精确打击，造成重大损失。',
      effects: [
        {
          targetKind: 'faction',
          factionId: 'russia',
          field: 'strength',
          op: 'add',
          value: -15,
          singleTarget: true, // 无人机集中打击单一俄军目标（确定性随机挑选）
          filterField: 'strength',
          filterBelow: 90, // 优先打击战力尚高的高价值目标（装甲/指挥所）
          reason: '乌军无人机精确打击俄军高价值目标',
        },
      ],
    },
    // === 俄军远程炮击（surprise）：随机乌军单位 strength -12 ===
    // 史实：俄军 2S19 炮兵与巡航导弹远程轰击乌军城市/阵地。
    {
      id: 'rus-artillery-barrage',
      kind: 'surprise',
      weight: 0.2,
      turnRange: [1, 30],
      label: '俄军远程炮击',
      description:
        '俄军集中 2S19 自行榴弹炮与巡航导弹对乌军阵地/城市实施远程炮击，造成伤亡。',
      effects: [
        {
          targetKind: 'faction',
          factionId: 'ukraine',
          field: 'strength',
          op: 'add',
          value: -12,
          singleTarget: true, // 远程炮击集中打击单一乌军目标
          reason: '俄军远程炮击造成乌军伤亡',
        },
      ],
    },
  ],
  // 第 3 批：战术决策模板（俄乌冲突两个关键节点）
  decisions: [
    // === 第 1 回合：基辅防御策略（开战之初战略抉择） ===
    {
      id: 'kyiv-defense',
      // 确定性触发：第 1 回合（开战之初，俄军北线南下攻基辅）
      triggerCondition: { kind: 'turn_in', turns: [1] },
      label: '基辅防御策略',
      description:
        '俄军装甲纵队正从白俄罗斯南下直扑基辅，霍斯托梅尔机场遭 VDV 突袭。乌军需决定基辅防御策略：' +
        '依托城市建筑隐蔽防御（反装甲伏击），或在开阔地野战正面迎击俄军装甲。',
      options: [
        {
          id: 'urban',
          label: '城市游击防御',
          description:
            '依托基辅城市建筑与北郊森林隐蔽防御，以标枪/NLAW 伏击俄军装甲纵队。防御加成高，' +
            '俄军侦察难以锁定（乌军步兵对俄军隐蔽）。',
          overrides: [
            // 乌军基辅步兵隐蔽，俄军侦察失效（以 strength 反映伏击优势）
            {
              field: 'units.ukr-infantry-1.strength',
              before: '__current__',
              after: '__add_15__',
              reason: '城市隐蔽防御，标枪伏击俄军装甲纵队',
            },
            {
              field: 'units.ukr-infantry-2.strength',
              before: '__current__',
              after: '__add_12__',
              reason: '北郊森林隐蔽，反装甲伏击优势',
            },
          ],
        },
        {
          id: 'open',
          label: '开阔地野战',
          description:
            '在基辅北郊开阔地正面迎击俄军装甲。机动空间大但失去城市掩护，俄军装甲/炮兵火力优势发挥。',
          overrides: [
            // 开阔地野战，俄军火力优势发挥，乌军承压
            {
              field: 'units.ukr-infantry-1.strength',
              before: '__current__',
              after: '__add_-10__',
              reason: '开阔地野战，俄军装甲火力优势发挥',
            },
            {
              field: 'units.rus-armor-1.strength',
              before: '__current__',
              after: '__add_10__',
              reason: '开阔地装甲突击优势',
            },
          ],
        },
      ],
    },
    // === 第 15 回合：HIMARS 反攻 vs 战略防御（战争中后期抉择） ===
    {
      id: 'himars-counterstrike',
      // 确定性触发：第 15 回合（HIMARS 交付后，反攻之机）
      triggerCondition: { kind: 'turn_in', turns: [15] },
      label: 'HIMARS 反攻',
      description:
        'HIMARS 火箭炮已投入作战，乌军远程精确打击俄军后方弹药库/指挥所/补给线成效显著。' +
        '泽连斯基可决定趁势发动反攻（收复赫尔松），或战略防御消耗俄军。请决断。',
      options: [
        {
          id: 'counterstrike',
          label: '反攻收复失地',
          description:
            '趁 HIMARS 削弱俄军后勤之机发动反攻，收复赫尔松等失地。乌军战力提升、俄军重创，' +
            '但反攻风险高、伤亡大。',
          overrides: [
            // 乌军机械化旅反攻战力提升
            {
              field: 'units.ukr-mechanized-1.strength',
              before: '__current__',
              after: '__add_15__',
              reason: 'HIMARS 支撑反攻，乌军战力提升',
            },
            // 俄军南线装甲后勤受打击，战力削弱
            {
              field: 'units.rus-armor-3.strength',
              before: '__current__',
              after: '__add_-20__',
              reason: 'HIMARS 打击俄军南线后勤，装甲战力削弱',
            },
          ],
        },
        {
          id: 'strategic-defense',
          label: '战略防御消耗',
          description:
            '不主动反攻，以 HIMARS 持续打击俄军后勤，消耗俄军战争潜力。乌军保全实力，' +
            '但战线变化缓慢。',
          overrides: [
            // 乌军炮兵精确打击能力充分发挥（远程消耗）
            {
              field: 'units.ukr-artillery-1.strength',
              before: '__current__',
              after: '__add_10__',
              reason: '战略防御，HIMARS 远程消耗俄军后勤',
            },
          ],
        },
      ],
    },
  ],
  // 第 5 批 + 第 2+3 批：自定义 AI 角色定义（rules.aiRoles）。
  //
  // 俄乌为 2 方战役（乌/俄），无第三方外交方；故 diplomat 角色不在此声明。
  aiRoles: [
    // ============================================================
    // 乌军侧（ukraine）
    // ============================================================
    // === 乌军参谋长：泽连斯基（灵活抵抗，争取国际支持） ===
    {
      id: 'ai-zelensky-chief',
      type: 'chief',
      factionId: 'ukraine',
      displayName: '泽连斯基',
      personality:
        '乌克兰战时总统，灵活抵抗的战略家。拒绝撤离基辅，以个人意志凝聚全国抗战决心。' +
        '善用国际舆论争取西方军援，把俄军拖入持久消耗。主张机动防御 + 无人机非对称打击。',
      aggression: 0.7,
      obedience: 0.9,
    },
    // === 乌军陆军司令：负责机械化旅反攻 ===
    {
      id: 'ai-ukr-army-commander',
      type: 'commander',
      factionId: 'ukraine',
      displayName: '乌军陆军司令',
      personality:
        '乌军陆军前线司令，指挥机械化旅与城市防御步兵。擅长机动反攻与反装甲伏击，' +
        '善用标枪/NLAW 与无人机协同打击俄军装甲纵队。执行泽连斯基的灵活抵抗战略。',
      aggression: 0.65,
      obedience: 0.8,
      responsibleUnits: ['ukr-mechanized-1', 'ukr-mechanized-2'],
    },
    // ============================================================
    // 俄军侧（russia）
    // ============================================================
    // === 俄军参谋长：普京（战略耐心，重型火力） ===
    {
      id: 'ai-putin-chief',
      type: 'chief',
      factionId: 'russia',
      displayName: '普京',
      personality:
        '俄罗斯战时最高统帅，战略耐心的强人。崇尚重型装甲 + 远程炮兵的火力优势，' +
        '企图速战速决后转入消耗。独断专行、不纳前线将领异议，微观干预前线指挥。',
      aggression: 0.5,
      obedience: 0.3,
    },
    // === 俄军前线指挥：负责装甲/机械化主攻 ===
    {
      id: 'ai-rus-front-commander',
      type: 'commander',
      factionId: 'russia',
      displayName: '俄军前线指挥',
      personality:
        '俄军前线指挥官，指挥装甲旅与机械化步兵多路推进。崇尚装甲突击 + 炮兵压制的苏式大纵深作战，' +
        '但受制于补给线脆弱与战术僵化。执行普京的战略调度。',
      aggression: 0.6,
      obedience: 0.5,
      responsibleUnits: [
        'rus-armor-1',
        'rus-armor-2',
        'rus-armor-3',
        'rus-mechanized-1',
        'rus-mechanized-2',
        'rus-mechanized-3',
      ],
    },
  ],
}
