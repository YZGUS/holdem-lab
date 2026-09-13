import { useEffect, useId, useRef } from 'react';

interface ConfirmDialogProps {
  title: string;
  description: string;
  busy: boolean;
  cancelLabel?: string;
  confirmLabel?: string;
  busyLabel?: string;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmDialog({
  title, description, busy, cancelLabel = '保留房间', confirmLabel = '确认解散', busyLabel = '正在解散…', onCancel, onConfirm,
}: ConfirmDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [busy, onCancel]);

  return <div className="confirm-backdrop" onMouseDown={(event) => {
    if (event.target === event.currentTarget && !busy) onCancel();
  }}>
    <section className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}>
      <div className="confirm-icon" aria-hidden="true">!</div>
      <div className="confirm-copy">
        <p className="eyebrow">不可撤销</p>
        <h2 id={titleId}>{title}</h2>
        <p id={descriptionId}>{description}</p>
      </div>
      <footer className="confirm-actions">
        <button ref={cancelRef} disabled={busy} onClick={onCancel}>{cancelLabel}</button>
        <button className="confirm-danger" disabled={busy} onClick={onConfirm}>{busy ? busyLabel : confirmLabel}</button>
      </footer>
    </section>
  </div>;
}
