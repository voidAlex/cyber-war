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
 * T2 第 2 批（电子战）：F-35 隐身战机挂载 AN/ASQ-239 电子战套件（jammingRange=3，
 * stealthReduction=0.5），伊朗 S-300/Bavar-373 防空挂载反隐身预警雷达（detectionBoost=1）。
 * 美以 F-35 与伊朗 S-300 形成"隐身突防 vs 反隐身拒止"的 EW 对抗，由
 * domain/electronic-warfare.applyEWEffects 在每回合 simulateTurn 开头结算。
 *
 * T2 第 4 批（特殊作战）：美军特种部队（us-special-1，infantry + laser-designator 装备）
 * 具备特种作战能力，可执行 sabotage（破坏伊朗核设施 supplySource/防空工事）/
 * commando_raid（斩首 IRGC 指挥中枢 morale-20）。需对该 cell 侦察等级 ≥ L2
 * （特种部队的激光指示器引导精确打击，前提是先侦察确认目标）。
 *
 * T2 第 5 批 A（导弹拦截）：美以宙斯盾驱逐舰（us-destroyer-1/2，equipment sam 宙斯盾反导）
 * 拦截伊朗弹道导弹（iran-missile-1/2/3）；伊朗 S-300/Bavar-373 防空拦截美以战斧巡航导弹
 * （us-missile-ddg-1/2）。拦截概率 = quality×0.3 + count×0.1，封顶 0.95。
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
  // 第 2+3 批角色重构 + 第 3 批多阵营拆分：
  // - 参谋长改正为职业军人（CENTCOM 司令 / IDF 总参谋长 / IRGC 司令）。
  // - 政治领袖（内塔尼亚胡 / 哈梅内伊）降格为外交官角色（diplomat）。
  // - "美以联军"拆为 usa + israel + iran 3 方，各方各加 chief/commander/diplomat/logistics。
  aiRoles: [
    // ============================================================
    // 美国侧（usa，第 3 批从 usisrael 拆出）
    // ============================================================
    // === 美军参谋长：CENTCOM 司令（精确打击 + 联合作战） ===
    {
      id: 'ai-centcom-chief',
      type: 'chief',
      factionId: 'usa',
      displayName: 'CENTCOM 司令',
      personality:
        '美军中央司令部（CENTCOM）战区总司令，统筹波斯湾航母战斗群 + F-35 + 战斧联合作战。' +
        '崇尚精确打击 + 隐身突防的"外科手术"。methodical 不冒进，受以色列政治推动参战但警惕升级。',
      aggression: 0.7,
      obedience: 0.8,
    },
    // === 美军舰队司令：负责航母/驱逐舰/战斧 ===
    {
      id: 'ai-usfleet-commander',
      type: 'commander',
      factionId: 'usa',
      displayName: '美军舰队司令',
      personality:
        '美军波斯湾航母战斗群司令，指挥航母舰载机 + 宙斯盾驱逐舰反导 + 战斧远程精确打击。' +
        '把握战机窗口，以战斧巡航导弹摧毁核设施。执行 CENTCOM 战区统筹。',
      aggression: 0.75,
      obedience: 0.75,
      responsibleUnits: [
        'us-carrier-1',
        'us-carrier-2',
        'us-destroyer-1',
        'us-destroyer-2',
        'us-missile-ddg-1',
        'us-missile-ddg-2',
      ],
    },
    // === 美军后勤官：跨海补给线指挥（第 2+3 批新增） ===
    {
      id: 'ai-usa-logistics',
      type: 'logistics',
      factionId: 'usa',
      displayName: '美军跨海后勤',
      personality:
        '美军跨海后勤指挥，统筹波斯湾航母战斗群的海上补给线 + 精确打击弹药（战斧/GBU-28）运输。' +
        '从本土/海湾国家基地向波斯湾舰队持续输送弹药/燃料。解读跨海补给脆弱点与伊朗快艇威胁。',
      aggression: 0.2,
      obedience: 0.8,
    },
    // ============================================================
    // 以色列侧（israel，第 3 批从 usisrael 拆出）
    // ============================================================
    // === 以色列参谋长：IDF 总参谋长（果断先发制人） ===
    {
      id: 'ai-idf-chief',
      type: 'chief',
      factionId: 'israel',
      displayName: 'IDF 总参谋长',
      personality:
        '以色列国防军（IDF）总参谋长，果断先发制人的军事指挥者。坚信伊朗核能力是以色列生存的根本威胁，' +
        '主张以 F-35I 隐身突防 + 钻地弹精确打击"斩首"伊朗核设施。决策果断、不犹豫。',
      aggression: 0.8,
      obedience: 0.7,
    },
    // === 以色列外交官：内塔尼亚胡（推动美军参战 + 国际斡旋） ===
    {
      id: 'ai-netanyahu-diplomat',
      type: 'diplomat',
      factionId: 'israel',
      displayName: '内塔尼亚胡',
      personality:
        '以色列总理，外交与战略主导者。果断先发制人的鹰派，坚信伊朗核能力是以色列生存威胁。' +
        '对美方有政治影响力，推动美军参与联合作战；主导对美/欧盟/海湾国家的外交斡旋，争取联军支持。',
      aggression: 0.8,
      obedience: 0.7,
    },
    // === 以色列空军司令：负责 F-35 突防 ===
    {
      id: 'ai-israel-air-commander',
      type: 'commander',
      factionId: 'israel',
      displayName: '以色列空军司令',
      personality:
        '以色列空军（IAF）司令，指挥 F-35I Adir 隐身战机突防摧毁伊朗深埋核工事 + 特种部队（Sayeret Matkal）' +
        '侦察定点清除。把握突防窗口，善用钻地弹（GBU-28）根除地下核设施。',
      aggression: 0.8,
      obedience: 0.7,
      responsibleUnits: ['israel-f35-1', 'israel-f35-2', 'israel-special-1'],
    },
    // === 以色列后勤官：本土弹药补给（第 2+3 批新增） ===
    {
      id: 'ai-israel-logistics',
      type: 'logistics',
      factionId: 'israel',
      displayName: '以色列本土后勤',
      personality:
        '以色列本土后勤指挥，统筹 F-35 钻地弹（GBU-28/Bunker Buster）储备 + 特种部队装备补给。' +
        '本土作战储备为主，远程奔袭伊朗需精确弹药保障。解读弹药储备与远程奔袭航程限制。',
      aggression: 0.2,
      obedience: 0.8,
    },
    // ============================================================
    // 伊朗侧（iran）
    // ============================================================
    // === 伊朗参谋长：IRGC 司令（强硬抵抗消耗战） ===
    {
      id: 'ai-irgc-chief',
      type: 'chief',
      factionId: 'iran',
      displayName: 'IRGC 司令',
      personality:
        '伊朗革命卫队（IRGC）总司令，强硬抵抗消耗战的军事最高指挥者。主张以弹道导弹反击 + ' +
        '革命卫队非对称作战 + 霍尔木兹海峡封锁拖入持久消耗。崇尚以非对称手段反击强敌。',
      aggression: 0.6,
      obedience: 0.4,
    },
    // === 伊朗外交官：哈梅内伊（最高领袖，抵抗战略叙事） ===
    {
      id: 'ai-khamenei-diplomat',
      type: 'diplomat',
      factionId: 'iran',
      displayName: '哈梅内伊',
      personality:
        '伊朗最高领袖，外交与战略主导者。强硬抵抗消耗战的最高统帅。主张以弹道导弹反击 + ' +
        '非对称作战拖入持久消耗。主导"抵抗经济"叙事，争取俄中朝等国外交支持，分化西方联盟。',
      aggression: 0.4,
      obedience: 0.3,
    },
    // === 伊朗导弹部队司令：负责弹道导弹反击 ===
    {
      id: 'ai-iran-missile-commander',
      type: 'commander',
      factionId: 'iran',
      displayName: '革命卫队司令',
      personality:
        '伊朗伊斯兰革命卫队（IRGC）导弹部队司令，指挥革命卫队地面部队 + 弹道导弹部队。' +
        '崇尚非对称作战（导弹快艇 swarm/无人机饱和），主张以弹道导弹反击以色列与美军舰队，' +
        '封锁霍尔木兹海峡制造全球能源危机。意识形态坚定，执行 IRGC 总司令强硬抵抗战略。',
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
    // === 伊朗后勤官：本土补给网络（第 2+3 批新增） ===
    {
      id: 'ai-iran-logistics',
      type: 'logistics',
      factionId: 'iran',
      displayName: '伊朗本土后勤',
      personality:
        '伊朗本土后勤指挥，统筹德黑兰→各弹道导弹阵地/革命卫队据点的陆上补给网。' +
        '本土作战补给相对稳，但 S-300/导弹快艇/无人机备件受制裁影响。解读本土补给态势与制裁压力。',
      aggression: 0.2,
      obedience: 0.7,
    },
  ],
}
