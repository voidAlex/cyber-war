import { useCallback, useState } from 'react';
import { GameStateDisplay } from '@/components/game-state-display';
import { TurnControlPanel } from '@/components/turn-control-panel';
import { GameBoard, CommandTerminal, EventLogPanel, AgentInspector, RuntimeConfigUnlockPanel } from '@/components';
import { useGameRecovery } from '@/game/use-game-recovery';
import { useGameStateContext } from '@/game';
import { parseNaturalLanguageCommand } from '@agents/command-parser';
import { readRuntimeConfigFromSession } from '@/utils';

/**
 * 主应用组件
 */
export default function App() {
  const { isRecovering, recoveryError } = useGameRecovery();
  const { gameState, submitOrder } = useGameStateContext();
  const [isParsing, setIsParsing] = useState(false);

  const handleParseCommand = useCallback(async (command: string) => {
    if (!gameState) {
      return;
    }

    const runtimeConfig = readRuntimeConfigFromSession();
    if (!runtimeConfig) {
      return;
    }

    setIsParsing(true);
    try {
      const action = await parseNaturalLanguageCommand({
        command,
        turn: gameState.turn,
        faction: 'player',
        provider: runtimeConfig.provider,
        endpoint: runtimeConfig.endpoint,
        apiKey: runtimeConfig.apiKey,
      });
      submitOrder(action);
    } finally {
      setIsParsing(false);
    }
  }, [gameState, submitOrder]);

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
        <span className="version">M4 - 情报/外交/ZIP/加密/Inspector</span>
      </header>
      
      {/* 主内容区 */}
      <main className="app-main">
        {/* 左侧：游戏状态显示 */}
        <aside className="left-panel">
          <GameStateDisplay />
          <TurnControlPanel />
        </aside>
        
        <section className="center-panel">
          <GameBoard />
          
          {/* 开发说明 */}
          <div className="dev-notes">
            <h3>M4 里程碑进度</h3>
            <ul>
              <li>✅ 情报半衰期 + 残影时间戳显示</li>
              <li>✅ 外交请求不确定履约（盟友信任度驱动）</li>
              <li>✅ ZIP 战役包导入导出与安全解包</li>
              <li>✅ API Key 本地加密（PBKDF2 + AES-GCM）</li>
              <li>✅ Agent Inspector（开发模式）</li>
            </ul>
          </div>
        </section>
        
        <aside className="right-panel">
          <CommandTerminal onParseCommand={handleParseCommand} isParsing={isParsing} />
          <RuntimeConfigUnlockPanel />
          {import.meta.env.DEV && <AgentInspector />}
        </aside>
      </main>

      <section className="app-log-area">
        <EventLogPanel />
      </section>
      
      {/* 页脚 */}
      <footer className="app-footer">
        <p>MVP 开发阶段 - M4 验收项开发完成</p>
      </footer>
    </div>
  );
}
