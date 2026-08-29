import {
  ArrowLeft,
  ChevronRight,
  Download,
  FilePlus2,
  FileText,
  Folder,
  FolderPlus,
  Plus,
  Save,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useApi } from "../api/context";
import type {
  ConsoleApi,
  SkillDetail,
  SkillDraft,
  SkillDraftEntry,
  SkillFileInput,
} from "../api/types";
import {
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  FormError,
  IconButton,
  Input,
  LoadingState,
  MarkdownContent,
  Page,
  PageHeader,
  Panel,
  StatusChip,
  Tabs,
  Textarea,
  formatDate,
  useToast,
} from "../components/ui";

const NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

function utf8Base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64Utf8(value: string): string {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function directoryName(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

function packagePath(directory: string, name: string): string {
  return [directory, name]
    .filter(Boolean)
    .join("/")
    .replace(/^\/+|\/+$/gu, "");
}

function slugify(value: string): string {
  return value
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function normalizedMarkdownName(value: string): string {
  const trimmed = value.trim();
  return trimmed.toLocaleLowerCase("en-US").endsWith(".md")
    ? trimmed
    : `${trimmed}.md`;
}

function entriesWithInferredDirectories(
  entries: readonly SkillDraftEntry[],
): readonly SkillDraftEntry[] {
  const byPath = new Map(entries.map((entry) => [entry.path, entry] as const));
  for (const entry of entries) {
    const segments = entry.path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const path = segments.slice(0, index).join("/");
      if (!byPath.has(path))
        byPath.set(path, {
          path,
          kind: "directory",
          contentType: null,
          sizeBytes: null,
          sha256: null,
        });
    }
  }
  return [...byPath.values()];
}

/** FileReader rather than Blob.text(): the latter is missing in some engines. */
function readUploadText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result ?? "")));
    reader.addEventListener("error", () =>
      reject(reader.error ?? new Error(`Could not read ${file.name}`)),
    );
    reader.readAsText(file, "utf-8");
  });
}

/**
 * Portable Skill bundle: one JSON file holding the discovery metadata, the
 * instructions, and every packaged resource. Download produces it from an
 * immutable version; Upload turns it back into a draft to review and publish.
 */
interface SkillBundle {
  readonly schemaVersion: 1;
  readonly kind: "oao.skill";
  readonly skill: {
    readonly key: string;
    readonly displayName: string;
    readonly name: string;
    readonly description: string;
    readonly instructions: string;
  };
  readonly files: readonly SkillFileInput[];
}

function bundleFileName(key: string, version: number): string {
  return `${slugify(key) || "skill"}-v${version}.skill.json`;
}

function parseSkillBundle(text: string): SkillBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("The file is not valid JSON.");
  }
  const value = parsed as Partial<SkillBundle> | null;
  if (
    !value ||
    typeof value !== "object" ||
    value.kind !== "oao.skill" ||
    value.schemaVersion !== 1 ||
    !value.skill ||
    typeof value.skill !== "object"
  )
    throw new Error(
      "The file is not an OAO Skill bundle. Download one from a Skill version first.",
    );
  const skill = value.skill as Partial<SkillBundle["skill"]>;
  for (const field of ["displayName", "name", "description", "instructions"])
    if (typeof skill[field as keyof typeof skill] !== "string")
      throw new Error(`The bundle is missing the ${field} field.`);
  const files = Array.isArray(value.files) ? value.files : [];
  for (const file of files as readonly Partial<SkillFileInput>[]) {
    if (
      typeof file?.path !== "string" ||
      typeof file.contentType !== "string" ||
      typeof file.dataBase64 !== "string"
    )
      throw new Error("A bundled resource is missing its path or content.");
    if (!file.path.toLocaleLowerCase("en-US").endsWith(".md"))
      throw new Error(
        `${file.path} is not a Markdown file. Only .md resources can be uploaded.`,
      );
  }
  return {
    schemaVersion: 1,
    kind: "oao.skill",
    skill: {
      key: typeof skill.key === "string" ? skill.key : slugify(skill.name!),
      displayName: skill.displayName!,
      name: skill.name!,
      description: skill.description!,
      instructions: skill.instructions!,
    },
    files: files as readonly SkillFileInput[],
  };
}

