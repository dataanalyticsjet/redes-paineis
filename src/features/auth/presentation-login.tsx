"use client";

import { ArrowRight, LoaderCircle, LockKeyhole } from "lucide-react";

type Props = {
  error: string | null;
  loading: boolean;
  onFeishuLogin: () => void;
};

export function PresentationLogin({ error, loading, onFeishuLogin }: Props) {
  return (
    <main className="presentation-login-page">
      <link
        rel="preload"
        as="image"
        href="/login-background.avif"
        type="image/avif"
        fetchPriority="high"
      />
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
      </section>
    </main>
  );
}

type AuthTransitionProps = {
  error: string | null;
  loading: boolean;
  onRetry: () => void;
  onFeishuLogin: () => void;
};

export function PresentationAuthTransition({ error, loading, onRetry, onFeishuLogin }: AuthTransitionProps) {
  return (
    <main className="presentation-auth-transition" aria-live="polite">
      <section className="presentation-auth-transition-card" aria-busy={!error}>
        <img className="presentation-auth-transition-logo" src="/jnt-logo-red.png" alt="J&T Express" />
        {error ? (
          <>
            <h1>Não foi possível validar sua sessão</h1>
            <p className="presentation-auth-transition-error" role="alert">{error}</p>
            <button className="presentation-auth-transition-primary" type="button" onClick={onRetry}>
              Tentar novamente
            </button>
            <button className="presentation-auth-transition-secondary" type="button" onClick={onFeishuLogin} disabled={loading}>
              {loading ? "Conectando ao Feishu…" : "Entrar novamente com Feishu"}
            </button>
          </>
        ) : (
          <>
            <LoaderCircle className="presentation-auth-transition-spinner" size={22} aria-hidden="true" />
            <h1>Preparando sua área de trabalho...</h1>
          </>
        )}
      </section>
    </main>
  );
}
