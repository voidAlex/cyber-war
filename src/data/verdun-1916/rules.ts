/**
 * 凡尔登战役 1916 — rules.json 数据（堑壕战数值规则覆盖）。
 *
 * 史实特征（查证自维基/百科）：
 * - 堑壕战：双方构筑堑壕工事，防御加成极高，进攻方伤亡惨重。
 * - 重炮压制：德军"大贝尔莎"420mm 重炮轰击要塞；炮击压制步兵使其无法机动。
 * - 消耗损耗：长期对峙双方均承受持续战损（弹药消耗、人员损耗）。
 * - 情报半衰：侦察命中后失去实时侦察，情报残影按半衰降级（halfLifeTurns=3）。
 *
 * @module data/verdun-1916/rules
 */

import type { CampaignRules } from '@/types'

/** 凡尔登堑壕战数值规则 */
export const verdunRules: CampaignRules = {
  intelDecay: {
    // 情报半衰期 3 回合（每回合≈10天 → 半衰约 30 天），与 PRD §6 半衰草案一致
    halfLifeTurns: 3,
    // 每半衰降级 1 级（Level 3 → 2 → 1）
    decayPerHalfLife: 1,
  },
  // T1-B：天气规则（凡尔登 1916 春，默兹河谷多雨雾，无雪）
  weather: {
    possibleTypes: ['clear', 'rain', 'storm', 'fog'],
    baseDuration: 3,
  },
  combat: {
    // 堑壕战消耗损耗率（每回合双方均承受持续损耗）
    attritionRate: 0.08,
    // 重炮压制强度（被炮击单位本回合无法机动/减效）
    artillerySuppression: 0.6,
    // 要塞防御加成（杜奥蒙/沃/苏维尔，配合 map cell defenseBonus）
    fortressDefenseBonus: 0.85,
    // 堑壕防御加成（野战工事）
    trenchDefenseBonus: 0.5,
  },
  movement: {
    // 基础机动点数（堑壕战机动受限）
    baseMovementPoints: 2,
    // 渡默兹河惩罚（高移动消耗）
    riverCrossingPenalty: 4,
    // 每次机动增加疲劳
    fatiguePerMove: 5,
  },
  supply: {
    // 每回合维持消耗（弹药/物资）
    sustainCostPerTurn: 8,
    // 低补给阈值（低于此值触发 low_supply 状态）
    lowSupplyThreshold: 25,
    // 补给回复率（"神圣之路"后勤轮换使法军回复较快）
    restockRate: 15,
  },
  // 第 2 批：战役随机事件（5 个模板）
  randomEvents: [
    // === 暴雨（weather）：全图单位疲劳+10（泥泞降低机动，以疲劳代理 movementCost 影响） ===
    {
      id: 'verdun-heavy-rain',
      kind: 'weather',
      weight: 0.2,
      turnRange: [1, 30],
      label: '默兹河暴雨',
      description:
        '连日暴雨使默兹河谷泥泞不堪，炮车与补给马车深陷泥潭，双方机动大受影响。',
      effects: [
        {
          targetKind: 'all',
          field: 'fatigue',
          op: 'add',
          value: 10,
          reason: '暴雨泥泞加剧疲劳，单位机动迟滞',
        },
      ],
    },
    // === 毒气（gas）：杜奥蒙周边（7,2 半径 2）单位 strength -10 ===
    {
      id: 'verdun-gas-attack',
      kind: 'gas',
      weight: 0.1,
      turnRange: [2, 30],
      label: '毒气攻击',
      description:
        '德军释放氯气/光气，黄绿色烟雾笼罩要塞前沿，未配防毒面具的单位大量减员。',
      effects: [
        {
          targetKind: 'region',
          coord: { col: 7, row: 2 },
          radius: 2,
          field: 'strength',
          op: 'add',
          value: -10,
          reason: '毒气造成化学杀伤，单位战斗力下降',
        },
      ],
    },
    // === 法军援军到达（reinforcement）：第 5/10/15 回合，新单位出现 ===
    {
      id: 'verdun-french-reinforcement',
      kind: 'reinforcement',
      weight: 0, // 不参与概率（turn_in 强制触发）
      triggerCondition: { kind: 'turn_in', turns: [5, 10, 15] },
      label: '法军援军到达',
      description:
        '贝当将军调集的援军沿"神圣之路"抵达前线，为守军注入生力军。',
      // 援军单位定义（来自战役包，非伪造）：每次触发都注入同样三单位（id 唯一性由注入时
      // 已存在则跳过保证，第 5 回合注入；第 10/15 回合已存在不再重复注入）。
      reinforcementUnits: [
        {
          id: 'fr-reinforcement-corps',
          factionId: 'france',
          type: 'infantry',
          coord: { col: 3, row: 4 },
          strength: 80,
          personnel: 9000,
          maxPersonnel: 12000,
          fuel: 60,
          ammo: 70,
          morale: 75,
          fatigue: 20,
          status: [],
        },
      ],
      effects: [
        // 援军注入即生效，effects 设定其初始士气（已由 reinforcementUnits 定义，此处留空）
      ],
    },
    // === 兵变（mutiny）：德军平均士气 <30 时概率触发，全德军单位 morale -20 ===
    {
      id: 'verdun-mutiny',
      kind: 'mutiny',
      weight: 0.4,
      triggerCondition: { kind: 'morale_below', factionId: 'germany', moraleThreshold: 30 },
      label: '前线兵变',
      description:
        '德军长期消耗使士气崩溃，部分单位拒绝执行进攻命令，前线陷入哗变。',
      effects: [
        {
          targetKind: 'faction',
          factionId: 'germany',
          field: 'morale',
          op: 'add',
          value: -20,
          reason: '兵变蔓延，单位士气进一步崩塌',
        },
      ],
    },
    // === 德军炮击（surprise）：随机区域单位 strength -15 ===
    {
      id: 'verdun-german-barrage',
      kind: 'surprise',
      weight: 0.15,
      turnRange: [1, 30],
      label: '德军重炮突袭',
      description:
        '德军集中"大贝尔莎"重炮对法军阵地实施突然而猛烈的炮击，造成重大伤亡。',
      effects: [
        {
          targetKind: 'faction',
          factionId: 'france',
          field: 'strength',
          op: 'add',
          value: -15,
          singleTarget: true, // 突袭集中打击单一目标（确定性随机挑选）
          reason: '德军重炮突袭造成重大伤亡',
        },
      ],
    },
  ],
  // 第 3 批：战术决策模板（凡尔登两个历史节点）
  decisions: [
    // === 第 3 回合：兵力集中方向（战役初期主攻方向抉择） ===
    {
      id: 'verdun-focus-direction',
      // 确定性触发：第 3 回合（战役初期，攻方需选定主攻方向）
      triggerCondition: { kind: 'turn_in', turns: [3] },
      label: '兵力集中方向',
      description:
        '战役进入第 3 天，前线指挥官请示兵力集中方向。杜奥蒙堡为德军要塞核心，默兹河两岸地形复杂但分散防守。请决定本阶段主攻方向。',
      options: [
        {
          id: 'focus-douaumont',
          label: '集中攻击杜奥蒙堡',
          description:
            '将主力集中于杜奥蒙堡方向，强攻这座要塞核心。攻方战力提升，但防守方因压力激增而疲劳加剧。',
          overrides: [
            // 攻方（德国）主攻步兵 strength +15
            {
              field: 'units.de-infantry-21.strength',
              before: '__current__',
              after: '__add_15__',
              reason: '集中主力于杜奥蒙方向，攻方战力提升',
            },
            // 守方（法国）杜奥蒙堡 fatigue +20（高强度防御压力）
            {
              field: 'units.fr-fortress-douaumont.fatigue',
              before: '__current__',
              after: '__add_20__',
              reason: '杜奥蒙方向防御压力激增，守军疲劳加剧',
            },
          ],
        },
        {
          id: 'spread-meuse',
          label: '牵制默兹河两岸',
          description:
            '在默兹河两岸分散部署，牵制敌军防线。整体战力分散，但降低单一方向损失。',
          overrides: [
            // 攻守双方主力步兵 strength 各 -5（分散消耗）
            {
              field: 'units.de-infantry-7.strength',
              before: '__current__',
              after: '__add_-5__',
              reason: '分散部署降低单一方向战力',
            },
            {
              field: 'units.fr-infantry-37.strength',
              before: '__current__',
              after: '__add_-5__',
              reason: '默兹河两岸牵制，双方均分散消耗',
            },
          ],
        },
        {
          id: 'hold-reinforce',
          label: '坚守待援',
          description:
            '转入防御，等待援军到达。守军士气提升，但本回合无进攻进展。',
          overrides: [
            // 守方（法国）杜奥蒙堡 morale +15（坚守提振士气）
            {
              field: 'units.fr-fortress-douaumont.morale',
              before: '__current__',
              after: '__add_15__',
              reason: '转入防御待援，守军士气提振',
            },
          ],
        },
      ],
    },
    // === 第 10 回合：尼韦勒 vs 贝当路线（战役中期战略路线抉择） ===
    {
      id: 'verdun-nivelle-petain',
      // 确定性触发：第 10 回合（战役中期，战略路线分歧）
      triggerCondition: { kind: 'turn_in', turns: [10] },
      label: '尼韦勒 vs 贝当路线',
      description:
        '战役进入关键阶段，统帅部出现路线分歧。尼韦勒主张激进反攻收复失地，贝当主张稳健轮换消耗敌军。请决定本阶段战略路线。',
      options: [
        {
          id: 'nivelle-aggressive',
          label: '尼韦勒激进反攻',
          description:
            '采纳尼韦勒的激进反攻方案，集中兵力发动大规模反击。进攻性大幅提升，但风险极高，可能遭受惨重损失。',
          overrides: [
            // 法军主攻步兵 strength +20 但 morale -10（高风险）
            {
              field: 'units.fr-infantry-37.strength',
              before: '__current__',
              after: '__add_20__',
              reason: '激进反攻集结兵力，攻方战力提升',
            },
            {
              field: 'units.fr-infantry-37.morale',
              before: '__current__',
              after: '__add_-10__',
              reason: '激进反攻风险高，士兵士气受压',
            },
          ],
        },
        {
          id: 'petain-steady',
          label: '贝当稳健轮换',
          description:
            '采纳贝当的稳健轮换方案，前线部队定期轮换休整。士气与疲劳好转，但本回合不发动进攻。',
          overrides: [
            // 法军主力步兵 morale +15、fatigue -15（轮换休整）
            {
              field: 'units.fr-infantry-2.morale',
              before: '__current__',
              after: '__add_15__',
              reason: '稳健轮换提振士气',
            },
            {
              field: 'units.fr-infantry-2.fatigue',
              before: '__current__',
              after: '__add_-15__',
              reason: '前线轮换休整，疲劳缓解',
            },
          ],
        },
      ],
    },
  ],
  // 第 5 批 + 第 2+3 批：自定义 AI 角色定义（rules.aiRoles）。
  //
  // 凡尔登为 2 方战役（法/德），无第三方外交方；故 diplomat 角色不在此声明
  // （缺省时 orchestrator 按既有逻辑兜底；玩家阵营角色由玩家操作不进 aiRoles，
  // 但第 2+3 批角色 tab 对话 UI 需要「玩家侧角色」定义来渲染 tab，故两军都声明
  // chief + 各指挥官，运行时 usePlayerRoleTabs 按 playerFactionId 过滤玩家侧）。
  //
  // 第 2+3 批扩展（按玩家选阵营动态）：
  // - 法军侧（playerFactionId='france'）：chief=贝当 + 炮兵司令 + 杜奥蒙守备指挥。
  // - 德军侧（playerFactionId='germany'）：chief=法金汉 + 皇太子（步兵）+ 重炮指挥。
  // 运行时 usePlayerRoleTabs 取 factionId===playerFactionId 的角色渲染 tab；
  // 敌方 AI 角色由 orchestrator 按 factionId 实例化（既有逻辑）。
  aiRoles: [
    // ============================================================
    // 法军侧（france）
    // ============================================================
    // === 法军参谋长：贝当（稳健防御，神圣之路轮换） ===
    {
      id: 'ai-petain-chief',
      type: 'chief',
      factionId: 'france',
      displayName: '贝当',
      personality:
        '法军总指挥，凡尔登守军的定海神针。稳健务实，首创「神圣之路」后勤轮换，' +
        '坚信「火力+轮换」能消耗德军攻击动能。不冒进，重视部队休整与士气维系。',
      aggression: 0.4,
      obedience: 0.6,
    },
    // === 法军炮兵司令（火力至上，压制德军集结） ===
    {
      id: 'ai-france-artillery-commander',
      type: 'commander',
      factionId: 'france',
      displayName: '法军炮兵司令',
      personality:
        '法军炮兵司令，信奉「炮兵征服，步兵占领」。以 75 野战炮与重榴弹炮实施弹幕射击，' +
        '压制德军集结地域与进攻轴线。火力至上，主张以钢铁换人命。',
      aggression: 0.6,
      obedience: 0.7,
      responsibleUnits: ['fr-artillery-1'],
    },
    // === 杜奥蒙守备指挥（坚守要塞，寸土不让） ===
    {
      id: 'ai-france-fortress-commander',
      type: 'commander',
      factionId: 'france',
      displayName: '杜奥蒙守备',
      personality:
        '凡尔登要塞守备指挥，依托杜奥蒙/沃/苏维尔工事群死守。坚信要塞是法军的脊梁，' +
        '宁可全员玉碎也不后退一步。顽强、固执，对放弃阵地的命令强烈抵触。',
      aggression: 0.3,
      obedience: 0.5,
      responsibleUnits: ['fr-fortress-douaumont', 'fr-fortress-vaux', 'fr-fortress-souville'],
    },
    // ============================================================
    // 德军侧（germany）
    // ============================================================
    // === 德军参谋长：法金汉（消耗战略策划者） ===
    {
      id: 'ai-falkenhayn-chief',
      type: 'chief',
      factionId: 'germany',
      displayName: '法金汉',
      personality:
        '德军总参谋长，凡尔登消耗战略的核心策划者。冷静精算，以重炮制造法军无法承受的伤亡交换比，' +
        '坚信消耗战能拖垮法国意志。methodical 不冒进。',
      aggression: 0.5,
      obedience: 0.55,
    },
    // === 德军第五集团军司令：皇太子（步兵主攻，东岸推进） ===
    {
      id: 'ai-crown-prince-commander',
      type: 'commander',
      factionId: 'germany',
      displayName: '皇太子',
      personality:
        '德国第五集团军司令（皇太子威廉），实际指挥东岸主攻。年轻尚武，较法金汉更激进，' +
        '屡屡请求加大进攻力度。服从消耗战略大框架，但战术层面主张扩大战果。',
      aggression: 0.7,
      obedience: 0.75,
      // 第 2+3 批拆分：皇太子仅负责步兵主攻；重炮归独立指挥官。
      responsibleUnits: ['de-infantry-21', 'de-infantry-7', 'de-infantry-12'],
    },
    // === 德军重炮指挥（精确打击，大贝尔莎操作者） ===
    {
      id: 'ai-germany-artillery-commander',
      type: 'commander',
      factionId: 'germany',
      displayName: '重炮指挥',
      personality:
        '德军重炮部队指挥，操作 420mm「大贝尔莎」与 210mm 榴弹炮。崇尚精确打击，' +
        '主张以重炮逐个敲开法军要塞。冷静、技术至上，反对步兵无谓冲锋。',
      aggression: 0.5,
      obedience: 0.8,
      responsibleUnits: ['de-artillery-heavy'],
    },
  ],
}
