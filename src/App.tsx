import { useCallback, useState } from 'react';
import { GameStateDisplay } from '@/components/game-state-display';
import { TurnControlPanel } from '@/components/turn-control-panel';
import { GameBoard, CommandTerminal, EventLogPanel } from '@/components';
import { useGameRecovery } from '@/game/use-game-recovery';
import { useGameStateContext } from '@/game';
import { parseNaturalLanguageCommand } from '@agents/command-parser';

interface RuntimeLLMConfig {
  provider: 'openai' | 'anthropic' | 'deepseek' | 'custom'
  endpoint: string
  apiKey: string
}

const LLM_RUNTIME_CONFIG_KEY = 'cyberwar.llm.runtime-config'

function readRuntimeLLMConfig(): RuntimeLLMConfig | null {
  const raw = window.localStorage.getItem(LLM_RUNTIME_CONFIG_KEY)
  if (!raw) {
    return null
  }

  try {
    const parsed = JSON.parse(raw) as RuntimeLLMConfig
    if (!parsed.provider || !parsed.endpoint || !parsed.apiKey) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

const FALLBACK_COMMAND_CONFIG: RuntimeLLMConfig = {
  provider: 'custom',
  endpoint: 'https://example.com/command-parser',
  apiKey: 'dev-placeholder-key',
}

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

    const config = readRuntimeLLMConfig();
    const runtimeConfig = config ?? FALLBACK_COMMAND_CONFIG

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
        <span className="version">M1 - 项目底座</span>
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
            <h3>M2 里程碑进度</h3>
            <ul>
              <li>✅ 命令握手（LLM解析）</li>
              <li>✅ 网格沙盘基础渲染</li>
              <li>✅ 路径预演虚线</li>
              <li>✅ 事件日志台</li>
              <li>✅ Worker 扩展规则</li>
            </ul>
          </div>
        </section>
        
        <aside className="right-panel">
          <CommandTerminal onParseCommand={handleParseCommand} isParsing={isParsing} />
        </aside>
      </main>

      <section className="app-log-area">
        <EventLogPanel />
      </section>
      
      {/* 页脚 */}
      <footer className="app-footer">
        <p>MVP 开发阶段 - 状态机 + OPFS 底座</p>
      </footer>
    </div>
  );
}
