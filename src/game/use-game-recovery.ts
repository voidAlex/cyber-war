import { useEffect, useState } from 'react';
import { listSaves } from '@/storage/opfs';
import { useGameStateContext } from './use-game-state-context';

/**
 * 状态恢复 Hook
 * 在刷新页面后自动从 OPFS 恢复最近的游戏状态
 */
export function useGameRecovery() {
  const { loadSavedGame } = useGameStateContext();
  const [isRecovering, setIsRecovering] = useState(true);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);

  useEffect(() => {
    async function recover() {
      try {
        const saves = await listSaves();
        
        if (saves.length > 0) {
          // Simplistic sorting assuming save format includes timestamp
          saves.sort().reverse();
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
  }, [loadSavedGame]);

  return { isRecovering, recoveryError };
}
