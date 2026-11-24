import {
  Check,
  CircleAlert,
  Clock3,
  LockKeyhole,
  ShieldCheck,
} from "lucide-react";
import type { ReactNode } from "react";

import type { BrowserRenaveLinkStatus } from "../App.js";

export interface ActivationPageProps {
  hasEstablishment: boolean;
  linkStatus?: BrowserRenaveLinkStatus;
  linkStatusError?: boolean;
  linkStatusLoading?: boolean;
}

type ActivationState = "complete" | "current" | "blocked" | "attention";

interface ActivationStep {
  description: string;
  label: string;
  state: ActivationState;
  stateLabel: string;
}

const stateIcons = {
  attention: <CircleAlert size={18} />,
  blocked: <LockKeyhole size={18} />,
  complete: <Check size={18} />,
  current: <Clock3 size={18} />,
} satisfies Record<ActivationState, ReactNode>;

function credentialStep(
  hasEstablishment: boolean,
  status: BrowserRenaveLinkStatus | undefined,
  loading: boolean,
  error: boolean,
): ActivationStep {
  if (!hasEstablishment) {
    return {
      description:
        "O vínculo só pode ser consultado depois que um estabelecimento autorizado estiver disponível.",
      label: "Vínculo Credencia",
      state: "blocked",
      stateLabel: "Bloqueado",
    };
  }
  if (loading) {
    return {
      description: "Consultando o estado autoritativo do vínculo.",
      label: "Vínculo Credencia",
      state: "current",
      stateLabel: "Consultando",
    };
  }
  if (error) {
    return {
      description:
        "O estado não pôde ser consultado. Nenhuma ativação foi presumida.",
      label: "Vínculo Credencia",
      state: "attention",
      stateLabel: "Indisponível",
    };
  }
  if (!status) {
    return {
      description:
        "O estado autoritativo do vínculo ainda não foi carregado para este estabelecimento.",
      label: "Vínculo Credencia",
      state: "current",
      stateLabel: "Aguardando consulta",
    };
  }

  const states: Record<
    BrowserRenaveLinkStatus,
    Omit<ActivationStep, "label">
  > = {
    not_started: {
      description:
        "A verificação segura do estabelecimento ainda não foi iniciada.",
      state: "current",
      stateLabel: "Aguardando início",
    },
    pending: {
      description: "O vínculo aguarda verificação no ambiente configurado.",
      state: "current",
      stateLabel: "Aguardando verificação",
    },
    confirmed: {
      description:
        "A identidade do vínculo foi confirmada; operações de escrita continuam bloqueadas.",
      state: "complete",
      stateLabel: "Identidade confirmada",
    },
    enabled: {
      description:
        "O vínculo está habilitado para os recursos que o servidor liberar.",
      state: "complete",
      stateLabel: "Pronto para consultas liberadas",
    },
    deactivated: {
      description:
        "O vínculo foi desativado e precisa de revisão antes de qualquer operação.",
      state: "attention",
      stateLabel: "Revisão necessária",
    },
    rejected: {
      description:
        "A última verificação foi rejeitada. Revise o vínculo antes de prosseguir.",
      state: "attention",
      stateLabel: "Correção necessária",
    },
  };
  const resolved = states[status];
  return { label: "Vínculo Credencia", ...resolved };
}

export function ActivationPage({
  hasEstablishment,
  linkStatus,
  linkStatusError = false,
  linkStatusLoading = false,
}: ActivationPageProps) {
  const link = credentialStep(
    hasEstablishment,
    linkStatus,
    linkStatusLoading,
    linkStatusError,
  );
  const steps: readonly ActivationStep[] = [
    {
      description: "A sessão possui acesso a uma organização ativa.",
      label: "Acesso à organização",
      state: "complete",
      stateLabel: "Concluído",
    },
    {
      description: hasEstablishment
        ? "Um estabelecimento autorizado está selecionado para esta sessão."
        : "Solicite ao administrador acesso a pelo menos um estabelecimento.",
      label: "Contexto do estabelecimento",
      state: hasEstablishment ? "complete" : "current",
      stateLabel: hasEstablishment ? "Concluído" : "Aguardando acesso",
    },
    link,
    {
      description:
        "A ativação operacional depende dos controles e da homologação aplicáveis. Esta tela não a concede.",
      label: "Mutações RENAVE",
      state: "blocked",
      stateLabel: "Protegidas",
    },
  ];

  return (
    <section
      className="activation"
      aria-labelledby="activation-title"
      aria-busy={linkStatusLoading}
    >
      <header className="activation__heading">
        <div>
          <p>Primeiro acesso</p>
          <h2 id="activation-title">Ativação do estabelecimento</h2>
        </div>
        <ShieldCheck size={22} aria-hidden="true" />
      </header>
      <p className="activation__intro">
        Acompanhe somente as etapas que já podem ser comprovadas pela
        plataforma.
      </p>
      <ol className="activation__steps">
        {steps.map((step) => (
          <li key={step.label} data-state={step.state}>
            <span className="activation__icon" aria-hidden="true">
              {stateIcons[step.state]}
            </span>
            <div>
              <h3>{step.label}</h3>
              <p>{step.description}</p>
            </div>
            <strong>{step.stateLabel}</strong>
          </li>
        ))}
      </ol>
    </section>
  );
}
