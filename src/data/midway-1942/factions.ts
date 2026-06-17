/**
 * 中途岛海战 1942 — factions.json 数据。
 *
 * 史实（查证自维基/百科）：
 * - 美国（守）：蓝（#1E3A8A）。3 艘航母（企业/约克城/大黄蜂）+ 巡洋舰/驱逐舰 + 中途岛岸基航空。
 *   凭情报优势（破译 JN-25）设伏，以少胜多。
 * - 日本（攻）：红（#DC2626）。4 艘主力航母（赤城/加贺/苍龙/飞龙）+ 战列舰/巡洋舰/驱逐舰庞大舰队。
 *   兵力占优但情报泄露、南云换弹失误致四航母一日沉没。
 * - 双方敌对（太平洋战争，互为唯一交战方）。
 *
 * @module data/midway-1942/factions
 */

import type { CampaignFaction } from '@/types'

/** 中途岛海战阵营列表 */
export const midwayFactions: CampaignFaction[] = [
  {
    id: 'usa',
    name: '美国太平洋舰队 (US Pacific Fleet)',
    color: '#1E3A8A', // 美军海军蓝
    side: 'player',
    commanderId: 'nimitz',
    // 注：战区司令角色由 rules.aiRoles 定义（斯普鲁恩斯 ai-spruance-commander）。
    supply: {
      // 美军开局物资中等（中途岛前沿基地 + 海上补给）
      supplies: 65,
      ammunition: 70,
      // 舰队油料储备尚可
      fuel: 60,
    },
    // 美国对外信任度：仅对日本敌对（5）
    trust: { japan: 5 },
    // 第 5 批：美-日定性关系——交战状态（太平洋战争）
    relations: { japan: 'at_war' },
    doctrineTags: ['情报至上', '航母决战', '俯冲轰炸', '设伏反击', '以少胜多'],
    description:
      '美国太平洋舰队在尼米兹指挥下，凭破译 JN-25 密码掌握日军作战计划，设伏中途岛。' +
      '斯普鲁恩斯指挥第 16/17 特混舰队（企业/大黄蜂/约克城），趁南云换弹危机发动 SBD 俯冲轰炸机突袭，' +
      '一日内击沉日军四艘主力航母。情报优势 + 果断出击成就太平洋战争转折点。',
  },
  {
    id: 'japan',
    name: '日本联合舰队 (IJN Combined Fleet)',
    color: '#DC2626', // 日军红（旭日）
    side: 'enemy',
    commanderId: 'yamamoto',
    // 注：战区司令角色由 rules.aiRoles 定义（南云 ai-nagumo-commander）。
    supply: {
      // 日军开局物资充足（庞大舰队 + 兵力优势）
      supplies: 80,
      ammunition: 85,
      // 舰队远离本土作战，油料补给有限
      fuel: 55,
    },
    trust: { usa: 5 },
    // 第 5 批：日-美定性关系——交战状态
    relations: { usa: 'at_war' },
    doctrineTags: ['航母机动', '决战至上', '兵力碾压', '赌徒直觉', '大胆进攻'],
    description:
      '日本联合舰队在山本五十六策划下，企图攻占中途岛引诱美军航母残部决战。' +
      '南云忠一指挥第一航空舰队（赤城/加贺/苍龙/飞龙）为核心机动部队，兵力占优。' +
      '然 JN-25 密码被破译、南云换弹危机（甲板堆满弹药）致 SBD 突袭殉爆，四航母一日沉没，' +
      '太平洋战争攻守易势。',
  },
]
