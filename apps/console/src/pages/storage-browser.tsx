import { FileText, Folder } from "lucide-react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router";
import { useApi } from "../api/context";
import {
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  Page,
  PageHeader,
  Panel,
  StatusChip,
  TableCard,
  formatDate,
} from "../components/ui";

function browseHref(providerId: string, prefix: string): string {
  const query = prefix ? `?prefix=${encodeURIComponent(prefix)}` : "";
  return `/storage-providers/${encodeURIComponent(providerId)}${query}`;
}

function entryName(key: string): string {
  return key.split("/").filter(Boolean).at(-1) ?? key;
}

function formatObjectSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function StorageBrowserPage() {
  const api = useApi();
  const { providerId = "" } = useParams();
  const [searchParams] = useSearchParams();
  const prefix = searchParams.get("prefix") ?? "";
  const highlight = searchParams.get("highlight") ?? "";
  const providers = useQuery({
    queryKey: ["storage-providers"],
    queryFn: () => api.listStorageProviders(),
  });
  const objects = useInfiniteQuery({
    queryKey: ["storage-objects", providerId, prefix],
    queryFn: ({ pageParam }) =>
      api.listStorageObjects(providerId, {
        ...(prefix ? { prefix } : {}),
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: "",
    getNextPageParam: (last) =>
      last.truncated && last.cursor ? last.cursor : undefined,
  });
  const provider = providers.data?.data.find(
    (entry) => entry.id === providerId,
  );
  const segments = prefix.split("/").filter(Boolean);
  const crumbs = [
    { label: "Storage providers", to: "/storage-providers" },
    ...(provider && segments.length > 0
      ? [{ label: provider.displayName, to: browseHref(providerId, "") }]
      : provider
        ? [{ label: provider.displayName }]
        : []),
    ...segments.map((segment, index) => {
      const target = `${segments.slice(0, index + 1).join("/")}/`;
      return index === segments.length - 1
        ? { label: segment }
        : { label: segment, to: browseHref(providerId, target) };
    }),
  ];
  const folders = objects.data?.pages.flatMap((page) => page.folders) ?? [];
  const entries = objects.data?.pages.flatMap((page) => page.objects) ?? [];
  return (
    <Page>
      <PageHeader
        eyebrow="Configure"
        title={provider ? provider.displayName : "Storage provider"}
        description={
          provider
            ? `Objects this project stores in s3://${provider.bucket}${provider.prefix ? `/${provider.prefix}` : ""}. Keys are shown relative to the project's storage root.`
            : "Objects this project stores with the selected provider."
        }
        breadcrumbs={crumbs}
      />
      <Panel
        title={prefix ? `Folder ${prefix}` : "Project storage root"}
        description="Run attachments live under run-files/ and per-thread workspace archives under workspace-backups/."
      >
        {providers.isError ? (
          <ErrorState
            error={providers.error}
            retry={() => void providers.refetch()}
          />
        ) : objects.isPending || providers.isPending ? (
          <LoadingState label="Loading stored objects" rows={3} />
        ) : objects.isError ? (
          <ErrorState
            error={objects.error}
            retry={() => void objects.refetch()}
          />
        ) : folders.length === 0 && entries.length === 0 ? (
          <EmptyState
            icon="▤"
            title="No stored objects"
            description={
              prefix
                ? "This folder does not contain any objects."
                : "Nothing has been stored for this project yet. Attach files to a session or complete an agent run to create workspace backups."
            }
          />
        ) : (
          <div className="stack">
            <TableCard
              label="Stored objects table"
              caption={
                prefix
                  ? `Folders and objects under ${prefix}`
                  : "Folders and objects at the storage root"
              }
            >
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Size</th>
                  <th>Last modified</th>
                </tr>
              </thead>
              <tbody>
                {folders.map((folder) => (
                  <tr key={folder}>
                    <td>
                      <span className="storage-entry">
                        <Folder size={15} aria-hidden="true" />
                        <Link
                          to={browseHref(providerId, folder)}
                          title={folder}
                        >
                          {entryName(folder)}/
                        </Link>
                      </span>
                    </td>
                    <td>—</td>
                    <td>—</td>
                  </tr>
                ))}
                {entries.map((object) => (
                  <tr
                    key={object.key}
                    className={
                      highlight && entryName(object.key) === highlight
                        ? "storage-row--highlight"
                        : undefined
                    }
                  >
                    <td>
                      <span className="storage-entry" title={object.key}>
                        <FileText size={15} aria-hidden="true" />
                        <span>{entryName(object.key)}</span>
                        {highlight && entryName(object.key) === highlight ? (
                          <StatusChip value="selected" />
                        ) : null}
                      </span>
                    </td>
                    <td>{formatObjectSize(object.sizeBytes)}</td>
                    <td>
                      {object.lastModifiedAt
                        ? formatDate(object.lastModifiedAt)
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableCard>
            {objects.hasNextPage ? (
              <Button
                size="sm"
                disabled={objects.isFetchingNextPage}
                onClick={() => void objects.fetchNextPage()}
              >
                {objects.isFetchingNextPage ? "Loading…" : "Load more"}
              </Button>
            ) : null}
          </div>
        )}
      </Panel>
    </Page>
  );
}
