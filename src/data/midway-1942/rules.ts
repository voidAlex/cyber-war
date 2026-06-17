/**
 * 中途岛海战 1942 — rules.json 数据（航母海战数值规则覆盖）。
 *
 * 史实特征（查证自维基/百科）：
 * - 航母决战：双方以航母舰载机互搏，舰队在数百公里海域机动；舰炮交火罕见（超视距海战）。
 *   （注：navalCombatRange/airCombatRange/carrierLandingRequired 等专属字段不在 schema combat 内，
 *   由 units equipment 的舰载机槽 + naval type 代理火力与射程。）
 * - 俯冲轰炸致命：SBD 俯冲轰炸机对航母甲板（堆满弹药/油料）命中即殉爆；南云换弹危机使
 *   日军航母极度脆弱。
 * - 高消耗率：海战单位少而精，单艘航母沉没即重大战损（attritionRate 较高，0.15）。
 * - 补给脆弱：舰队远离本土海上机动，油料/弹药补给受限（severedMultiplier=1.5）。
 * - 情报半衰：航空侦察短暂接触，半衰极短（halfLifeTurns=2，海战情报时效性强）。
 *
 * 注：schema combat 仅允许 attritionRate/artillerySuppression/fortressDefenseBonus/
 * trenchDefenseBonus（additionalProperties:false）。海战专属数值由 units equipment 代理。
 *
 * @module data/midway-1942/rules
 */

import type { CampaignRules } from '@/types'

