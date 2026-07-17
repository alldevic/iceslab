import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Code,
  CopyButton,
  Group,
  Loader,
  Modal,
  NumberInput,
  ScrollArea,
  Select,
  SegmentedControl,
  Stack,
  Switch,
  TagsInput,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  IconChevronDown,
  IconChevronUp,
  IconEdit,
  IconListSearch,
  IconPlus,
  IconRefresh,
  IconTrash,
} from '@tabler/icons-react';
import {
  getGeoSources,
  addGeoSource,
  updateGeoSource,
  deleteGeoSource,
  reorderGeoSources,
  getSourceCategories,
  getSourceCategoryPreview,
  getGeoCategories,
  addGeoCategory,
  updateGeoCategory,
  deleteGeoCategory,
  buildGeo,
  getGeoBuild,
  apiErrorMessage,
  type GeoSource,
  type GeoCategorySpec,
  type GeoCategoryRef,
} from '../lib/api';

// Geo databases: operator-managed upstream sources + composed custom categories,
// compiled into minimal .dat artifacts served from the panel (removing the
// GitHub/jsdelivr dependency). This is the authoring surface for G1/G3 + build.
export function GeoPanel() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const onError = (err: unknown) =>
    notifications.show({ color: 'red', message: apiErrorMessage(err) });

  const sourcesQuery = useQuery({ queryKey: ['geo', 'sources'], queryFn: getGeoSources });
  const categoriesQuery = useQuery({ queryKey: ['geo', 'categories'], queryFn: getGeoCategories });
  const buildQuery = useQuery({ queryKey: ['geo', 'build'], queryFn: getGeoBuild });

  const [srcModal, setSrcModal] = useState<GeoSource | 'new' | null>(null);
  const [catModal, setCatModal] = useState<GeoCategorySpec | 'new' | null>(null);
  const [browseSrc, setBrowseSrc] = useState<GeoSource | null>(null);

  const rebuild = useMutation({
    mutationFn: buildGeo,
    onSuccess: () => {
      notifications.show({ color: 'green', message: t('geo.rebuilt') });
      qc.invalidateQueries({ queryKey: ['geo', 'build'] });
    },
    onError,
  });

  // Enable/disable toggles with an OPTIMISTIC cache update, so the switch moves
  // instantly instead of "sticking" until the PATCH round-trip + refetch lands;
  // rolled back on error.
  const SRC_KEY = ['geo', 'sources'];
  const toggleSource = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      updateGeoSource(id, { enabled }),
    onMutate: async ({ id, enabled }) => {
      await qc.cancelQueries({ queryKey: SRC_KEY });
      const prev = qc.getQueryData<{ sources: GeoSource[] }>(SRC_KEY);
      if (prev) {
        qc.setQueryData<{ sources: GeoSource[] }>(SRC_KEY, {
          sources: prev.sources.map((s) => (s.id === id ? { ...s, enabled } : s)),
        });
      }
      return { prev };
    },
    onError: (err, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(SRC_KEY, ctx.prev);
      onError(err);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: SRC_KEY }),
  });

  // Reorder = set priority (first enabled with a db wins the client mirror).
  const reorder = useMutation({
    mutationFn: (ids: string[]) => reorderGeoSources(ids),
    onMutate: async (ids) => {
      await qc.cancelQueries({ queryKey: SRC_KEY });
      const prev = qc.getQueryData<{ sources: GeoSource[] }>(SRC_KEY);
      if (prev) {
        const byId = new Map(prev.sources.map((s) => [s.id, s]));
        const next = ids.map((id) => byId.get(id)).filter((s): s is GeoSource => !!s);
        qc.setQueryData<{ sources: GeoSource[] }>(SRC_KEY, { sources: next });
      }
      return { prev };
    },
    onError: (err, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(SRC_KEY, ctx.prev);
      onError(err);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: SRC_KEY }),
  });

  const CAT_KEY = ['geo', 'categories'];
  const toggleCategory = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      updateGeoCategory(id, { enabled }),
    onMutate: async ({ id, enabled }) => {
      await qc.cancelQueries({ queryKey: CAT_KEY });
      const prev = qc.getQueryData<{ categories: GeoCategorySpec[] }>(CAT_KEY);
      if (prev) {
        qc.setQueryData<{ categories: GeoCategorySpec[] }>(CAT_KEY, {
          categories: prev.categories.map((c) => (c.id === id ? { ...c, enabled } : c)),
        });
      }
      return { prev };
    },
    onError: (err, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(CAT_KEY, ctx.prev);
      onError(err);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: CAT_KEY }),
  });

  const sources = sourcesQuery.data?.sources ?? [];
  const categories = categoriesQuery.data?.categories ?? [];
  const build = buildQuery.data;

  // Which source is the client-facing MIRROR for each database = the first
  // ENABLED source (in list order) that provides it. Order = priority.
  const mirrorGeositeId = sources.find((s) => s.enabled && s.geositeUrl)?.id;
  const mirrorGeoipId = sources.find((s) => s.enabled && s.geoipUrl)?.id;
  function moveSource(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= sources.length) return;
    const ids = sources.map((s) => s.id);
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    reorder.mutate(ids);
  }

  return (
    <Stack gap="lg">
      {/* ───── sources ───── */}
      <Card withBorder padding="md" radius="md">
        <Group justify="space-between" mb="sm">
          <Text fw={600}>{t('geo.sources')}</Text>
          <Button
            size="xs"
            variant="light"
            leftSection={<IconPlus size={14} />}
            onClick={() => setSrcModal('new')}
          >
            {t('geo.addSource')}
          </Button>
        </Group>
        {sourcesQuery.isLoading ? (
          <Loader size="sm" />
        ) : (
          <Stack gap={6}>
            {sources.map((s, i) => (
              <Card key={s.id} withBorder padding="xs" radius="sm">
                <Group justify="space-between" wrap="nowrap">
                  <Group gap={4} wrap="nowrap" style={{ minWidth: 0 }}>
                    <Stack gap={0}>
                      <ActionIcon
                        size="xs"
                        variant="subtle"
                        disabled={i === 0}
                        onClick={() => moveSource(i, -1)}
                        aria-label={t('geo.moveUp')}
                      >
                        <IconChevronUp size={14} />
                      </ActionIcon>
                      <ActionIcon
                        size="xs"
                        variant="subtle"
                        disabled={i === sources.length - 1}
                        onClick={() => moveSource(i, 1)}
                        aria-label={t('geo.moveDown')}
                      >
                        <IconChevronDown size={14} />
                      </ActionIcon>
                    </Stack>
                    <div style={{ minWidth: 0 }}>
                      <Group gap={6}>
                        <Text size="sm" fw={500}>
                          {s.name}
                        </Text>
                        {s.trusted && (
                          <Badge size="xs" color="blue" variant="light">
                            {t('geo.defaultBadge')}
                          </Badge>
                        )}
                        {s.id === mirrorGeositeId && (
                          <Tooltip label={t('geo.mirrorHint')}>
                            <Badge size="xs" color="teal" variant="light">
                              {t('geo.mirrorGeosite')}
                            </Badge>
                          </Tooltip>
                        )}
                        {s.id === mirrorGeoipId && (
                          <Tooltip label={t('geo.mirrorHint')}>
                            <Badge size="xs" color="teal" variant="light">
                              {t('geo.mirrorGeoip')}
                            </Badge>
                          </Tooltip>
                        )}
                      </Group>
                      <Text size="xs" c="dimmed" truncate>
                        {[s.geositeUrl && 'geosite', s.geoipUrl && 'geoip']
                          .filter(Boolean)
                          .join(' + ')}{' '}
                        · {t('geo.everyHours', { n: s.refreshIntervalHours })}
                      </Text>
                    </div>
                  </Group>
                  <Group gap={4} wrap="nowrap">
                    <Switch
                      size="sm"
                      checked={s.enabled}
                      onChange={(e) =>
                        toggleSource.mutate({ id: s.id, enabled: e.currentTarget.checked })
                      }
                    />
                    <Tooltip label={t('geo.browseCategories')}>
                      <ActionIcon
                        variant="subtle"
                        onClick={() => setBrowseSrc(s)}
                        aria-label={t('geo.browseCategories')}
                      >
                        <IconListSearch size={16} />
                      </ActionIcon>
                    </Tooltip>
                    <ActionIcon variant="subtle" onClick={() => setSrcModal(s)} aria-label="edit">
                      <IconEdit size={16} />
                    </ActionIcon>
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      onClick={() =>
                        deleteGeoSource(s.id)
                          .then(() => qc.invalidateQueries({ queryKey: ['geo', 'sources'] }))
                          .catch(onError)
                      }
                      aria-label="delete"
                    >
                      <IconTrash size={16} />
                    </ActionIcon>
                  </Group>
                </Group>
              </Card>
            ))}
          </Stack>
        )}
      </Card>

      {/* ───── custom categories ───── */}
      <Card withBorder padding="md" radius="md">
        <Group justify="space-between" mb="sm">
          <Text fw={600}>{t('geo.categories')}</Text>
          <Button
            size="xs"
            variant="light"
            leftSection={<IconPlus size={14} />}
            onClick={() => setCatModal('new')}
          >
            {t('geo.addCategory')}
          </Button>
        </Group>
        {categoriesQuery.isLoading ? (
          <Loader size="sm" />
        ) : categories.length === 0 ? (
          <Text size="sm" c="dimmed">
            {t('geo.categoriesEmpty')}
          </Text>
        ) : (
          <Stack gap={6}>
            {categories.map((c) => (
              <Card key={c.id} withBorder padding="xs" radius="sm">
                <Group justify="space-between" wrap="nowrap">
                  <div style={{ minWidth: 0 }}>
                    <Text size="sm" fw={500}>
                      {c.name}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {t('geo.refsSummary', {
                        refs: c.domainRefs.length + c.ipRefs.length,
                        domains: c.manualDomains.length,
                        ips: c.manualIps.length,
                      })}
                    </Text>
                  </div>
                  <Group gap={4} wrap="nowrap">
                    <Switch
                      size="sm"
                      checked={c.enabled}
                      onChange={(e) =>
                        toggleCategory.mutate({ id: c.id, enabled: e.currentTarget.checked })
                      }
                    />
                    <ActionIcon variant="subtle" onClick={() => setCatModal(c)} aria-label="edit">
                      <IconEdit size={16} />
                    </ActionIcon>
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      onClick={() =>
                        deleteGeoCategory(c.id)
                          .then(() => qc.invalidateQueries({ queryKey: ['geo', 'categories'] }))
                          .catch(onError)
                      }
                      aria-label="delete"
                    >
                      <IconTrash size={16} />
                    </ActionIcon>
                  </Group>
                </Group>
              </Card>
            ))}
          </Stack>
        )}
      </Card>

      {/* ───── build ───── */}
      <Card withBorder padding="md" radius="md">
        <Group justify="space-between" mb="sm">
          <Text fw={600}>{t('geo.build')}</Text>
          <Button
            size="xs"
            leftSection={<IconRefresh size={14} />}
            loading={rebuild.isPending}
            onClick={() => rebuild.mutate()}
          >
            {t('geo.rebuild')}
          </Button>
        </Group>
        {!build ? (
          <Text size="sm" c="dimmed">
            {t('geo.notBuilt')}
          </Text>
        ) : (
          <Stack gap={6}>
            <Text size="xs" c="dimmed">
              {t('geo.builtAt', { when: new Date(build.builtAt).toLocaleString() })}
            </Text>
            <Group gap={6}>
              {build.artifacts.map((a) => (
                <Badge key={a.name} variant="light" size="sm">
                  {a.name} · {(a.size / 1024).toFixed(1)} KB
                </Badge>
              ))}
            </Group>
            {build.categories.map((c) => (
              <Text key={c.name} size="xs">
                {t('geo.catStat', { name: c.name, domains: c.domains, cidrs: c.cidrs })}
                {c.missing.length > 0 && (
                  <Text span c="orange">
                    {' '}
                    · {t('geo.missing', { list: c.missing.join(', ') })}
                  </Text>
                )}
              </Text>
            ))}
            {build.sourceErrors.length > 0 && (
              <Text size="xs" c="red">
                {t('geo.sourceErrors', {
                  count: build.sourceErrors.length,
                  first: build.sourceErrors[0]!.error,
                })}
              </Text>
            )}
          </Stack>
        )}
      </Card>

      {srcModal && (
        <SourceModal
          source={srcModal === 'new' ? null : srcModal}
          onClose={() => setSrcModal(null)}
          onSaved={() => {
            setSrcModal(null);
            qc.invalidateQueries({ queryKey: ['geo', 'sources'] });
          }}
          onError={onError}
        />
      )}
      {catModal && (
        <CategoryModal
          category={catModal === 'new' ? null : catModal}
          sources={sources}
          onClose={() => setCatModal(null)}
          onSaved={() => {
            setCatModal(null);
            qc.invalidateQueries({ queryKey: ['geo', 'categories'] });
          }}
          onError={onError}
        />
      )}
      {browseSrc && <SourceCategoriesModal source={browseSrc} onClose={() => setBrowseSrc(null)} />}
    </Stack>
  );
}

