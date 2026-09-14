import { useState, type FormEvent } from 'react';

interface CloudLoginProps {
  checking: boolean;
  error: string | null;
  onLogin: (code: string) => Promise<void>;
}

export function CloudLogin({ checking, error, onLogin }: CloudLoginProps) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await onLogin(code.trim());
    } catch {
      // The hook exposes the server message next to the form.
    } finally {
      setBusy(false);
    }
  };

  return <main className="auth-shell">
    <section className="auth-card">
      <p className="eyebrow">HOLDEM LAB · CLOUD</p>
      <h1>{checking ? '正在验证身份' : '输入邀请码'}</h1>
      <p>{checking ? '正在连接身份服务，请稍候。' : '云端牌桌仅对受邀玩家开放。登录状态保存在安全 Cookie 中。'}</p>
      {!checking && <form onSubmit={submit}>
        <label>
          邀请码
          <input
            autoFocus
            autoComplete="one-time-code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            minLength={6}
            maxLength={128}
            required
          />
        </label>
        <button className="primary wide" disabled={busy || code.trim().length < 6}>{busy ? '正在登录' : '进入牌桌'}</button>
      </form>}
      {error && <p className="auth-error" role="alert">{error}</p>}
    </section>
  </main>;
}
