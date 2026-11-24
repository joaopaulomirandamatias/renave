export type RenaveMutationOperation = "request-stock-entry";

export type CrvType = "AZUL" | "VERDE" | "BRANCO" | "DIGITAL";
export type OwnerDocumentType = "CPF" | "CNPJ";

export interface StockEntryVehicle {
  codigoSegurancaCrv: string;
  dataHoraMedicaoHodometro: string;
  documentoProprietarioAtual: string;
  numeroCrv?: string;
  placa: string;
  quilometragemHodometro: number;
  renavam?: string;
  tipoCrv: CrvType;
  tipoDocumentoProprietarioAtual: OwnerDocumentType;
}

export interface StockEntryRequest {
  cpfOperadorResponsavel: string;
  dataCompra: string;
  emailEstabelecimento: string;
  emailVendedor: string;
  valorCompra: number;
  veiculo: StockEntryVehicle;
}

export type RenaveStockState =
  "SOLICITADO" | "TRANSFERIDO" | "CONFIRMADO" | "FINALIZADO";

export interface StockEntryResponse {
  estado?: RenaveStockState;
  id?: number;
  numeroCrv?: string;
  placa?: string;
  renavam?: string;
}

export interface VehicleEligibilityQuery {
  numeroCrv?: string;
  placa?: string;
  renavam?: string;
  tipoCrv: CrvType;
}

export interface VehicleEligibilityDiagnosis {
  motivosParaNaoAptidao?: string[];
  veiculoApto?: boolean;
  veiculoBaixado?: boolean;
  veiculoComAlarme?: boolean;
  veiculoComLicenciamentoProvisorio?: boolean;
  veiculoComPendenciaDeEmissaoCrv?: boolean;
  veiculoComRecall?: boolean;
  veiculoComRestricaoExtrajudicial?: boolean;
  veiculoComRestricaoImpeditivaNoDetran?: boolean;
  veiculoComRestricaoJudicial?: boolean;
  veiculoComRestricaoNaReceitaFederal?: boolean;
  veiculoComRestricaoPgfn?: boolean;
  veiculoComRouboFurto?: boolean;
  veiculoSemAtpv?: boolean;
  veiculoTemAutorizacaoTransferenciaParaEstabelecimentoDiferenteDoEstabelecimentoConsultante?: boolean;
  veiculoTemComunicacaoDeVendaParaCompradorDiferenteDoEstabelecimentoConsultante?: boolean;
  veiculoTemIntencaoDeVendaParaCompradorDiferenteDoEstabelecimentoConsultante?: boolean;
}

export interface VehicleEligibilityTransferAuthorization {
  cpfOperadorResponsavelAutorizacao?: string;
  dataHoraAutorizacao?: string;
  estabelecimentoAutorizador?: Record<string, unknown>;
}

export interface VehicleEligibilityDebtInformation {
  boletos?: unknown[];
  codigosBancos?: string[];
  existemDebitos?: boolean;
  valorDebitoDpvat?: number;
  valorDebitoIpva?: number;
  valorDebitoLicenciamento?: number;
  valorDebitoMultas?: number;
  valorTaxasEDebitosDiversos?: number;
}

export interface VehicleEligibilityVehicle {
  chassi?: string;
  dataPreCadastro?: string;
  placa?: string;
  renavam?: string;
  restricoes?: unknown[];
  veiculoAcabado?: boolean;
}

/** Projeção pública e estritamente allowlisted de Restricao do Swagger. */
export interface RenaveVehicleRestriction {
  codigoTipo?: string;
  tipo?: string;
}

/** Veículo consultado por placa; propriedades desconhecidas nunca são expostas. */
export interface RenaveVehicle {
  chassi?: string;
  dataPreCadastro?: string;
  placa: string;
  renavam?: string;
  restricoes: readonly RenaveVehicleRestriction[];
  veiculoAcabado?: boolean;
}

export interface VehicleEligibilityResponse {
  autorizacaoTransferencia?: VehicleEligibilityTransferAuthorization;
  comunicacaoComDetranFalhou?: boolean;
  diagnostico?: VehicleEligibilityDiagnosis;
  informacoesDebitos?: VehicleEligibilityDebtInformation;
  veiculo?: VehicleEligibilityVehicle;
}

export const renaveMutationRoutes = {
  "request-stock-entry": {
    method: "POST",
    path: "/api/solicitacoes-entrada-estoque",
  },
} as const satisfies Record<
  RenaveMutationOperation,
  { method: "POST"; path: `/api/${string}` }
>;
