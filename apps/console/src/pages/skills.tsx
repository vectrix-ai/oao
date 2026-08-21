import { Plus, Save } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useApi } from "../api/context";
import type { CreateSkillInput } from "../api/types";
import {
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  FormError,
  Input,
  LoadingState,
  Page,
  PageHeader,
  Panel,
  StatusChip,
  Textarea,
  formatDate,
  useToast,
} from "../components/ui";

function utf8Base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function SkillsPage() {
  const api = useApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const notify = useToast();
  const [creating, setCreating] = useState(false);
  const query = useQuery({
    queryKey: ["skills"],
    queryFn: () => api.listSkills({}),
  });
  const create = useMutation({
    mutationFn: (input: CreateSkillInput) => api.createSkill(input),
    onSuccess: async (skill) => {
      await queryClient.invalidateQueries({ queryKey: ["skills"] });
      setCreating(false);
      notify("Skill created with immutable version 1.");
      navigate(`/skills/${skill.id}`);
    },
  });
  return (
    <Page>
      <PageHeader
        eyebrow="Build"
        title="Skills"
        description="Versioned procedural knowledge loaded progressively by managed agents."
        actions={
          <Button
            variant="primary"
            icon={<Plus size={15} />}
            onClick={() => setCreating(true)}
          >
            Create Skill
          </Button>
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
            <Button onClick={() => setCreating(true)}>Create Skill</Button>
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
      {creating ? (
        <SkillDialog
          title="Create Skill"
          submitLabel="Create Skill"
          pending={create.isPending}
          error={create.error}
          onClose={() => setCreating(false)}
          onSubmit={(input) => create.mutate(input)}
        />
      ) : null}
    </Page>
  );
}

function SkillDialog({
  title,
  submitLabel,
  pending,
  error,
  initial,
  onClose,
  onSubmit,
}: {
  readonly title: string;
  readonly submitLabel: string;
  readonly pending: boolean;
  readonly error: Error | null;
  readonly initial?: {
    readonly displayName?: string;
    readonly name: string;
    readonly description: string;
    readonly instructions: string;
  };
  readonly onClose: () => void;
  readonly onSubmit: (input: CreateSkillInput) => void;
}) {
  return (
    <Dialog
      title={title}
      description="The name and description form the small always-visible catalog entry. Full instructions and references load only when activated."
      wide
      onClose={onClose}
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const referencePath = String(data.get("referencePath") ?? "").trim();
        const referenceContent = String(data.get("referenceContent") ?? "");
        onSubmit({
          displayName: String(
            data.get("displayName") ?? initial?.displayName ?? "",
          ),
          name: String(data.get("name") ?? ""),
          description: String(data.get("description") ?? ""),
          instructions: String(data.get("instructions") ?? ""),
          ...(referencePath && referenceContent
            ? {
                files: [
                  {
                    path: referencePath,
                    contentType: "text/markdown",
                    dataBase64: utf8Base64(referenceContent),
                  },
                ],
              }
            : {}),
        });
      }}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" loading={pending}>
            {pending ? "Publishing…" : submitLabel}
          </Button>
        </>
      }
    >
      {initial?.displayName === undefined ? (
        <Field label="Display name">
          <Input
            name="displayName"
            required
            autoFocus
            placeholder="Shipment Intake"
          />
        </Field>
      ) : null}
      <Field label="Skill name" hint="Lowercase letters, numbers, and hyphens.">
        <Input
          name="name"
          required
          pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
          defaultValue={initial?.name}
          autoFocus={initial?.displayName !== undefined}
          placeholder="shipment-intake"
        />
      </Field>
      <Field
        label="Catalog description"
        hint="Say what it does and when to use it."
      >
        <Textarea
          name="description"
          required
          maxLength={1024}
          rows={3}
          defaultValue={initial?.description}
        />
      </Field>
      <Field label="Instructions">
        <Textarea
          name="instructions"
          required
          rows={10}
          defaultValue={initial?.instructions}
        />
      </Field>
      <Field
        label="Optional reference path"
        hint="For example references/intake-flow.md."
      >
        <Input name="referencePath" placeholder="references/reference.md" />
      </Field>
      <Field label="Optional Markdown reference">
        <Textarea name="referenceContent" rows={6} />
      </Field>
      {error ? <FormError>{error.message}</FormError> : null}
    </Dialog>
  );
}

export function SkillDetailPage() {
  const { skillId = "" } = useParams();
  const api = useApi();
  const queryClient = useQueryClient();
  const notify = useToast();
  const [publishing, setPublishing] = useState(false);
  const query = useQuery({
    queryKey: ["skill", skillId],
    queryFn: () => api.getSkill(skillId),
  });
  const publish = useMutation({
    mutationFn: async (input: CreateSkillInput) => {
      const latest = query.data?.versions[0];
      const exported = latest
        ? await api.exportSkillVersion(skillId, latest.id)
        : { files: [] };
      return api.publishSkillVersion(skillId, {
        name: input.name,
        description: input.description,
        instructions: input.instructions,
        files: input.files ?? exported.files,
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["skill", skillId] });
      await queryClient.invalidateQueries({ queryKey: ["skills"] });
      setPublishing(false);
      notify("New immutable Skill version published.");
    },
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
          <Button
            variant="primary"
            icon={<Save size={15} />}
            onClick={() => setPublishing(true)}
          >
            Publish new version
          </Button>
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
              <details>
                <summary>Instructions</summary>
                <pre className="code-block">{version.instructions}</pre>
              </details>
            </article>
          ))}
        </div>
        {lifecycle.error ? (
          <FormError>{lifecycle.error.message}</FormError>
        ) : null}
      </Panel>
      {publishing && latest ? (
        <SkillDialog
          title="Publish new Skill version"
          submitLabel="Publish version"
          pending={publish.isPending}
          error={publish.error}
          initial={{
            displayName: query.data.displayName,
            name: latest.name,
            description: latest.description,
            instructions: latest.instructions,
          }}
          onClose={() => setPublishing(false)}
          onSubmit={(input) => publish.mutate(input)}
        />
      ) : null}
    </Page>
  );
}
