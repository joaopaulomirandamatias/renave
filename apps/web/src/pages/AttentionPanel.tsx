import { Button } from "@seu-renave/ui";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  Clock3,
} from "lucide-react";
import type { ReactNode } from "react";

import type {
  BrowserRenaveLinkStatus,
  BrowserRenaveReadiness,
  EstablishmentManagementCapability,
} from "../App.js";

type AttentionAction =
  "confirm-access" | "create-establishment" | "reload-link";

type AttentionTone = "attention" | "blocked" | "complete" | "waiting";

export interface AttentionItem {
  action?: AttentionAction;
  cause: string;
  id: string;
  impact: string;
  nextStep: string;
  tone: AttentionTone;
}

export interface AttentionState {
  canCreateEstablishment: boolean;
  canReloadLinkStatus: boolean;
  contextError: boolean;
  contextLoading: boolean;
  establishmentManagement: EstablishmentManagementCapability;
  hasEstablishment: boolean;
  linkStatus?: BrowserRenaveLinkStatus;
  linkStatusError: boolean;
  linkStatusLoading: boolean;
  preflightAvailable: boolean;
  readiness?: BrowserRenaveReadiness;
  readinessError: boolean;
  readinessLoading: boolean;
}

export interface AttentionPanelProps extends AttentionState {
  onReloadLinkStatus?: () => void;
}

function blockedPrincipal(
  id: string,
  cause: string,
  status: BrowserRenaveReadiness["operatorIdentity"],
): AttentionItem | undefined {
  if (status === "ready") return undefined;
  return {
    cause,
    id,
    impact:
      status === "unavailable"
        ? "O estado da fonte protegida não pôde ser confirmado; nenhuma operação será liberada por suposição."
        : "Operações RENAVE que exigem essa identidade permanecem bloqueadas.",
    nextStep:
      status === "unavailable"
        ? "Tente novamente quando o serviço de perfis estiver disponível."
        : "Conclua a verificação com a equipe responsável pelo cadastro.",
    tone: status === "unavailable" ? "attention" : "blocked",
  };
}

