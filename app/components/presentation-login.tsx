"use client";

import { ArrowRight, LoaderCircle, LockKeyhole } from "lucide-react";
import { useState, type FormEvent } from "react";

type Props = {
  error: string | null;
  loading: boolean;
  showDevelopmentLogin: boolean;
  onFeishuLogin: () => void;
  onDevelopmentLogin: (username: string, password: string) => Promise<void>;
};

export function PresentationLogin({ error, loading, showDevelopmentLogin, onFeishuLogin, onDevelopmentLogin }: Props) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  async function submitDevelopmentLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onDevelopmentLogin(username, password);
    setPassword("");
  }

  return (
    <main className="presentation-login-page">
      <section className="presentation-login-card" aria-labelledby="presentation-login-title">
        <span className="presentation-login-kicker"><LockKeyhole size={14} /> Acesso seguro</span>
        <h1 id="presentation-login-title">Central de Painéis</h1>
        <p className="presentation-login-subtitle">Acesse seus indicadores e dashboards</p>
        {error ? <p className="presentation-login-error" role="alert">{error}</p> : null}
        <button className="presentation-feishu-button" type="button" onClick={onFeishuLogin} disabled={loading}>
          {loading ? <LoaderCircle className="presentation-spinner" size={18} /> : <ArrowRight size={18} />}
          {loading ? "Conectando ao Feishu…" : "Entrar com Feishu"}
        </button>
        <p className="presentation-login-footnote">Acesso exclusivo para colaboradores autorizados</p>
        {showDevelopmentLogin ? (
          <details className="presentation-development-login">
            <summary>Acesso local de desenvolvimento</summary>
            <form onSubmit={(event) => void submitDevelopmentLogin(event)}>
              <label htmlFor="development-viewer-username">Usuário</label>
              <input id="development-viewer-username" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required />
              <label htmlFor="development-viewer-password">Senha</label>
              <input id="development-viewer-password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
              <button type="submit" disabled={loading}>{loading ? "Verificando…" : "Entrar localmente"}</button>
            </form>
          </details>
        ) : null}
      </section>
    </main>
  );
}