/** Fills a draft from a bundle: metadata first, then every packaged resource. */
async function applySkillBundle(
  api: ConsoleApi,
  draft: SkillDraft,
  bundle: SkillBundle,
  { replaceResources }: { readonly replaceResources: boolean },
): Promise<SkillDraft> {
  let current = await api.updateSkillDraft(draft.id, {
    key: draft.skillId ? draft.key : bundle.skill.key,
    displayName: bundle.skill.displayName,
    name: draft.skillId ? draft.name : bundle.skill.name,
    description: bundle.skill.description,
    instructions: bundle.skill.instructions,
  });
  if (replaceResources) {
    // Files first, then directories deepest-first: a sourced draft may list
    // nested files without their parent directories, so every entry is
    // removed individually rather than trusting top-level recursion.
    const entries = [...current.entries].sort(
      (left, right) =>
        Number(left.kind === "directory") -
          Number(right.kind === "directory") ||
        right.path.split("/").length - left.path.split("/").length,
    );
    for (const entry of entries) {
      if (
        !current.entries.some(
          (item) => item.path === entry.path && item.kind === entry.kind,
        )
      )
        continue;
      current = await api.removeSkillDraftEntry(
        current.id,
        entry.path,
        entry.kind === "directory",
      );
    }
  }
  for (const file of bundle.files)
    current = await api.putSkillDraftFile(current.id, {
      path: file.path,
      contentType: "text/markdown",
      dataBase64: file.dataBase64,
    });
  return current;
}

