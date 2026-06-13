import { useState, useEffect } from 'react';
import { listSaves, deleteSave } from '@/storage/opfs';
import { loadCampaignZip, importSaveZip, buildCampaignZip } from '@/storage/zip-campaign';
import type { CampaignPayload } from '@/storage/zip-campaign';
import { SAMPLE_CAMPAIGN } from '@/data/sample-campaign';
import {
  hasEncryptedRuntimeConfig,
  unlockRuntimeConfig,
  configureRuntimeConfig,
  clearRuntimeConfigSession,
  readRuntimeConfigFromSession,
  clearEncryptedRuntimeConfig,
} from '@/utils';

interface WelcomeScreenProps {
  onStartNewGame: (payload: CampaignPayload, playerFactionId: string) => void;
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
  const [campaignPayload, setCampaignPayload] = useState<CampaignPayload>(SAMPLE_CAMPAIGN);
  const [campaignStatus, setCampaignStatus] = useState('');
  const [selectedFactionId, setSelectedFactionId] = useState('player');
  const [saveImportStatus, setSaveImportStatus] = useState('');
  const [provider, setProvider] = useState<'openai' | 'anthropic' | 'deepseek' | 'custom'>('openai');
  const [endpoint, setEndpoint] = useState('https://api.openai.com/v1/chat/completions');
  const [model, setModel] = useState('gpt-4o-mini');
  const [apiKey, setApiKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [configStatus, setConfigStatus] = useState('');

  useEffect(() => {
    loadSaves();
    setHasConfig(hasEncryptedRuntimeConfig());
    setIsUnlocked(!!readRuntimeConfigFromSession());
  }, []);

  const loadSaves = async () => {
    try {
      const saveIds = await listSaves();
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
        model,
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

  const handleDeleteConfig = () => {
    clearEncryptedRuntimeConfig();
    setHasConfig(false);
    setIsUnlocked(false);
    setConfigStatus('已删除配置');
    setShowConfig(true);
  };

  const getEndpointPlaceholder = () => {
    switch (provider) {
      case 'openai': return 'https://api.openai.com/v1/chat/completions';
      case 'anthropic': return 'https://api.anthropic.com/v1/messages';
      case 'deepseek': return 'https://api.deepseek.com/v1/chat/completions';
      default: return 'https://...';
    }
  };

  const getModelPlaceholder = () => {
    switch (provider) {
      case 'openai': return 'gpt-4o-mini';
      case 'anthropic': return 'claude-3-5-sonnet-20240620';
      case 'deepseek': return 'deepseek-chat';
      default: return '填写模型名称';
    }
  };

  const handleImportCampaignZip = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const buffer = await file.arrayBuffer();
      const payload = loadCampaignZip(new Uint8Array(buffer));
      setCampaignPayload(payload);
      setCampaignStatus(`已导入战役：${payload.manifest.name}`);
      const playerFaction = payload.factions.find(f => f.type === 'player')?.id ?? payload.factions[0]?.id;
      if (playerFaction) {
        setSelectedFactionId(playerFaction);
      }
    } catch (error) {
      setCampaignStatus(error instanceof Error ? error.message : '战役包导入失败');
    }
  };

  const handleDownloadSampleCampaign = () => {
    const bytes = buildCampaignZip(campaignPayload)
    const blob = new Blob([new Uint8Array(bytes)], { type: 'application/zip' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${campaignPayload.manifest.id}.zip`
    link.click()
    URL.revokeObjectURL(url)
  }

  const handleImportSaveZip = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const buffer = await file.arrayBuffer();
      const result = await importSaveZip(new Uint8Array(buffer));
      setSaveImportStatus(`已导入存档：${result.saveId}`);
      await loadSaves();
      onLoadGame(result.saveId);
    } catch (error) {
      setSaveImportStatus(error instanceof Error ? error.message : '存档导入失败');
    }
  };

  const handleDeleteSave = async (saveId: string) => {
    try {
      await deleteSave(saveId);
      await loadSaves();
      setConfigStatus('存档已删除');
    } catch (error) {
      setConfigStatus(error instanceof Error ? error.message : '删除存档失败');
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
              <div style={{ display: 'flex', gap: '8px', justifyContent: 'center' }}>
                <button onClick={handleLock} className="btn btn-secondary">
                  锁定配置
                </button>
                <button onClick={handleDeleteConfig} className="btn btn-secondary" style={{ color: '#ef4444' }}>
                  删除配置
                </button>
              </div>
            </div>
          ) : hasConfig ? (
            <div>
              <p style={{ color: '#f59e0b', marginBottom: '16px' }}>
                🔒 检测到已保存的配置
              </p>
              {!showUnlock ? (
                <div style={{ display: 'flex', gap: '8px', justifyContent: 'center' }}>
                  <button onClick={() => setShowUnlock(true)} className="btn btn-primary">
                    解锁配置
                  </button>
                  <button onClick={handleDeleteConfig} className="btn btn-secondary" style={{ color: '#ef4444' }}>
                    删除配置
                  </button>
                </div>
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
              {configStatus && <p style={{ marginTop: '8px', fontSize: '0.9rem', color: '#facc15' }}>{configStatus}</p>}
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
                    模型
                    <input
                      type="text"
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                      placeholder={getModelPlaceholder()}
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

        <div style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: '20px'
        }}>
          <div style={{
            padding: '24px',
            borderRadius: '12px',
            border: '2px solid #4a90e2',
            background: 'rgba(74, 144, 226, 0.08)'
          }}>
            <h3 style={{ marginBottom: '12px', color: '#93c5fd' }}>
              🗺️ 战役选择
            </h3>
            <div style={{ marginBottom: '12px', textAlign: 'left' }}>
              <div style={{ fontWeight: 'bold', marginBottom: '6px' }}>{campaignPayload.manifest.name}</div>
              <div style={{ fontSize: '0.85rem', color: '#cbd5f5' }}>版本：{campaignPayload.manifest.version}</div>
            </div>
            <label className="btn btn-secondary" style={{ display: 'inline-block', marginBottom: '12px' }}>
              📥 导入战役 ZIP
              <input type="file" accept=".zip,application/zip" style={{ display: 'none' }} onChange={handleImportCampaignZip} />
            </label>
            <button className="btn btn-secondary" style={{ marginLeft: '8px' }} onClick={handleDownloadSampleCampaign}>
              📦 下载样例战役
            </button>
            {campaignStatus && <p style={{ fontSize: '0.85rem', color: '#facc15' }}>{campaignStatus}</p>}

            <h4 style={{ marginTop: '16px', marginBottom: '8px', color: '#93c5fd' }}>🎯 选择阵营</h4>
            <select
              value={selectedFactionId}
              onChange={(event) => setSelectedFactionId(event.target.value)}
              style={{
                width: '100%',
                padding: '8px',
                borderRadius: '6px',
                border: '1px solid #4b5563',
                background: '#1f2937',
                color: '#e5e7eb'
              }}
            >
              {campaignPayload.factions
                .filter(f => f.type === 'player' || f.type === 'ally')
                .map(faction => (
                  <option key={faction.id} value={faction.id}>
                    {faction.name} ({faction.type === 'player' ? '玩家' : '盟友'})
                  </option>
                ))}
            </select>
          </div>

          <div style={{
            padding: '24px',
            borderRadius: '12px',
            border: '2px solid #6b7280',
            background: 'rgba(255,255,255,0.03)',
          }}>
            <h3 style={{ marginBottom: '12px', color: '#9ca3af' }}>
              💾 存档选择
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
                  <div key={save.id} style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '8px 12px',
                    marginBottom: '8px',
                    borderRadius: '6px',
                    border: '1px solid #4b5563',
                    background: '#1f2937',
                  }}>
                    <button
                      onClick={() => onLoadGame(save.id)}
                      style={{
                        flex: 1,
                        textAlign: 'left',
                        background: 'transparent',
                        border: 'none',
                        color: '#e5e7eb',
                        cursor: 'pointer',
                        fontSize: '0.9rem'
                      }}
                    >
                      {save.name}
                    </button>
                    <button
                      onClick={() => handleDeleteSave(save.id)}
                      className="btn btn-danger"
                      style={{
                        padding: '4px 8px',
                        fontSize: '0.8rem'
                      }}
                    >
                      删除
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div style={{ marginTop: '12px' }}>
              <label className="btn btn-secondary" style={{ display: 'inline-block' }}>
                📥 导入存档 ZIP
                <input type="file" accept=".zip,application/zip" style={{ display: 'none' }} onChange={handleImportSaveZip} />
              </label>
              {saveImportStatus && (
                <p style={{ marginTop: '8px', fontSize: '0.85rem', color: '#facc15' }}>{saveImportStatus}</p>
              )}
            </div>
          </div>
        </div>

        <div style={{ marginTop: '24px' }}>
          <button
            onClick={() => onStartNewGame(campaignPayload, selectedFactionId)}
            style={{
              padding: '14px 32px',
              borderRadius: '10px',
              border: '2px solid #4a90e2',
              background: 'rgba(74, 144, 226, 0.18)',
              color: '#93c5fd',
              fontSize: '1.1rem',
              fontWeight: 'bold',
              cursor: 'pointer'
            }}
          >
            ▶️ 进入战局
          </button>
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
