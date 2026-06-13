/**
 * 导演部兜底桩（director/rule-engine-fallback.ts）。
 *
 * 对应重写计划关键防坑「解析失败伪造 unit-1/C3」：
 * ajv schema 校验失败/降级 → 抛错转规则引擎兜底（纯数值结算 + 模板战报），
 * event-log 标 source:'rule-engine'，**绝不编造不存在的 unit/坐标**。
 *
 * 离线可玩降级（修订点 E）：无 LLM 时规则引擎推进游戏，仅失去叙事润色。
 *
 * 里程碑：M3（规则引擎兜底）。
 *
 * @module layers/agents/director
 */

/**
 * 规则引擎兜底桩。
 * TODO(M3): 由后续子代理实现纯数值结算 + 模板战报降级。
 */
export function ruleEngineFallback(): void {
  // TODO(M3): 纯数值兜底，绝不伪造数据
}