// Read-only browser of a source's geosite/geoip categories (name + entry count),
// with a click-to-preview of a category's sample entries.
function SourceCategoriesModal({ source, onClose }: { source: GeoSource; onClose: () => void }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'geosite' | 'geoip'>('geosite');
  const [filter, setFilter] = useState('');
  const [preview, setPreview] = useState<{ name: string; kind: 'geosite' | 'geoip' } | null>(null);

  const q = useQuery({
    queryKey: ['geo', 'sourceCategories', source.id],
    queryFn: () => getSourceCategories(source.id),
  });
  const previewQ = useQuery({
    queryKey: ['geo', 'catPreview', source.id, preview?.kind, preview?.name],
    queryFn: () => getSourceCategoryPreview(source.id, preview!.kind, preview!.name),
    enabled: !!preview,
  });

  const list = (tab === 'geosite' ? q.data?.geosite : q.data?.geoip) ?? [];
  const f = filter.trim().toLowerCase();
  const shown = f ? list.filter((c) => c.name.toLowerCase().includes(f)) : list;

  return (
    <Modal opened onClose={onClose} title={t('geo.categoriesOf', { name: source.name })} size="xl">
      <Stack gap="sm">
        <SegmentedControl
          value={tab}
          onChange={(v) => {
            setTab(v as 'geosite' | 'geoip');
            setPreview(null);
          }}
          data={[
            { value: 'geosite', label: t('geo.tabGeosite', { n: q.data?.geosite.length ?? 0 }) },
            { value: 'geoip', label: t('geo.tabGeoip', { n: q.data?.geoip.length ?? 0 }) },
          ]}
        />
        {q.data?.errors && q.data.errors.length > 0 && (
          <Text size="xs" c="red">
            {q.data.errors.join('; ')}
          </Text>
        )}
        <TextInput
          placeholder={t('geo.filterCategories')}
          value={filter}
          onChange={(e) => setFilter(e.currentTarget.value)}
        />
        {q.isLoading ? (
          <Loader size="sm" />
        ) : (
          <Group align="flex-start" gap="md" wrap="nowrap">
            <ScrollArea h={360} style={{ flex: 1 }}>
              <Stack gap={2}>
                {shown.map((c) => (
                  <Group
                    key={c.name}
                    justify="space-between"
                    wrap="nowrap"
                    style={{
                      cursor: 'pointer',
                      borderRadius: 4,
                      padding: '4px 8px',
                      background:
                        preview?.name === c.name && preview.kind === tab
                          ? 'var(--mantine-color-default-hover)'
                          : undefined,
                    }}
                    onClick={() => setPreview({ name: c.name, kind: tab })}
                  >
                    <Text size="sm" ff="monospace">
                      {c.name}
                    </Text>
                    <Badge size="xs" variant="light">
                      {c.count}
                    </Badge>
                  </Group>
                ))}
                {shown.length === 0 && (
                  <Text size="sm" c="dimmed">
                    {t('geo.noCategories')}
                  </Text>
                )}
              </Stack>
            </ScrollArea>
            <ScrollArea h={360} style={{ flex: 1 }}>
              {!preview ? (
                <Text size="sm" c="dimmed">
                  {t('geo.previewHint')}
                </Text>
              ) : previewQ.isLoading ? (
                <Loader size="sm" />
              ) : (
                <Stack gap={4}>
                  <Group gap={6}>
                    <Text size="sm" fw={600} ff="monospace">
                      {preview.name}
                    </Text>
                    <Badge size="xs" variant="light">
                      {t('geo.previewCount', {
                        shown: previewQ.data?.entries.length ?? 0,
                        total: previewQ.data?.total ?? 0,
                      })}
                    </Badge>
                    <CopyButton value={(previewQ.data?.entries ?? []).join('\n')}>
                      {({ copied, copy }) => (
                        <Button size="compact-xs" variant="subtle" onClick={copy}>
                          {copied ? t('common.copied') : t('common.copy')}
                        </Button>
                      )}
                    </CopyButton>
                  </Group>
                  <Code block style={{ whiteSpace: 'pre-wrap', fontSize: 11 }}>
                    {(previewQ.data?.entries ?? []).join('\n')}
                  </Code>
                </Stack>
              )}
            </ScrollArea>
          </Group>
        )}
      </Stack>
    </Modal>
  );
}

