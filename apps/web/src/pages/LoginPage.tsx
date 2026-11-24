import {
  type AppEnvironment,
  BrandLogo,
  Button,
  EnvironmentBadge,
  resolveAppEnvironment,
  SecurityNotice,
} from "@seu-renave/ui";
import {
  Building2,
  ExternalLink,
  LockKeyhole,
  ShieldCheck,
} from "lucide-react";

export interface LoginPageProps {
  authFeedback?: {
    message: string;
    title: string;
  };
  environment?: AppEnvironment;
}

export function LoginPage({ authFeedback, environment }: LoginPageProps = {}) {
  const activeEnvironment =
    environment ?? resolveAppEnvironment(import.meta.env.VITE_APP_ENVIRONMENT);

  return (
    <main className="login-page">
      <header className="brand-header">
        <BrandLogo />
        <p>Plataforma privada — não é o sistema oficial do governo</p>
      </header>

      <section className="access-card" aria-labelledby="access-title">
        <div className="access-card__intro">
          <EnvironmentBadge environment={activeEnvironment} />
          <h1 id="access-title">Entrar na sua conta</h1>
          <p>
            Registro eletrônico de estoque no RENAVE, com rastreabilidade e
            segurança.
          </p>
        </div>

        {authFeedback ? (
          <section className="auth-feedback" role="alert">
            <h2>{authFeedback.title}</h2>
            <p>{authFeedback.message}</p>
          </section>
        ) : null}

        <div className="identity-panel">
          <div className="identity-panel__icon" aria-hidden="true">
            <Building2 size={24} />
          </div>
          <div>
            <h2>Identidade corporativa</h2>
            <p>Você será direcionado ao provedor seguro da sua organização.</p>
          </div>
        </div>

        <Button
          href="/api/auth/login"
          variant="primary"
          size="lg"
          fullWidth
          trailingIcon={<ExternalLink size={18} aria-hidden="true" />}
        >
          Continuar com acesso seguro
        </Button>

        <SecurityNotice
          label="Proteções do acesso"
          items={[
            {
              id: "no-local-credentials",
              icon: <LockKeyhole size={18} />,
              text: "A senha e o código MFA não passam pelo Seu Renave.",
            },
            {
              id: "mfa-privileged",
              icon: <ShieldCheck size={18} />,
              text: "A sessão é validada pelo provedor corporativo antes de liberar o acesso.",
            },
          ]}
        />
      </section>

      <footer>
        Dados processados em datacenter no Brasil · Todo acesso é auditado
      </footer>
    </main>
  );
}
