import { Button } from "@seu-renave/ui";
import { Building2, ShieldCheck } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";

import {
  type CreateEstablishmentInput,
  type CreateEstablishmentResult,
  EstablishmentCreationClientError,
  type EstablishmentManagementCapability,
} from "../App.js";

export interface EstablishmentCreationPanelProps {
  capability: EstablishmentManagementCapability;
  onCreate: (
    input: CreateEstablishmentInput,
  ) => Promise<CreateEstablishmentResult>;
  selectionKey: string;
}

interface Attempt {
  idempotencyKey: string;
  payloadKey: string;
}

interface FieldErrors {
  cnpj?: string;
  tradeName?: string;
}

function errorMessage(error: unknown): string {
  if (!(error instanceof EstablishmentCreationClientError)) {
    return "Não foi possível cadastrar. Os dados foram preservados para você tentar novamente.";
  }
  switch (error.code) {
    case "INVALID_ESTABLISHMENT_INPUT":
      return "Revise os campos informados antes de tentar novamente.";
    case "ESTABLISHMENT_CNPJ_CONFLICT":
      return "Já existe um estabelecimento com esse CNPJ nesta organização.";
    case "IDEMPOTENCY_KEY_REUSED":
      return "A tentativa anterior não corresponde mais a estes dados. Revise o formulário e envie novamente.";
    case "MFA_REQUIRED":
      return "Confirme novamente seu acesso corporativo antes de cadastrar.";
    case "TENANT_RESOURCE_NOT_FOUND":
      return "Seu acesso à organização mudou. Recarregue o painel antes de tentar novamente.";
    case "CONTEXT_CHANGED":
      return "A organização ativa mudou. O resultado anterior foi ignorado com segurança.";
    case "TENANT_MUTATION_RATE_LIMITED":
      return error.retryAfterSeconds
        ? `Muitas tentativas. Aguarde ${error.retryAfterSeconds} segundos antes de tentar novamente.`
        : "Muitas tentativas. Aguarde antes de tentar novamente.";
    case "NETWORK_ERROR":
      return "A conexão falhou. Os dados foram preservados para uma nova tentativa segura.";
    default:
      if (error.status === 401) {
        return "Sua sessão expirou. Entre novamente antes de cadastrar.";
      }
      return "O cadastro está temporariamente indisponível. Os dados foram preservados.";
  }
}

function preservesAttempt(error: unknown): boolean {
  return (
    error instanceof EstablishmentCreationClientError &&
    error.code !== "CONTEXT_CHANGED" &&
    (error.status === 0 || error.status === 429 || error.status === 503)
  );
}

