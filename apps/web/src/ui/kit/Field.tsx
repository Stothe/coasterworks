import { cloneElement, isValidElement, useId, type ReactNode } from "react";

export interface FieldProps {
  label: string;
  hint?: string;
  error?: string;
  /** One form control. The field gives it the label, the hint and the error. */
  children: ReactNode;
}

interface ControlProps {
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}

/** A label, a form control, and the hint and error that go with it. */
export function Field({ label, hint, error, children }: FieldProps) {
  const uid = useId();
  const hintId = `${uid}-hint`;
  const errorId = `${uid}-error`;

  const control = isValidElement<ControlProps>(children) ? children : null;
  const controlId = control?.props.id ?? uid;
  const describedBy = [control?.props["aria-describedby"], hint && hintId, error && errorId]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={controlId} className="text-xs font-medium text-muted">
        {label}
      </label>
      {control
        ? cloneElement(control, {
            id: controlId,
            ...(describedBy && { "aria-describedby": describedBy }),
            ...(error && { "aria-invalid": true }),
          })
        : children}
      {hint && (
        <p id={hintId} className="text-xs text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-xs text-[#ffb4b4]">
          {error}
        </p>
      )}
    </div>
  );
}
