import { useCallback, useState } from 'react';
import { GameStateDisplay } from '@/components/game-state-display';
import { TurnControlPanel } from '@/components/turn-control-panel';
import { WelcomeScreen } from '@/components/welcome-screen';
import { GameBoard, CommandTerminal, EventLogPanel } from '@/components';
import { useGameRecovery } from '@/game/use-game-recovery';
import { useGameStateContext } from '@/game';
import { parseNaturalLanguageCommand } from '@agents/command-parser';
import { readRuntimeConfigFromSession } from '@/utils';
import { getLogger } from '@/utils';

const logger = getLogger({ context: 'App' });

/**
 * 主应用组件
 */
export default function App() {
  const { isRecovering, recoveryError } = useGameRecovery({ autoLoadLatest: false });
  const { gameState, submitOrder, createGame, loadSavedGame } = useGameStateContext();
  const [isParsing, setIsParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [hasEnteredGame, setHasEnteredGame] = useState(false);

  const handleParseCommand = useCallback(async (command: string) => {
    setParseError(null);
    
    if (!gameState) {
      const errorMsg = '请先创建或加载游戏';
      setParseError(errorMsg);
      logger.error('CommandParseError: ' + errorMsg, { command });
      return;
    }

    const runtimeConfig = readRuntimeConfigFromSession();
    if (!runtimeConfig) {
      const errorMsg = '请先在欢迎页面配置并解锁 LLM 运行时';
      setParseError(errorMsg);
      logger.error('CommandParseError: ' + errorMsg, { command });
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
        model: runtimeConfig.model,
      });
      submitOrder(action);
      setParseError(null);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : '命令解析失败';
      setParseError(errorMsg);
      logger.error('CommandParseError: ' + errorMsg, { command, error: err });
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

  if (!hasEnteredGame) {
    return (
      <WelcomeScreen
        onStartNewGame={(payload, playerFactionId) => {
          setHasEnteredGame(true);
          createGame(payload.manifest.name, {
            worldState: {
              turnIndex: 0,
              map: payload.map,
              factions: payload.factions,
              units: payload.units,
            },
          }).then(() => {
            if (playerFactionId !== 'player') {
              logger.info('玩家选择的阵营非默认 player', { playerFactionId })
            }
          })
        }}
        onLoadGame={(saveId) => {
          setHasEnteredGame(true);
          loadSavedGame(saveId);
        }}
      />
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
        </section>
        
        <aside className="right-panel">
          {parseError && (
            <div className="error-banner" style={{ 
              background: '#fee2e2', 
              color: '#dc2626', 
              padding: '10px', 
              marginBottom: '10px',
              borderRadius: '4px',
              fontSize: '14px'
            }}>
              ⚠️ {parseError}
            </div>
          )}
          <CommandTerminal onParseCommand={handleParseCommand} isParsing={isParsing} />
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
