import { Button } from "@seu-renave/ui";
import { ArrowUpFromLine, LockKeyhole } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";

import {
  type CreateStockExitInput,
  type CreateStockExitResult,
  StockExitCreationClientError,
} from "../App.js";
import { businessDateInSaoPaulo } from "./UsedStockEntryPanel.js";

export interface UsedStockExitPanelProps {
  available: boolean;
  clock?: () => Date;
  initialPlate?: string;
  initialStockId?: number;
  onCreate: (input: CreateStockExitInput) => Promise<CreateStockExitResult>;
  selectionKey: string;
}

type BuyerDocumentType = "CPF" | "CNPJ";

interface Attempt {
  idempotencyKey: string;
  payloadKey: string;
}

interface FormValues {
  bairro: string;
  cep: string;
  codigoMunicipio: string;
  codigoSegurancaCrv: string;
  complemento: string;
  confirmed: boolean;
  dataVenda: string;
  email: string;
  logradouro: string;
  nome: string;
  numero: string;
  numeroCrv: string;
  numeroDocumento: string;
  placa: string;
  renavam: string;
  stockId: string;
  tipoDocumento: BuyerDocumentType;
  valorVenda: string;
}

type FieldErrors = Partial<Record<keyof FormValues, string>>;

const MAX_SALE_VALUE = 99_999_999.99;
const MAX_MUNICIPALITY_CODE = 2_147_483_647;
const FIRST_CNPJ_WEIGHTS = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const SECOND_CNPJ_WEIGHTS = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

function createInitialValues(
  initialStockId?: number,
  initialPlate?: string,
): FormValues {
  return {
    bairro: "",
    cep: "",
    codigoMunicipio: "",
    codigoSegurancaCrv: "",
    complemento: "",
    confirmed: false,
    dataVenda: "",
    email: "",
    logradouro: "",
    nome: "",
    numero: "",
    numeroCrv: "",
    numeroDocumento: "",
    placa: initialPlate
      ? initialPlate
          .toUpperCase()
          .replaceAll(/[^A-Z0-9]/gu, "")
          .slice(0, 7)
      : "",
    renavam: "",
    stockId:
      initialStockId !== undefined &&
      Number.isSafeInteger(initialStockId) &&
      initialStockId >= 1
        ? String(initialStockId)
        : "",
    tipoDocumento: "CPF",
    valorVenda: "",
  };
}

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return (
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() === Number(month) - 1 &&
    date.getUTCDate() === Number(day)
  );
}

function hasValidText(value: string, maxLength: number): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= maxLength &&
    !/[\u0000-\u001f\u007f]/u.test(trimmed)
  );
}

function cpfDigit(base: string, factor: number): number {
  let total = 0;
  for (const character of base) {
    total += Number(character) * factor;
    factor -= 1;
  }
  const remainder = (total * 10) % 11;
  return remainder === 10 ? 0 : remainder;
}

function isValidCpf(value: string): boolean {
  return (
    /^\d{11}$/u.test(value) &&
    !/^(\d)\1{10}$/u.test(value) &&
    cpfDigit(value.slice(0, 9), 10) === Number(value[9]) &&
    cpfDigit(value.slice(0, 10), 11) === Number(value[10])
  );
}

function cnpjDigit(
  values: readonly number[],
  weights: readonly number[],
): number {
  const total = values.reduce(
    (sum, value, index) => sum + value * (weights[index] ?? 0),
    0,
  );
  const remainder = total % 11;
  return remainder < 2 ? 0 : 11 - remainder;
}

function isValidCnpj(value: string): boolean {
  if (!/^[0-9A-Z]{12}\d{2}$/u.test(value) || /^(\d)\1{13}$/u.test(value)) {
    return false;
  }
  const base = [...value.slice(0, 12)].map(
    (character) => character.charCodeAt(0) - 48,
  );
  const first = cnpjDigit(base, FIRST_CNPJ_WEIGHTS);
  const second = cnpjDigit([...base, first], SECOND_CNPJ_WEIGHTS);
  return `${first}${second}` === value.slice(12);
}

