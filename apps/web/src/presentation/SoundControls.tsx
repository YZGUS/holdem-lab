import { useEffect, useState, useSyncExternalStore } from 'react';
import { audioManager } from './audio-manager';

export function SoundControls() {
  const [open, setOpen] = useState(false);
  const settings = useSyncExternalStore(audioManager.subscribe, audioManager.getSnapshot);

  useEffect(() => {
    audioManager.setRoomActive(true);
    audioManager.setPageVisible(!document.hidden);
    const unlock = () => void audioManager.unlock();
    const visibility = () => audioManager.setPageVisible(!document.hidden);
    window.addEventListener('pointerdown', unlock, { once: true, capture: true });
    window.addEventListener('keydown', unlock, { once: true, capture: true });
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener('pointerdown', unlock, { capture: true });
      window.removeEventListener('keydown', unlock, { capture: true });
      document.removeEventListener('visibilitychange', visibility);
      audioManager.setRoomActive(false);
    };
  }, []);

  return <div className="sound-controls">
    <button className="ghost compact sound-trigger" aria-label="声音设置" aria-expanded={open} onClick={() => setOpen((value) => !value)}>声音</button>
    {open && <div className="sound-popover" role="dialog" aria-label="声音设置面板">
      <div><strong>声音设置</strong><button aria-label="关闭声音设置" onClick={() => setOpen(false)}>×</button></div>
      <label><span>音效</span><button className={settings.sfxEnabled ? 'selected' : ''} onClick={() => audioManager.setSfxEnabled(!settings.sfxEnabled)}>{settings.sfxEnabled ? '开启' : '关闭'}</button></label>
      <input aria-label="音效音量" type="range" min="0" max="1" step="0.05" value={settings.sfxVolume} onChange={(event) => audioManager.setSfxVolume(Number(event.target.value))} />
      <label><span>背景音乐</span><button className={settings.bgmEnabled ? 'selected' : ''} onClick={() => audioManager.setBgmEnabled(!settings.bgmEnabled)}>{settings.bgmEnabled ? '开启' : '关闭'}</button></label>
      <input aria-label="背景音乐音量" type="range" min="0" max="1" step="0.05" value={settings.bgmVolume} onChange={(event) => audioManager.setBgmVolume(Number(event.target.value))} />
    </div>}
  </div>;
}
