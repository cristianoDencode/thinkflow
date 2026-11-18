import type { Detector } from '../pii';
import { cardDetector } from './card';
import { cepDetector } from './cep';
import { cnhDetector } from './cnh';
import { cnpjDetector } from './cnpj';
import { cnsDetector } from './cns';
import { cpfDetector } from './cpf';
import { emailDetector } from './email';
import { phoneDetector } from './phone';
import { pisDetector } from './pis';
import { plateDetector } from './plate';
import { renavamDetector } from './renavam';
import { rgDetector } from './rg';
import { tituloDetector } from './titulo';

export { isValidCard, luhn } from './card';
export { isValidCnh } from './cnh';
export { isValidCnpj, normalizeCnpj } from './cnpj';
export { isValidCns } from './cns';
export { isValidCpf } from './cpf';
export { isValidDdd } from './phone';
export { isValidPis } from './pis';
export { isValidRenavam } from './renavam';
export { isValidTitulo } from './titulo';
export {
  cardDetector,
  cepDetector,
  cnhDetector,
  cnpjDetector,
  cnsDetector,
  cpfDetector,
  emailDetector,
  phoneDetector,
  pisDetector,
  plateDetector,
  renavamDetector,
  rgDetector,
  tituloDetector,
};

/** Every native detector (the person-name heuristic lives in `../names`). */
export const NATIVE_DETECTORS: readonly Detector[] = [
  cpfDetector,
  cnpjDetector,
  cnsDetector,
  pisDetector,
  tituloDetector,
  cnhDetector,
  renavamDetector,
  cardDetector,
  emailDetector,
  phoneDetector,
  cepDetector,
  rgDetector,
  plateDetector,
];
