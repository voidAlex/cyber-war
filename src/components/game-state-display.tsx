import { useGameState } from '@/game';
import { getPhaseDisplayName, getPhaseDescription } from '@/game';
import type { GamePhase } from '@/types';

/**
 * 阶段颜色配置
 */
const PHASE_COLORS: Record<GamePhase, string> = {
  idle: '#6b7282',
  planning: '#4a90e2',
  handshake: '#f5a623',
  locked: '#e74c3c', // fixed typo e74c3c4
  resolution: '#9c27b0',
  briefing: '#2e7d32',
  persist: '#795548',
};

/**
 * 阶段图标配置
 */
const PHASE_ICONS: Record<GamePhase, string> = {
  idle: '⏸',
  planning: '📝',
  handshake: '🤝',
  locked: '🔒',
  resolution: '⚔️',
  briefing: '📋',
  persist: '💾',
};

interface GameStateDisplayProps {
  className?: string;
}

/**
 * 游戏状态显示组件
 */
export function GameStateDisplay({ className }: GameStateDisplayProps) {
  const { gameState, context, isLoading, error } = useGameState();

  if (isLoading) {
    return (
      <div className={`game-state-display loading ${className ?? ''}`}>
        <div className="spinner">⏳</div>
        <span>加载中...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className={`game-state-display error ${className ?? ''}`}>
        <span className="error-icon">❌</span>
        <span className="error-message">{error}</span>
      </div>
    );
  }

  if (!gameState) {
    return (
      <div className={`game-state-display no-game ${className ?? ''}`}>
        <span>尚未开始游戏</span>
        <button onClick={() => {}}>开始新游戏</button>
      </div>
    );
  }

  const phaseColor = PHASE_COLORS[gameState.phase] || '#666';
  const phaseIcon = PHASE_ICONS[gameState.phase] || '❓';
  const phaseName = getPhaseDisplayName(gameState.phase);
  const phaseDescription = getPhaseDescription(gameState.phase);

  return (
    <div className={`game-state-display ${className ?? ''}`}>
      {/* 回合信息 */}
      <div className="turn-info">
        <span className="turn-label">回合</span>
        <span className="turn-number">{gameState.turn}</span>
      </div>
      
      {/* 阶段信息 */}
      <div className="phase-info" style={{ borderColor: phaseColor }}>
        <span className="phase-icon">{phaseIcon}</span>
        <div className="phase-details">
          <span className="phase-name">{phaseName}</span>
          <span className="phase-description">{phaseDescription}</span>
        </div>
      </div>
      
      {/* 状态摘要 */}
      <div className="state-summary">
        <div className="summary-item">
          <span className="summary-label">存档 ID</span>
          <span className="summary-value">{gameState.saveId.substring(0, 12)}...</span>
        </div>
        <div className="summary-item">
          <span className="summary-label">场景种子</span>
          <span className="summary-value">{gameState.scenarioSeed.substring(0, 8)}...</span>
        </div>
        <div className="summary-item">
          <span className="summary-label">版本</span>
          <span className="summary-value">{gameState.version}</span>
        </div>
      </div>
      
      {/* 待处理命令 */}
      {context.pendingOrders.length > 0 && (
        <div className="pending-orders">
          <span className="orders-label">
            待确认命令 ({context.pendingOrders.length})
          </span>
        </div>
      )}
      
      {/* 已确认命令 */}
      {context.confirmedOrders.length > 0 && (
        <div className="confirmed-orders">
          <span className="orders-label">
            已锁定命令 ({context.confirmedOrders.length})
          </span>
        </div>
      )}
    </div>
  );
}
