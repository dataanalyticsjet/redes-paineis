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
