import { Button } from "@seu-renave/ui";
import { CarFront, LockKeyhole } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";

import {
  type BrowserCrvType,
  type CreateStockEntryInput,
  type CreateStockEntryResult,
  StockEntryCreationClientError,
} from "../App.js";

export interface UsedStockEntryPanelProps {
  available: boolean;
  clock?: () => Date;
  onCreate: (input: CreateStockEntryInput) => Promise<CreateStockEntryResult>;
  selectionKey: string;
}

type OwnerDocumentType = "CPF" | "CNPJ";

interface Attempt {
  idempotencyKey: string;
  payloadKey: string;
}

interface FormValues {
  codigoSegurancaCrv: string;
  dataCompra: string;
  dataHoraMedicaoHodometro: string;
  documentoProprietarioAtual: string;
  emailVendedor: string;
  numeroCrv: string;
  placa: string;
  quilometragemHodometro: string;
  renavam: string;
  tipoCrv: BrowserCrvType;
  tipoDocumentoProprietarioAtual: OwnerDocumentType;
  valorCompra: string;
}

type FieldErrors = Partial<Record<keyof FormValues, string>>;

const initialValues: FormValues = {
  codigoSegurancaCrv: "",
  dataCompra: "",
  dataHoraMedicaoHodometro: "",
  documentoProprietarioAtual: "",
  emailVendedor: "",
  numeroCrv: "",
  placa: "",
  quilometragemHodometro: "",
  renavam: "",
  tipoCrv: "DIGITAL",
  tipoDocumentoProprietarioAtual: "CPF",
  valorCompra: "",
};

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * Mantém o instante escolhido pelo operador e explicita o offset local. O
 * backend nunca precisa interpretar um `datetime-local` no fuso do servidor.
 */
export function localDateTimeWithOffset(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const date = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    0,
    0,
  );
  if (
    date.getFullYear() !== Number(year) ||
    date.getMonth() !== Number(month) - 1 ||
    date.getDate() !== Number(day) ||
    date.getHours() !== Number(hour) ||
    date.getMinutes() !== Number(minute)
  ) {
    return null;
  }
  const minutesEast = -date.getTimezoneOffset();
  const sign = minutesEast >= 0 ? "+" : "-";
  const absolute = Math.abs(minutesEast);
  return `${value}:00${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

const businessDateFormatter = new Intl.DateTimeFormat("en-US", {
  day: "2-digit",
  month: "2-digit",
  timeZone: "America/Sao_Paulo",
  year: "numeric",
});

export function businessDateInSaoPaulo(now: Date): string {
  const parts = new Map(
    businessDateFormatter
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.get("year")}-${parts.get("month")}-${parts.get("day")}`;
}

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  return (
    date.getFullYear() === Number(year) &&
    date.getMonth() === Number(month) - 1 &&
    date.getDate() === Number(day)
  );
}

function validate(values: FormValues, now: Date): FieldErrors {
  const errors: FieldErrors = {};
  if (!isCalendarDate(values.dataCompra)) {
    errors.dataCompra = "Informe a data da compra.";
  } else if (values.dataCompra > businessDateInSaoPaulo(now)) {
    errors.dataCompra = "A data da compra não pode estar no futuro.";
  }
  if (
    !/^[-A-Za-z0-9_.]+@[-A-Za-z0-9_]+\.[-A-Za-z0-9_.]+$/u.test(
      values.emailVendedor,
    )
  ) {
    errors.emailVendedor = "Informe um e-mail válido do vendedor.";
  }
  const purchaseValue = Number(values.valorCompra);
  if (
    !Number.isFinite(purchaseValue) ||
    purchaseValue <= 0 ||
    purchaseValue > 99_999_999.99
  ) {
    errors.valorCompra =
      "Informe um valor maior que zero e de até R$ 99.999.999,99.";
  }
  if (!/^[A-Z]{3}[0-9][0-9A-Z][0-9]{2}$/u.test(values.placa)) {
    errors.placa = "Informe uma placa válida com sete caracteres, sem hífen.";
  }
  if (!/^\d{11}$/u.test(values.codigoSegurancaCrv)) {
    errors.codigoSegurancaCrv =
      "Informe o código de segurança do CRV com 11 dígitos.";
  }
  const expectedDocumentLength =
    values.tipoDocumentoProprietarioAtual === "CPF" ? 11 : 14;
  if (
    !new RegExp(
      values.tipoDocumentoProprietarioAtual === "CPF"
        ? `^\\d{${expectedDocumentLength}}$`
        : "^[A-Z0-9]{12}\\d{2}$",
      "u",
    ).test(values.documentoProprietarioAtual)
  ) {
    errors.documentoProprietarioAtual =
      values.tipoDocumentoProprietarioAtual === "CPF"
        ? "Informe o CPF com 11 caracteres, sem máscara."
        : "Informe o CNPJ com 14 caracteres, sem máscara.";
  }
  const odometer = Number(values.quilometragemHodometro);
  if (
    !Number.isSafeInteger(odometer) ||
    odometer < 0 ||
    odometer > 2_147_483_647
  ) {
    errors.quilometragemHodometro =
      "Informe uma quilometragem inteira entre 0 e 2.147.483.647.";
  }
  const measurement = localDateTimeWithOffset(values.dataHoraMedicaoHodometro);
  if (!measurement) {
    errors.dataHoraMedicaoHodometro = "Informe a data e a hora da medição.";
  } else if (Date.parse(measurement) > now.getTime()) {
    errors.dataHoraMedicaoHodometro =
      "A medição do hodômetro não pode estar no futuro.";
  }
  if (values.numeroCrv && !/^\d{12}$/u.test(values.numeroCrv)) {
    errors.numeroCrv = "Informe o número do CRV com 12 dígitos.";
  }
  if (values.renavam && !/^\d{11}$/u.test(values.renavam)) {
    errors.renavam = "Informe o RENAVAM com 11 dígitos.";
  }
  return errors;
}

