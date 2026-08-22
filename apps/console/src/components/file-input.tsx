import { FileText, Paperclip, X } from "lucide-react";
import { useRef, useState, type DragEvent } from "react";
import { IconButton } from "./button";
import { useFieldControl } from "./field";
import { formatFileSize } from "./format";

/**
 * File attachment control shared by every surface that accepts uploads.
 *
 * Replaces the bare `<input type="file">`: a drop target with a real button,
 * plus a removable list of what is currently attached. The component is
 * controlled — the parent owns the `File[]` so submitting and resetting a form
 * stays explicit. Inside a `Field`, the field label points at the hidden input,
 * so the accessible name and `getByLabelText` behave like a native input.
 */
export function FileDropInput({
  files,
  onChange,
  accept,
  multiple = true,
  disabled = false,
}: {
  readonly files: readonly File[];
  readonly onChange: (files: readonly File[]) => void;
  readonly accept?: string;
  readonly multiple?: boolean;
  readonly disabled?: boolean;
}) {
  const control = useFieldControl();
  const input = useRef<HTMLInputElement>(null);
  const [dropping, setDropping] = useState(false);
  const add = (added: readonly File[]) => {
    if (added.length === 0) return;
    const next = [...files];
    for (const file of added) {
      if (
        next.some(
          (existing) =>
            existing.name === file.name && existing.size === file.size,
        )
      )
        continue;
      next.push(file);
    }
    onChange(multiple ? next : next.slice(-1));
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDropping(false);
    if (!disabled) add([...event.dataTransfer.files]);
  };
  return (
    <div
      className={`file-drop${dropping ? " file-drop--dropping" : ""}`}
      onDragOver={(event) => {
        event.preventDefault();
        if (!disabled) setDropping(true);
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={onDrop}
    >
      <input
        {...control}
        ref={input}
        className="sr-only"
        type="file"
        multiple={multiple}
        {...(accept ? { accept } : {})}
        disabled={disabled}
        onChange={(event) => {
          add([...(event.currentTarget.files ?? [])]);
          // Reset so re-picking the same file after a removal fires again.
          event.currentTarget.value = "";
        }}
      />
      <button
        type="button"
        className="file-drop-target"
        disabled={disabled}
        onClick={() => input.current?.click()}
      >
        <Paperclip size={15} aria-hidden="true" />
        <span>
          <strong>Choose files</strong> or drag and drop
        </span>
      </button>
      {files.length > 0 ? (
        <ul className="file-drop-list">
          {files.map((file, index) => (
            <li key={`${file.name}:${file.size}:${index}`}>
              <FileText size={14} aria-hidden="true" />
              <span className="file-drop-name" title={file.name}>
                {file.name}
              </span>
              <small>{formatFileSize(file.size)}</small>
              <IconButton
                label={`Remove ${file.name}`}
                disabled={disabled}
                onClick={() =>
                  onChange(files.filter((_, position) => position !== index))
                }
              >
                <X size={13} aria-hidden="true" />
              </IconButton>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