/** 中途岛海战数值规则 */
export const midwayRules: CampaignRules = {
  intelDecay: {
    // 情报半衰期 2 回合（海战航空侦察时效性强，情报残影衰减快）
    halfLifeTurns: 2,
    // 每半衰降级 1 级（Level 3 → 2 → 1）
    decayPerHalfLife: 1,
  },
  combat: {
    // 海战消耗损耗率高（单艘航母沉没即重大战损，舰载机互搏损耗大）
    attritionRate: 0.15,
    // 舰炮/舰载机压制强度（航母舰载机压制对方舰队机动）
    artillerySuppression: 0.5,
    // 中途岛岸基防御加成（机场/基地，配合 map urban cell defenseBonus=0.85）
    fortressDefenseBonus: 0.85,
    // 舰队防空/规避工事加成（屏护阵）
    trenchDefenseBonus: 0.3,
  },
  movement: {
    // 基础机动点数（舰队海上机动较快）
    baseMovementPoints: 3,
    // 渡海无河流概念，珊瑚礁/浅滩规避惩罚
    riverCrossingPenalty: 3,
    // 每次机动增加疲劳（舰队长时间海上机动疲劳）
    fatiguePerMove: 4,
  },
  supply: {
    // 每回合维持消耗（舰队油料/弹药消耗）
    sustainCostPerTurn: 6,
    // 低补给阈值（低于此值触发 low_supply 状态）
    lowSupplyThreshold: 25,
    // 补给回复率（海上补给舰/中途岛基地补给）
    restockRate: 12,
    // 补给被切断时的基线消耗倍率（舰队远离本土，倍率中等）
    severedMultiplier: 1.5,
  },
  // 第 2 批：战役随机事件（2 个模板，对应 JN-25 破译与南云换弹危机）
  randomEvents: [
    // === 破译 JN-25 密码（surprise）：第 1 回合，美军情报优势显现 ===
    // 史实：美军密码破译小组（罗彻福特）破译 JN-25，掌握日军 AF=中途岛及作战时间表。
    // 效果（声明式 unit 字段覆写）：日军旗舰赤城战力削弱（美军精准设伏，舰载机突击命中率提升）。
    {
      id: 'decrypt-jn25',
      kind: 'surprise',
      weight: 0, // 不参与概率（turn_in 强制触发）
      triggerCondition: { kind: 'turn_in', turns: [1] },
      label: '破译 JN-25 密码',
      description:
        '美军密码破译小组（罗彻福特）破译日军 JN-25 密码，确认 AF=中途岛，掌握日军作战全盘计划。' +
        '尼米兹据此设伏，美军舰载机突击命中率大增。',
      effects: [
        // 日军旗舰赤城战力削弱（美军精准掌握其阵位 + 时机）
        {
          targetKind: 'specific',
          unitIds: ['jp-carrier-akagi'],
          field: 'strength',
          op: 'add',
          value: -15,
          reason: 'JN-25 破译，美军精准设伏，日军旗舰赤城暴露于突击之下',
        },
      ],
    },
    // === 南云换弹危机（surprise）：第 2 回合，日军航母甲板堆满弹药极度脆弱 ===
    // 史实：南云因侦察报告中途岛仍有美军航空兵力，下令舰攻换弹（鱼雷→高爆弹），
    // 甲板堆满弹药/油料，SBD 突袭即殉爆。
    // weight=0 + turn_in 强制触发（确定性历史事件）。
    {
      id: 'nakagawa-rearm',
      kind: 'surprise',
      weight: 0,
      triggerCondition: { kind: 'turn_in', turns: [2] },
      label: '南云换弹危机',
      description:
        '日军航母甲板堆满弹药与加油软管（南云下令换弹），一旦被俯冲轰炸机命中即殉爆沉没。' +
        '四艘主力航母此时极度脆弱。',
      effects: [
        // 赤城战力骤降（甲板弹药殉爆弱点）
        {
          targetKind: 'specific',
          unitIds: ['jp-carrier-akagi'],
          field: 'strength',
          op: 'set',
          value: 30,
          reason: '甲板堆满弹药，殉爆弱点暴露，战力骤降',
        },
        // 加贺/苍龙/飞龙亦承压（换弹危机波及全舰队）
        {
          targetKind: 'specific',
          unitIds: ['jp-carrier-kaga', 'jp-carrier-soryu', 'jp-carrier-hiryu'],
          field: 'strength',
          op: 'add',
          value: -10,
          reason: '换弹危机波及全舰队，航母群承压',
        },
      ],
    },
  ],
  // 第 3 批：战术决策模板（中途岛两个关键节点）
  decisions: [
    // === 第 2 回合：是否率先出击（SBD 俯冲轰炸机群） ===
    // 史实：斯普鲁恩斯果断下令 SBD 趁南云换弹危机出击，一举击沉三航母。
    {
      id: 'strike-first',
      // 确定性触发：第 2 回合（南云换弹危机窗口，SBD 出击时机）
      triggerCondition: { kind: 'turn_in', turns: [2] },
      label: '是否率先出击',
      description:
        '侦察发现日军航母群阵位，且南云舰队甲板堆满弹药（换弹危机）。斯普鲁恩斯可果断下令 SBD 俯冲轰炸机群' +
        '率先出击（趁敌脆弱一举重创），或等待进一步侦察确认（稳妥但可能错失战机）。请决断。',
      options: [
        {
          id: 'strike',
          label: 'SBD 俯冲轰炸机群出击',
          description:
            '果断下令 SBD 无畏俯冲轰炸机群全数出击，趁南云换弹危机对日军航母实施毁灭打击。' +
            '美军舰载机战力提升、日军航母重创，但美军航母亦暴露于日军反击。',
          overrides: [
            // 美军企业号舰载机战力提升（果断出击，命中率激增）
            {
              field: 'units.us-carrier-enterprise.strength',
              before: '__current__',
              after: '__add_15__',
              reason: '果断出击，SBD 趁换弹危机命中率激增',
            },
            // 日军赤城战力重创（甲板殉爆）
            {
              field: 'units.jp-carrier-akagi.strength',
              before: '__current__',
              after: '__add_-40__',
              reason: 'SBD 命中甲板弹药殉爆，赤城重创',
            },
            // 加贺亦中弹重创
            {
              field: 'units.jp-carrier-kaga.strength',
              before: '__current__',
              after: '__add_-30__',
              reason: 'SBD 命中，加贺甲板殉爆',
            },
          ],
        },
        {
          id: 'wait',
          label: '等待侦察确认',
          description:
            '等待 PBY 巡逻机进一步确认日军航母精确阵位再出击。稳妥避免误击，但可能错失南云换弹' +
            '危机的黄金窗口。',
          overrides: [
            // 等待使日军得以完成换弹恢复战力（窗口流失）
            {
              field: 'units.jp-carrier-akagi.strength',
              before: '__current__',
              after: '__add_15__',
              reason: '等待使南云完成换弹，赤城恢复战力',
            },
            // 美军侦察到位（疲劳略增但情报提升，以 morale 反映）
            {
              field: 'units.us-carrier-enterprise.morale',
              before: '__current__',
              after: '__add_5__',
              reason: '侦察确认到位，美军信心增强',
            },
          ],
        },
      ],
    },
    // === 第 5 回合：追击 vs 收兵（日军四航母沉没后） ===
    {
      id: 'pursue-or-consolidate',
      // 确定性触发：第 5 回合（决战后，日军四航母沉没，追击山本主力之机）
      triggerCondition: { kind: 'turn_in', turns: [5] },
      label: '追击 vs 收兵',
      description:
        '日军四艘主力航母已沉没，山本主力（战列舰/巡洋舰）仍在西向撤退。美军可趁胜追击扩大战果，' +
        '或见好就收保存舰队实力。请决断。',
      options: [
        {
          id: 'pursue',
          label: '趁胜追击',
          description:
            '趁日军航母群覆灭之机追击山本主力（战列舰/巡洋舰），扩大战果。战果大但美军舰队承压、' +
            '约克城可能受损（史实约克城被飞龙反击重创后沉没）。',
          overrides: [
            // 美军约克城承压（追击中暴露于日军反击）
            {
              field: 'units.us-carrier-yorktown.strength',
              before: '__current__',
              after: '__add_-25__',
              reason: '追击中约克城暴露于日军残部反击',
            },
            // 日军战列舰重创（追击扩大战果）
            {
              field: 'units.jp-battleship-1.strength',
              before: '__current__',
              after: '__add_-20__',
              reason: '美军追击，日军战列舰重创',
            },
          ],
        },
        {
          id: 'consolidate',
          label: '见好就收',
          description:
            '不追击，保存舰队实力，巩固中途岛防御。美军舰队无损、士气稳定，但战果有限。',
          overrides: [
            // 美军舰队疲劳缓解（收兵休整）
            {
              field: 'units.us-carrier-enterprise.fatigue',
              before: '__current__',
              after: '__add_-15__',
              reason: '收兵休整，美军舰队疲劳缓解',
            },
          ],
        },
      ],
    },
  ],
  // 第 5 批 + 第 2+3 批：自定义 AI 角色定义（rules.aiRoles）。
  //
  // 中途岛为 2 方海战（美/日），无第三方外交方；故 diplomat 角色不在此声明。
  aiRoles: [
    // ============================================================
    // 美军侧（usa）
    // ============================================================
    // === 美军参谋长：尼米兹（情报至上，冷静设伏） ===
    {
      id: 'ai-nimitz-chief',
      type: 'chief',
      factionId: 'usa',
      displayName: '尼米兹',
      personality:
        '美国太平洋舰队总司令，冷静算计、情报至上的战略大师。破译 JN-25 后掌握日军全盘计划，' +
        '果断设伏中途岛。授权前线指挥官临机决断，深信"以少胜多"靠情报与时机。',
      aggression: 0.8,
      obedience: 0.9,
    },
    // === 美军前线指挥：斯普鲁恩斯（航母舰队司令） ===
    {
      id: 'ai-spruance-commander',
      type: 'commander',
      factionId: 'usa',
      displayName: '斯普鲁恩斯',
      personality:
        '美军第 16 特混舰队司令，冷静果断的海战指挥官。趁南云换弹危机果断下令 SBD 出击，' +
        '一举击沉日军三航母。冷静、不贪功，见好就收保存舰队实力。海战时机把握精准。',
      aggression: 0.7,
      obedience: 0.8,
      responsibleUnits: [
        'us-carrier-enterprise',
        'us-carrier-yorktown',
        'us-carrier-hornet',
      ],
    },
    // ============================================================
    // 日军侧（japan）
    // ============================================================
    // === 日军参谋长：山本五十六（赌徒直觉，大胆进攻） ===
    {
      id: 'ai-yamamoto-chief',
      type: 'chief',
      factionId: 'japan',
      displayName: '山本五十六',
      personality:
        '日本联合舰队司令长官，赌徒直觉、大胆进攻的海军名将。策划中途岛决战，企图歼灭美军航母残部。' +
        '自信于兵力优势，崇尚"舰队决战"学说，主张以航母机动部队主动出击、一锤定音。',
      aggression: 0.7,
      obedience: 0.6,
    },
    // === 日军前线指挥：南云忠一（第一航空舰队司令） ===
    {
      id: 'ai-nagumo-commander',
      type: 'commander',
      factionId: 'japan',
      displayName: '南云',
      personality:
        '日军第一航空舰队司令（南云忠一），水雷战专家出身，指挥航母机动部队。' +
        '中途岛海战中因侦察情报不明，下令舰攻换弹（鱼雷→高爆弹），致甲板堆满弹药，' +
        '为美军 SBD 突袭殉爆埋下祸根。战术执行谨慎但缺乏航空作战直觉。',
      aggression: 0.5,
      obedience: 0.7,
      responsibleUnits: [
        'jp-carrier-akagi',
        'jp-carrier-kaga',
        'jp-carrier-soryu',
        'jp-carrier-hiryu',
      ],
    },
    // ============================================================
    // 第 2 批新增：后勤官（logistics）纯对话角色
    // ============================================================
    // === 美军后勤官：舰队补给/损管 ===
    // 史实：美军航母海上机动，需油船补给燃料 + 维修船损管。约克城战损后珍珠港 3 天抢修重返战场。
    {
      id: 'ai-usa-logistics',
      type: 'logistics',
      factionId: 'usa',
      displayName: '美军舰队补给',
      personality:
        '美军太平洋舰队后勤指挥，统筹油船补给燃料 + 维修船损管 + 舰载机弹药补充。' +
        '约克城号战损后珍珠港船厂 72 小时抢修使其重返战场（史实关键后勤奇迹）。' +
        '在角色 tab 中解读舰队油料/弹药/损管态势与海上补给窗口。',
      aggression: 0.2,
      obedience: 0.8,
    },
    // === 日军后勤官：联合舰队补给 ===
    // 史实：日军联合舰队远离本土海上机动，油料/弹药补给受限。中途岛战机换弹危机即后勤混乱的体现。
    {
      id: 'ai-japan-logistics',
      type: 'logistics',
      factionId: 'japan',
      displayName: '联合舰队补给',
      personality:
        '日军联合舰队后勤指挥，统筹本土→中途岛海域的油船/弹药船补给。' +
        '舰队远离本土海上机动，补给受限。南云换弹危机即甲板后勤混乱的体现（鱼雷/高爆弹反复调拨）。' +
        '在角色 tab 中解读舰队补给线脆弱点与弹药调拨混乱。',
      aggression: 0.2,
      obedience: 0.7,
    },
  ],
}
