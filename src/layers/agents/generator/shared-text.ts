/**
 * 生成器共享文本常量（shared-text.ts）— 纯常量模块。
 *
 * 三段固定文本构成 L0 共享前缀（prefix.ts 引用）：
 * - CAMPAIGN_SCHEMA_SUMMARY：七文件 schema 的字段/枚举/区间摘要（让 LLM 输出合法值）。
 * - GENERATION_RULES：生成规则（数值平衡/引用自洽/双方公平等约束）。
 * - HISTORY_CHECK_RULES：历史校验规则（史实来源策略、存疑/非史实标注）。
 *
 * 这些文本**永不变**（缓存价值最高）：枚举值与 schema 区间来自
 * src/campaign-schemas/*.schema.json，schema 演进时同步更新此处摘要。
 *
 * @module layers/agents/generator/shared-text
 */

/**
 * 七文件 schema 摘要（关键字段/枚举/区间）。
 * 与 src/campaign-schemas/*.schema.json 严格对齐；枚举值一字不差。
 */
export const CAMPAIGN_SCHEMA_SUMMARY = [
  'CampaignPayload 七文件聚合：{ manifest, map, factions[], units[], commanders[], rules, victory }。',
  '',
  'manifest: {',
  '  scenarioId: 小写字母数字连字符 ^[a-z0-9][a-z0-9-]*$，',
  '  displayName: 1..120 字符，scenarioSeed: 1..128 字符（固定种子），',
  '  schemaVersion: 非空字符串，playerFactionIds: 至少 1 个唯一字符串，',
  '  description?: <=2000 字符，startInGameDate?: 非空，maxTurns?: 1..1000',
  '}',
  '',
  'map: { gridType: "square"|"hex", cols: 正整数, rows: 正整数,',
  '  cells[]: { id, col>=0, row>=0, terrain: "plain"|"forest"|"mountain"|"water"|"urban"|"fortress"|"marsh",',
  '             movementCost: 正数, defenseBonus: 0..1, isObjective: bool },',
  '  highValueNodes[]: { id, name, cellId(须存在于 cells), controlThreshold: 正数 }',
  '}',
  '',
  'factions[]: { id, name, color: ^#[0-9A-Fa-f]{6}$, side: "player"|"enemy"|"ally"|"neutral",',
  '  commanderId(须存在于 commanders), theaterCommanderIds?: 唯一 id[],',
  '  supply: { supplies, ammunition, fuel: 数值 }, doctrineTags: 唯一非空字符串[],',
  '  trust?: { [对方factionId]: 0..100 }, description? }',
  '',
  'units[]: { id, factionId(须存在于 factions),',
  '  type: "infantry"|"armor"|"artillery"|"recon"|"fortress"|"support",',
  '  coord: { col>=0, row>=0 }(须落在地图范围), strength: 0..100,',
  '  personnel: 整数>=0, maxPersonnel: 整数>=1, fuel/ammo/morale/fatigue: 0..100,',
  '  status?: 唯一枚举[] "engaged"|"suppressed"|"pinned"|"retreating"|"low_supply"|"decoy" }',
  '',
  'commanders[]: { id, name: 1..80, personality: 1..2000,',
  '  aggression: 0..1, obedience: 0..1,',
  '  preferredTempo: "methodical"|"balanced"|"rapid",',
  '  doctrineTags: 唯一非空字符串[], rank?: 1..80, factionId? }',
  '',
  'rules: { intelDecay: { halfLifeTurns: 1..50, decayPerHalfLife: 0..3 },',
  '  combat: { attritionRate?: 0..1, artillerySuppression?: 0..1,',
  '            fortressDefenseBonus?: 0..1, trenchDefenseBonus?: 0..1 },',
  '  movement?: { baseMovementPoints?: 1..100, riverCrossingPenalty?: 0..10, fatiguePerMove?: 0..50 },',
  '  supply?: { sustainCostPerTurn?: 0..50, lowSupplyThreshold?: 0..100, restockRate?: 0..100 } }',
  '',
  'victory: { maxTurns: 1..1000,',
  '  conditions[]: { id, factionId(须存在于 factions),',
  '    type: "objective"|"casualty"|"turn_limit", description: 非空,',
  '    nodeId?(objective 须存在于 highValueNodes),',
  '    casualtyThreshold?: 0..1, targetFactionId?(casualty 须存在于 factions) } }',
].join('\n')