function downloadBundle(bundle: SkillBundle, fileName: string): void {
  const blob = new Blob([JSON.stringify(bundle, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

/** Hidden file input behind an "Upload" button; accepts one Skill bundle. */
function SkillBundleUpload({
  label,
  pending,
  onFile,
}: {
  readonly label: string;
  readonly pending: boolean;
  readonly onFile: (file: File) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        accept=".json,application/json"
        aria-label={`${label} file`}
        hidden
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) onFile(file);
        }}
      />
      <Button
        icon={<Upload size={15} />}
        loading={pending}
        onClick={() => input.current?.click()}
      >
        {label}
      </Button>
    </>
  );
}

export function SkillsPage() {
  const api = useApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const notify = useToast();
  const [draft, setDraft] = useState<SkillDraft | null>(null);
  const query = useQuery({
    queryKey: ["skills"],
    queryFn: () => api.listSkills({}),
  });
  const createDraft = useMutation({
    mutationFn: () => api.createSkillDraft(),
    onSuccess: setDraft,
  });
  const importBundle = useMutation({
    mutationFn: async (file: File) => {
      const bundle = parseSkillBundle(await readUploadText(file));
      const created = await api.createSkillDraft();
      try {
        return await applySkillBundle(api, created, bundle, {
          replaceResources: false,
        });
      } catch (error) {
        await api.discardSkillDraft(created.id).catch(() => undefined);
        throw error;
      }
    },
    onSuccess: setDraft,
    onError: (error) => notify(error.message),
  });
  return (
    <Page>
      <PageHeader
        eyebrow="Build"
        title="Skills"
        description="Versioned procedural knowledge loaded progressively by managed agents."
        actions={
          <>
            <SkillBundleUpload
              label="Upload Skill"
              pending={importBundle.isPending}
              onFile={(file) => importBundle.mutate(file)}
            />
            <Button
              variant="primary"
              icon={<Plus size={15} />}
              loading={createDraft.isPending}
              onClick={() => createDraft.mutate()}
            >
              Create Skill
            </Button>
          </>
        }
      />
      {query.isPending ? (
        <LoadingState label="Loading Skills" rows={5} />
      ) : query.isError ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : query.data.data.length === 0 ? (
        <EmptyState
          icon="◇"
          title="No Skills published"
          description="Publish reusable instructions and references, then attach their exact versions to an agent version."
          action={
            <Button
              loading={createDraft.isPending}
              onClick={() => createDraft.mutate()}
            >
              Create Skill
            </Button>
          }
        />
      ) : (
        <Panel
          title="Published Skills"
          description="Latest versions are offered when publishing an agent; existing bindings never float."
          flush
        >
          <div className="compact-list">
            {query.data.data.map((skill) => (
              <Link key={skill.id} to={`/skills/${skill.id}`}>
                <span className="who">
                  <strong>{skill.displayName}</strong>
                  <small>
                    {skill.name} · v{skill.version} · {skill.fileCount}{" "}
                    resources
                  </small>
                  <small>{skill.description}</small>
                </span>
                <StatusChip value={skill.status} />
              </Link>
            ))}
          </div>
        </Panel>
      )}
      <Panel
        title="How Skills work"
        collapsible
        defaultCollapsed
        description="Immutable, reusable instruction packages that agents load only when needed. Open for the publish, bind, and activation model."
      >
        <div className="skill-explainer">
          <article>
            <h3>Publish a version</h3>
            <p>
              A Skill version combines a small discovery name and description
              with full Markdown instructions and optional supporting files.
              Publishing an update creates a new version; it never changes an
              existing one.
            </p>
          </article>
          <article>
            <h3>Attach it to an agent</h3>
            <p>
              An agent version stores exact Skill version IDs. New sessions
              inherit those bindings automatically, so an older agent version
              continues using the same Skill version after newer ones are
              published.
            </p>
          </article>
          <article>
            <h3>Load progressively</h3>
            <p>
              The model initially sees only the discovery entry. It activates a
              relevant Skill to load its instructions, then reads a reference
              only when those instructions require it.
            </p>
          </article>
          <article>
            <h3>Understand reference paths</h3>
            <p>
              You author a package-relative path such as{" "}
              <code>references/intake-flow.md</code>. After activation, Flue
              advertises a runtime-only virtual path shaped like{" "}
              <code>
                /.flue/packaged-skills/&lt;Flue-skill-id&gt;/references/intake-flow.md
              </code>
              . The file is served from the verified package; it is not a file
              in the agent sandbox.
            </p>
          </article>
        </div>
      </Panel>
      {draft ? (
        <SkillDialog
          draft={draft}
          title="Create Skill"
          submitLabel="Publish Skill"
          onClose={() => {
            const draftId = draft.id;
            setDraft(null);
            void api
              .discardSkillDraft(draftId)
              .catch((error: unknown) =>
                notify(
                  error instanceof Error
                    ? error.message
                    : "Could not discard the Skill draft.",
                ),
              );
          }}
          onPublished={async (skillId) => {
            await queryClient.invalidateQueries({ queryKey: ["skills"] });
            setDraft(null);
            notify("Skill created with immutable version 1.");
            navigate(`/skills/${skillId}`);
          }}
        />
      ) : null}
    </Page>
  );
}

function MarkdownEditor({
  label,
  hint,
  value,
  onChange,
  rows = 10,
  required = false,
  autoFocus = false,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly rows?: number;
  readonly required?: boolean;
  readonly autoFocus?: boolean;
}) {
  const [view, setView] = useState<"write" | "preview">("write");
  return (
    <div className="md-editor">
      <div className="md-editor__bar">
        <span aria-hidden="true">{label}</span>
        <Tabs
          label={`${label} view`}
          variant="segmented"
          value={view}
          onChange={setView}
          tabs={[
            { value: "write", label: "Write" },
            { value: "preview", label: "Preview" },
          ]}
        />
      </div>
      {view === "write" ? (
        <Field label={label} labelHidden {...(hint ? { hint } : {})}>
          <Textarea
            required={required}
            autoFocus={autoFocus}
            rows={rows}
            value={value}
            onChange={(event) => onChange(event.currentTarget.value)}
          />
        </Field>
      ) : (
        <div className="skill-markdown-panel md-editor__preview">
          <MarkdownContent>
            {value.trim() ? value : "*Nothing to preview yet.*"}
          </MarkdownContent>
        </div>
      )}
    </div>
  );
}

function SkillDialog({
  draft: initialDraft,
  title,
  submitLabel,
  onClose,
  onPublished,
}: {
  readonly draft: SkillDraft;
  readonly title: string;
  readonly submitLabel: string;
  readonly onClose: () => void;
  readonly onPublished: (skillId: string) => void | Promise<void>;
}) {
  const api = useApi();
  const isNew = initialDraft.skillId === null;
  const [draft, setDraft] = useState(initialDraft);
  const [displayName, setDisplayName] = useState(initialDraft.displayName);
  const [name, setName] = useState(initialDraft.name);
  const [nameEdited, setNameEdited] = useState(initialDraft.name.length > 0);
  const [description, setDescription] = useState(initialDraft.description);
  const [instructions, setInstructions] = useState(initialDraft.instructions);
  const [step, setStep] = useState(0);
  const [localError, setLocalError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const mutateResources = useMutation({
    mutationFn: async (
      operation:
        | { readonly kind: "directory"; readonly path: string }
        | {
            readonly kind: "file";
            readonly path: string;
            readonly content: string;
          }
        | {
            readonly kind: "remove";
            readonly path: string;
            readonly recursive: boolean;
          },
    ) => {
      if (operation.kind === "directory")
        return api.createSkillDraftDirectory(draft.id, operation.path);
      if (operation.kind === "remove")
        return api.removeSkillDraftEntry(
          draft.id,
          operation.path,
          operation.recursive,
        );
      return api.putSkillDraftFile(draft.id, {
        path: operation.path,
        contentType: "text/markdown",
        dataBase64: utf8Base64(operation.content),
      });
    },
    onSuccess: setDraft,
  });
  const publish = useMutation({
    mutationFn: async () => {
      const saved = await api.updateSkillDraft(draft.id, {
        key: isNew ? name : draft.key,
        displayName,
        name,
        description,
        instructions,
      });
      setDraft(saved);
      await api.validateSkillDraft(draft.id);
      return api.publishSkillDraft(draft.id);
    },
    onSuccess: (published) => onPublished(published.skillId),
  });

  const fileCount = draft.entries.filter(
    (entry) => entry.kind === "file",
  ).length;
  const busy = uploading || mutateResources.isPending || publish.isPending;
  const stepReady: readonly boolean[] = [
    (!isNew || displayName.trim().length > 0) &&
      NAME_PATTERN.test(name) &&
      description.trim().length > 0,
    instructions.trim().length > 0,
    true,
  ];
  const steps = [
    { label: "Basics" },
    { label: "Instructions" },
    { label: fileCount > 0 ? `Files (${fileCount})` : "Files" },
  ];
  const lastStep = steps.length - 1;
  const canEnter = (target: number) =>
    stepReady.slice(0, target).every(Boolean);

  async function uploadFiles(
    files: readonly File[],
    directory: string,
  ): Promise<void> {
    setLocalError(null);
    setUploading(true);
    let current = draft;
    try {
      for (const file of files) {
        if (!file.name.toLocaleLowerCase("en-US").endsWith(".md"))
          throw new Error(`${file.name} is not a Markdown file.`);
        current = await api.putSkillDraftFile(current.id, {
          path: packagePath(directory, file.name),
          contentType: "text/markdown",
          dataBase64: utf8Base64(await readUploadText(file)),
        });
      }
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "Upload failed");
    } finally {
      setDraft(current);
      setUploading(false);
    }
  }

  return (
    <Dialog
      title={title}
      description="Name it, write the instructions, and optionally add reference files — then publish one immutable version."
      wide
      onClose={onClose}
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (step < lastStep) {
          if (stepReady[step]) setStep(step + 1);
        } else publish.mutate();
      }}
      footer={
        <>
          <Button onClick={onClose} disabled={publish.isPending}>
            Cancel
          </Button>
          {step > 0 ? (
            <Button
              icon={<ArrowLeft size={15} />}
              disabled={busy}
              onClick={() => setStep(step - 1)}
            >
              Back
            </Button>
          ) : null}
          {step < lastStep ? (
            <Button
              variant="primary"
              type="submit"
              disabled={!stepReady[step] || busy}
            >
              Next
            </Button>
          ) : (
            <Button
              variant="primary"
              type="submit"
              loading={publish.isPending}
              disabled={uploading || mutateResources.isPending}
            >
              {publish.isPending ? "Publishing…" : submitLabel}
            </Button>
          )}
        </>
      }
    >
      <ol className="skill-steps">
        {steps.map((item, index) => (
          <li key={item.label}>
            <button
              type="button"
              aria-current={index === step ? "step" : undefined}
              disabled={busy || (index > step && !canEnter(index))}
              onClick={() => setStep(index)}
            >
              <span className="skill-steps__num" aria-hidden="true">
                {index + 1}
              </span>
              {item.label}
            </button>
          </li>
        ))}
      </ol>
      {step === 0 ? (
        <>
          {isNew ? (
            <Field label="Display name" hint="Shown in the Skill catalog.">
              <Input
                required
                autoFocus
                placeholder="Shipment Intake"
                value={displayName}
                onChange={(event) => {
                  const next = event.currentTarget.value;
                  setDisplayName(next);
                  if (!nameEdited) setName(slugify(next));
                }}
              />
            </Field>
          ) : null}
          <Field
            label="Skill name"
            hint={
              isNew
                ? "Identifier agents use to activate the Skill. Auto-generated from the display name; lowercase letters, numbers, and hyphens."
                : "Identifier agents use to activate the Skill. Lowercase letters, numbers, and hyphens."
            }
          >
            <Input
              required
              pattern="[a-z][a-z0-9]*(?:-[a-z0-9]+)*"
              value={name}
              autoFocus={!isNew}
              placeholder="shipment-intake"
              onChange={(event) => {
                const next = event.currentTarget.value;
                setName(next);
                setNameEdited(next.length > 0);
              }}
            />
          </Field>
          <Field
            label="Description"
            hint="One or two sentences: what the Skill does and when an agent should use it."
          >
            <Textarea
              required
              maxLength={1024}
              rows={3}
              value={description}
              onChange={(event) => setDescription(event.currentTarget.value)}
            />
          </Field>
        </>
      ) : null}
      {step === 1 ? (
        <MarkdownEditor
          label="Instructions"
          hint="The agent receives these full instructions only after it activates the Skill."
          value={instructions}
          onChange={setInstructions}
          rows={12}
          required
          autoFocus
        />
      ) : null}
      {step === 2 ? (
        <>
          <p className="skill-finder__intro">
            Optional supporting Markdown files, organized like a folder on disk.
            The agent reads a file only when the instructions point to its
            package path, such as <code>references/intake-flow.md</code>.
          </p>
          <SkillFinder
            entries={entriesWithInferredDirectories(draft.entries)}
            busy={busy}
            uploading={uploading}
            onCreateFolder={(path) =>
              mutateResources.mutateAsync({ kind: "directory", path })
            }
            onWriteFile={(path, content) =>
              mutateResources.mutateAsync({ kind: "file", path, content })
            }
            onRemove={(path, recursive) =>
              mutateResources.mutateAsync({ kind: "remove", path, recursive })
            }
            onUpload={uploadFiles}
          />
        </>
      ) : null}
      {localError ? <FormError>{localError}</FormError> : null}
      {mutateResources.error ? (
        <FormError>{mutateResources.error.message}</FormError>
      ) : null}
      {publish.error ? <FormError>{publish.error.message}</FormError> : null}
    </Dialog>
  );
}