function validate(values: FormValues, now: Date): FieldErrors {
  const errors: FieldErrors = {};

  const stockId = Number(values.stockId);
  if (
    !/^[1-9]\d{0,15}$/u.test(values.stockId.trim()) ||
    !Number.isSafeInteger(stockId) ||
    stockId < 1
  ) {
    errors.stockId =
      "Informe o número do registro de estoque (inteiro positivo).";
  }

  if (!/^[A-Z]{3}[0-9][0-9A-Z][0-9]{2}$/u.test(values.placa)) {
    errors.placa = "Informe uma placa válida com sete caracteres, sem hífen.";
  }

  if (!/^\d{11}$/u.test(values.renavam)) {
    errors.renavam = "Informe o RENAVAM com 11 dígitos.";
  }

  if (!/^\d{12}$/u.test(values.numeroCrv)) {
    errors.numeroCrv = "Informe o número do CRV com 12 dígitos.";
  }

  if (!/^\d{11}$/u.test(values.codigoSegurancaCrv)) {
    errors.codigoSegurancaCrv =
      "Informe o código de segurança do CRV com 11 dígitos.";
  }

  if (values.tipoDocumento === "CPF") {
    if (!isValidCpf(values.numeroDocumento)) {
      errors.numeroDocumento =
        "Informe um CPF válido com 11 dígitos, sem máscara.";
    }
  } else if (!isValidCnpj(values.numeroDocumento)) {
    errors.numeroDocumento =
      "Informe um CNPJ válido com 14 caracteres, sem máscara.";
  }

  if (!hasValidText(values.nome, 40)) {
    errors.nome = "Informe o nome completo do comprador (até 40 caracteres).";
  }

  const trimmedEmail = values.email.trim();
  if (
    !hasValidText(trimmedEmail, 254) ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(trimmedEmail)
  ) {
    errors.email = "Informe um e-mail válido do comprador.";
  }

  if (!/^\d{8}$/u.test(values.cep)) {
    errors.cep = "Informe o CEP com 8 dígitos, sem hífen.";
  }

  if (!hasValidText(values.logradouro, 200)) {
    errors.logradouro =
      "Informe o logradouro do endereço (até 200 caracteres).";
  }

  if (!hasValidText(values.numero, 30)) {
    errors.numero = "Informe o número do endereço (até 30 caracteres).";
  }

  if (
    values.complemento.trim().length > 0 &&
    !hasValidText(values.complemento, 200)
  ) {
    errors.complemento = "O complemento deve ter no máximo 200 caracteres.";
  }

  if (!hasValidText(values.bairro, 200)) {
    errors.bairro = "Informe o bairro do endereço (até 200 caracteres).";
  }

  const municipalityCode = Number(values.codigoMunicipio);
  if (
    !/^[1-9]\d{0,9}$/u.test(values.codigoMunicipio.trim()) ||
    !Number.isInteger(municipalityCode) ||
    municipalityCode < 1 ||
    municipalityCode > MAX_MUNICIPALITY_CODE
  ) {
    errors.codigoMunicipio =
      "Informe um código de município inteiro positivo válido.";
  }

  if (!isCalendarDate(values.dataVenda)) {
    errors.dataVenda = "Informe a data da venda.";
  } else if (values.dataVenda > businessDateInSaoPaulo(now)) {
    errors.dataVenda = "A data da venda não pode estar no futuro.";
  }

  const saleValue = Number(values.valorVenda);
  if (
    !Number.isFinite(saleValue) ||
    saleValue <= 0 ||
    saleValue > MAX_SALE_VALUE ||
    Math.round(saleValue * 100) < 1 ||
    Math.abs(saleValue - Math.round(saleValue * 100) / 100) > 1e-9
  ) {
    errors.valorVenda =
      "Informe um valor maior que zero e de até R$ 99.999.999,99 (até duas casas decimais).";
  }

  if (!values.confirmed) {
    errors.confirmed =
      "Confirme a conferência dos dados do veículo, do comprador e da venda antes de registrar.";
  }

  return errors;
}

