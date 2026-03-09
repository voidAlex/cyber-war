import { useGameStateContext } from '@/game';

interface TurnControlPanelProps {
  className?: string;
}

/**
 * 回合控制面板组件
 */
export function TurnControlPanel({ className }: TurnControlPanelProps) {
  const {
    gameState,
    context,
    startPlanning,
    confirmHandshake,
    lockOrders,
    startResolution,
    dismissBriefing,
    nextTurn,
    createGame,
  } = useGameStateContext();

  const handleCreateGame = () => {
    createGame('新游戏');
  };

  /**
   * 根据当前阶段渲染控制按钮
   */
  const renderControls = () => {
    const phase = gameState?.phase ?? 'idle';
    switch (phase) {
      case 'idle':
        return (
          <>
            <button onClick={handleCreateGame} className="btn btn-primary">
              🎮 开始新游戏
            </button>
            <button onClick={startPlanning} className="btn btn-secondary">
              📝 开始规划
            </button>
          </>
        );
      case 'planning':
        return (
          <>
            <button onClick={startPlanning} className="btn btn-primary">
              📝 完成规划
            </button>
            <span className="hint">添加命令后点击"完成规划"进入确认阶段</span>
          </>
        );
      case 'handshake':
        return (
          <>
            <button onClick={confirmHandshake} className="btn btn-primary">
              ✅ 确认命令
            </button>
            <button onClick={lockOrders} className="btn btn-secondary">
              🔒 锁定命令
            </button>
          </>
        );
      case 'locked':
        return (
          <>
            <button onClick={startResolution} className="btn btn-primary">
              ⚔️ 开始结算
            </button>
            <span className="hint">双方计划已锁定，准备结算</span>
          </>
        );
      case 'resolution': {
        const completedAgentCount = Object.values(context.agentProgressById).filter(
          status => status === 'completed'
        ).length
        const totalAgentCount = Object.keys(context.agentProgressById).length
        return (
          <div className="resolution-status">
            <span className="spinner">⏳</span>
            <span>结算进行中...</span>
            <span className="hint">Agent 完成度：{completedAgentCount}/{totalAgentCount}</span>
          </div>
        );
      }
      case 'briefing':
        return (
          <>
            <button onClick={dismissBriefing} className="btn btn-primary">
              📋 查看战报完成
            </button>
          </>
        );
      case 'persist':
        return (
          <>
            <button onClick={nextTurn} className="btn btn-primary">
              ▶️ 进入下一回合
            </button>
          </>
        );
      default:
        return <span className="unknown-phase">未知阶段: {phase}</span>;
    }
  };

  return (
    <div className={`turn-control-panel ${className ?? ''}`}>
      <div className="panel-header">
        <h3>回合控制</h3>
      </div>
      <div className="panel-content">
        {renderControls()}
      </div>
    </div>
  );
}
