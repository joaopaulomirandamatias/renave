import {
  Check,
  CircleAlert,
  Clock3,
  LockKeyhole,
  ShieldCheck,
} from "lucide-react";
import type { ReactNode } from "react";

import type { BrowserRenaveReadiness } from "../App.js";

export interface HomologationReadinessPanelProps {
  error?: boolean;
  loading?: boolean;
  readiness?: BrowserRenaveReadiness;
}

type ReadinessState = "complete" | "current" | "blocked" | "attention";

interface ReadinessItem {
  description: string;
  label: string;
  state: ReadinessState;
  stateLabel: string;
}

const icons = {
  attention: <CircleAlert size={18} />,
  blocked: <LockKeyhole size={18} />,
  complete: <Check size={18} />,
  current: <Clock3 size={18} />,
} satisfies Record<ReadinessState, ReactNode>;

function certificateItem(
  status: BrowserRenaveReadiness["certificate"],
): ReadinessItem {
  const states: Record<
    BrowserRenaveReadiness["certificate"],
    Omit<ReadinessItem, "label">
  > = {
    ready: {
      description:
        "O material configurado está válido para consultas no instante verificado.",
      state: "complete",
      stateLabel: "Pronto",
    },
    warning: {
      description:
        "O material ainda permite consultas, mas requer atenção operacional.",
      state: "attention",
      stateLabel: "Atenção",
    },
    blocked: {
      description: "A validação local bloqueou o uso do material configurado.",
      state: "blocked",
      stateLabel: "Bloqueado",
    },
    unavailable: {
      description:
        "Nenhum material de homologação está disponível para esta instância.",
      state: "blocked",
      stateLabel: "Indisponível",
    },
  };
  return { label: "Certificado mTLS", ...states[status] };
}

function linkItem(status: BrowserRenaveReadiness["link"]): ReadinessItem {
  if (status === "confirmed" || status === "enabled") {
    return {
      description:
        "A identidade do estabelecimento foi confirmada no ambiente configurado.",
      label: "Vínculo Credencia",
      state: "complete",
      stateLabel:
        status === "enabled"
          ? "Consultas habilitadas"
          : "Identidade confirmada",
    };
  }
  if (status === "rejected" || status === "deactivated") {
    return {
      description:
        "O vínculo exige revisão antes que consultas possam ser liberadas.",
      label: "Vínculo Credencia",
      state: "attention",
      stateLabel:
        status === "rejected" ? "Correção necessária" : "Revisão necessária",
    };
  }
  return {
    description:
      status === "pending"
        ? "A verificação do vínculo ainda não foi concluída."
        : "A verificação segura do vínculo ainda não foi iniciada.",
    label: "Vínculo Credencia",
    state: "current",
    stateLabel:
      status === "pending" ? "Aguardando verificação" : "Aguardando início",
  };
}

function principalItem(
  label: string,
  status: BrowserRenaveReadiness["operatorIdentity"],
): ReadinessItem {
  const states: Record<
    BrowserRenaveReadiness["operatorIdentity"],
    Omit<ReadinessItem, "label">
  > = {
    missing: {
      description:
        "Nenhum cadastro verificado foi localizado para esta finalidade.",
      state: "blocked",
      stateLabel: "Cadastro ausente",
    },
    pending: {
      description:
        "O cadastro existe, mas a verificação ainda não foi concluída.",
      state: "current",
      stateLabel: "Aguardando verificação",
    },
    verified: {
      description:
        "A fonte verificada necessária está disponível, sem expor o dado protegido.",
      state: "complete",
      stateLabel: "Verificação concluída",
    },
    suspended: {
      description:
        "A verificação foi suspensa e não pode ser usada em uma operação RENAVE.",
      state: "blocked",
      stateLabel: "Acesso suspenso",
    },
    unavailable: {
      description:
        "O estado não pôde ser confirmado com segurança nesta verificação.",
      state: "attention",
      stateLabel: "Indisponível",
    },
  };
  return { label, ...states[status] };
}

function readinessItems(
  readiness: BrowserRenaveReadiness,
): readonly ReadinessItem[] {
  return [
    {
      description: "O destino da integração é fixo no ambiente de homologação.",
      label: "Ambiente RENAVE",
      state: "complete",
      stateLabel: "Homologação",
    },
    {
      description:
        readiness.integration === "configured"
          ? "Os controles locais necessários para consultas estão configurados."
          : "A integração não foi composta nesta instância.",
      label: "Configuração segura",
      state: readiness.integration === "configured" ? "complete" : "blocked",
      stateLabel:
        readiness.integration === "configured" ? "Configurada" : "Desabilitada",
    },
    certificateItem(readiness.certificate),
    linkItem(readiness.link),
    principalItem("Identidade do operador", readiness.operatorIdentity),
    principalItem(
      "Contato RENAVE do estabelecimento",
      readiness.establishmentContact,
    ),
    {
      description:
        readiness.queries === "ready"
          ? "As consultas autorizadas podem ser executadas com os controles atuais."
          : "As consultas permanecem indisponíveis até todos os gates serem atendidos.",
      label: "Consultas RENAVE",
      state: readiness.queries === "ready" ? "complete" : "blocked",
      stateLabel: readiness.queries === "ready" ? "Liberadas" : "Bloqueadas",
    },
    {
      description:
        "Operações de escrita permanecem indisponíveis nesta etapa, independentemente dos demais itens.",
      label: "Mutações RENAVE",
      state: "blocked",
      stateLabel: "Protegidas",
    },
  ];
}

export function HomologationReadinessPanel({
  error = false,
  loading = false,
  readiness,
}: HomologationReadinessPanelProps) {
  return (
    <section
      className="readiness-panel"
      aria-busy={loading}
      aria-labelledby="readiness-title"
    >
      <header className="readiness-panel__heading">
        <div>
          <p>Homologação SERPRO</p>
          <h2 id="readiness-title">Prontidão da integração</h2>
        </div>
        <ShieldCheck size={22} aria-hidden="true" />
      </header>

      {loading ? (
        <p className="readiness-panel__feedback" role="status">
          Verificando controles locais de prontidão…
        </p>
      ) : error ? (
        <p
          className="readiness-panel__feedback readiness-panel__feedback--error"
          role="alert"
        >
          Não foi possível carregar a prontidão. O vínculo já exibido foi
          preservado e nenhuma liberação foi presumida.
        </p>
      ) : readiness ? (
        <ol className="readiness-panel__items">
          {readinessItems(readiness).map((item) => (
            <li key={item.label} data-state={item.state}>
              <span className="readiness-panel__icon" aria-hidden="true">
                {icons[item.state]}
              </span>
              <div>
                <h3>{item.label}</h3>
                <p>{item.description}</p>
              </div>
              <strong>{item.stateLabel}</strong>
            </li>
          ))}
        </ol>
      ) : (
        <p className="readiness-panel__feedback">
          Selecione um estabelecimento para verificar a prontidão local.
        </p>
      )}
    </section>
  );
}
