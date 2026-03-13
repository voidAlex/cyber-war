import { useEffect, useState } from 'react';
import { listSaves } from '@/storage/opfs';
import { useGameStateContext } from './use-game-state-context';

/**
 * 状态恢复 Hook
 * 在刷新页面后自动从 OPFS 恢复最近的游戏状态
 */
export function useGameRecovery() {
  const { loadSavedGame, gameState } = useGameStateContext();
  const [isRecovering, setIsRecovering] = useState(true);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [hasAttemptedRecovery, setHasAttemptedRecovery] = useState(false);

  useEffect(() => {
    async function recover() {
      // 避免重复尝试恢复
      if (hasAttemptedRecovery) return;
      setHasAttemptedRecovery(true);
      
      try {
        const saves = await listSaves();
        
        if (saves.length > 0) {
          // 按时间戳排序（saveId 格式为 save_{timestamp}_{random}）
          saves.sort((a, b) => {
            const timeA = parseInt(a.split('_')[1] || '0', 10);
            const timeB = parseInt(b.split('_')[1] || '0', 10);
            return timeB - timeA; // 降序，最新的在前
          });
          const latestSave = saves[0];
          
          await loadSavedGame(latestSave);
        }
      } catch (err) {
        setRecoveryError(err instanceof Error ? err.message : String(err));
      } finally {
        setIsRecovering(false);
      }
    }
    
    recover();
  }, [loadSavedGame, hasAttemptedRecovery]);

  return { isRecovering, recoveryError, hasSave: !!gameState };
}
