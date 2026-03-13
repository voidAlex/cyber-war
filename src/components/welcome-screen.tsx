import { useState, useEffect } from 'react';
import { listSaves } from '@/storage/opfs';
import { hasEncryptedRuntimeConfig, unlockRuntimeConfig, configureRuntimeConfig, clearRuntimeConfigSession } from '@/utils';

interface WelcomeScreenProps {
  onStartNewGame: () => void;
  onLoadGame: (saveId: string) => void;
}

interface SaveInfo {
  id: string;
  name: string;
  turn: number;
  updatedAt: string;
}

export function WelcomeScreen({ onStartNewGame, onLoadGame }: WelcomeScreenProps) {
  const [saves, setSaves] = useState<SaveInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showConfig, setShowConfig] = useState(false);
  const [showUnlock, setShowUnlock] = useState(false);
  const [hasConfig, setHasConfig] = useState(false);
  const [isUnlocked, setIsUnlocked] = useState(false);

  // LLM 配置表单
  const [provider, setProvider] = useState<'openai' | 'anthropic' | 'deepseek' | 'custom'>('openai');
  const [endpoint, setEndpoint] = useState('https://api.openai.com/v1/chat/completions');
  const [apiKey, setApiKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [configStatus, setConfigStatus] = useState('');

  useEffect(() => {
    loadSaves();
    setHasConfig(hasEncryptedRuntimeConfig());
    checkUnlocked();
  }, []);

  const loadSaves = async () => {
    try {
      const saveIds = await listSaves();
      // 简化的存档信息加载
      const savesInfo: SaveInfo[] = saveIds.map(id => ({
        id,
        name: `存档 ${id.substring(0, 8)}...`,
        turn: 1,
        updatedAt: new Date().toLocaleDateString()
      }));
      setSaves(savesInfo);
    } catch {
      setSaves([]);
    } finally {
      setIsLoading(false);
    }
  };

  const checkUnlocked = () => {
    // 尝试从 session 读取来判断是否已解锁
    const unlocked = !!localStorage.getItem('__runtime_config_session__');
    setIsUnlocked(unlocked);
  };

  const handleConfigure = async () => {
    if (!apiKey.trim() || !passphrase.trim()) {
      setConfigStatus('请填写 API Key 和口令');
      return;
    }

    try {
      await configureRuntimeConfig({
        provider,
        endpoint,
        apiKey,
        passphrase,
      });
      setConfigStatus('配置已保存并解锁');
      setHasConfig(true);
      setIsUnlocked(true);
      setShowConfig(false);
      setApiKey('');
    } catch (error) {
      setConfigStatus(error instanceof Error ? error.message : '配置失败');
    }
  };

  const handleUnlock = async () => {
    if (!passphrase.trim()) {
      setConfigStatus('请输入口令');
      return;
    }

    try {
      const config = await unlockRuntimeConfig(passphrase);
      if (config) {
        setConfigStatus('已解锁');
        setIsUnlocked(true);
        setShowUnlock(false);
      } else {
        setConfigStatus('口令错误或配置不存在');
      }
    } catch (error) {
      setConfigStatus(error instanceof Error ? error.message : '解锁失败');
    }
  };

  const handleLock = () => {
    clearRuntimeConfigSession();
    setIsUnlocked(false);
    setConfigStatus('已锁定');
  };

  const getEndpointPlaceholder = () => {
    switch (provider) {
      case 'openai': return 'https://api.openai.com/v1/chat/completions';
      case 'anthropic': return 'https://api.anthropic.com/v1/messages';
      case 'deepseek': return 'https://api.deepseek.com/v1/chat/completions';
      default: return 'https://...';
    }
  };

  return (
    <div className="welcome-screen" style={{
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'linear-gradient(135deg, #1a1f2a 0%, #2d3748 100%)',
      color: '#e5e7eb',
      padding: '20px'
    }}>
      <div style={{
        maxWidth: '800px',
        width: '100%',
        textAlign: 'center'
      }}>
        <h1 style={{
          fontSize: '3rem',
          marginBottom: '10px',
          background: 'linear-gradient(90deg, #4a90e2, #9c27b0)',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent'
        }}>
          赛博战争模拟器
        </h1>
        <p style={{
          fontSize: '1.2rem',
          color: '#9ca3af',
          marginBottom: '40px'
        }}>
          Cyber War Simulator - 由大语言模型驱动的硬核大战略游戏
        </p>

        {/* LLM 配置区域 */}
        <div style={{
          background: 'rgba(255,255,255,0.05)',
          borderRadius: '12px',
          padding: '24px',
          marginBottom: '32px',
          border: '1px solid rgba(255,255,255,0.1)'
        }}>
          <h2 style={{ marginBottom: '16px', fontSize: '1.3rem' }}>
            🔐 LLM 配置
          </h2>

          {isUnlocked ? (
            <div>
              <p style={{ color: '#10b981', marginBottom: '16px' }}>
                ✅ 已解锁 - 可以使用 AI 功能
              </p>
              <button onClick={handleLock} className="btn btn-secondary">
                锁定配置
              </button>
            </div>
          ) : hasConfig ? (
            <div>
              <p style={{ color: '#f59e0b', marginBottom: '16px' }}>
                🔒 检测到已保存的配置，需要解锁
              </p>
              {!showUnlock ? (
                <button onClick={() => setShowUnlock(true)} className="btn btn-primary">
                  解锁配置
                </button>
              ) : (
                <div style={{ display: 'flex', gap: '8px', justifyContent: 'center' }}>
                  <input
                    type="password"
                    value={passphrase}
                    onChange={(e) => setPassphrase(e.target.value)}
                    placeholder="输入解锁口令"
                    style={{
                      padding: '8px 12px',
                      borderRadius: '6px',
                      border: '1px solid #4b5563',
                      background: '#1f2937',
                      color: '#fff'
                    }}
                  />
                  <button onClick={handleUnlock} className="btn btn-primary">
                    确认解锁
                  </button>
                  <button onClick={() => setShowUnlock(false)} className="btn btn-secondary">
                    取消
                  </button>
                </div>
              )}
              {configStatus && <p style={{ marginTop: '8px', fontSize: '0.9rem', color: '#ef4444' }}>{configStatus}</p>}
            </div>
          ) : (
            <div>
              <p style={{ color: '#9ca3af', marginBottom: '16px' }}>
                首次使用需要配置 LLM API
              </p>
              {!showConfig ? (
                <button onClick={() => setShowConfig(true)} className="btn btn-primary">
                  配置 LLM
                </button>
              ) : (
                <div style={{ textAlign: 'left', maxWidth: '400px', margin: '0 auto' }}>
                  <label style={{ display: 'block', marginBottom: '12px' }}>
                    供应商
                    <select
                      value={provider}
                      onChange={(e) => {
                        setProvider(e.target.value as typeof provider);
                        setEndpoint(getEndpointPlaceholder());
                      }}
                      style={{
                        width: '100%',
                        padding: '8px',
                        marginTop: '4px',
                        borderRadius: '6px',
                        border: '1px solid #4b5563',
                        background: '#1f2937',
                        color: '#fff'
                      }}
                    >
                      <option value="openai">OpenAI</option>
                      <option value="anthropic">Anthropic (Claude)</option>
                      <option value="deepseek">DeepSeek</option>
                      <option value="custom">自定义</option>
                    </select>
                  </label>

                  <label style={{ display: 'block', marginBottom: '12px' }}>
                    API 端点
                    <input
                      type="text"
                      value={endpoint}
                      onChange={(e) => setEndpoint(e.target.value)}
                      placeholder={getEndpointPlaceholder()}
                      style={{
                        width: '100%',
                        padding: '8px',
                        marginTop: '4px',
                        borderRadius: '6px',
                        border: '1px solid #4b5563',
                        background: '#1f2937',
                        color: '#fff'
                      }}
                    />
                  </label>

                  <label style={{ display: 'block', marginBottom: '12px' }}>
                    API Key
                    <input
                      type="password"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder="sk-..."
                      style={{
                        width: '100%',
                        padding: '8px',
                        marginTop: '4px',
                        borderRadius: '6px',
                        border: '1px solid #4b5563',
                        background: '#1f2937',
                        color: '#fff'
                      }}
                    />
                  </label>

                  <label style={{ display: 'block', marginBottom: '16px' }}>
                    解锁口令（用于本地加密）
                    <input
                      type="password"
                      value={passphrase}
                      onChange={(e) => setPassphrase(e.target.value)}
                      placeholder="设置一个口令"
                      style={{
                        width: '100%',
                        padding: '8px',
                        marginTop: '4px',
                        borderRadius: '6px',
                        border: '1px solid #4b5563',
                        background: '#1f2937',
                        color: '#fff'
                      }}
                    />
                  </label>

                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button onClick={handleConfigure} className="btn btn-primary" style={{ flex: 1 }}>
                      保存并解锁
                    </button>
                    <button onClick={() => setShowConfig(false)} className="btn btn-secondary">
                      取消
                    </button>
                  </div>

                  {configStatus && <p style={{ marginTop: '8px', fontSize: '0.9rem', color: '#ef4444' }}>{configStatus}</p>}
                </div>
              )}
            </div>
          )}
        </div>

        {/* 游戏选择区域 */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: '20px'
        }}>
          {/* 开始新游戏 */}
          <button
            onClick={onStartNewGame}
            style={{
              padding: '32px 24px',
              borderRadius: '12px',
              border: '2px solid #4a90e2',
              background: 'rgba(74, 144, 226, 0.1)',
              color: '#4a90e2',
              fontSize: '1.3rem',
              fontWeight: 'bold',
              cursor: 'pointer',
              transition: 'all 0.2s'
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(74, 144, 226, 0.2)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'rgba(74, 144, 226, 0.1)';
            }}
          >
            🎮 开始新游戏
          </button>

          {/* 加载存档 */}
          <div style={{
            padding: '24px',
            borderRadius: '12px',
            border: '2px solid #6b7280',
            background: 'rgba(255,255,255,0.03)',
          }}>
            <h3 style={{ marginBottom: '12px', color: '#9ca3af' }}>
              💾 加载存档
            </h3>
            {isLoading ? (
              <p>加载中...</p>
            ) : saves.length === 0 ? (
              <p style={{ color: '#6b7280', fontSize: '0.9rem' }}>
                暂无存档
              </p>
            ) : (
              <div style={{ maxHeight: '150px', overflowY: 'auto' }}>
                {saves.map((save) => (
                  <button
                    key={save.id}
                    onClick={() => onLoadGame(save.id)}
                    style={{
                      width: '100%',
                      padding: '8px 12px',
                      marginBottom: '8px',
                      textAlign: 'left',
                      borderRadius: '6px',
                      border: '1px solid #4b5563',
                      background: '#1f2937',
                      color: '#e5e7eb',
                      cursor: 'pointer',
                      fontSize: '0.9rem'
                    }}
                  >
                    {save.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <p style={{
          marginTop: '32px',
          fontSize: '0.85rem',
          color: '#6b7280'
        }}>
          提示：游戏数据保存在浏览器本地存储中，清除浏览器数据会导致存档丢失
        </p>
      </div>
    </div>
  );
}