export function deriveAttentionItems(
  state: AttentionState,
): readonly AttentionItem[] {
  if (state.contextLoading) {
    return [
      {
        cause: "Contexto da organização em atualização",
        id: "context-loading",
        impact:
          "Estabelecimentos e permissões ainda podem mudar durante o carregamento.",
        nextStep: "Aguarde a conclusão antes de iniciar uma nova ação.",
        tone: "waiting",
      },
    ];
  }

  if (state.contextError) {
    return [
      {
        cause: "Contexto da organização não confirmado",
        id: "context-error",
        impact:
          "O contexto anterior foi preservado, mas não é seguro presumir que a troca foi concluída.",
        nextStep: "Recarregue o painel antes de iniciar uma nova operação.",
        tone: "attention",
      },
    ];
  }

  if (!state.hasEstablishment) {
    if (
      state.establishmentManagement === "available" &&
      state.canCreateEstablishment
    ) {
      return [
        {
          action: "create-establishment",
          cause: "Nenhum estabelecimento selecionado",
          id: "establishment-missing",
          impact:
            "Prontidão, vínculo e consultas RENAVE dependem de um estabelecimento ativo.",
          nextStep: "Cadastre o primeiro estabelecimento desta organização.",
          tone: "blocked",
        },
      ];
    }
    if (
      state.establishmentManagement === "mfa_required" &&
      state.canCreateEstablishment
    ) {
      return [
        {
          action: "confirm-access",
          cause: "Acesso corporativo precisa ser confirmado",
          id: "establishment-mfa",
          impact:
            "O cadastro de estabelecimento está protegido por autenticação recente com verificação adicional.",
          nextStep: "Confirme seu acesso corporativo e retorne ao cadastro.",
          tone: "attention",
        },
      ];
    }
    return [
      {
        cause: "Nenhum estabelecimento disponível",
        id: "establishment-denied",
        impact:
          "Sem um estabelecimento autorizado, a plataforma não pode verificar vínculo nem liberar consultas.",
        nextStep:
          "Solicite acesso ou cadastro a um administrador da organização.",
        tone: "blocked",
      },
    ];
  }

  const items: AttentionItem[] = [];

  if (state.readinessLoading) {
    items.push({
      cause: "Controles locais em verificação",
      id: "readiness-loading",
      impact:
        "Certificado, perfis e configuração ainda não têm um resultado conclusivo.",
      nextStep: "Aguarde a conclusão da verificação de prontidão.",
      tone: "waiting",
    });
  } else if (state.readinessError) {
    items.push({
      cause: "Prontidão da integração indisponível",
      id: "readiness-error",
      impact:
        "Nenhuma consulta ou operação pode ser liberada sem confirmar os controles locais.",
      nextStep: "Tente carregar o painel novamente mais tarde.",
      tone: "attention",
    });
  } else if (!state.readiness) {
    items.push({
      cause: "Prontidão ainda não carregada",
      id: "readiness-missing",
      impact:
        "Ainda não há evidência suficiente para afirmar que a integração está disponível.",
      nextStep: "Aguarde o diagnóstico do estabelecimento selecionado.",
      tone: "waiting",
    });
  } else {
    if (state.readiness.integration === "disabled") {
      items.push({
        cause: "Integração RENAVE desabilitada",
        id: "integration-disabled",
        impact:
          "Esta instância não foi composta para acessar o ambiente de homologação.",
        nextStep:
          "Solicite à equipe responsável a configuração segura da integração.",
        tone: "blocked",
      });
    }

    if (
      state.readiness.certificate === "blocked" ||
      state.readiness.certificate === "unavailable"
    ) {
      items.push({
        cause:
          state.readiness.certificate === "blocked"
            ? "Certificado mTLS bloqueado"
            : "Certificado mTLS indisponível",
        id: "certificate-blocked",
        impact:
          "Consultas ao SERPRO permanecem bloqueadas para proteger a identidade da integradora.",
        nextStep:
          "Acione a equipe de infraestrutura para validar o material de homologação.",
        tone: "blocked",
      });
    } else if (state.readiness.certificate === "warning") {
      items.push({
        cause: "Certificado mTLS requer atenção",
        id: "certificate-warning",
        impact:
          "As consultas ainda podem funcionar, mas o material exige acompanhamento operacional.",
        nextStep:
          "Planeje a regularização antes que o certificado seja bloqueado.",
        tone: "attention",
      });
    }

    const operator = blockedPrincipal(
      "operator-identity",
      "Identidade do operador pendente",
      state.readiness.operatorIdentity,
    );
    if (operator) items.push(operator);
    const contact = blockedPrincipal(
      "establishment-contact",
      "Contato RENAVE do estabelecimento pendente",
      state.readiness.establishmentContact,
    );
    if (contact) items.push(contact);
  }

  const readinessLinkAllowsQueries =
    state.readiness?.link === "confirmed" ||
    state.readiness?.link === "enabled";
  const loadedLinkAllowsQueries =
    state.linkStatus === "confirmed" || state.linkStatus === "enabled";
  const linkStatesDiverge =
    state.readiness !== undefined &&
    state.linkStatus !== undefined &&
    readinessLinkAllowsQueries !== loadedLinkAllowsQueries;

  if (linkStatesDiverge) {
    items.push({
      cause: "Estados do vínculo estão divergentes",
      id: "link-state-divergence",
      impact:
        "A consulta do vínculo e o diagnóstico de prontidão discordam sobre a liberação; o sistema mantém as consultas bloqueadas.",
      nextStep:
        "Recarregue o vínculo e aguarde um diagnóstico de prontidão consistente antes de continuar.",
      tone: "attention",
    });
  }

  if (state.linkStatusLoading) {
    items.push({
      cause: "Vínculo Credencia/RENAVE em carregamento",
      id: "link-loading",
      impact: "O estado atual do vínculo ainda não pode ser confirmado.",
      nextStep: "Aguarde a consulta ser concluída.",
      tone: "waiting",
    });
  } else if (state.linkStatusError) {
    items.push({
      ...(state.canReloadLinkStatus ? { action: "reload-link" as const } : {}),
      cause: "Vínculo Credencia/RENAVE indisponível",
      id: "link-error",
      impact:
        "O último estado conhecido foi preservado e nenhuma liberação foi presumida.",
      nextStep: state.canReloadLinkStatus
        ? "Carregue o vínculo novamente."
        : "Tente carregar o painel novamente mais tarde.",
      tone: "attention",
    });
  } else if (!state.linkStatus) {
    items.push({
      cause: "Vínculo ainda não carregado",
      id: "link-missing",
      impact:
        "A identidade do estabelecimento não está confirmada no ambiente configurado.",
      nextStep: "Aguarde o carregamento do vínculo.",
      tone: "waiting",
    });
  } else if (state.linkStatus === "not_started") {
    items.push({
      cause: "Verificação do vínculo ainda não iniciada",
      id: "link-not-started",
      impact:
        "Consultas RENAVE permanecem bloqueadas até a identidade ser confirmada.",
      nextStep: state.preflightAvailable
        ? "Use o controle “Verificar vínculo” na seção de vínculo do estabelecimento."
        : "Conclua a configuração segura antes de verificar o vínculo.",
      tone: "blocked",
    });
  } else if (state.linkStatus === "pending") {
    items.push({
      cause: "Vínculo aguardando verificação",
      id: "link-pending",
      impact:
        "Consultas ainda não podem ser liberadas enquanto a confirmação estiver pendente.",
      nextStep: "Acompanhe a conclusão da verificação; não repita a ação.",
      tone: "waiting",
    });
  } else if (
    state.linkStatus === "rejected" ||
    state.linkStatus === "deactivated"
  ) {
    items.push({
      cause:
        state.linkStatus === "rejected"
          ? "Vínculo rejeitado"
          : "Vínculo desativado",
      id: "link-review",
      impact:
        "O estabelecimento não pode usar as consultas RENAVE neste estado.",
      nextStep: "Solicite revisão do vínculo à equipe responsável pela adesão.",
      tone: "blocked",
    });
  }

  if (items.length > 0) return items;

  const demonstrablyReady =
    state.readiness?.queries === "ready" &&
    readinessLinkAllowsQueries &&
    (state.linkStatus === "confirmed" || state.linkStatus === "enabled");
  if (demonstrablyReady) {
    return [
      {
        cause: "Nenhuma ação pendente para consultas",
        id: "queries-ready",
        impact:
          "Os controles conhecidos permitem usar as consultas disponíveis neste painel.",
        nextStep:
          "Consulte a aptidão ou localize um veículo em estoque quando necessário.",
        tone: "complete",
      },
    ];
  }

  return [
    {
      cause: "Liberação ainda não comprovada",
      id: "unknown-blocker",
      impact:
        "Os estados carregados não são suficientes para afirmar que as consultas estão disponíveis.",
      nextStep: "Revise o checklist de prontidão e o vínculo acima.",
      tone: "attention",
    },
  ];
}