function feedbackFor(error: unknown): string {
  if (!(error instanceof StockEntryCreationClientError)) {
    return "Não foi possível registrar a solicitação local. Os dados foram preservados.";
  }
  switch (error.code) {
    case "INVALID_STOCK_ENTRY_INPUT":
      return "Revise os campos informados antes de tentar novamente.";
    case "STOCK_ENTRY_PRINCIPALS_UNAVAILABLE":
      return "A identidade verificada do operador ou do estabelecimento está indisponível. Tente novamente mais tarde.";
    case "STOCK_ENTRY_OPERATION_CONFLICT":
      return "Os dados diferem de uma tentativa anterior. Revise o formulário antes de iniciar outra operação.";
    case "STOCK_ENTRY_RATE_LIMITED":
      return error.retryAfterSeconds
        ? `Muitas tentativas. Aguarde ${error.retryAfterSeconds} segundos.`
        : "Muitas tentativas. Aguarde antes de tentar novamente.";
    case "STOCK_ENTRY_OPERATION_NOT_CONFIGURED":
      return "A criação local ainda não está habilitada neste ambiente.";
    case "STOCK_ENTRY_RESOURCE_NOT_FOUND":
      return "O contexto selecionado não está mais disponível. Recarregue a página.";
    case "STOCK_ENTRY_RATE_LIMIT_UNAVAILABLE":
      return "O controle de segurança está temporariamente indisponível. Tente novamente com os mesmos dados.";
    case "STOCK_ENTRY_OPERATION_UNAVAILABLE":
      return "Não foi possível confirmar a criação local. Tente novamente com os mesmos dados.";
    case "NETWORK_ERROR":
    case "INVALID_RESPONSE":
      return "A confirmação ficou indisponível. Tente novamente com os mesmos dados.";
  }
  return error.status >= 500
    ? "Não foi possível confirmar a criação local. Tente novamente com os mesmos dados."
    : "A criação local não foi concluída. Revise o contexto e tente novamente.";
}

function preservesAttempt(error: unknown): boolean {
  return (
    error instanceof StockEntryCreationClientError &&
    (error.status === 0 || error.status === 429 || error.status >= 500)
  );
}

