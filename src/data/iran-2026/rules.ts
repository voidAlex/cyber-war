/**
 * 美以伊冲突 2026 — rules.json 数据（现代精确打击 + 不对称反击数值规则覆盖）。
 *
 * 设定特征（虚构近未来剧本）：
 * - 精确打击：美以战斧巡航导弹 + F-35 隐身突防 + 钻地弹（GBU-28）精确打击深埋核设施；
 *   伊朗 S-300/Bavar-373 防空拦截。
 *   （注：missileRange/airDefenseInterceptionRate 等专属字段不在 schema combat 内，
 *   由 units equipment 的巡航导弹/防空导弹槽 + missile/support type 代理火力与拦截。）
 * - 弹道导弹反击：伊朗 Sejjil/Emad 弹道导弹反击以色列/美军舰队；美军宙斯盾反导拦截。
 * - 不对称封锁：IRGC 导弹快艇 swarm + Shahed-136 无人机饱和攻击霍尔木兹海峡。
 * - 高消耗率：精确打击 + 反击损耗较高（attritionRate=0.1）。
 * - 补给脆弱：美以跨海补给线长（severedMultiplier=1.5）；伊朗本土作战补给相对稳。
 * - 情报半衰：现代战场情报更新快，半衰较短（halfLifeTurns=2）。
 *
 * 注：schema combat 仅允许 attritionRate/artillerySuppression/fortressDefenseBonus/
 * trenchDefenseBonus（additionalProperties:false）。精确打击/防空拦截等专属数值由 units
 * equipment 代理。
 *
 * @module data/iran-2026/rules
 */

import type { CampaignRules } from '@/types'

