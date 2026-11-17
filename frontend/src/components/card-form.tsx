'use client';

import { useId, useState } from 'react';
import { CardErrors, CardInput, SavedCard, detectBrand, formatCardNumber, formatExpiry, validateCard } from '@/lib/card';
import { cardLabel } from '@/lib/format';

const BRAND_TEXT: Record<string, string> = {
  visa: 'VISA', mastercard: 'Mastercard', amex: 'AMEX', rupay: 'RuPay', discover: 'Discover', diners: 'Diners', jcb: 'JCB', unionpay: 'UnionPay',
};

interface CardFormProps {
  title: string;
  submitLabel: string;
  busyLabel?: string;
  busy?: boolean;
  onSubmit: (card: SavedCard) => void;
  onCancel?: () => void;
}

/**
 * Card entry. Everything is validated here, in the browser; the card number,
 * expiry and security code are never sent to the server or stored. Only the
 * brand and last four digits are kept to identify the card.
 */
export default function CardForm({ title, submitLabel, busyLabel, busy, onSubmit, onCancel }: CardFormProps) {
  const id = useId();
  const [input, setInput] = useState<CardInput>({ number: '', expiry: '', cvc: '', holder: '' });
  const [errors, setErrors] = useState<CardErrors>({});
  const [touched, setTouched] = useState<Partial<Record<keyof CardInput, boolean>>>({});
  const digits = input.number.replace(/\D/g, '');
  const brand = detectBrand(digits);
  const maxDigits = brand === 'amex' ? 15 : 19;

  const update = (field: keyof CardInput, value: string) => {
    const next = { ...input, [field]: value };
    setInput(next);
    if (touched[field]) setErrors(validateCard(next).errors);
  };
  const blur = (field: keyof CardInput) => {
    setTouched((t) => ({ ...t, [field]: true }));
    setErrors((prev) => ({ ...prev, [field]: validateCard(input).errors[field] }));
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const result = validateCard(input);
    setTouched({ number: true, expiry: true, cvc: true, holder: true });
    setErrors(result.errors);
    if (result.card) onSubmit(result.card);
  };

  const field = (hasError: boolean) =>
    `w-full rounded-xl border bg-white px-3.5 py-3 text-[15px] outline-none transition-colors placeholder:text-[#9aa0a8] focus:border-ink ${hasError ? 'border-bad' : 'border-line'}`;
  const err = (f: keyof CardInput) =>
    touched[f] && errors[f] ? (
      <p id={`${id}-${f}-err`} className="mt-1.5 text-[13px] text-bad">
        {errors[f]}
      </p>
    ) : null;

  return (
    <form onSubmit={submit} noValidate className="kerb-step flex flex-col gap-4" aria-busy={busy}>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="font-display text-[22px] font-semibold leading-tight">{title}</h3>
        {onCancel && (
          <button type="button" onClick={onCancel} className="text-[14px] font-medium text-ink-2 underline-offset-4 hover:underline" disabled={busy}>
            Back
          </button>
        )}
      </div>

      <div>
        <label htmlFor={`${id}-number`} className="mb-1.5 block text-[13px] font-medium text-ink-2">
          Card number
        </label>
        <div className="relative">
          <input
            id={`${id}-number`}
            className={`${field(Boolean(touched.number && errors.number))} pr-24 tabular-nums tracking-wide`}
            inputMode="numeric"
            autoComplete="cc-number"
            placeholder="1234 5678 9012 3456"
            value={formatCardNumber(digits)}
            onChange={(e) => update('number', e.target.value.replace(/\D/g, '').slice(0, maxDigits))}
            onBlur={() => blur('number')}
            aria-invalid={Boolean(touched.number && errors.number)}
            aria-describedby={errors.number ? `${id}-number-err` : undefined}
            disabled={busy}
          />
          {brand !== 'card' && (
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded-md bg-ink px-2 py-1 text-[11px] font-bold tracking-wide text-white">
              {BRAND_TEXT[brand]}
            </span>
          )}
        </div>
        {err('number')}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor={`${id}-exp`} className="mb-1.5 block text-[13px] font-medium text-ink-2">
            Expiry
          </label>
          <input
            id={`${id}-exp`}
            className={`${field(Boolean(touched.expiry && errors.expiry))} tabular-nums`}
            inputMode="numeric"
            autoComplete="cc-exp"
            placeholder="MM / YY"
            value={formatExpiry(input.expiry)}
            onChange={(e) => update('expiry', e.target.value.replace(/\D/g, '').slice(0, 4))}
            onBlur={() => blur('expiry')}
            aria-invalid={Boolean(touched.expiry && errors.expiry)}
            aria-describedby={errors.expiry ? `${id}-expiry-err` : undefined}
            disabled={busy}
          />
          {err('expiry')}
        </div>
        <div>
          <label htmlFor={`${id}-cvc`} className="mb-1.5 block text-[13px] font-medium text-ink-2">
            Security code
          </label>
          <input
            id={`${id}-cvc`}
            className={`${field(Boolean(touched.cvc && errors.cvc))} tabular-nums`}
            inputMode="numeric"
            autoComplete="cc-csc"
            placeholder={brand === 'amex' ? '4 digits' : '3 digits'}
            value={input.cvc}
            onChange={(e) => update('cvc', e.target.value.replace(/\D/g, '').slice(0, brand === 'amex' ? 4 : 3))}
            onBlur={() => blur('cvc')}
            aria-invalid={Boolean(touched.cvc && errors.cvc)}
            aria-describedby={errors.cvc ? `${id}-cvc-err` : undefined}
            disabled={busy}
          />
          {err('cvc')}
        </div>
      </div>

      <div>
        <label htmlFor={`${id}-holder`} className="mb-1.5 block text-[13px] font-medium text-ink-2">
          Name on card
        </label>
        <input
          id={`${id}-holder`}
          className={field(Boolean(touched.holder && errors.holder))}
          autoComplete="cc-name"
          placeholder="As printed on the card"
          value={input.holder}
          onChange={(e) => update('holder', e.target.value.slice(0, 60))}
          onBlur={() => blur('holder')}
          aria-invalid={Boolean(touched.holder && errors.holder)}
          aria-describedby={errors.holder ? `${id}-holder-err` : undefined}
          disabled={busy}
        />
        {err('holder')}
      </div>

      <button type="submit" disabled={busy} className="mt-1 h-13 rounded-2xl bg-ink px-5 py-3.5 text-[16px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60">
        {busy ? busyLabel ?? 'Working…' : submitLabel}
      </button>
      <p className="text-[12.5px] leading-5 text-muted">
        This is a simulation: use any valid test number, such as 4242 4242 4242 4242. Card details are checked on this device and never sent —
        only the card type and last four digits ({digits.length >= 4 ? cardLabel({ brand, last4: digits.slice(-4) }) : 'e.g. Visa •••• 4242'}) are
        kept. Whether your bank approves is decided at random when you pay.
      </p>
    </form>
  );
}
