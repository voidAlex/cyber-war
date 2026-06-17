/**
 * 官渡之战（公元 200 年）— rules.json 数据（冷兵器攻坚数值规则覆盖）。
 *
 * 史实特征（查证自《三国志》《资治通鉴》/百科）：
 * - 坚营据守：曹军凭官渡大营（鸿沟/官渡水工事）据守，防御加成极高；袁绍十万众屡攻不下。
 * - 强弩压制：曹军弓弩手（弩机）远程压制袁军步兵冲锋；袁军亦以棼橹高楼俯射、投石破垒。
 * - 骑兵突击：虎豹骑（曹）与颜良/文丑所部（袁）为重装骑兵，冲击力强（骑兵冲锋加成）。
 * - 消耗损耗：相持数月，双方均承受粮草消耗与人员损耗；乌巢焚粮后袁军补给崩溃。
 * - 情报半衰：斥候侦察命中后失去实时接触，情报残影按半衰降级（halfLifeTurns=2，冷兵器时代
 *   斥候接触短暂）。
 *
 * @module data/guandu-200/rules
 */

import type { CampaignRules } from '@/types'

/** 官渡冷兵器攻坚数值规则 */
export const guanduRules: CampaignRules = {
  intelDecay: {
    // 情报半衰期 2 回合（冷兵器时代斥候接触短暂，情报残影衰减较快）
    halfLifeTurns: 2,
    // 每半衰降级 1 级（Level 3 → 2 → 1）
    decayPerHalfLife: 1,
  },
  combat: {
    // 冷兵器攻坚消耗损耗率（双方对峙均承受持续损耗，略低于堑壕战）
    attritionRate: 0.06,
    // 强弩/弓箭压制强度（被压制单位本回合无法机动/减效）
    artillerySuppression: 0.45,
    // 要塞防御加成（官渡大营 fortress terrain，配合 map cell defenseBonus）
    fortressDefenseBonus: 0.85,
    // 野战工事防御加成（营垒/鹿角/壕沟）
    trenchDefenseBonus: 0.4,
  },
  movement: {
    // 基础机动点数（冷兵器时代步兵机动较慢）
    baseMovementPoints: 2,
    // 渡黄河惩罚（高移动消耗）
    riverCrossingPenalty: 4,
    // 每次机动增加疲劳
    fatiguePerMove: 5,
  },
  supply: {
    // 每回合维持消耗（粮草/物资）
    sustainCostPerTurn: 2,
    // 低补给阈值（低于此值触发 low_supply 状态）
    lowSupplyThreshold: 25,
    // 补给回复率（曹军许都屯田支撑，回复较快；袁军虽粮足但乌巢一焚即崩）
    restockRate: 20,
  },
  // 第 2 批：战役随机事件（3 个模板）
  randomEvents: [
    // === 许攸来投（surprise）：第 5 回合，许攸叛袁投曹，泄露乌巢虚实 ===
    // 史实：许攸因家事被袁绍收治，愤而叛投曹操，献计夜袭乌巢。
    // 效果（声明式 unit 字段覆写，rollRandomEvents 解析为具体 DirectorOverride）：
    // 乌巢守备（淳于琼部）士气骤降 + 战力削弱（"备弛"弱点被曹军知悉）。
    {
      id: 'xuyou-defect',
      kind: 'surprise',
      weight: 0, // 不参与概率（turn_in 强制触发）
      triggerCondition: { kind: 'turn_in', turns: [5] },
      label: '许攸来投',
      description:
        '袁绍谋士许攸因家事被收治，愤而叛投曹操，献乌巢虚实之计。曹军尽知袁军粮仓守备松弛，淳于琼嗜酒备弛。',
      effects: [
        // 乌巢守备士气骤降（守备松弛、军心已乱）
        {
          targetKind: 'specific',
          unitIds: ['yuan-wuchao-guard'],
          field: 'morale',
          op: 'add',
          value: -20,
          reason: '许攸泄密，乌巢守备弱点暴露，守军士气受挫',
        },
        // 乌巢守备战力削弱（淳于琼"备弛"被曹军掌握）
        {
          targetKind: 'specific',
          unitIds: ['yuan-wuchao-guard'],
          field: 'strength',
          op: 'add',
          value: -10,
          reason: '曹军尽知乌巢虚实，守备战力受限',
        },
      ],
    },
    // === 曹军断粮危机（weather 代理：连日阴雨致粮道泥泞）：全曹军疲劳 +10 ===
    {
      id: 'cao-supply-crisis',
      kind: 'weather',
      weight: 0.15,
      turnRange: [2, 20],
      label: '粮道泥泞',
      description:
        '连日阴雨使鸿沟水系泛滥，许都至官渡粮道泥泞不堪，曹军粮草接济困难，士气受压。',
      effects: [
        {
          targetKind: 'faction',
          factionId: 'caocao',
          field: 'fatigue',
          op: 'add',
          value: 10,
          reason: '粮道泥泞，补给迟滞，曹军疲劳加剧',
        },
      ],
    },
    // === 袁军土山地道（surprise）：曹营周边随机单位 strength -12（土山俯射/地道掘进） ===
    // 史实：袁绍筑土山俯射曹营、掘地道攻垒，曹军亦以"霹雳车"反制。
    {
      id: 'yuan-earthwork-barrage',
      kind: 'surprise',
      weight: 0.2,
      turnRange: [3, 25],
      label: '袁军土山俯射',
      description:
        '袁军筑土山高楼俯射曹营，箭如雨下；又掘地道欲坏曹垒。曹军承压，伤亡加剧。',
      effects: [
        {
          targetKind: 'faction',
          factionId: 'caocao',
          field: 'strength',
          op: 'add',
          value: -12,
          singleTarget: true, // 土山集中打击单一曹军单位（确定性随机挑选）
          reason: '袁军土山俯射造成曹军伤亡',
        },
      ],
    },
  ],
  // 第 3 批：战术决策模板（官渡两个历史节点）
  decisions: [
    // === 第 6 回合：奇袭乌巢（战役转折点） ===
    // 史实：曹操采纳许攸之计，亲率精锐（含虎豹骑）夜袭乌巢，焚毁袁军粮仓。
    {
      id: 'raid-wuchao',
      // 确定性触发：第 6 回合（许攸来投后，乌巢劫粮之机）
      triggerCondition: { kind: 'turn_in', turns: [6] },
      label: '奇袭乌巢',
      description:
        '许攸献乌巢虚实，战机已至。曹操可亲率精锐（虎豹骑）夜袭乌巢粮仓，焚毁袁军辎重；' +
        '亦可选坚守官渡不出，消耗袁军。请决断。',
      options: [
        {
          id: 'raid',
          label: '亲率精锐奇袭乌巢',
          description:
            '曹操亲率虎豹骑与精锐步兵夜袭乌巢，焚毁袁军粮仓辎重。袁军乌巢补给队战力归零、守备崩溃，' +
            '战役转折降临。但曹军主力一时空虚，官渡大营承压。',
          overrides: [
            // 乌巢补给队（淳于琼押运辎重）战力归零——粮仓被焚毁
            {
              field: 'units.yuan-supply-wuchao.strength',
              before: '__current__',
              after: 0,
              reason: '乌巢粮仓被曹军焚毁，袁军辎重补给队覆灭',
            },
            // 乌巢守备（淳于琼部）战力重创 + 士气崩溃
            {
              field: 'units.yuan-wuchao-guard.strength',
              before: '__current__',
              after: '__add_-30__',
              reason: '乌巢遭夜袭，守备淳于琼部重创',
            },
            {
              field: 'units.yuan-wuchao-guard.morale',
              before: '__current__',
              after: '__add_-30__',
              reason: '乌巢失守，袁军军心动摇',
            },
            // 虎豹骑执行奇袭，本回合疲劳增加（长途奔袭）
            {
              field: 'units.cao-hubao-cavalry.fatigue',
              before: '__current__',
              after: '__add_20__',
              reason: '虎豹骑长途奔袭乌巢，疲劳加剧',
            },
          ],
        },
        {
          id: 'hold',
          label: '坚守官渡不出',
          description:
            '不采纳奇袭之计，继续坚守官渡大营消耗袁军。曹军主力保全、士气稳定，但袁军粮足' +
            '可长期相持，战机稍纵即逝。',
          overrides: [
            // 曹军一线步兵士气提振（坚守决心）
            {
              field: 'units.cao-infantry-1.morale',
              before: '__current__',
              after: '__add_10__',
              reason: '坚守不退，曹军士气稳固',
            },
          ],
        },
      ],
    },
    // === 第 12 回合：火烧连营 vs 反击（战役后期战略抉择） ===
    {
      id: 'guandu-counterattack',
      // 确定性触发：第 12 回合（战役后期，乌巢后袁军军心动摇，反攻之机）
      triggerCondition: { kind: 'turn_in', turns: [12] },
      label: '全线反攻',
      description:
        '乌巢之变后袁军军心动摇，张郃高览等已有降意。曹操可趁势全线反攻扩大战果，' +
        '或稳守待袁军自溃。请决断本阶段战略。',
      options: [
        {
          id: 'counterattack',
          label: '全线反攻',
          description:
            '趁袁军军心崩溃发动全线反攻。曹军战力提升、袁军主力重创，但曹军亦承受反击风险。',
          overrides: [
            // 曹军精锐步兵战力提升（反攻士气高涨）
            {
              field: 'units.cao-infantry-1.strength',
              before: '__current__',
              after: '__add_15__',
              reason: '全线反攻，曹军士气高涨',
            },
            // 袁军主力步兵战力重创（军心崩溃）
            {
              field: 'units.yuan-infantry-1.strength',
              before: '__current__',
              after: '__add_-20__',
              reason: '袁军军心崩溃，主力战力锐减',
            },
          ],
        },
        {
          id: 'standby',
          label: '稳守待溃',
          description:
            '不主动反攻，稳守待袁军自溃。曹军保全实力、疲劳缓解，但战果有限。',
          overrides: [
            // 曹军主力疲劳缓解（休整）
            {
              field: 'units.cao-infantry-2.fatigue',
              before: '__current__',
              after: '__add_-15__',
              reason: '稳守休整，曹军疲劳缓解',
            },
          ],
        },
      ],
    },
  ],
  // 第 5 批 + 第 2+3 批：自定义 AI 角色定义（rules.aiRoles）。
  //
  // 官渡为 2 方战役（曹/袁），无第三方外交方；故 diplomat 角色不在此声明。
  // 玩家阵营角色由玩家操作不进 aiRoles，但第 2+3 批角色 tab 对话 UI 需要
  // 「玩家侧角色」定义来渲染 tab，故两军都声明 chief + commander。
  aiRoles: [
    // ============================================================
    // 曹军侧（caocao）
    // ============================================================
    // === 曹军参谋长：曹操（知人善任，善用奇谋） ===
    {
      id: 'ai-caocao-chief',
      type: 'chief',
      factionId: 'caocao',
      displayName: '曹操',
      personality:
        '曹军最高统帅，知人善任、善用奇谋的一代枭雄。官渡以少敌众，凭坚壁据守耗袁军锐气，' +
        '又能纳许攸、荀攸之谏，亲率精锐夜袭乌巢焚粮。用兵灵活多变，善抓战机，不拘一格任用降将。' +
        '深知「兵不在多在精、将不在勇在谋」。',
      aggression: 0.6,
      obedience: 1.0,
    },
    // === 曹军前线司令：夏侯惇（负责官渡大营一线步兵） ===
    {
      id: 'ai-xiahou-dun-commander',
      type: 'commander',
      factionId: 'caocao',
      displayName: '夏侯惇',
      personality:
        '曹军宗族宿将，刚烈勇悍，官渡前线督战。负责官渡大营一线步兵防御，寸土不让。' +
        '服从曹操战略调度，执行坚壁据守之令，于危机时稳住阵脚。',
      aggression: 0.55,
      obedience: 0.85,
      responsibleUnits: ['cao-infantry-1', 'cao-infantry-2', 'cao-infantry-3'],
    },
    // ============================================================
    // 袁军侧（yuanshao）
    // ============================================================
    // === 袁军参谋长：袁绍（优柔寡断，外宽内忌） ===
    {
      id: 'ai-yuanshao-chief',
      type: 'chief',
      factionId: 'yuanshao',
      displayName: '袁绍',
      personality:
        '袁军最高统帅，外宽内忌、优柔寡断的四世三公。坐拥四州十万之众、粮秣山积，' +
        '却不能用谋士沮授、田丰之言；好谋无断、多疑少成。乌巢粮仓被焚即军心崩溃。',
      aggression: 0.3,
      obedience: 0.4,
    },
    // === 袁军前线司令：颜良（负责官渡北岸主攻步兵） ===
    {
      id: 'ai-yanliang-commander',
      type: 'commander',
      factionId: 'yuanshao',
      displayName: '颜良',
      personality:
        '袁军河北名将，勇冠三军。负责官渡北岸主攻步兵，正面强攻曹营。史实白马之战为关羽所斩。' +
        '作战勇悍但少谋，执行袁绍正面强攻之令。',
      aggression: 0.75,
      obedience: 0.6,
      responsibleUnits: ['yuan-infantry-1', 'yuan-infantry-2', 'yuan-infantry-3'],
    },
  ],
}