/** 美以伊冲突数值规则 */
export const iranRules: CampaignRules = {
  intelDecay: {
    // 情报半衰期 2 回合（现代战场情报更新快，卫星/无人机侦察时效性强）
    halfLifeTurns: 2,
    // 每半衰降级 1 级（Level 3 → 2 → 1）
    decayPerHalfLife: 1,
  },
  combat: {
    // 现代精确打击消耗率（巡航导弹/弹道导弹/隐身战机损耗较高）
    attritionRate: 0.1,
    // 远程火力压制强度（巡航导弹/弹道导弹压制对方防空/舰队）
    artillerySuppression: 0.5,
    // 核设施防御加成（深埋工事 fortress terrain，配合 map defenseBonus=0.9，极难摧毁）
    fortressDefenseBonus: 0.9,
    // 野战防空/工事加成（阵地/掩体）
    trenchDefenseBonus: 0.35,
  },
  movement: {
    // 基础机动点数（海空 + 地面机动）
    baseMovementPoints: 3,
    // 波斯湾/海峡水域规避惩罚
    riverCrossingPenalty: 3,
    // 每次机动增加疲劳（跨海远程奔袭疲劳）
    fatiguePerMove: 5,
  },
  supply: {
    // 每回合维持消耗（精确打击弹药/燃料消耗大）
    sustainCostPerTurn: 6,
    // 低补给阈值（低于此值触发 low_supply 状态）
    lowSupplyThreshold: 25,
    // 补给回复率（美以跨海补给，回复中等；伊朗本土补给较稳）
    restockRate: 14,
    // 补给被切断时的基线消耗倍率（美以跨海补给线长，倍率中等）
    severedMultiplier: 1.5,
  },
  // 第 2 批：战役随机事件（2 个模板）
  randomEvents: [
    // === 伊朗弹道导弹反击（surprise）：第 2/5/8 回合，导弹命中美军航母 ===
    // 设定：伊朗以 Sejjil/Emad 弹道导弹反击美以联军，部分突破宙斯盾反导命中航母。
    {
      id: 'iran-retaliation',
      kind: 'surprise',
      weight: 0, // 不参与概率（turn_in 强制触发）
      triggerCondition: { kind: 'turn_in', turns: [2, 5, 8] },
      label: '伊朗弹道导弹反击',
      description:
        '伊朗革命卫队发射 Sejjil/Emad 弹道导弹反击美以联军，部分突破美军宙斯盾反导拦截，' +
        '命中波斯湾航母战斗群，造成损失。',
      effects: [
        // 美军航母战力削弱（导弹命中）
        {
          targetKind: 'specific',
          unitIds: ['us-carrier-1'],
          field: 'strength',
          op: 'set',
          value: 60,
          reason: '伊朗弹道导弹突破反导命中航母，战力受损',
        },
      ],
    },
    // === 霍尔木兹海峡封锁（surprise）：IRGC 导弹快艇 swarm 封锁油轮/美军 ===
    // 设定：IRGC 导弹快艇群 + 水雷封锁霍尔木兹海峡，全球石油运输中断，油价飙升。
    {
      id: 'hormuz-blockade',
      kind: 'surprise',
      weight: 0.2,
      turnRange: [3, 15],
      label: '封锁霍尔木兹海峡',
      description:
        'IRGC 导弹快艇群与水雷封锁霍尔木兹海峡，全球石油运输中断，油价飙升，国际社会施压停战。' +
        '美军舰队机动受限。',
      effects: [
        // 美军驱逐舰战力削弱（海峡封锁限制机动 + 快艇骚扰）
        {
          targetKind: 'specific',
          unitIds: ['us-destroyer-1'],
          field: 'strength',
          op: 'add',
          value: -10,
          reason: '霍尔木兹封锁，美军驱逐舰机动受限、承压',
        },
      ],
    },
  ],
  // 第 3 批：战术决策模板（美以伊冲突两个关键节点）
  decisions: [
    // === 第 3 回合：是否打击核设施（先发制人核心抉择） ===
    // 设定：美以联军面临是否对纳坦兹/福特罗核设施实施 B-2/战斧精确打击的抉择。
    {
      id: 'strike-nuclear',
      // 确定性触发：第 3 回合（先发打击窗口，核设施决战抉择）
      triggerCondition: { kind: 'turn_in', turns: [3] },
      label: '是否打击核设施',
      description:
        '情报确认纳坦兹/福特罗核设施铀浓缩进度临近突破。美以联军可出动 B-2 隐身轰炸机 + 战斧巡航导弹' +
        '精确打击核设施（摧毁伊朗核能力，但面临伊朗全面反击与地区升级），或以外交施压/制裁替代军事打击。请决断。',
      options: [
        {
          id: 'strike',
          label: 'B-2 轰炸纳坦兹',
          description:
            '出动 B-2 隐身轰炸机 + 战斧巡航导弹精确打击纳坦兹核设施，钻地弹摧毁铀浓缩离心机。' +
            '纳坦兹核设施相关 IRGC 守备 + 防空被压制，但伊朗弹道导弹全面反击（局势升级）。',
          overrides: [
            // 纳坦兹 IRGC 守备战力重创（精确打击压制核设施防御）
            {
              field: 'units.iran-irgc-1.strength',
              before: '__current__',
              after: '__add_-30__',
              reason: 'B-2 精确打击压制纳坦兹 IRGC 守备',
            },
            // 纳坦兹防空被压制（F-35/B-2 反辐射摧毁 S-300）
            {
              field: 'units.iran-air-defense-1.strength',
              before: '__current__',
              after: '__add_-25__',
              reason: '反辐射导弹摧毁纳坦兹 S-300 防空',
            },
            // 美军战斧驱逐舰弹药消耗（精确打击耗弹）
            {
              field: 'units.us-missile-ddg-1.ammo',
              before: '__current__',
              after: '__add_-30__',
              reason: '战斧精确打击纳坦兹耗弹',
            },
          ],
        },
        {
          id: 'diplomacy',
          label: '外交施压',
          description:
            '不实施军事打击，以制裁 + 外交施压遏制伊朗核突破。避免地区升级与伊朗全面反击，' +
            '但核设施运转持续，战略目标未达成。',
          overrides: [
            // 美军舰队士气受压（外交妥协，军人信心下降）
            {
              field: 'units.us-carrier-1.morale',
              before: '__current__',
              after: '__add_-10__',
              reason: '外交施压替代军事打击，联军士气受挫',
            },
            // 伊朗 IRGC 得以加强核设施防御（外交窗口期加固）
            {
              field: 'units.iran-irgc-1.strength',
              before: '__current__',
              after: '__add_10__',
              reason: '外交窗口期，伊朗加固核设施防御',
            },
          ],
        },
      ],
    },
    // === 第 8 回合：斩首 vs 消耗（战争升级抉择） ===
    {
      id: 'decapitate-or-attrition',
      // 确定性触发：第 8 回合（战争升级，斩首德黑兰指挥中枢 vs 有限消耗）
      triggerCondition: { kind: 'turn_in', turns: [8] },
      label: '斩首 vs 有限消耗',
      description:
        '战争持续升级，美以联军面临战略抉择：扩大打击范围"斩首"德黑兰指挥中枢（推翻政权），' +
        '或保持有限打击消耗伊朗核能力（避免全面战争）。请决断。',
      options: [
        {
          id: 'decapitate',
          label: '斩首德黑兰',
          description:
            '扩大打击范围，斩首德黑兰政治/军事指挥中枢（哈梅内伊/革命卫队指挥部）。可能推翻政权，' +
            '但面临伊朗全面战争 + 地区升级 + 霍尔木兹长期封锁。',
          overrides: [
            // 伊朗导弹阵地战力重创（斩首指挥致指挥链断裂）
            {
              field: 'units.iran-missile-1.strength',
              before: '__current__',
              after: '__add_-25__',
              reason: '斩首指挥致伊朗导弹部队指挥链断裂',
            },
            // 美军航母承压（全面战争，伊朗全力反击）
            {
              field: 'units.us-carrier-1.strength',
              before: '__current__',
              after: '__add_-15__',
              reason: '全面战争，伊朗全力反击美军舰队',
            },
          ],
        },
        {
          id: 'limited-attrition',
          label: '有限消耗',
          description:
            '保持有限打击，专注消耗伊朗核能力，避免全面战争与地区升级。美军舰队保全、' +
            '局势可控，但伊朗政权与核能力未根除。',
          overrides: [
            // 美军舰队疲劳缓解（有限战争节奏可控）
            {
              field: 'units.us-carrier-1.fatigue',
              before: '__current__',
              after: '__add_-15__',
              reason: '有限战争节奏可控，联军疲劳缓解',
            },
          ],
        },
      ],
    },
  ],
  // 第 5 批 + 第 2+3 批：自定义 AI 角色定义（rules.aiRoles）。
  //
  // 美以伊为 2 方战役，无第三方外交方；故 diplomat 角色不在此声明。
  aiRoles: [
    // ============================================================
    // 美以联军侧（usisrael）
    // ============================================================
    // === 美以参谋长：内塔尼亚胡（果断先发制人） ===
    {
      id: 'ai-netanyahu-chief',
      type: 'chief',
      factionId: 'usisrael',
      displayName: '内塔尼亚胡',
      personality:
        '以色列总理，美以联军政治主导者。果断先发制人的鹰派，坚信伊朗核能力是以色列生存的根本威胁，' +
        '主张以精确打击"斩首"伊朗核设施。决策果断、不犹豫，敢冒地区升级风险。',
      aggression: 0.8,
      obedience: 0.7,
    },
    // === 美军中央司令：负责航母/F-35 联合作战 ===
    {
      id: 'ai-uscentcom-commander',
      type: 'commander',
      factionId: 'usisrael',
      displayName: '美军中央司令',
      personality:
        '美军中央司令部（CENTCOM）前线指挥官，指挥波斯湾航母战斗群与 F-35 联合作战。' +
        '崇尚精确打击 + 隐身突防的"外科手术"，善用战斧巡航导弹与钻地弹摧毁深埋工事。' +
        '执行内塔尼亚胡先发制人战略，把握战机窗口。',
      aggression: 0.75,
      obedience: 0.75,
      responsibleUnits: [
        'us-carrier-1',
        'us-carrier-2',
        'us-f35-1',
        'us-f35-2',
      ],
    },
    // ============================================================
    // 伊朗侧（iran）
    // ============================================================
    // === 伊朗参谋长：最高领袖哈梅内伊（强硬抵抗消耗战） ===
    {
      id: 'ai-khamenei-chief',
      type: 'chief',
      factionId: 'iran',
      displayName: '哈梅内伊',
      personality:
        '伊朗最高领袖，强硬抵抗消耗战的最高统帅。主张以弹道导弹反击 + 革命卫队非对称作战 + ' +
        '霍尔木兹海峡封锁拖入持久消耗。独断专行，对革命卫队绝对掌控。',
      aggression: 0.4,
      obedience: 0.3,
    },
    // === 伊朗革命卫队司令：负责 IRGC + 弹道导弹反击 ===
    {
      id: 'ai-irgc-commander',
      type: 'commander',
      factionId: 'iran',
      displayName: '革命卫队司令',
      personality:
        '伊朗伊斯兰革命卫队（IRGC）司令，指挥革命卫队地面部队 + 弹道导弹部队。' +
        '崇尚非对称作战（导弹快艇 swarm/无人机饱和），主张以弹道导弹反击以色列与美军舰队，' +
        '封锁霍尔木兹海峡制造全球能源危机。意识形态坚定，执行最高领袖强硬抵抗战略。',
      aggression: 0.65,
      obedience: 0.6,
      responsibleUnits: [
        'iran-irgc-1',
        'iran-irgc-2',
        'iran-missile-1',
        'iran-missile-2',
        'iran-missile-3',
      ],
    },
  ],
}