function SkillFinder({
  entries,
  busy,
  uploading,
  onCreateFolder,
  onWriteFile,
  onRemove,
  onUpload,
}: {
  readonly entries: readonly SkillDraftEntry[];
  readonly busy: boolean;
  readonly uploading: boolean;
  readonly onCreateFolder: (path: string) => Promise<unknown>;
  readonly onWriteFile: (path: string, content: string) => Promise<unknown>;
  readonly onRemove: (path: string, recursive: boolean) => Promise<unknown>;
  readonly onUpload: (
    files: readonly File[],
    directory: string,
  ) => Promise<void>;
}) {
  const [directory, setDirectory] = useState("");
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [creating, setCreating] = useState<"folder" | "file" | null>(null);
  const [draftName, setDraftName] = useState("");
  const [dropping, setDropping] = useState(false);

  const openEntry =
    openPath === null
      ? null
      : (entries.find(
          (entry) => entry.kind === "file" && entry.path === openPath,
        ) ?? null);
  const items = entries
    .filter((entry) => directoryName(entry.path) === directory)
    .sort((left, right) =>
      left.kind === right.kind
        ? left.path.localeCompare(right.path)
        : left.kind === "directory"
          ? -1
          : 1,
    );
  const crumbs = directory ? directory.split("/") : [];
  const childCount = (path: string) =>
    entries.filter((entry) => directoryName(entry.path) === path).length;

  function goTo(path: string): void {
    setDirectory(path);
    setCreating(null);
    setDraftName("");
  }

  function openFile(entry: SkillDraftEntry): void {
    setOpenPath(entry.path);
    setContent(entry.dataBase64 ? base64Utf8(entry.dataBase64) : "");
    setDirty(false);
  }

  async function commitCreate(): Promise<void> {
    const value = draftName.trim().replace(/^\/+|\/+$/gu, "");
    if (!value || creating === null) return;
    const path = packagePath(
      directory,
      creating === "file" ? normalizedMarkdownName(value) : value,
    );
    try {
      if (creating === "folder") {
        await onCreateFolder(path);
        setDirectory(path);
      } else {
        const heading = (path.split("/").at(-1) ?? "")
          .replace(/\.md$/iu, "")
          .replace(/[-_]/gu, " ");
        const body = `# ${heading}\n`;
        await onWriteFile(path, body);
        setDirectory(directoryName(path));
        setOpenPath(path);
        setContent(body);
        setDirty(false);
      }
      setCreating(null);
      setDraftName("");
    } catch {
      // The dialog surfaces the API error; keep the input so a corrected
      // name can be retried.
    }
  }

  async function removeEntry(entry: SkillDraftEntry): Promise<void> {
    if (
      !globalThis.confirm(
        `Remove ${entry.path}${entry.kind === "directory" ? " and everything inside it" : ""}?`,
      )
    )
      return;
    try {
      await onRemove(entry.path, entry.kind === "directory");
      if (
        openPath !== null &&
        (openPath === entry.path || openPath.startsWith(`${entry.path}/`))
      )
        setOpenPath(null);
      if (directory === entry.path || directory.startsWith(`${entry.path}/`))
        setDirectory(directoryName(entry.path));
    } catch {
      // The dialog surfaces the API error.
    }
  }

  async function saveFile(): Promise<void> {
    if (openPath === null) return;
    try {
      await onWriteFile(openPath, content);
      setDirty(false);
    } catch {
      // The dialog surfaces the API error.
    }
  }

  async function closeEditor(): Promise<void> {
    if (dirty && openPath !== null) {
      try {
        await onWriteFile(openPath, content);
      } catch {
        return;
      }
    }
    setOpenPath(null);
    setDirty(false);
  }

  if (openEntry) {
    return (
      <div className="skill-finder">
        <div className="skill-finder__bar">
          <div className="skill-finder__editor-head">
            <IconButton
              label="Back to files"
              disabled={busy}
              onClick={() => void closeEditor()}
            >
              <ArrowLeft size={15} />
            </IconButton>
            <div>
              <strong>{openEntry.path}</strong>
              <small>
                {dirty
                  ? "Unsaved changes"
                  : `${openEntry.sizeBytes ?? 0} bytes`}
              </small>
            </div>
          </div>
          <Button
            size="sm"
            icon={<Save size={14} />}
            disabled={busy || !dirty}
            onClick={() => void saveFile()}
          >
            Save file
          </Button>
        </div>
        <div className="skill-finder__editor">
          <MarkdownEditor
            label="Markdown content"
            value={content}
            onChange={(next) => {
              setContent(next);
              setDirty(true);
            }}
            rows={12}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="skill-finder">
      <div className="skill-finder__bar">
        <nav className="skill-crumbs" aria-label="Package location">
          <button
            type="button"
            aria-current={directory === "" ? "location" : undefined}
            onClick={() => goTo("")}
          >
            Package root
          </button>
          {crumbs.map((segment, index) => {
            const path = crumbs.slice(0, index + 1).join("/");
            return (
              <span key={path} className="skill-crumbs__part">
                <ChevronRight size={13} aria-hidden="true" />
                <button
                  type="button"
                  aria-current={path === directory ? "location" : undefined}
                  onClick={() => goTo(path)}
                >
                  {segment}
                </button>
              </span>
            );
          })}
        </nav>
        <div className="skill-finder__actions">
          <Button
            size="sm"
            icon={<FolderPlus size={14} />}
            disabled={busy}
            onClick={() => {
              setCreating("folder");
              setDraftName("");
            }}
          >
            New folder
          </Button>
          <Button
            size="sm"
            icon={<FilePlus2 size={14} />}
            disabled={busy}
            onClick={() => {
              setCreating("file");
              setDraftName("");
            }}
          >
            New file
          </Button>
          <label className="btn btn--sm">
            {uploading ? (
              <span className="spin" aria-hidden="true" />
            ) : (
              <Upload size={14} />
            )}{" "}
            Upload Markdown
            <input
              className="sr-only"
              type="file"
              accept=".md,text/markdown"
              multiple
              disabled={busy}
              onChange={(event) => {
                const files = [...(event.currentTarget.files ?? [])];
                event.currentTarget.value = "";
                if (files.length) void onUpload(files, directory);
              }}
            />
          </label>
        </div>
      </div>
      <div
        className={`skill-finder__list${dropping ? " is-dropping" : ""}`}
        onDragOver={(event) => {
          event.preventDefault();
          if (!busy) setDropping(true);
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDropping(false);
          if (busy) return;
          const files = [...event.dataTransfer.files];
          if (files.length) void onUpload(files, directory);
        }}
      >
        {creating ? (
          <div className="skill-finder__new">
            {creating === "folder" ? (
              <Folder size={15} aria-hidden="true" />
            ) : (
              <FileText size={15} aria-hidden="true" />
            )}
            <Input
              autoFocus
              aria-label={creating === "folder" ? "Folder name" : "File name"}
              placeholder={
                creating === "folder" ? "references" : "business-rules.md"
              }
              value={draftName}
              onChange={(event) => setDraftName(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void commitCreate();
                } else if (event.key === "Escape") {
                  event.stopPropagation();
                  setCreating(null);
                }
              }}
            />
            <Button
              size="sm"
              disabled={busy || !draftName.trim()}
              onClick={() => void commitCreate()}
            >
              Add
            </Button>
            <IconButton label="Cancel" onClick={() => setCreating(null)}>
              <X size={14} />
            </IconButton>
          </div>
        ) : null}
        {items.map((entry) => (
          <div key={entry.path} className="skill-finder__row">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (entry.kind === "directory") goTo(entry.path);
                else openFile(entry);
              }}
            >
              {entry.kind === "directory" ? (
                <Folder size={15} aria-hidden="true" />
              ) : (
                <FileText size={15} aria-hidden="true" />
              )}
              <span className="skill-finder__name">
                {entry.path.split("/").at(-1)}
              </span>
            </button>
            <span className="skill-finder__meta">
              {entry.kind === "directory"
                ? `${childCount(entry.path)} ${childCount(entry.path) === 1 ? "item" : "items"}`
                : `${entry.sizeBytes ?? 0} bytes`}
            </span>
            <button
              type="button"
              className="skill-finder__remove"
              aria-label={`Remove ${entry.path}`}
              disabled={busy}
              onClick={() => void removeEntry(entry)}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        {items.length === 0 && !creating ? (
          <div className="skill-finder__empty">
            <Folder size={24} aria-hidden="true" />
            <strong>
              {directory === ""
                ? "No supporting files yet"
                : "This folder is empty"}
            </strong>
            <p>Create a Markdown file, or drop .md files here to upload.</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function SkillDetailPage() {
  const { skillId = "" } = useParams();
  const api = useApi();
  const queryClient = useQueryClient();
  const notify = useToast();
  const [draft, setDraft] = useState<SkillDraft | null>(null);
  const query = useQuery({
    queryKey: ["skill", skillId],
    queryFn: () => api.getSkill(skillId),
  });
  const createDraft = useMutation({
    mutationFn: (sourceSkillVersionId: string) =>
      api.createSkillDraft({ skillId, sourceSkillVersionId }),
    onSuccess: setDraft,
  });
  const exportVersion = useMutation({
    mutationFn: async (versionId: string) => {
      const skill = query.data;
      const version = skill?.versions.find((item) => item.id === versionId);
      if (!skill || !version) throw new Error("Skill version not found");
      const exported = await api.exportSkillVersion(skillId, versionId);
      downloadBundle(
        {
          schemaVersion: 1,
          kind: "oao.skill",
          skill: {
            key: skill.key,
            displayName: skill.displayName,
            name: version.name,
            description: version.description,
            instructions: version.instructions,
          },
          files: exported.files,
        },
        bundleFileName(skill.key, version.version),
      );
      return version.version;
    },
    onSuccess: (version) => notify(`Downloaded Skill version ${version}.`),
    onError: (error) => notify(error.message),
  });
  const importVersion = useMutation({
    mutationFn: async (file: File) => {
      const bundle = parseSkillBundle(await readUploadText(file));
      const created = await api.createSkillDraft({ skillId });
      try {
        return await applySkillBundle(api, created, bundle, {
          replaceResources: true,
        });
      } catch (error) {
        await api.discardSkillDraft(created.id).catch(() => undefined);
        throw error;
      }
    },
    onSuccess: setDraft,
    onError: (error) => notify(error.message),
  });
  const lifecycle = useMutation({
    mutationFn: (input: {
      readonly versionId: string;
      readonly status: "deprecated" | "revoked";
    }) =>
      api.updateSkillVersionLifecycle(skillId, input.versionId, input.status),
    onSuccess: async (_, input) => {
      await queryClient.invalidateQueries({ queryKey: ["skill", skillId] });
      await queryClient.invalidateQueries({ queryKey: ["skills"] });
      notify(`Skill version ${input.status}.`);
    },
  });
  if (query.isPending)
    return (
      <Page>
        <LoadingState label="Loading Skill" rows={6} />
      </Page>
    );
  if (query.isError)
    return (
      <Page>
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      </Page>
    );
  const latest = query.data.versions[0];
  return (
    <Page>
      <PageHeader
        breadcrumbs={[
          { label: "Skills", to: "/skills" },
          { label: query.data.displayName },
        ]}
        eyebrow={`${query.data.key} · v${query.data.version}`}
        title={query.data.displayName}
        description={query.data.description}
        actions={
          <>
            <SkillBundleUpload
              label="Upload version"
              pending={importVersion.isPending}
              onFile={(file) => importVersion.mutate(file)}
            />
            <Button
              variant="primary"
              icon={<Save size={15} />}
              loading={createDraft.isPending}
              disabled={!latest}
              onClick={() => {
                if (latest) createDraft.mutate(latest.id);
              }}
            >
              Publish new version
            </Button>
          </>
        }
      />
      <Panel
        title="Immutable versions"
        description="Agent and session bindings reference these exact version IDs."
        flush
      >
        <div className="compact-list">
          {query.data.versions.map((version) => (
            <article key={version.id} className="tool-card">
              <header>
                <strong>Version {version.version}</strong>
                <div className="btn-group">
                  <StatusChip value={version.status} />
                  <Button
                    size="sm"
                    icon={<Download size={14} />}
                    loading={
                      exportVersion.isPending &&
                      exportVersion.variables === version.id
                    }
                    disabled={exportVersion.isPending}
                    onClick={() => exportVersion.mutate(version.id)}
                  >
                    Download
                  </Button>
                  {version.status === "active" ? (
                    <Button
                      size="sm"
                      disabled={lifecycle.isPending}
                      onClick={() =>
                        lifecycle.mutate({
                          versionId: version.id,
                          status: "deprecated",
                        })
                      }
                    >
                      Deprecate
                    </Button>
                  ) : null}
                  {version.status !== "revoked" ? (
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={lifecycle.isPending}
                      onClick={() => {
                        if (
                          globalThis.confirm(
                            `Revoke Skill version ${version.version}? Existing sessions will fail admission.`,
                          )
                        )
                          lifecycle.mutate({
                            versionId: version.id,
                            status: "revoked",
                          });
                      }}
                    >
                      Revoke
                    </Button>
                  ) : null}
                </div>
              </header>
              <p>{version.description}</p>
              <small>
                {formatDate(version.createdAt)} · {version.files.length}{" "}
                resources
              </small>
              <code>{version.contentHash}</code>
              <details className="skill-content-details">
                <summary>Instructions</summary>
                <div className="skill-markdown-panel">
                  <MarkdownContent>{version.instructions}</MarkdownContent>
                </div>
              </details>
              {version.files.length > 0 ? (
                <SkillVersionResources
                  skillId={skillId}
                  versionId={version.id}
                  files={version.files}
                />
              ) : null}
            </article>
          ))}
        </div>
        {lifecycle.error ? (
          <FormError>{lifecycle.error.message}</FormError>
        ) : null}
      </Panel>
      {draft ? (
        <SkillDialog
          draft={draft}
          title="Publish new Skill version"
          submitLabel="Publish version"
          onClose={() => {
            const draftId = draft.id;
            setDraft(null);
            void api
              .discardSkillDraft(draftId)
              .catch((error: unknown) =>
                notify(
                  error instanceof Error
                    ? error.message
                    : "Could not discard the Skill draft.",
                ),
              );
          }}
          onPublished={async () => {
            await queryClient.invalidateQueries({
              queryKey: ["skill", skillId],
            });
            await queryClient.invalidateQueries({ queryKey: ["skills"] });
            setDraft(null);
            notify("New immutable Skill version published.");
          }}
        />
      ) : null}
    </Page>
  );
}

function SkillVersionResources({
  skillId,
  versionId,
  files,
}: {
  readonly skillId: string;
  readonly versionId: string;
  readonly files: SkillDetail["versions"][number]["files"];
}) {
  const api = useApi();
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ["skill", skillId, "version", versionId, "export"],
    queryFn: () => api.exportSkillVersion(skillId, versionId),
    enabled: open,
  });
  const exportedByPath = new Map(
    query.data?.files.map((file) => [file.path, file] as const) ?? [],
  );

  return (
    <details
      className="skill-content-details"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        Reference resources <span>({files.length})</span>
      </summary>
      <div className="skill-resource-list">
        {files.map((file) => {
          const exported = exportedByPath.get(file.path);
          const isMarkdown = file.contentType
            .toLowerCase()
            .startsWith("text/markdown");
          return (
            <section className="skill-resource" key={file.path}>
              <header>
                <strong>{file.path}</strong>
                <small>
                  {file.contentType} · {file.sizeBytes} bytes
                </small>
              </header>
              <p className="skill-runtime-path">
                Runtime path:{" "}
                <code>
                  /.flue/packaged-skills/&lt;Flue-skill-id&gt;/{file.path}
                </code>
              </p>
              {query.isPending ? (
                <p role="status">Loading reference…</p>
              ) : query.isError ? (
                <FormError>{query.error.message}</FormError>
              ) : isMarkdown && exported ? (
                <div className="skill-markdown-panel">
                  <MarkdownContent>
                    {base64Utf8(exported.dataBase64)}
                  </MarkdownContent>
                </div>
              ) : (
                <p>This resource is not rendered as Markdown.</p>
              )}
            </section>
          );
        })}
      </div>
    </details>
  );
}
