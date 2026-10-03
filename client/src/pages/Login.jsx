import { useState } from 'react';
import { LogIn } from 'lucide-react';
import * as api from '../api.js';
import { Button, Field } from '../ui/kit.jsx';

export default function Login({ onLogin }) {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post('/auth/login', { login, password }, { offline: false });
      api.setToken(r.token);
      onLogin(r.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">
          <img src="/icon.svg" alt="" width="52" height="52" />
          <div>
            <h1>FiberFleet</h1>
            <p className="muted">Сервис тягачей и прицепов</p>
          </div>
        </div>
        <Field label="Логин">
          <input className="input" value={login} onChange={(e) => setLogin(e.target.value)} autoComplete="username" autoCapitalize="none" autoFocus required />
        </Field>
        <Field label="Пароль">
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </Field>
        {error && <div className="alert alert-red">{error}</div>}
        <Button variant="primary" type="submit" icon={LogIn} loading={busy} className="w-full">Войти</Button>
      </form>
    </div>
  );
}
