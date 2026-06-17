/**
 * NPC 主动外交（diplomacy-npc.ts）— 纯函数（T3-A）。
 *
 * NPC（非玩家）阵营按当前态势（信任度 + 兵力对比 + 是否被攻击）主动发起外交请求，
 * 推送给玩家。每回合最多 1 个请求（避免轰炸玩家 UI）。
 *
 * 决策模型（PRD §4 + 钢铁雄心对比）：
 * - 求和（ceasefire）：NPC 对玩家信任度 > 40 且当前兵力 < 初始 ×0.5（劣势求和）。
 * - 求援（reinforcement）：NPC 对某盟友信任度 > 60 且正被攻击（本回合有敌方单位邻接）。
 * - 威胁（threat）：NPC 兵力 > 初始 ×1.5（绝对优势）→ 威胁玩家投降。
 *
 * "初始兵力"近似：用各阵营单位的 maxPersonnel 累加（编制满员≈初始），
 * 当前兵力用 strength 累加。纯函数可计算（无需运行时持久化 initialStrength）。
 *
 * 确定性：所有概率判定用注入的 DeterministicRandom（编排器按
 * scenarioSeed:turn:<npc-diplomacy-seq> 注入）。
 *
 * @module layers/domain/diplomacy-npc
 */

import type {
  WorldState,
  Faction,
  DiplomaticRequest,
} from '@/types'
import type { DeterministicRandom } from './deterministic-random'

/** NPC 求和触发：对玩家信任度阈值（>40 才考虑求和）。 */
export const NPC_CEASEFIRE_TRUST_THRESHOLD = 40
/** NPC 求援触发：对盟友信任度阈值（>60 才考虑求援）。 */
export const NPC_REINFORCEMENT_TRUST_THRESHOLD = 60
/** NPC 求和触发：当前兵力占初始比例下限（<0.5 才劣势求和）。 */
export const NPC_CEASEFIRE_STRENGTH_RATIO = 0.5
/** NPC 威胁触发：当前兵力占初始比例下限（>1.5 才优势威胁）。 */
export const NPC_THREAT_STRENGTH_RATIO = 1.5
/** 每种 NPC 外交请求的基础触发概率（0..1，叠加信任度/态势微调）。 */
export const NPC_DIPLOMACY_BASE_PROBABILITY = 0.35

/**
 * 计算某阵营当前总 strength（活单位累加）。
 *
 * @param world 当前世界状态
 * @param factionId 阵营 id
 * @returns 该阵营所有 strength>0 单位的 strength 累加
 */
export function computeFactionStrength(world: WorldState, factionId: string): number {
  let total = 0
  for (const u of world.units) {
    if (u.factionId === factionId && u.strength > 0) {
      total += u.strength
    }
  }
  return total
}

/**
 * 计算某阵营"初始总 strength"近似（用 maxPersonnel 累加，编制满员≈初始）。
 *
 * 不依赖持久化的 initialStrength 字段（旧存档无此字段），用 maxPersonnel 作基线：
 * 编制满员时 personnel=maxPersonnel，对应 strength≈100。故初始总 strength ≈
 * 单位数 × 100（每个满编单位 strength 100）。但 maxPersonnel 是绝对数（如 8000），
 * 不直接等价于 strength。简化：用单位数 × 100（满编 strength 基线）。
 *
 * @param world 当前世界状态
 * @param factionId 阵营 id
 * @returns 该阵营"初始"总 strength 近似（单位数 × 100）
 */
export function computeFactionInitialStrength(world: WorldState, factionId: string): number {
  let count = 0
  for (const u of world.units) {
    if (u.factionId === factionId) count += 1
  }
  // 每个满编单位 strength 基线 100（与 types 约定 strength ∈ 0..100 一致）
  return count * 100
}

/**
 * 判断某阵营当前是否"正被攻击"（任一活单位被敌方活单位曼哈顿邻接）。
 *
 * 用于求援触发判定。邻接=4 邻接（上下左右）。
 *
 * @param world 当前世界状态
 * @param factionId 待判定阵营
 * @returns true=至少一个单位被敌方邻接（正被攻击/对峙）
 */
export function isFactionUnderAttack(world: WorldState, factionId: string): boolean {
  const ownUnits = world.units.filter((u) => u.factionId === factionId && u.strength > 0)
  const enemyUnits = world.units.filter((u) => u.factionId !== factionId && u.strength > 0)
  for (const own of ownUnits) {
    for (const enemy of enemyUnits) {
      const dist =
        Math.abs(own.coord.col - enemy.coord.col) +
        Math.abs(own.coord.row - enemy.coord.row)
      if (dist <= 1) return true
    }
  }
  return false
}

/** NPC 外交评估内部候选（带优先级 + 触发概率，最终按 rng 抽 1 个）。 */
interface NpcDiplomacyCandidate {
  kind: DiplomaticRequest['kind']
  fromFactionId: string
  toFactionId: string
  text: string
  /** 触发概率（0..1，叠加信任度/态势微调后的最终值） */
  probability: number
}