export function UsedStockEntryPanel({
  available,
  clock = () => new Date(),
  onCreate,
  selectionKey,
}: UsedStockEntryPanelProps) {
  const [values, setValues] = useState<FormValues>(initialValues);
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
    setValues(initialValues);
    setErrors({});
    setFeedback(undefined);
    setPending(false);
    return () => {
      generation.current += 1;
      pendingRef.current = false;
    };
  }, [available, selectionKey]);

  function edit<K extends keyof FormValues>(field: K, value: FormValues[K]) {
    if (pendingRef.current) return;
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
    setFeedback(undefined);
    attempt.current = undefined;
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

    const measurement = localDateTimeWithOffset(
      values.dataHoraMedicaoHodometro,
    )!;
    const payload = {
      dataCompra: values.dataCompra,
      emailVendedor: values.emailVendedor,
      valorCompra: Number(values.valorCompra),
      veiculo: {
        codigoSegurancaCrv: values.codigoSegurancaCrv.trim(),
        dataHoraMedicaoHodometro: measurement,
        documentoProprietarioAtual: values.documentoProprietarioAtual,
        ...(values.numeroCrv ? { numeroCrv: values.numeroCrv } : {}),
        placa: values.placa,
        quilometragemHodometro: Number(values.quilometragemHodometro),
        ...(values.renavam ? { renavam: values.renavam } : {}),
        tipoCrv: values.tipoCrv,
        tipoDocumentoProprietarioAtual: values.tipoDocumentoProprietarioAtual,
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
      setValues(initialValues);
      setErrors({});
      setFeedback({
        kind: "success",
        message: result.replayed
          ? "A solicitação local já estava registrada e foi recuperada com segurança."
          : "Solicitação local registrada. Nenhum envio ao RENAVE foi realizado.",
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
      aria-labelledby="stock-entry-title"
    >
      <header className="stock-entry__heading">
        {available ? (
          <CarFront size={22} aria-hidden="true" />
        ) : (
          <LockKeyhole size={22} aria-hidden="true" />
        )}
        <div>
          <p>Entrada de estoque usado</p>
          <h2 id="stock-entry-title">Registrar compra do veículo</h2>
        </div>
      </header>
      <p className="stock-entry__intro">
        O CPF do operador e o contato RENAVE do estabelecimento vêm dos perfis
        verificados no servidor e nunca são solicitados neste formulário.
      </p>

      {!available ? (
        <p className="stock-entry__blocked" role="status">
          A criação local permanece indisponível até a API publicar a capability
          explícita e todos os controles de prontidão estarem liberados. Nenhum
          dado pode ser enviado por esta tela.
        </p>
      ) : (
        <form onSubmit={(event) => void submit(event)} noValidate>
          <fieldset disabled={pending}>
            <legend>Dados da compra</legend>
            <label htmlFor="stock-entry-purchase-date">Data da compra</label>
            <input
              id="stock-entry-purchase-date"
              type="date"
              value={values.dataCompra}
              aria-invalid={Boolean(errors.dataCompra)}
              aria-describedby="stock-entry-purchase-date-error"
              onChange={(event) =>
                edit("dataCompra", event.currentTarget.value)
              }
            />
            <p id="stock-entry-purchase-date-error" className="field-error">
              {errors.dataCompra}
            </p>

            <label htmlFor="stock-entry-seller-email">E-mail do vendedor</label>
            <input
              id="stock-entry-seller-email"
              type="email"
              autoComplete="off"
              maxLength={254}
              value={values.emailVendedor}
              aria-invalid={Boolean(errors.emailVendedor)}
              aria-describedby="stock-entry-seller-email-error"
              onChange={(event) =>
                edit("emailVendedor", event.currentTarget.value)
              }
            />
            <p id="stock-entry-seller-email-error" className="field-error">
              {errors.emailVendedor}
            </p>

            <label htmlFor="stock-entry-purchase-value">Valor da compra</label>
            <input
              id="stock-entry-purchase-value"
              type="number"
              inputMode="decimal"
              min="0.01"
              max="99999999.99"
              step="0.01"
              value={values.valorCompra}
              aria-invalid={Boolean(errors.valorCompra)}
              aria-describedby="stock-entry-purchase-value-error"
              onChange={(event) =>
                edit("valorCompra", event.currentTarget.value)
              }
            />
            <p id="stock-entry-purchase-value-error" className="field-error">
              {errors.valorCompra}
            </p>
          </fieldset>

          <fieldset disabled={pending}>
            <legend>Veículo e documento</legend>
            <label htmlFor="stock-entry-plate">Placa</label>
            <input
              id="stock-entry-plate"
              autoCapitalize="characters"
              autoComplete="off"
              maxLength={7}
              value={values.placa}
              aria-invalid={Boolean(errors.placa)}
              aria-describedby="stock-entry-plate-error"
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
            <p id="stock-entry-plate-error" className="field-error">
              {errors.placa}
            </p>

            <label htmlFor="stock-entry-crv-type">Tipo do CRV</label>
            <select
              id="stock-entry-crv-type"
              value={values.tipoCrv}
              onChange={(event) =>
                edit("tipoCrv", event.currentTarget.value as BrowserCrvType)
              }
            >
              <option value="AZUL">CRV azul</option>
              <option value="VERDE">CRV verde</option>
              <option value="BRANCO">CRV branco</option>
              <option value="DIGITAL">CRV digital</option>
            </select>

            <label htmlFor="stock-entry-crv-security">
              Código de segurança do CRV
            </label>
            <input
              id="stock-entry-crv-security"
              inputMode="numeric"
              autoComplete="off"
              maxLength={11}
              value={values.codigoSegurancaCrv}
              aria-invalid={Boolean(errors.codigoSegurancaCrv)}
              aria-describedby="stock-entry-crv-security-error"
              onChange={(event) =>
                edit(
                  "codigoSegurancaCrv",
                  event.currentTarget.value.replaceAll(/\D/gu, "").slice(0, 11),
                )
              }
            />
            <p id="stock-entry-crv-security-error" className="field-error">
              {errors.codigoSegurancaCrv}
            </p>

            <label htmlFor="stock-entry-crv-number">
              Número do CRV (opcional)
            </label>
            <input
              id="stock-entry-crv-number"
              inputMode="numeric"
              autoComplete="off"
              maxLength={12}
              value={values.numeroCrv}
              aria-invalid={Boolean(errors.numeroCrv)}
              aria-describedby="stock-entry-crv-number-error"
              onChange={(event) =>
                edit(
                  "numeroCrv",
                  event.currentTarget.value.replaceAll(/\D/gu, "").slice(0, 12),
                )
              }
            />
            <p id="stock-entry-crv-number-error" className="field-error">
              {errors.numeroCrv}
            </p>

            <label htmlFor="stock-entry-renavam">RENAVAM (opcional)</label>
            <input
              id="stock-entry-renavam"
              inputMode="numeric"
              autoComplete="off"
              maxLength={11}
              value={values.renavam}
              aria-invalid={Boolean(errors.renavam)}
              aria-describedby="stock-entry-renavam-error"
              onChange={(event) =>
                edit(
                  "renavam",
                  event.currentTarget.value.replaceAll(/\D/gu, "").slice(0, 11),
                )
              }
            />
            <p id="stock-entry-renavam-error" className="field-error">
              {errors.renavam}
            </p>

            <label htmlFor="stock-entry-owner-type">
              Documento do proprietário atual
            </label>
            <select
              id="stock-entry-owner-type"
              value={values.tipoDocumentoProprietarioAtual}
              onChange={(event) => {
                edit(
                  "tipoDocumentoProprietarioAtual",
                  event.currentTarget.value as OwnerDocumentType,
                );
                edit("documentoProprietarioAtual", "");
              }}
            >
              <option value="CPF">CPF</option>
              <option value="CNPJ">CNPJ</option>
            </select>
            <label htmlFor="stock-entry-owner-document">
              Número do documento, sem máscara
            </label>
            <input
              id="stock-entry-owner-document"
              autoComplete="off"
              maxLength={
                values.tipoDocumentoProprietarioAtual === "CPF" ? 11 : 14
              }
              value={values.documentoProprietarioAtual}
              aria-invalid={Boolean(errors.documentoProprietarioAtual)}
              aria-describedby="stock-entry-owner-document-error"
              onChange={(event) =>
                edit(
                  "documentoProprietarioAtual",
                  event.currentTarget.value
                    .toUpperCase()
                    .replaceAll(/[^A-Z0-9]/gu, ""),
                )
              }
            />
            <p id="stock-entry-owner-document-error" className="field-error">
              {errors.documentoProprietarioAtual}
            </p>

            <label htmlFor="stock-entry-odometer">
              Quilometragem do hodômetro
            </label>
            <input
              id="stock-entry-odometer"
              type="number"
              inputMode="numeric"
              min="0"
              max="2147483647"
              step="1"
              value={values.quilometragemHodometro}
              aria-invalid={Boolean(errors.quilometragemHodometro)}
              aria-describedby="stock-entry-odometer-error"
              onChange={(event) =>
                edit("quilometragemHodometro", event.currentTarget.value)
              }
            />
            <p id="stock-entry-odometer-error" className="field-error">
              {errors.quilometragemHodometro}
            </p>

            <label htmlFor="stock-entry-odometer-time">
              Data e hora da medição
            </label>
            <input
              id="stock-entry-odometer-time"
              type="datetime-local"
              value={values.dataHoraMedicaoHodometro}
              aria-invalid={Boolean(errors.dataHoraMedicaoHodometro)}
              aria-describedby="stock-entry-odometer-time-help stock-entry-odometer-time-error"
              onChange={(event) =>
                edit("dataHoraMedicaoHodometro", event.currentTarget.value)
              }
            />
            <p id="stock-entry-odometer-time-help">
              O fuso local será incluído explicitamente na solicitação.
            </p>
            <p id="stock-entry-odometer-time-error" className="field-error">
              {errors.dataHoraMedicaoHodometro}
            </p>
          </fieldset>

          <Button type="submit" loading={pending} loadingLabel="Registrando…">
            Registrar solicitação local
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
