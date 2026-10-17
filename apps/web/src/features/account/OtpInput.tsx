import { useEffect, useRef, type ClipboardEvent, type KeyboardEvent } from 'react';

/** Seis casillas: admite pegar el código completo y el autocompletado de SMS/WhatsApp. */
export function OtpInput({
  value,
  onChange,
  disabled,
  invalid,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  invalid?: boolean;
}) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  useEffect(() => {
    refs.current[0]?.focus();
  }, []);
  const digits = Array.from({ length: 6 }, (_, i) => value[i] ?? '');
  const set = (index: number, raw: string) => {
    const clean = raw.replace(/\D/g, '');
    if (!clean) return;
    // Un valor largo en una casilla proviene de autocompletado o pegado.
    const next = (value.slice(0, index) + clean).slice(0, 6);
    onChange(next);
    refs.current[Math.min(next.length, 5)]?.focus();
  };
  const keyDown = (index: number, event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Backspace') {
      event.preventDefault();
      const target = digits[index] ? index : Math.max(0, index - 1);
      onChange(value.slice(0, target));
      refs.current[target]?.focus();
    } else if (event.key === 'ArrowLeft') refs.current[Math.max(0, index - 1)]?.focus();
    else if (event.key === 'ArrowRight') refs.current[Math.min(5, index + 1)]?.focus();
  };
  const paste = (event: ClipboardEvent<HTMLInputElement>) => {
    event.preventDefault();
    const clean = event.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    if (clean) {
      onChange(clean);
      refs.current[Math.min(clean.length, 5)]?.focus();
    }
  };
  return (
    <div className="otp-input" role="group" aria-label="Código de verificación de 6 dígitos">
      {digits.map((digit, index) => (
        <input
          key={index}
          ref={(node) => {
            refs.current[index] = node;
          }}
          value={digit}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          aria-label={`Dígito ${index + 1}`}
          inputMode="numeric"
          autoComplete={index === 0 ? 'one-time-code' : 'off'}
          maxLength={index === 0 ? 6 : 1}
          onChange={(e) => set(index, e.target.value)}
          onKeyDown={(e) => keyDown(index, e)}
          onPaste={paste}
          onFocus={(e) => e.target.select()}
        />
      ))}
    </div>
  );
}
