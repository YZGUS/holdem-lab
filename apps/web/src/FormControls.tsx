import { useId, type KeyboardEvent } from 'react';

interface ChoiceOption<T extends string | number> {
  value: T;
  label: string;
}

interface SegmentedChoiceProps<T extends string | number> {
  label: string;
  value: T;
  options: readonly ChoiceOption<T>[];
  onChange: (value: T) => void;
  className?: string;
  disabled?: boolean;
}

export function SegmentedChoice<T extends string | number>({ label, value, options, onChange, className = '', disabled = false }: SegmentedChoiceProps<T>) {
  const labelId = useId();

  const moveSelection = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (index + 1) % options.length;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (index - 1 + options.length) % options.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = options.length - 1;
    if (nextIndex === null) return;

    event.preventDefault();
    onChange(options[nextIndex].value);
    const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    buttons?.[nextIndex]?.focus();
  };

  return <div className={`settings-control settings-choice ${disabled ? 'disabled' : ''} ${className}`.trim()}>
    <span className="settings-control-label" id={labelId}>{label}</span>
    <div className="segmented-control" role="radiogroup" aria-labelledby={labelId}>
      {options.map((option, index) => {
        const selected = option.value === value;
        return <button
          type="button"
          role="radio"
          aria-checked={selected}
          tabIndex={selected ? 0 : -1}
          disabled={disabled}
          key={String(option.value)}
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => moveSelection(event, index)}
        >{option.label}</button>;
      })}
    </div>
  </div>;
}

interface StepperControlProps {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  formatValue?: (value: number) => string;
  className?: string;
  disabled?: boolean;
}

export function StepperControl({ label, value, min, max, onChange, formatValue = String, className = '', disabled = false }: StepperControlProps) {
  const labelId = useId();
  const update = (nextValue: number) => onChange(Math.max(min, Math.min(max, nextValue)));

  return <div className={`settings-control settings-stepper ${disabled ? 'disabled' : ''} ${className}`.trim()}>
    <span className="settings-control-label" id={labelId}>{label}</span>
    <div className="stepper-control" role="group" aria-labelledby={labelId}>
      <button type="button" aria-label={`减少${label}`} disabled={disabled || value <= min} onClick={() => update(value - 1)}>−</button>
      <output aria-live="polite">{formatValue(value)}</output>
      <button type="button" aria-label={`增加${label}`} disabled={disabled || value >= max} onClick={() => update(value + 1)}>＋</button>
    </div>
  </div>;
}