function feedbackFor(error: unknown): string {
  if (!(error instanceof StockExitCreationClientError)) {
    return "Não foi possível registrar a solicitação local de saída. Os dados foram preservados.";
  }
  if (error.status === 401) {
    return "Sua sessão expirou. Recarregue a página para autenticar novamente.";
  }
  switch (error.code) {
    case "INVALID_STOCK_EXIT_INPUT":
      return "Revise os campos informados antes de tentar novamente.";
    case "INVALID_STOCK_EXIT_MUNICIPALITY":
      return "O código do município informado não consta no catálogo aceito. Revise o endereço.";
    case "INVALID_IDEMPOTENCY_KEY":
      return "Não foi possível validar a tentativa. Tente enviar novamente.";
    case "MFA_REQUIRED":
    case "MFA_RECENT_REQUIRED":
      return "Esta operação exige autenticação corporativa recente com verificação adicional.";
    case "CSRF_ORIGIN_MISMATCH":
      return "A origem da solicitação não foi aceita. Recarregue a página e tente novamente.";
    case "STOCK_EXIT_RESOURCE_NOT_FOUND":
      return "O contexto selecionado não está mais disponível. Recarregue a página.";
    case "STOCK_EXIT_PREFLIGHT_REJECTED":
      return "O veículo não está apto para saída neste estabelecimento segundo a verificação prévia no RENAVE.";
    case "STOCK_EXIT_OPERATION_CONFLICT":
      return "Já existe uma operação conflitante ou o vínculo operacional não está habilitado para este veículo.";
    case "STOCK_EXIT_IDEMPOTENCY_CONFLICT":
      return "Os dados diferem de uma tentativa anterior. Revise o formulário antes de iniciar outra operação.";
    case "STOCK_EXIT_RATE_LIMITED":
    case "STOCK_EXIT_PREFLIGHT_LIMITED":
      return error.retryAfterSeconds
        ? `Muitas tentativas. Aguarde ${error.retryAfterSeconds} segundos.`
        : "Muitas tentativas. Aguarde antes de tentar novamente.";
    case "STOCK_EXIT_PRINCIPALS_UNAVAILABLE":
      return "A identidade verificada do operador ou do estabelecimento está indisponível. Tente novamente mais tarde.";
    case "STOCK_EXIT_CERTIFICATE_UNAVAILABLE":
      return "O certificado digital do estabelecimento está indisponível no momento. Tente novamente mais tarde.";
    case "STOCK_EXIT_PREFLIGHT_UNAVAILABLE":
      return "A verificação prévia no RENAVE está temporariamente indisponível. Tente novamente com os mesmos dados.";
    case "STOCK_EXIT_OPERATION_NOT_CONFIGURED":
      return "A criação local de saída ainda não está habilitada neste ambiente.";
    case "STOCK_EXIT_RATE_LIMIT_UNAVAILABLE":
      return "O controle de segurança está temporariamente indisponível. Tente novamente com os mesmos dados.";
    case "STOCK_EXIT_OPERATION_UNAVAILABLE":
      return "Não foi possível confirmar a criação local. Tente novamente com os mesmos dados.";
    case "NETWORK_ERROR":
    case "INVALID_RESPONSE":
      return "A confirmação ficou indisponível. Tente novamente com os mesmos dados.";
  }
  return error.status >= 500
    ? "Não foi possível confirmar a criação local. Tente novamente com os mesmos dados."
    : "A criação local de saída não foi concluída. Revise o contexto e tente novamente.";
}

function preservesAttempt(error: unknown): boolean {
  return (
    error instanceof StockExitCreationClientError &&
    (error.status === 0 || error.status === 429 || error.status >= 500)
  );
}