/**
 * 评估所有 NPC 阵营本回合是否发起主动外交请求（纯函数）。
 *
 * 流程：
 * 1. 遍历所有非玩家阵营（factionId !== playerFactionId 且 side !== 'player'）。
 * 2. 对每个 NPC 阵营，按态势判定可能的外交请求（ceasefire/reinforcement/threat），
 *    累加候选（含触发概率）。
 * 3. 用注入的 rng 按概率抽签：对每个候选，rng.nextFloat() < probability 则触发。
 * 4. 取首个触发的候选（确定性顺序：按 faction 在 world.factions 中的顺序 + 候选类型顺序）。
 * 5. 返回 DiplomaticRequest[]（0 或 1 个元素，符合"每回合最多 1 个 NPC 请求"约束）。
 *
 * 确定性：rng 由调用方注入（编排器用 DeterministicRandom.fromSequence(
 * scenarioSeed, turn, <npc-diplomacy-seq>)）。相同 (world, turn, rng) → 相同结果。
 *
 * @param world 当前世界状态（只读）
 * @param turn 当前回合索引
 * @param rng 注入的确定性随机
 * @param playerFactionId 玩家阵营 id（默认从 world.playerFactionId 取）
 * @returns DiplomaticRequest[]（0 或 1 个 NPC 主动外交请求）
 */
export function evaluateNpcDiplomacy(
  world: WorldState,
  turn: number,
  rng: DeterministicRandom,
  playerFactionId?: string,
): DiplomaticRequest[] {
  const playerId = playerFactionId && playerFactionId.length > 0
    ? playerFactionId
    : world.playerFactionId
  if (!playerId) return []

  const candidates: NpcDiplomacyCandidate[] = []

  for (const npc of world.factions) {
    // 仅非玩家阵营（factionId !== player 且 side !== 'player'）可主动发起
    if (npc.id === playerId) continue
    if (npc.side === 'player') continue

    const candidatesForNpc = evaluateSingleNpc(world, npc, playerId, turn)
    candidates.push(...candidatesForNpc)
  }

  if (candidates.length === 0) return []

  // 按确定性顺序逐个抽签，取首个触发的（保证每回合最多 1 个请求）。
  // 顺序：candidates 数组顺序（先按 faction 在 world.factions 中的顺序，再按候选类型顺序）。
  for (const cand of candidates) {
    if (rng.nextFloat() < cand.probability) {
      return [{
        turn,
        fromFactionId: cand.fromFactionId,
        toFactionId: cand.toFactionId,
        kind: cand.kind,
        text: cand.text,
      }]
    }
  }

  return []
}

/**
 * 评估单个 NPC 阵营可能发起的外交请求候选（纯函数，内部辅助）。
 *
 * 按任务约束的三类请求判定：
 * - ceasefire（求和）：trust[玩家] > 40 且 strength < initial ×0.5。
 * - reinforcement（求援）：trust[某盟友] > 60 且正被攻击。
 * - threat（威胁）：strength > initial ×1.5。
 *
 * 概率叠加：基础 0.35 + 信任度/态势微调（求和 +trust/200，威胁 +优势比例/4）。
 *
 * @returns 该 NPC 的候选列表（可能为空，可能多个）
 */
function evaluateSingleNpc(
  world: WorldState,
  npc: Faction,
  playerId: string,
  turn: number,
): NpcDiplomacyCandidate[] {
  const candidates: NpcDiplomacyCandidate[] = []
  const currentStrength = computeFactionStrength(world, npc.id)
  const initialStrength = computeFactionInitialStrength(world, npc.id)
  // 避免除零：无单位的 NPC 不发起外交
  if (initialStrength <= 0) return candidates
  const strengthRatio = currentStrength / initialStrength

  const npcName = npc.name.length > 0 ? npc.name : npc.id

  // 1. 求和（ceasefire）：信任度 > 40 且兵力劣势（< 0.5 × initial）
  const trustToPlayer = npc.trust[playerId] ?? 50
  if (
    trustToPlayer > NPC_CEASEFIRE_TRUST_THRESHOLD &&
    strengthRatio < NPC_CEASEFIRE_STRENGTH_RATIO
  ) {
    const probability =
      NPC_DIPLOMACY_BASE_PROBABILITY + trustToPlayer / 200 // 信任越高越愿求和（0.35 + 0.2~0.5）
    candidates.push({
      kind: 'ceasefire',
      fromFactionId: npc.id,
      toFactionId: playerId,
      text: `${npcName} 使节前来请求停火：我军损失惨重，愿与贵方谈判休战，以保全军民。`,
      probability: Math.min(0.9, probability),
    })
  }

  // 2. 求援（reinforcement）：对玩家信任度 > 60 且正被攻击 → 向玩家求援
  // （NPC 主动外交的接收方恒为玩家，便于 NpcDiplomacyModal 统一弹窗处理。
  //  对"盟友"的信任度用作触发条件——与玩家关系友好的 NPC 才会向玩家求援。）
  const underAttack = isFactionUnderAttack(world, npc.id)
  if (underAttack && trustToPlayer > NPC_REINFORCEMENT_TRUST_THRESHOLD) {
    const probability =
      NPC_DIPLOMACY_BASE_PROBABILITY +
      (trustToPlayer - NPC_REINFORCEMENT_TRUST_THRESHOLD) / 100
    candidates.push({
      kind: 'reinforcement',
      fromFactionId: npc.id,
      toFactionId: playerId,
      text: `${npcName} 紧急向贵方求援：我军正遭敌军猛攻，恳请盟友火速派遣增援！`,
      probability: Math.min(0.9, probability),
    })
  }

  // 3. 威胁（threat）：兵力优势（> 1.5 × initial）→ 威胁玩家投降
  if (strengthRatio > NPC_THREAT_STRENGTH_RATIO) {
    const probability =
      NPC_DIPLOMACY_BASE_PROBABILITY + (strengthRatio - NPC_THREAT_STRENGTH_RATIO) / 4
    candidates.push({
      kind: 'threat',
      fromFactionId: npc.id,
      toFactionId: playerId,
      text: `${npcName} 统帅发来最后通牒：我军兵力占绝对优势，识时务者为俊杰——立即投降，可保军民性命！`,
      probability: Math.min(0.9, probability),
    })
  }

  void turn
  return candidates
}