function SourceModal({
  source,
  onClose,
  onSaved,
  onError,
}: {
  source: GeoSource | null;
  onClose: () => void;
  onSaved: () => void;
  onError: (err: unknown) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(source?.name ?? '');
  const [geositeUrl, setGeositeUrl] = useState(source?.geositeUrl ?? '');
  const [geoipUrl, setGeoipUrl] = useState(source?.geoipUrl ?? '');
  const [interval, setIntervalHours] = useState<number | string>(source?.refreshIntervalHours ?? 24);

  const save = useMutation({
    mutationFn: () => {
      const refreshIntervalHours =
        typeof interval === 'number' && interval >= 1 ? Math.round(interval) : 24;
      const input = {
        name,
        geositeUrl: geositeUrl.trim() || null,
        geoipUrl: geoipUrl.trim() || null,
        refreshIntervalHours,
      };
      return source ? updateGeoSource(source.id, input) : addGeoSource(input);
    },
    onSuccess: onSaved,
    onError,
  });

  const valid = name.trim().length > 0 && (geositeUrl.trim() || geoipUrl.trim());

  return (
    <Modal opened onClose={onClose} title={source ? t('geo.editSource') : t('geo.newSource')} size="lg">
      <Stack gap="sm">
        <TextInput
          label={t('geo.name')}
          required
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
        />
        <TextInput
          label={t('geo.geositeUrl')}
          placeholder="https://.../geosite.dat"
          value={geositeUrl}
          onChange={(e) => setGeositeUrl(e.currentTarget.value)}
        />
        <TextInput
          label={t('geo.geoipUrl')}
          placeholder="https://.../geoip.dat"
          value={geoipUrl}
          onChange={(e) => setGeoipUrl(e.currentTarget.value)}
        />
        <NumberInput
          label={t('geo.refreshInterval')}
          description={t('geo.refreshIntervalHint')}
          value={interval}
          onChange={setIntervalHours}
          min={1}
          max={24 * 30}
          step={1}
          clampBehavior="strict"
          w={220}
        />
        <Text size="xs" c="dimmed">
          {t('geo.sourceUrlHint')}
        </Text>
        <Group justify="flex-end">
          <Button variant="subtle" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button disabled={!valid} loading={save.isPending} onClick={() => save.mutate()}>
            {source ? t('common.save') : t('common.create')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function CategoryModal({
  category,
  sources,
  onClose,
  onSaved,
  onError,
}: {
  category: GeoCategorySpec | null;
  sources: GeoSource[];
  onClose: () => void;
  onSaved: () => void;
  onError: (err: unknown) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(category?.name ?? '');
  const [domainRefs, setDomainRefs] = useState<GeoCategoryRef[]>(category?.domainRefs ?? []);
  const [ipRefs, setIpRefs] = useState<GeoCategoryRef[]>(category?.ipRefs ?? []);
  const [manualDomains, setManualDomains] = useState<string[]>(category?.manualDomains ?? []);
  const [manualIps, setManualIps] = useState<string[]>(category?.manualIps ?? []);
  const [excludeDomains, setExcludeDomains] = useState<string[]>(category?.excludeDomains ?? []);

  const sourceOptions = sources
    .filter((s) => s.geositeUrl || s.geoipUrl)
    .map((s) => ({ value: s.id, label: s.name }));

  const save = useMutation({
    mutationFn: () => {
      // Drop half-filled ref rows (no source picked / empty category name) so
      // an abandoned row does not bounce off schema validation as a raw 400.
      const complete = (r: GeoCategoryRef) => r.sourceId !== '' && r.category.trim() !== '';
      const input = {
        name,
        domainRefs: domainRefs.filter(complete),
        ipRefs: ipRefs.filter(complete),
        manualDomains,
        manualIps,
        excludeDomains,
      };
      return category ? updateGeoCategory(category.id, input) : addGeoCategory(input);
    },
    onSuccess: onSaved,
    onError,
  });

  function refEditor(
    label: string,
    refs: GeoCategoryRef[],
    setRefs: (r: GeoCategoryRef[]) => void,
  ) {
    return (
      <Stack gap={4}>
        <Group justify="space-between">
          <Text size="sm" fw={500}>
            {label}
          </Text>
          <Button
            size="xs"
            variant="subtle"
            leftSection={<IconPlus size={12} />}
            onClick={() =>
              setRefs([...refs, { sourceId: sourceOptions[0]?.value ?? '', category: '' }])
            }
          >
            {t('geo.addRef')}
          </Button>
        </Group>
        {refs.map((r, i) => (
          <Group key={i} gap="xs" wrap="nowrap" align="flex-end">
            <Select
              placeholder={t('geo.refSource')}
              data={sourceOptions}
              value={r.sourceId || null}
              onChange={(v) =>
                setRefs(refs.map((x, j) => (j === i ? { ...x, sourceId: v ?? '' } : x)))
              }
              style={{ flex: 1 }}
            />
            <TextInput
              placeholder={t('geo.refCategory')}
              value={r.category}
              onChange={(e) =>
                setRefs(refs.map((x, j) => (j === i ? { ...x, category: e.currentTarget.value } : x)))
              }
              style={{ flex: 1 }}
            />
            <ActionIcon
              variant="subtle"
              color="red"
              onClick={() => setRefs(refs.filter((_, j) => j !== i))}
              aria-label={t('geo.removeRef')}
            >
              <IconTrash size={16} />
            </ActionIcon>
          </Group>
        ))}
      </Stack>
    );
  }

  // Match the backend charset (a name becomes an ext:geo-custom.dat:<name>
  // routing tag): reject ':'/'@'/spaces client-side so the operator sees WHY
  // instead of a generic 400 after submitting.
  const nameOk = /^[A-Za-z0-9._-]+$/.test(name.trim());
  const valid = name.trim().length > 0 && nameOk;

  return (
    <Modal
      opened
      onClose={onClose}
      title={category ? t('geo.editCategory') : t('geo.newCategory')}
      size="xl"
    >
      <Stack gap="sm">
        <TextInput
          label={t('geo.name')}
          required
          placeholder="my-block"
          description={t('geo.nameHint')}
          error={name.trim().length > 0 && !nameOk ? t('geo.nameInvalid') : undefined}
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
        />
        {refEditor(t('geo.domainRefs'), domainRefs, setDomainRefs)}
        {refEditor(t('geo.ipRefs'), ipRefs, setIpRefs)}
        <TagsInput
          label={t('geo.manualDomains')}
          placeholder="example.com, full:x.com"
          value={manualDomains}
          onChange={setManualDomains}
        />
        <TagsInput
          label={t('geo.manualIps')}
          placeholder="1.2.3.0/24"
          value={manualIps}
          onChange={setManualIps}
        />
        <TagsInput
          label={t('geo.excludeDomains')}
          placeholder="ads.example"
          value={excludeDomains}
          onChange={setExcludeDomains}
        />
        <Tooltip label={t('geo.rebuildHint')} position="left">
          <Group justify="flex-end">
            <Button variant="subtle" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button disabled={!valid} loading={save.isPending} onClick={() => save.mutate()}>
              {category ? t('common.save') : t('common.create')}
            </Button>
          </Group>
        </Tooltip>
      </Stack>
    </Modal>
  );
}