/** 生成规则（数值平衡/引用自洽/双方公平等，固定） */
export const GENERATION_RULES = [
  '1. 引用自洽：factions.commanderId 必须存在于 commanders[].id；',
  '   units.factionId 必须存在于 factions[].id；',
  '   victory.conditions.nodeId 必须存在于 map.highValueNodes[].id；',
  '   victory.conditions.targetFactionId 必须存在于 factions[].id；',
  '   map.highValueNodes.cellId 必须存在于 map.cells[].id。',
  '2. 坐标范围：所有 units.coord.col < map.cols 且 row < map.rows。',
  '3. 双方公平：每个 playerFactionId 与敌方阵营至少各 1 条可达胜利条件；',
  '   兵力差距不应悬殊到一方无胜算（总 personnel 比值建议在 0.5..2.0 之间）。',
  '4. 数值区间：所有数值字段必须落在 schema 区间内（见七文件 schema 定义）。',
  '5. 至少 1 个 player 阵营、1 个非 player 阵营（enemy/ally/neutral 之一）；',
  '   playerFactionIds 至少 1 个且存在于 factions。',
  '6. 固定种子：manifest.scenarioSeed 必须给定固定字符串（确定性随机基底）。',
  '7. cells 须覆盖整个 cols×rows 网格（cells.length == cols*rows）。',
].join('\n')

/** 历史校验规则（史实来源策略、存疑/非史实标注，固定） */
export const HISTORY_CHECK_RULES = [
  '1. 史实来源以 LLM 内置知识为主（不联网）。',
  '2. 著名战役（一战/二战等知名战役）尽量给出准确时间/双方/指挥官/兵力。',
  '3. 冷门或不确定事实：研究员在 facts.isUncertain 标 true（存疑），',
  '   并在 notes 提示玩家核对。',
  '4. 虚构/架空/自定义需求：historical=false（非史实），',
  '   事实字段合理推断且标 isUncertain:true，并在 notes 注明「非史实·虚构」。',
  '5. 不得编造具体到日期/数字的「精确」史实以掩饰不确定；不确定就标存疑。',
].join('\n')

/**
 * 研究员输出 schema 文本（L0 末段，固定）。
 * 让 LLM 知道要输出哪个 JSON 形状。
 */
export const RESEARCHER_OUTPUT_SCHEMA_TEXT = [
  '研究员输出 schema（严格 JSON）：',
  '{',
  '  historical: boolean,            // true=真实战役，false=虚构/架空/自定义',
  '  name: string,                   // 战役名（人类可读）',
  '  timePeriod: string,             // 时间（如 1943-07-05 ~ 1943-08-23）',
  '  factions: [{                    // 双方阵营',
  '    id: string, name: string, side: "player"|"enemy"|"ally"|"neutral",',
  '    brief: string                 // 阵营简述',
  '  }],',
  '  commanders: [{                  // 指挥官（含人格倾向）',
  '    name: string, factionId: string, rank?: string,',
  '    aggression: "low"|"medium"|"high",   // 人格倾向（设计师据此映射数值）',
  '    obedience: "low"|"medium"|"high",',
  '    tempo: "methodical"|"balanced"|"rapid",',
  '    brief: string',
  '  }],',
  '  geography: {                    // 地理（映射沙盘）',
  '    riversOrBarriers: string[],   // 河流/天险',
  '    fortressesOrObjectives: [{ name: string, brief: string }],  // 要塞/高价值节点',
  '    terrainSummary: string',
  '  },',
  '  forceScale: {                   // 兵力规模（粗略即可，不确定标存疑）',
  '    sideApprox: [{ factionId: string, personnelApprox: string }]',
  '  },',
  '  keyEvents: [{ phase: string, description: string }],',
  '  outcome: string,                // 胜负结局',
  '  facts: [{ claim: string, isUncertain: boolean }],  // 关键事实 + 存疑标注',
  '  notes: string                   // 提示玩家核对/虚构说明',
  '}',
].join('\n')

/** 平衡校验输出 schema 文本（L0 末段，固定） */
export const BALANCER_OUTPUT_SCHEMA_TEXT = [
  '平衡校验输出 schema（严格 JSON）：',
  '{',
  '  pass: boolean,                  // true=通过，false=需设计师修正',
  '  issues: [{ field: string, problem: string }],   // 具体字段问题',
  '  suggestions: string[]           // 可执行修正建议',
  '}',
].join('\n')