export function EstablishmentCreationPanel({
  capability,
  onCreate,
  selectionKey,
}: EstablishmentCreationPanelProps) {
  const [cnpj, setCnpj] = useState("");
  const [tradeName, setTradeName] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [feedback, setFeedback] = useState<
    { kind: "error" | "success"; message: string } | undefined
  >();
  const [pending, setPending] = useState(false);
  const attemptRef = useRef<Attempt | undefined>(undefined);
  const pendingRef = useRef(false);
  const generationRef = useRef(0);
  const cnpjRef = useRef<HTMLInputElement>(null);
  const tradeNameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    generationRef.current += 1;
    setCnpj("");
    setTradeName("");
    setErrors({});
    setFeedback(undefined);
    setPending(false);
    pendingRef.current = false;
    attemptRef.current = undefined;
    return () => {
      // Invalida a promise ainda no cleanup da seleção anterior, antes do
      // efeito passivo da próxima seleção poder executar.
      generationRef.current += 1;
      pendingRef.current = false;
    };
  }, [selectionKey]);

  function edit(field: "cnpj" | "tradeName", value: string) {
    if (field === "cnpj") setCnpj(value);
    else setTradeName(value);
    setErrors((current) => ({ ...current, [field]: undefined }));
    setFeedback(undefined);
    attemptRef.current = undefined;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pendingRef.current) return;
    const nextErrors: FieldErrors = {};
    if (!cnpj.trim()) nextErrors.cnpj = "Informe o CNPJ do estabelecimento.";
    if (!tradeName.trim()) nextErrors.tradeName = "Informe o nome comercial.";
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      setFeedback({
        kind: "error",
        message: "Revise os campos destacados.",
      });
      if (nextErrors.cnpj) cnpjRef.current?.focus();
      else tradeNameRef.current?.focus();
      return;
    }

    const normalizedTradeName = tradeName.trim();
    const payloadKey = JSON.stringify({ cnpj, tradeName: normalizedTradeName });
    const attempt =
      attemptRef.current?.payloadKey === payloadKey
        ? attemptRef.current
        : { idempotencyKey: crypto.randomUUID(), payloadKey };
    attemptRef.current = attempt;
    const generation = generationRef.current;
    pendingRef.current = true;
    setPending(true);
    setFeedback(undefined);
    try {
      const result = await onCreate({
        cnpj,
        idempotencyKey: attempt.idempotencyKey,
        tradeName: normalizedTradeName,
      });
      if (generationRef.current !== generation) return;
      setCnpj("");
      setTradeName("");
      setErrors({});
      attemptRef.current = undefined;
      setFeedback({
        kind: "success",
        message: `${result.establishment.tradeName} foi cadastrado e selecionado. O vínculo RENAVE ainda não foi iniciado.`,
      });
    } catch (error) {
      if (
        generationRef.current !== generation ||
        (error instanceof EstablishmentCreationClientError &&
          error.code === "CONTEXT_CHANGED")
      ) {
        return;
      }
      if (!preservesAttempt(error)) attemptRef.current = undefined;
      setFeedback({ kind: "error", message: errorMessage(error) });
    } finally {
      if (generationRef.current === generation) {
        pendingRef.current = false;
        setPending(false);
      }
    }
  }

  if (capability === "denied") return null;

  if (capability === "mfa_required") {
    return (
      <section
        className="establishment-creation"
        aria-labelledby="establishment-creation-title"
      >
        <header className="establishment-creation__heading">
          <ShieldCheck size={22} aria-hidden="true" />
          <div>
            <p>Gestão de estabelecimentos</p>
            <h2 id="establishment-creation-title">Confirme seu acesso</h2>
          </div>
        </header>
        <p>
          O cadastro exige uma autenticação corporativa recente com verificação
          adicional.
        </p>
        <Button href="/api/auth/login" variant="secondary">
          Confirmar acesso corporativo
        </Button>
      </section>
    );
  }

  return (
    <section
      className="establishment-creation"
      aria-labelledby="establishment-creation-title"
      aria-busy={pending}
    >
      <header className="establishment-creation__heading">
        <Building2 size={22} aria-hidden="true" />
        <div>
          <p>Gestão de estabelecimentos</p>
          <h2 id="establishment-creation-title">Cadastrar estabelecimento</h2>
        </div>
      </header>
      <p className="establishment-creation__intro">
        Cadastre os dados locais. O vínculo Credencia/RENAVE continuará como não
        iniciado até uma verificação separada.
      </p>
      <form onSubmit={(event) => void submit(event)} noValidate>
        <div className="establishment-creation__field">
          <label htmlFor="establishment-cnpj">CNPJ</label>
          <input
            ref={cnpjRef}
            id="establishment-cnpj"
            name="cnpj"
            autoComplete="off"
            maxLength={32}
            value={cnpj}
            aria-invalid={Boolean(errors.cnpj)}
            aria-describedby="establishment-cnpj-help establishment-cnpj-error"
            onChange={(event) => edit("cnpj", event.currentTarget.value)}
          />
          <p id="establishment-cnpj-help">
            Aceita CNPJ numérico ou alfanumérico, com ou sem máscara.
          </p>
          <p id="establishment-cnpj-error" className="field-error">
            {errors.cnpj}
          </p>
        </div>
        <div className="establishment-creation__field">
          <label htmlFor="establishment-trade-name">Nome comercial</label>
          <input
            ref={tradeNameRef}
            id="establishment-trade-name"
            name="tradeName"
            autoComplete="organization"
            maxLength={160}
            value={tradeName}
            aria-invalid={Boolean(errors.tradeName)}
            aria-describedby="establishment-trade-name-error"
            onChange={(event) => edit("tradeName", event.currentTarget.value)}
          />
          <p id="establishment-trade-name-error" className="field-error">
            {errors.tradeName}
          </p>
        </div>
        <Button type="submit" loading={pending} loadingLabel="Cadastrando…">
          Cadastrar estabelecimento
        </Button>
      </form>
      {feedback ? (
        <p
          className={`establishment-creation__feedback establishment-creation__feedback--${feedback.kind}`}
          role={feedback.kind === "error" ? "alert" : "status"}
        >
          {feedback.message}
        </p>
      ) : null}
    </section>
  );
}
