/**
 * Client-side card handling. Card numbers are validated in the browser and
 * never sent anywhere: only a token made of the brand and last four digits
 * (e.g. `card_visa_4242`) is used as the payment method.
 */

export type CardBrand = 'visa' | 'mastercard' | 'amex' | 'discover' | 'diners' | 'jcb' | 'rupay' | 'unionpay' | 'card';

export interface SavedCard {
  brand: CardBrand;
  last4: string;
  expMonth: number;
  expYear: number;
  holder: string;
}

export function detectBrand(digits: string): CardBrand {
  if (/^4/.test(digits)) return 'visa';
  if (/^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/.test(digits)) return 'mastercard';
  if (/^3[47]/.test(digits)) return 'amex';
  if (/^(60|65|81|82|508)/.test(digits)) return 'rupay';
  if (/^(6011|64[4-9])/.test(digits)) return 'discover';
  if (/^3(0[0-5]|[68])/.test(digits)) return 'diners';
  if (/^35(2[89]|[3-8])/.test(digits)) return 'jcb';
  if (/^62/.test(digits)) return 'unionpay';
  return 'card';
}

export function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return digits.length > 0 && sum % 10 === 0;
}

export function cardLengths(brand: CardBrand): number[] {
  if (brand === 'amex') return [15];
  if (brand === 'diners') return [14, 16];
  return [16, 19];
}

/** Group digits the way they are printed on the card. */
export function formatCardNumber(digits: string): string {
  const brand = detectBrand(digits);
  const groups = brand === 'amex' ? [4, 6, 5] : [4, 4, 4, 4, 3];
  const out: string[] = [];
  let i = 0;
  for (const g of groups) {
    if (i >= digits.length) break;
    out.push(digits.slice(i, i + g));
    i += g;
  }
  return out.join(' ');
}

export function formatExpiry(raw: string): string {
  const d = raw.replace(/\D/g, '').slice(0, 4);
  return d.length <= 2 ? d : `${d.slice(0, 2)} / ${d.slice(2)}`;
}

export interface CardInput {
  number: string;
  expiry: string;
  cvc: string;
  holder: string;
}

export type CardErrors = Partial<Record<keyof CardInput, string>>;

export function validateCard(input: CardInput, now = new Date()): { errors: CardErrors; card?: SavedCard } {
  const errors: CardErrors = {};
  const digits = input.number.replace(/\D/g, '');
  const brand = detectBrand(digits);
  if (!digits) errors.number = 'Enter your card number.';
  else if (!cardLengths(brand).includes(digits.length) && !(digits.length >= 13 && digits.length <= 19 && brand === 'card')) {
    errors.number = 'This card number is too short.';
  } else if (!luhnValid(digits)) errors.number = 'Check the card number — it isn’t valid.';

  const exp = input.expiry.replace(/\D/g, '');
  const month = Number(exp.slice(0, 2));
  const year = 2000 + Number(exp.slice(2, 4));
  if (exp.length !== 4) errors.expiry = 'Enter the expiry date as MM / YY.';
  else if (month < 1 || month > 12) errors.expiry = 'The month must be between 01 and 12.';
  else if (year < now.getFullYear() || (year === now.getFullYear() && month < now.getMonth() + 1)) errors.expiry = 'This card has expired.';

  const cvcLength = brand === 'amex' ? 4 : 3;
  if (!new RegExp(`^\\d{${cvcLength}}$`).test(input.cvc)) errors.cvc = `Enter the ${cvcLength}-digit security code.`;
  if (input.holder.trim().length < 2) errors.holder = 'Enter the name on the card.';

  if (Object.keys(errors).length > 0) return { errors };
  return { errors, card: { brand, last4: digits.slice(-4), expMonth: month, expYear: year, holder: input.holder.trim() } };
}

/** The only thing that leaves the browser. */
export function cardToken(card: SavedCard): string {
  return `card_${card.brand}_${card.last4}`;
}
