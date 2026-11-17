export function money(amountMinor: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amountMinor / 100);
}

export function distance(meters: number): string {
  return meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(1)} km`;
}

export function minutes(seconds: number): string {
  const m = Math.max(1, Math.round(seconds / 60));
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}

export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function dateTime(iso: string): string {
  return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function percent(ratio: number | null, digits = 0): string {
  return ratio === null ? '—' : `${(ratio * 100).toFixed(digits)}%`;
}

export function compact(n: number): string {
  return new Intl.NumberFormat('en-US', { notation: n >= 10_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(n);
}

const BRAND_NAMES: Record<string, string> = {
  visa: 'Visa', mastercard: 'Mastercard', amex: 'Amex', discover: 'Discover', diners: 'Diners', jcb: 'JCB', rupay: 'RuPay', unionpay: 'UnionPay', card: 'Card', demo: 'Demo card',
};

export function cardLabel(method: { brand: string; last4: string | null }): string {
  const name = BRAND_NAMES[method.brand] ?? 'Card';
  return method.last4 ? `${name} •••• ${method.last4}` : name;
}

const DECLINE_REASONS: Record<string, string> = {
  INSUFFICIENT_FUNDS: 'Insufficient funds',
  DO_NOT_HONOR: 'Your bank didn’t approve this payment',
  CARD_DECLINED: 'Card declined',
  LIMIT_EXCEEDED: 'Card limit exceeded',
  DEMO_DECLINED: 'Card declined',
  INVALID_PAYMENT_METHOD: 'This card can’t be used',
};

export function declineReason(code: string | null): string {
  return (code && DECLINE_REASONS[code]) || 'Payment declined';
}
