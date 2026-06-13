/**
 * Agent 协议层 barrel — 纯函数边界。
 *
 * protocol（context-builder 等）是纯函数，不调 Tauri/fetch/crypto，
 * 不调 Date.now()/随机数。
 *
 * @module layers/agents/protocol
 */

export { buildContext } from './context-builder'