export function UsedStockExitPanel({
  available,
  clock = () => new Date(),
  initialPlate,
  initialStockId,
  onCreate,
  selectionKey,
}: UsedStockExitPanelProps) {
  const [values, setValues] = useState<FormValues>(() =>
    createInitialValues(initialStockId, initialPlate),
  );
  const [errors, setErrors] = useState<FieldErrors>({});
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<
    { kind: "error" | "success"; message: string } | undefined
  >();
  const generation = useRef(0);
  const pendingRef = useRef(false);
  const attempt = useRef<Attempt | undefined>(undefined);

  useEffect(() => {
    generation.current += 1;
    pendingRef.current = false;
    attempt.current = undefined;
    setValues(createInitialValues(initialStockId, initialPlate));
    setErrors({});
    setFeedback(undefined);
    setPending(false);
    return () => {
      generation.current += 1;
      pendingRef.current = false;
    };
  }, [available, initialPlate, initialStockId, selectionKey]);

  function edit<K extends keyof FormValues>(field: K, value: FormValues[K]) {
    if (pendingRef.current) return;
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
    setFeedback(undefined);
    if (field !== "confirmed") {
      attempt.current = undefined;
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!available || pendingRef.current) return;
    const nextErrors = validate(values, clock());
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      setFeedback({ kind: "error", message: "Revise os campos destacados." });
      return;
    }

    const trimmedComplement = values.complemento.trim();
    const payload = {
      comprador: {
        email: values.email.trim(),
        endereco: {
          bairro: values.bairro.trim(),
          cep: values.cep,
          codigoMunicipio: Number(values.codigoMunicipio.trim()),
          ...(trimmedComplement ? { complemento: trimmedComplement } : {}),
          logradouro: values.logradouro.trim(),
          numero: values.numero.trim(),
        },
        nome: values.nome.trim(),
        numeroDocumento: values.numeroDocumento,
        tipoDocumento: values.tipoDocumento,
      },
      dataVenda: values.dataVenda,
      stockId: Number(values.stockId.trim()),
      valorVenda: Number(values.valorVenda),
      veiculo: {
        codigoSegurancaCrv: values.codigoSegurancaCrv,
        numeroCrv: values.numeroCrv,
        placa: values.placa,
        renavam: values.renavam,
      },
    };
    const payloadKey = JSON.stringify(payload);
    const currentAttempt =
      attempt.current?.payloadKey === payloadKey
        ? attempt.current
        : { idempotencyKey: crypto.randomUUID(), payloadKey };
    attempt.current = currentAttempt;
    const currentGeneration = generation.current;
    pendingRef.current = true;
    setPending(true);
    setFeedback(undefined);
    try {
      const result = await onCreate({
        ...payload,
        idempotencyKey: currentAttempt.idempotencyKey,
      });
      if (generation.current !== currentGeneration) return;
      attempt.current = undefined;
      setValues(createInitialValues());
      setErrors({});
      setFeedback({
        kind: "success",
        message: result.replayed
          ? "A solicitação local de saída já estava registrada e foi recuperada com segurança."
          : "Solicitação local de saída registrada. Nenhum envio ao RENAVE foi realizado.",
      });
    } catch (error) {
      if (generation.current !== currentGeneration) return;
      if (!preservesAttempt(error)) attempt.current = undefined;
      setFeedback({ kind: "error", message: feedbackFor(error) });
    } finally {
      if (generation.current === currentGeneration) {
        pendingRef.current = false;
        setPending(false);
      }
    }
  }

  return (
    <section
      className="stock-entry"
      aria-busy={pending}
      aria-labelledby="stock-exit-title"
    >
      <header className="stock-entry__heading">
        {available ? (
          <ArrowUpFromLine size={22} aria-hidden="true" />
        ) : (
          <LockKeyhole size={22} aria-hidden="true" />
        )}
        <div>
          <p>Saída de estoque usado</p>
          <h2 id="stock-exit-title">Registrar saída de estoque (venda)</h2>
        </div>
      </header>
      <p className="stock-entry__intro">
        O CPF do operador e o contato RENAVE do estabelecimento vêm dos perfis
        verificados no servidor e nunca são solicitados neste formulário. A
        solicitação fica retida localmente (HELD_LOCAL) para conferência antes
        de qualquer envio ao RENAVE.
      </p>

      {!available ? (
        <p className="stock-entry__blocked" role="status">
          A criação local de saída permanece indisponível até a API publicar a
          capability explícita e todos os controles de prontidão estarem
          liberados. Nenhum dado pode ser enviado por esta tela.
        </p>
      ) : (
        <form onSubmit={(event) => void submit(event)} noValidate>
          <fieldset disabled={pending}>
            <legend>Veículo e documento (CRV)</legend>

            <label htmlFor="stock-exit-stock-id">Registro de estoque</label>
            <input
              id="stock-exit-stock-id"
              inputMode="numeric"
              autoComplete="off"
              maxLength={16}
              value={values.stockId}
              aria-invalid={Boolean(errors.stockId)}
              aria-describedby="stock-exit-stock-id-error"
              onChange={(event) =>
                edit(
                  "stockId",
                  event.currentTarget.value.replaceAll(/\D/gu, "").slice(0, 16),
                )
              }
            />
            <p id="stock-exit-stock-id-error" className="field-error">
              {errors.stockId}
            </p>

            <label htmlFor="stock-exit-plate">Placa</label>
            <input
              id="stock-exit-plate"
              autoCapitalize="characters"
              autoComplete="off"
              maxLength={7}
              value={values.placa}
              aria-invalid={Boolean(errors.placa)}
              aria-describedby="stock-exit-plate-error"
              onChange={(event) =>
                edit(
                  "placa",
                  event.currentTarget.value
                    .toUpperCase()
                    .replaceAll(/[^A-Z0-9]/gu, "")
                    .slice(0, 7),
                )
              }
            />
            <p id="stock-exit-plate-error" className="field-error">
              {errors.placa}
            </p>

            <label htmlFor="stock-exit-renavam">RENAVAM</label>
            <input
              id="stock-exit-renavam"
              inputMode="numeric"
              autoComplete="off"
              maxLength={11}
              value={values.renavam}
              aria-invalid={Boolean(errors.renavam)}
              aria-describedby="stock-exit-renavam-error"
              onChange={(event) =>
                edit(
                  "renavam",
                  event.currentTarget.value.replaceAll(/\D/gu, "").slice(0, 11),
                )
              }
            />
            <p id="stock-exit-renavam-error" className="field-error">
              {errors.renavam}
            </p>

            <label htmlFor="stock-exit-crv-number">Número do CRV</label>
            <input
              id="stock-exit-crv-number"
              inputMode="numeric"
              autoComplete="off"
              maxLength={12}
              value={values.numeroCrv}
              aria-invalid={Boolean(errors.numeroCrv)}
              aria-describedby="stock-exit-crv-number-error"
              onChange={(event) =>
                edit(
                  "numeroCrv",
                  event.currentTarget.value.replaceAll(/\D/gu, "").slice(0, 12),
                )
              }
            />
            <p id="stock-exit-crv-number-error" className="field-error">
              {errors.numeroCrv}
            </p>

            <label htmlFor="stock-exit-crv-security">
              Código de segurança do CRV
            </label>
            <input
              id="stock-exit-crv-security"
              inputMode="numeric"
              autoComplete="off"
              maxLength={11}
              value={values.codigoSegurancaCrv}
              aria-invalid={Boolean(errors.codigoSegurancaCrv)}
              aria-describedby="stock-exit-crv-security-error"
              onChange={(event) =>
                edit(
                  "codigoSegurancaCrv",
                  event.currentTarget.value.replaceAll(/\D/gu, "").slice(0, 11),
                )
              }
            />
            <p id="stock-exit-crv-security-error" className="field-error">
              {errors.codigoSegurancaCrv}
            </p>
          </fieldset>

          <fieldset disabled={pending}>
            <legend>Comprador</legend>

            <label htmlFor="stock-exit-buyer-doc-type">
              Tipo de documento do comprador
            </label>
            <select
              id="stock-exit-buyer-doc-type"
              value={values.tipoDocumento}
              onChange={(event) => {
                edit(
                  "tipoDocumento",
                  event.currentTarget.value as BuyerDocumentType,
                );
                edit("numeroDocumento", "");
              }}
            >
              <option value="CPF">CPF</option>
              <option value="CNPJ">CNPJ</option>
            </select>

            <label htmlFor="stock-exit-buyer-document">
              Número do documento, sem máscara
            </label>
            <input
              id="stock-exit-buyer-document"
              autoComplete="off"
              maxLength={values.tipoDocumento === "CPF" ? 11 : 14}
              value={values.numeroDocumento}
              aria-invalid={Boolean(errors.numeroDocumento)}
              aria-describedby="stock-exit-buyer-document-error"
              onChange={(event) =>
                edit(
                  "numeroDocumento",
                  values.tipoDocumento === "CPF"
                    ? event.currentTarget.value
                        .replaceAll(/\D/gu, "")
                        .slice(0, 11)
                    : event.currentTarget.value
                        .toUpperCase()
                        .replaceAll(/[^A-Z0-9]/gu, "")
                        .slice(0, 14),
                )
              }
            />
            <p id="stock-exit-buyer-document-error" className="field-error">
              {errors.numeroDocumento}
            </p>

            <label htmlFor="stock-exit-buyer-name">Nome completo</label>
            <input
              id="stock-exit-buyer-name"
              autoComplete="off"
              maxLength={40}
              value={values.nome}
              aria-invalid={Boolean(errors.nome)}
              aria-describedby="stock-exit-buyer-name-error"
              onChange={(event) => edit("nome", event.currentTarget.value)}
            />
            <p id="stock-exit-buyer-name-error" className="field-error">
              {errors.nome}
            </p>

            <label htmlFor="stock-exit-buyer-email">
              E-mail do comprador (recebe a ATPV-e para assinar)
            </label>
            <input
              id="stock-exit-buyer-email"
              type="email"
              autoComplete="off"
              maxLength={254}
              value={values.email}
              aria-invalid={Boolean(errors.email)}
              aria-describedby="stock-exit-buyer-email-error"
              onChange={(event) => edit("email", event.currentTarget.value)}
            />
            <p id="stock-exit-buyer-email-error" className="field-error">
              {errors.email}
            </p>
          </fieldset>

          <fieldset disabled={pending}>
            <legend>Endereço do comprador</legend>

            <label htmlFor="stock-exit-buyer-cep">CEP</label>
            <input
              id="stock-exit-buyer-cep"
              inputMode="numeric"
              autoComplete="off"
              maxLength={8}
              value={values.cep}
              aria-invalid={Boolean(errors.cep)}
              aria-describedby="stock-exit-buyer-cep-error"
              onChange={(event) =>
                edit(
                  "cep",
                  event.currentTarget.value.replaceAll(/\D/gu, "").slice(0, 8),
                )
              }
            />
            <p id="stock-exit-buyer-cep-error" className="field-error">
              {errors.cep}
            </p>

            <label htmlFor="stock-exit-buyer-street">Logradouro</label>
            <input
              id="stock-exit-buyer-street"
              autoComplete="off"
              maxLength={200}
              value={values.logradouro}
              aria-invalid={Boolean(errors.logradouro)}
              aria-describedby="stock-exit-buyer-street-error"
              onChange={(event) =>
                edit("logradouro", event.currentTarget.value)
              }
            />
            <p id="stock-exit-buyer-street-error" className="field-error">
              {errors.logradouro}
            </p>

            <label htmlFor="stock-exit-buyer-number">Número</label>
            <input
              id="stock-exit-buyer-number"
              autoComplete="off"
              maxLength={30}
              value={values.numero}
              aria-invalid={Boolean(errors.numero)}
              aria-describedby="stock-exit-buyer-number-error"
              onChange={(event) => edit("numero", event.currentTarget.value)}
            />
            <p id="stock-exit-buyer-number-error" className="field-error">
              {errors.numero}
            </p>

            <label htmlFor="stock-exit-buyer-complement">
              Complemento (opcional)
            </label>
            <input
              id="stock-exit-buyer-complement"
              autoComplete="off"
              maxLength={200}
              value={values.complemento}
              aria-invalid={Boolean(errors.complemento)}
              aria-describedby="stock-exit-buyer-complement-error"
              onChange={(event) =>
                edit("complemento", event.currentTarget.value)
              }
            />
            <p id="stock-exit-buyer-complement-error" className="field-error">
              {errors.complemento}
            </p>

            <label htmlFor="stock-exit-buyer-neighborhood">Bairro</label>
            <input
              id="stock-exit-buyer-neighborhood"
              autoComplete="off"
              maxLength={200}
              value={values.bairro}
              aria-invalid={Boolean(errors.bairro)}
              aria-describedby="stock-exit-buyer-neighborhood-error"
              onChange={(event) => edit("bairro", event.currentTarget.value)}
            />
            <p id="stock-exit-buyer-neighborhood-error" className="field-error">
              {errors.bairro}
            </p>

            <label htmlFor="stock-exit-buyer-municipality">
              Código do município (RENAVE)
            </label>
            <input
              id="stock-exit-buyer-municipality"
              inputMode="numeric"
              autoComplete="off"
              maxLength={10}
              value={values.codigoMunicipio}
              aria-invalid={Boolean(errors.codigoMunicipio)}
              aria-describedby="stock-exit-buyer-municipality-error"
              onChange={(event) =>
                edit(
                  "codigoMunicipio",
                  event.currentTarget.value.replaceAll(/\D/gu, "").slice(0, 10),
                )
              }
            />
            <p id="stock-exit-buyer-municipality-error" className="field-error">
              {errors.codigoMunicipio}
            </p>
          </fieldset>

          <fieldset disabled={pending}>
            <legend>Dados da venda</legend>

            <label htmlFor="stock-exit-sale-date">Data da venda</label>
            <input
              id="stock-exit-sale-date"
              type="date"
              value={values.dataVenda}
              aria-invalid={Boolean(errors.dataVenda)}
              aria-describedby="stock-exit-sale-date-error"
              onChange={(event) => edit("dataVenda", event.currentTarget.value)}
            />
            <p id="stock-exit-sale-date-error" className="field-error">
              {errors.dataVenda}
            </p>

            <label htmlFor="stock-exit-sale-value">Valor da venda</label>
            <input
              id="stock-exit-sale-value"
              type="number"
              inputMode="decimal"
              min="0.01"
              max="99999999.99"
              step="0.01"
              value={values.valorVenda}
              aria-invalid={Boolean(errors.valorVenda)}
              aria-describedby="stock-exit-sale-value-error"
              onChange={(event) =>
                edit("valorVenda", event.currentTarget.value)
              }
            />
            <p id="stock-exit-sale-value-error" className="field-error">
              {errors.valorVenda}
            </p>
          </fieldset>

          <fieldset disabled={pending}>
            <legend>Confirmação reforçada</legend>
            <label
              className="stock-entry__confirm"
              htmlFor="stock-exit-confirm"
            >
              <input
                id="stock-exit-confirm"
                type="checkbox"
                checked={values.confirmed}
                aria-invalid={Boolean(errors.confirmed)}
                aria-describedby="stock-exit-confirm-error"
                onChange={(event) =>
                  edit("confirmed", event.currentTarget.checked)
                }
              />
              <span>
                Confirmo que conferi os dados do veículo, do comprador e da
                venda antes de registrar a solicitação local de saída.
              </span>
            </label>
            <p id="stock-exit-confirm-error" className="field-error">
              {errors.confirmed}
            </p>
          </fieldset>

          <Button
            type="submit"
            disabled={!values.confirmed}
            loading={pending}
            loadingLabel="Registrando…"
          >
            Registrar saída local
          </Button>
        </form>
      )}

      {feedback ? (
        <p
          className={`stock-entry__feedback stock-entry__feedback--${feedback.kind}`}
          role={feedback.kind === "error" ? "alert" : "status"}
        >
          {feedback.message}
        </p>
      ) : null}
    </section>
  );
}