const icons: Record<AttentionTone, ReactNode> = {
  attention: <AlertTriangle size={20} />,
  blocked: <AlertTriangle size={20} />,
  complete: <CheckCircle2 size={20} />,
  waiting: <Clock3 size={20} />,
};

export function AttentionPanel({
  onReloadLinkStatus,
  ...state
}: AttentionPanelProps) {
  const items = deriveAttentionItems(state);

  return (
    <section
      className="attention-panel"
      aria-labelledby="attention-title"
      aria-busy={
        state.contextLoading ||
        state.readinessLoading ||
        state.linkStatusLoading
      }
    >
      <header className="attention-panel__heading">
        <ClipboardCheck size={28} aria-hidden="true" />
        <div>
          <p>Próximos passos</p>
          <h2 id="attention-title">O que precisa da sua atenção agora</h2>
        </div>
      </header>
      <ul className="attention-panel__items">
        {items.map((item) => (
          <li key={item.id} data-tone={item.tone}>
            <span className="attention-panel__icon" aria-hidden="true">
              {icons[item.tone]}
            </span>
            <div className="attention-panel__content">
              <h3>{item.cause}</h3>
              <p>
                <strong>Impacto:</strong> {item.impact}
              </p>
              <p>
                <strong>Próxima ação:</strong> {item.nextStep}
              </p>
            </div>
            {item.action === "create-establishment" ? (
              <Button href="#establishment-creation" variant="secondary">
                Cadastrar estabelecimento
              </Button>
            ) : item.action === "confirm-access" ? (
              <Button href="#establishment-creation" variant="secondary">
                Ir para confirmação de acesso
              </Button>
            ) : item.action === "reload-link" && onReloadLinkStatus ? (
              <Button variant="secondary" onClick={onReloadLinkStatus}>
                Carregar vínculo novamente
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
