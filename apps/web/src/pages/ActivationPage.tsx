import {
  Check,
  CircleAlert,
  Clock3,
  ExternalLink,
  LockKeyhole,
  ShieldCheck,
} from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@seu-renave/ui";

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

function credentialGuideSummary(
  hasEstablishment: boolean,
  status: BrowserRenaveLinkStatus | undefined,
  loading: boolean,
  error: boolean,
): string {
  if (!hasEstablishment) {
    return "Obtenha acesso a um estabelecimento antes de verificar o vínculo nesta plataforma.";
  }
  if (loading) {
    return "A consulta do vínculo está em andamento. Use o roteiro abaixo apenas como referência.";
  }
  if (error || status === undefined) {
    return "O estado do vínculo ainda não foi confirmado. Confira o Credencia antes de tentar a verificação novamente.";
  }
  if (status === "enabled") {
    return "O vínculo está habilitado para os recursos liberados pelo servidor. Não refaça o processo sem necessidade.";
  }
  if (status === "confirmed") {
    return "A identidade foi confirmada. A liberação final ainda pode depender da habilitação pelo órgão competente.";
  }
  if (status === "pending") {
    return "O vínculo aguarda verificação. Acompanhe no Credencia as confirmações e habilitações aplicáveis; não refaça a solicitação sem orientação.";
  }
  if (status === "deactivated" || status === "rejected") {
    return "Revise o vínculo no Credencia e as orientações do órgão competente antes de solicitar nova verificação.";
  }
  return "Conclua o vínculo no Credencia e volte para solicitar a verificação segura nesta plataforma.";
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
  const guideSummary = credentialGuideSummary(
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

      <aside
        className="activation__guide"
        aria-labelledby="activation-guide-title"
      >
        <div className="activation__guide-heading">
          <div>
            <p>Orientação oficial</p>
            <h3 id="activation-guide-title">Como preparar o vínculo</h3>
          </div>
          <ExternalLink size={20} aria-hidden="true" />
        </div>

        <p className="activation__guide-summary">{guideSummary}</p>

        <ol className="activation__guide-steps">
          <li>
            <strong>Acesse o Credencia</strong>
            <p>
              Entre somente pelo portal oficial e selecione o estabelecimento
              que será autorizado a operar o RENAVE.
            </p>
          </li>
          <li>
            <strong>Confira credenciamento e contratação</strong>
            <p>
              Verifique se o cadastro, o CNAE e a natureza RENAVE aplicável
              estão disponíveis para o estabelecimento e siga a contratação
              indicada no canal oficial.
            </p>
          </li>
          <li>
            <strong>Solicite o vínculo com a integradora</strong>
            <p>
              Quando a função estiver disponível para o seu perfil, escolha a
              natureza RENAVE e a integradora RenavEstoque, revise os dados e
              conclua a manifestação exibida pelo Credencia.
            </p>
          </li>
          <li>
            <strong>Acompanhe e verifique</strong>
            <p>
              Aguarde as confirmações e habilitações aplicáveis. Depois, volte
              ao RenavEstoque e use a verificação de vínculo. Esta tela não
              concede a ativação.
            </p>
          </li>
        </ol>

        <div className="activation__guide-actions">
          <Button
            href="https://credencia.serpro.gov.br/"
            target="_blank"
            rel="noopener noreferrer"
            variant="secondary"
            trailingIcon={<ExternalLink size={16} />}
          >
            Acessar Credencia
            <span className="sr-only"> (abre em nova aba)</span>
          </Button>
          <Button
            href="https://centraldeajuda.serpro.gov.br/renave/institucional/como-credenciar/"
            target="_blank"
            rel="noopener noreferrer"
            variant="quiet"
            trailingIcon={<ExternalLink size={16} />}
          >
            Ver orientação oficial
            <span className="sr-only"> (abre em nova aba)</span>
          </Button>
        </div>

        <p className="activation__guide-security">
          <LockKeyhole size={17} aria-hidden="true" />
          Não compartilhe certificado, chave privada ou senha. O RenavEstoque
          não solicita CPF ou CNPJ nesta etapa.
        </p>
      </aside>
    </section>
  );
}
