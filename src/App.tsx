import { GameStateDisplay } from '@/components/game-state-display';
import { TurnControlPanel } from '@/components/turn-control-panel';
import { useGameRecovery } from '@/game/use-game-recovery';

/**
 * 主应用组件
 */
export default function App() {
  const { isRecovering, recoveryError } = useGameRecovery();

  if (isRecovering) {
    return (
      <div className="app loading">
        <div className="spinner">⏳</div>
        <p>正在恢复游戏状态...</p>
        {recoveryError && <p className="error-text">恢复失败: {recoveryError}</p>}
      </div>
    );
  }

  return (
    <div className="app">
      {/* 标题栏 */}
      <header className="app-header">
        <h1>赛博战争模拟器</h1>
        <p>Cyber War Simulator</p>
        <span className="version">M1 - 项目底座</span>
      </header>
      
      {/* 主内容区 */}
      <main className="app-main">
        {/* 左侧：游戏状态显示 */}
        <aside className="left-panel">
          <GameStateDisplay />
        </aside>
        
        {/* 中央：回合控制面板 */}
        <section className="center-panel">
          <TurnControlPanel />
          
          {/* 开发说明 */}
          <div className="dev-notes">
            <h3>M1 里程碑进度</h3>
            <ul>
              <li>✅ 核心类型系统</li>
              <li>✅ OPFS 存储层</li>
              <li>✅ WEGO 状态机</li>
              <li>✅ 错误处理基线</li>
              <li>✅ 基础 UI 组件</li>
              <li>✅ 单元测试</li>
              <li>✅ 验收测试</li>
            </ul>
          </div>
        </section>
        
        {/* 右侧：开发工具 */}
        <aside className="right-panel">
          <div className="dev-tools">
            <h3>开发工具</h3>
            <div className="tool-item">
              <span>📋</span>
              <span>状态检查</span>
            </div>
            <div className="tool-item">
              <span>💾</span>
              <span>存储管理</span>
            </div>
            <div className="tool-item">
              <span>📊</span>
              <span>日志查看</span>
            </div>
          </div>
        </aside>
      </main>
      
      {/* 页脚 */}
      <footer className="app-footer">
        <p>MVP 开发阶段 - 状态机 + OPFS 底座</p>
      </footer>
    </div>
  );
}
