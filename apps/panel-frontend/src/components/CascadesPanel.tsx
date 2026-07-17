import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Card,
  Group,
  Modal,
  Select,
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
  IconArrowDown,
  IconArrowRight,
  IconArrowUp,
  IconEdit,
  IconPlus,
  IconRoute,
  IconTrash,
} from '@tabler/icons-react';
import {
  listCascades,
  createCascade,
  updateCascade,
  deleteCascade,
  getCascadeStatus,
  listNodes,
  apiErrorMessage,
  type Cascade,
  type CascadeHopInput,
  type CascadeProtocol,
  type CascadeLinkProtocol,
  type EgressRule,
  type EgressTarget,
} from '../lib/api';
import { useOverview } from '../hooks/useOverview';
import { countryFlag } from '../lib/countries';

// A cascade save reaches its hop nodes asynchronously, so the save toast polls
// the status endpoint and resolves itself. Bounded: roughly 12 polls at 7s is
// about a minute and a half, well past a normal provisioning round, after which
// we name whoever is still silent rather than spinning forever.
const PROVISION_POLL_MS = 7000;
const PROVISION_MAX_POLLS = 12;

const HAIRLINE = '#1C2A3D';
const CARD = '#0F1A28';
const GROUND = '#0B1521';
const SNOW = '#C8D4E3';
const MIST = '#7A8BA3';
const CYAN = '#7DD3FC';
const MOSS = '#A7D8B9';
const AMBER = '#F5B14C';
const RED = '#E07A5F';
const VIOLET = '#A78BFA';
const MONO = { fontFamily: "'Geist Mono', monospace" } as const;

const STATUS_ACCENT: Record<string, string> = {
  online: MOSS,
  unknown: MIST,
  offline: RED,
  unreachable: RED,
  disabled: MIST,
  degraded: AMBER,
};

const PROTOCOLS: { value: CascadeProtocol; label: string }[] = [
  { value: 'xray', label: 'xray' },
  { value: 'hysteria', label: 'hysteria2' },
  { value: 'shadowsocks', label: 'shadowsocks' },
  { value: 'amneziawg', label: 'amneziawg' },
  { value: 'naive', label: 'naive' },
  { value: 'mtproto', label: 'mtproto' },
  { value: 'mieru', label: 'mieru' },
];

// Inter-hop LINK protocol = the two realised link cells only (the node maps
// anything else to vless). shadowsocks/SS2022 is the default (native UDP, no
// head-of-line blocking for voice); vless is the plaintext raw link.
const LINK_PROTOCOLS: { value: CascadeLinkProtocol; label: string }[] = [
  { value: 'shadowsocks', label: 'shadowsocks (SS2022)' },
  { value: 'vless', label: 'vless (raw)' },
];

// Max hops per cascade. Mirrors the backend cap (cascade.schemas MAX_CASCADE_HOPS);
// keep the two in sync. Each hop adds latency + an inter-hop UFW link port.
const MAX_HOPS = 5;

function formatBytes(n: number): string {
  if (!n || n === 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const i = Math.min(Math.floor(Math.log2(Math.max(1, n)) / 10), units.length - 1);
  const v = n / 1024 ** i;
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

interface ChainNode {
  name: string;
  countryCode: string | null;
  status: string;
  todayBytes: number | null;
}

/**
 * The "Cascades" sub-view of the Nodes page. A cascade is a chain of nodes, so
 * each hop is drawn as a real node card (flag / status / role / today's
 * traffic), connected entry -> ... -> exit by arrows labelled with the link
 * protocol. Self-contained: pulls its own cascades + node list + overview
 * metrics (react-query dedupes the shared keys with NodesPage).
 */
export function CascadesPanel() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const cascadesQuery = useQuery({ queryKey: ['cascades'], queryFn: listCascades });
  const nodesQuery = useQuery({ queryKey: ['nodes', 'all'], queryFn: () => listNodes({ limit: 200 }) });
  const overviewQuery = useOverview();

  const nodeOptions = useMemo(
    () =>
      (nodesQuery.data?.nodes ?? []).map((n) => ({ value: n.id, label: n.name })),
    [nodesQuery.data],
  );

  // nodeId -> chain render data (status/flag/traffic) for the hop cards.
  const nodesById = useMemo(() => {
    const overviewById = new Map((overviewQuery.data?.nodes ?? []).map((n) => [n.id, n]));
    const m = new Map<string, ChainNode>();
    for (const n of nodesQuery.data?.nodes ?? []) {
      const ov = overviewById.get(n.id);
      m.set(n.id, {
        name: n.name,
        countryCode: n.countryCode,
        status: ov?.status ?? n.status,
        todayBytes: ov?.todayBytes ?? null,
      });
    }
    return m;
  }, [nodesQuery.data, overviewQuery.data]);

  const [editing, setEditing] = useState<Cascade | 'new' | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['cascades'] });
  const onError = (err: unknown) => {
    // Cascade writes commit fast and provision nodes asynchronously, so a slow
    // or timed-out response can fire onError even though the change landed.
    // Refetch so the list reflects reality instead of a stale view.
    invalidate();
    notifications.show({ color: 'red', title: t('common.saveError'), message: apiErrorMessage(err) });
  };

  const deleteMutation = useMutation({
    mutationFn: deleteCascade,
    onSuccess: () => {
      invalidate();
      notifications.show({ color: 'green', message: t('cascades.deleted') });
    },
    onError,
  });

  const cascades = cascadesQuery.data?.cascades ?? [];

  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-start">
        <Text size="xs" c="dimmed" maw={760}>
          {t('cascades.help')}
        </Text>
        <Button leftSection={<IconPlus size={14} />} onClick={() => setEditing('new')}>
          {t('cascades.add')}
        </Button>
      </Group>

      {cascades.length === 0 && cascadesQuery.isFetched && (
        <Text size="sm" c="dimmed" ta="center" py="lg">
          {t('cascades.empty')}
        </Text>
      )}

      {cascades.map((c) => (
        <Card
          key={c.id}
          withBorder
          padding="md"
          radius="md"
          style={{ backgroundColor: CARD, borderColor: HAIRLINE }}
        >
          <Group justify="space-between" wrap="nowrap" mb="sm">
            <Group gap="xs">
              <IconRoute size={16} style={{ color: VIOLET }} />
              <Text fw={600} style={{ color: SNOW }}>
                {c.name}
              </Text>
              <Badge size="sm" color={c.enabled ? 'teal' : 'gray'} variant="light">
                {c.enabled ? 'enabled' : 'disabled'}
              </Badge>
              {c.mode === 'balancer' && (
                <Badge size="sm" color="violet" variant="light">
                  {t('cascades.modeBalancer')}
                </Badge>
              )}
            </Group>
            <Group gap={4} wrap="nowrap">
              <Tooltip label={t('common.edit')}>
                <ActionIcon variant="subtle" color="blue" onClick={() => setEditing(c)}>
                  <IconEdit size={16} />
                </ActionIcon>
              </Tooltip>
              <Tooltip label={t('common.delete')}>
                <ActionIcon
                  variant="subtle"
                  color="red"
                  loading={deleteMutation.isPending && deleteMutation.variables === c.id}
                  onClick={() => deleteMutation.mutate(c.id)}
                >
                  <IconTrash size={16} />
                </ActionIcon>
              </Tooltip>
            </Group>
          </Group>

          <Group gap="sm" wrap="wrap" align="stretch">
            {c.hops.map((h, i) => {
              // balancer: hop 0 is the entry, every hop >=1 is a parallel exit
              // (no transit). chain: entry, transit(s), then the single exit.
              const isExitHop = c.mode === 'balancer' ? i >= 1 : i === c.hops.length - 1;
              const role = i === 0
                ? t('cascades.entry')
                : isExitHop
                  ? t('cascades.exit')
                  : t('cascades.transit');
              const roleColor = i === 0 ? CYAN : isExitHop ? MOSS : MIST;
              const nd = nodesById.get(h.nodeId);
              const status = nd?.status ?? 'unknown';
              const accent = STATUS_ACCENT[status] ?? MIST;
              return (
                <Group key={h.id} gap="sm" wrap="nowrap" align="center">
                  <Box
                    style={{
                      border: `1px solid ${roleColor}44`,
                      borderRadius: 8,
                      background: GROUND,
                      padding: '8px 10px',
                      minWidth: 150,
                    }}
                  >
                    <Group gap={6} wrap="nowrap" mb={4}>
                      {nd?.countryCode && (
                        <Text size="sm" lh={1}>
                          {countryFlag(nd.countryCode)}
                        </Text>
                      )}
                      <Text fw={600} size="sm" truncate style={{ color: SNOW, maxWidth: 120 }}>
                        {nd?.name ?? h.nodeName}
                      </Text>
                    </Group>
                    <Group gap={6} wrap="nowrap" mb={4}>
                      <span
                        style={{
                          width: 7,
                          height: 7,
                          borderRadius: '50%',
                          background: accent,
                          boxShadow: `0 0 6px ${accent}99`,
                          flexShrink: 0,
                        }}
                      />
                      <Text size="xs" style={{ ...MONO, color: accent, textTransform: 'uppercase' }}>
                        {status}
                      </Text>
                    </Group>
                    <Badge
                      size="xs"
                      variant="light"
                      style={{
                        backgroundColor: `${roleColor}1A`,
                        color: roleColor,
                        border: `1px solid ${roleColor}33`,
                        textTransform: 'none',
                      }}
                    >
                      {role}
                      {h.entryProtocol ? ` · ${h.entryProtocol}` : ''}
                    </Badge>
                    {nd?.todayBytes != null && (
                      <Text size="9px" mt={4} style={{ ...MONO, color: MIST }}>
                        {formatBytes(nd.todayBytes)} {t('cascades.today')}
                      </Text>
                    )}
                  </Box>
                  {(c.mode === 'balancer' ? i === 0 : i < c.hops.length - 1) && (
                    <Stack gap={0} align="center" justify="center" style={{ color: MIST }}>
                      <Text size="9px" ff="monospace">
                        {c.mode === 'balancer' ? `${h.linkProtocol ?? 'link'} · auto` : h.linkProtocol}
                      </Text>
                      <IconArrowRight size={16} />
                    </Stack>
                  )}
                </Group>
              );
            })}
          </Group>
        </Card>
      ))}

      <CascadeFormModal
        opened={editing !== null}
        cascade={editing === 'new' ? null : editing}
        nodeOptions={nodeOptions}
        onClose={() => setEditing(null)}
        onSaved={() => {
          invalidate();
          setEditing(null);
        }}
        onError={onError}
      />
    </Stack>
  );
}

interface HopRow {
  nodeId: string;
  entryProtocol: string;
  linkProtocol: string;
}

// UI row for one entry-hop geo-split rule. The MVP editor only represents
// geosite/geoip category lists + target ('editable' rows). A policy authored via
// the API can also carry literal domain/ip/port/network matchers; those rules
// are kept verbatim as 'raw' rows IN THEIR ORIGINAL POSITION so opening and
// saving a cascade never silently drops or reorders them (first-match matters).
type GeoRuleRow =
  | { kind: 'editable'; geosite: string[]; geoip: string[]; target: EgressTarget }
  | { kind: 'raw'; rule: EgressRule };

/** A rule the MVP editor can fully represent = only geosite/geoip/target. */
function isEditableRule(r: EgressRule): boolean {
  return (
    !r.domain?.length && !r.ip?.length && r.port === undefined && r.network === undefined
  );
}

function CascadeFormModal({
  opened,
  cascade,
  nodeOptions,
  onClose,
  onSaved,
  onError,
}: {
  opened: boolean;
  cascade: Cascade | null;
  nodeOptions: { value: string; label: string }[];
  onClose: () => void;
  onSaved: () => void;
  onError: (err: unknown) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [mode, setMode] = useState<'chain' | 'balancer'>('chain');
  const [hideHopsFromSub, setHideHopsFromSub] = useState(true);
  const [hops, setHops] = useState<HopRow[]>([]);
  const [geoRules, setGeoRules] = useState<GeoRuleRow[]>([]);
  const [lastFor, setLastFor] = useState<string | null | undefined>(undefined);

  // Seed the form when the modal opens for a (different) cascade.
  if (opened && lastFor !== (cascade?.id ?? null)) {
    setLastFor(cascade?.id ?? null);
    if (cascade) {
      setName(cascade.name);
      setEnabled(cascade.enabled);
      setMode(cascade.mode === 'balancer' ? 'balancer' : 'chain');
      setHideHopsFromSub(cascade.hideHopsFromSub ?? true);
      setHops(
        cascade.hops.map((h) => ({
          nodeId: h.nodeId,
          entryProtocol: h.entryProtocol ?? '',
          linkProtocol: h.linkProtocol ?? '',
        })),
      );
      setGeoRules(
        (cascade.egressPolicy ?? []).map((r): GeoRuleRow =>
          isEditableRule(r)
            ? { kind: 'editable', geosite: r.geosite ?? [], geoip: r.geoip ?? [], target: r.target }
            : { kind: 'raw', rule: r },
        ),
      );
    } else {
      setName('');
      setEnabled(true);
      setMode('chain');
      setHideHopsFromSub(true);
      setHops([
        // Link defaults to shadowsocks (SS2022): native UDP (no head-of-line
        // blocking for voice) + AEAD-encrypted, on the trusted DC-to-DC link.
        { nodeId: '', entryProtocol: 'xray', linkProtocol: 'shadowsocks' },
        { nodeId: '', entryProtocol: '', linkProtocol: '' },
      ]);
      setGeoRules([]);
    }
  } else if (!opened && lastFor !== undefined) {
    setLastFor(undefined);
  }

  const saveMutation = useMutation({
    mutationFn: () => {
      const isBalancer = mode === 'balancer';
      const hopInputs: CascadeHopInput[] = hops.map((h, i) => {
        // chain: every non-exit hop carries the link to the next. balancer: only
        // the entry carries the (uniform) exit-link protocol; exits carry none.
        const carriesLink = isBalancer ? i === 0 : i < hops.length - 1;
        return {
          nodeId: h.nodeId,
          position: i,
          ...(i === 0 && h.entryProtocol ? { entryProtocol: h.entryProtocol as CascadeProtocol } : {}),
          ...(carriesLink && h.linkProtocol
            ? { linkProtocol: h.linkProtocol as CascadeLinkProtocol }
            : {}),
        };
      });
      // Compile the entry-hop geo split, preserving order. Editable rows with no
      // matcher are dropped; 'raw' rows (API-authored literal/port rules the MVP
      // editor can't represent) pass through verbatim so a UI save can't delete
      // them. [] on update clears the policy.
      const egressPolicy: EgressRule[] = geoRules
        .map((r): EgressRule | null => {
          if (r.kind === 'raw') return r.rule;
          if (r.geosite.length === 0 && r.geoip.length === 0) return null;
          return {
            ...(r.geosite.length > 0 ? { geosite: r.geosite } : {}),
            ...(r.geoip.length > 0 ? { geoip: r.geoip } : {}),
            target: r.target,
          };
        })
        .filter((r): r is EgressRule => r !== null);
      return cascade
        ? updateCascade(cascade.id, { name, enabled, mode, hideHopsFromSub, hops: hopInputs, egressPolicy })
        : createCascade({ name, enabled, mode, hideHopsFromSub, hops: hopInputs, egressPolicy });
    },
    onSuccess: (result) => {
      const id = result?.id ?? cascade?.id;
      onSaved();
      if (!id) {
        notifications.show({ color: 'green', message: t('cascades.saved') });
        return;
      }
      // A save reaches each hop asynchronously (cascade.changed -> inbound-sync),
      // so resolve a live toast instead of leaving the operator guessing. The
      // poll is deliberately detached from this modal: it closes immediately and
      // the toast should outlive it. It is bounded, so a hop that never answers
      // cannot poll forever.
      const toastId = `cascade-provisioning-${id}`;
      notifications.show({
        id: toastId,
        loading: true,
        autoClose: false,
        withCloseButton: false,
        title: t('cascades.saved'),
        message: t('cascades.provisioning'),
      });
      const settle = (color: string, message: string) =>
        notifications.update({
          id: toastId,
          loading: false,
          color,
          autoClose: 8000,
          title: t('cascades.saved'),
          message,
        });
      let polls = 0;
      let failures = 0;
      const poll = async () => {
        polls += 1;
        try {
          const st = await getCascadeStatus(id);
          failures = 0;
          if (st.done) {
            settle('green', t('cascades.provisioned'));
            return;
          }
          if (polls >= PROVISION_MAX_POLLS) {
            const waiting = st.hops.filter((h) => !h.applied).map((h) => h.name).join(', ');
            settle('yellow', t('cascades.provisionWaiting', { nodes: waiting }));
            return;
          }
        } catch {
          // Don't claim we're still waiting when we can't even ask. A blip or
          // two is normal; a persistent failure gets reported as unknown.
          failures += 1;
          if (failures >= 3) {
            settle('yellow', t('cascades.provisionUnknown'));
            return;
          }
        }
        window.setTimeout(poll, PROVISION_POLL_MS);
      };
      window.setTimeout(poll, PROVISION_POLL_MS);
    },
    onError,
  });

  function setHop(idx: number, patch: Partial<HopRow>) {
    setHops((prev) => prev.map((h, i) => (i === idx ? { ...h, ...patch } : h)));
  }
  function addHop() {
    setHops((prev) =>
      prev.length >= MAX_HOPS
        ? prev
        : [...prev, { nodeId: '', entryProtocol: '', linkProtocol: 'shadowsocks' }],
    );
  }
  function removeHop(idx: number) {
    setHops((prev) => (prev.length <= 2 ? prev : prev.filter((_, i) => i !== idx)));
  }
  function move(idx: number, dir: -1 | 1) {
    const j = idx + dir;
    if (j < 0 || j >= hops.length) return;
    setHops((prev) => {
      const next = [...prev];
      [next[idx], next[j]] = [next[j]!, next[idx]!];
      return next;
    });
  }

  function addGeoRule() {
    setGeoRules((prev) => [...prev, { kind: 'editable', geosite: [], geoip: [], target: 'direct' }]);
  }
  // Patches only apply to editable rows (raw rows have no editable fields).
  function setGeoRule(
    idx: number,
    patch: Partial<{ geosite: string[]; geoip: string[]; target: EgressTarget }>,
  ) {
    setGeoRules((prev) =>
      prev.map((r, i) => (i === idx && r.kind === 'editable' ? { ...r, ...patch } : r)),
    );
  }
  function removeGeoRule(idx: number) {
    setGeoRules((prev) => prev.filter((_, i) => i !== idx));
  }

  const valid = name.trim().length > 0 && hops.length >= 2 && hops.every((h) => h.nodeId);

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      size="xl"
      title={cascade ? t('cascades.editTitle', { name: cascade.name }) : t('cascades.newTitle')}
    >
      <Stack gap="sm">
        <TextInput
          label={t('cascades.name')}
          required
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
        />
        <Switch
          label={t('cascades.enabledLabel')}
          checked={enabled}
          onChange={(e) => setEnabled(e.currentTarget.checked)}
        />
        <Select
          label={t('cascades.mode')}
          data={[
            { value: 'chain', label: t('cascades.modeChain') },
            { value: 'balancer', label: t('cascades.modeBalancer') },
          ]}
          value={mode}
          onChange={(v) => setMode(v === 'balancer' ? 'balancer' : 'chain')}
          w={260}
        />
        <Switch
          label={t('cascades.hideHopsLabel')}
          description={t('cascades.hideHopsDesc')}
          checked={hideHopsFromSub}
          onChange={(e) => setHideHopsFromSub(e.currentTarget.checked)}
        />

        <Stack gap="xs" mt="xs">
          <Group justify="space-between" align="center">
            <Text size="sm" fw={500}>
              {t('cascades.split')}
            </Text>
            <Button
              size="xs"
              variant="light"
              leftSection={<IconPlus size={14} />}
              onClick={addGeoRule}
            >
              {t('cascades.splitAddRule')}
            </Button>
          </Group>
          <Text size="xs" c="dimmed">
            {t('cascades.splitHint')}
          </Text>
          {geoRules.map((r, i) => {
            const showLabel = i === geoRules.findIndex((x) => x.kind === 'editable');
            if (r.kind === 'raw') {
              // API-authored literal/port rule the MVP editor can't represent -
              // shown read-only so it's visible and preserved, removable if the
              // operator really wants it gone.
              return (
                <Group key={i} align="center" gap="xs" wrap="nowrap">
                  <Text size="xs" c="dimmed" style={{ flex: 1 }} truncate>
                    {t('cascades.splitRawRule', {
                      summary:
                        [
                          r.rule.domain?.length && `domain:${r.rule.domain.join(',')}`,
                          r.rule.ip?.length && `ip:${r.rule.ip.join(',')}`,
                          r.rule.port && `port:${r.rule.port}`,
                          r.rule.network && `net:${r.rule.network}`,
                        ]
                          .filter(Boolean)
                          .join(' ') + ` → ${r.rule.target}`,
                    })}
                  </Text>
                  <Tooltip label={t('cascades.removeRule')}>
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      onClick={() => removeGeoRule(i)}
                      aria-label={t('cascades.removeRule')}
                    >
                      <IconTrash size={16} />
                    </ActionIcon>
                  </Tooltip>
                </Group>
              );
            }
            return (
              <Group key={i} align="flex-end" gap="xs" wrap="nowrap">
                <TagsInput
                  label={showLabel ? 'geosite' : undefined}
                  placeholder="category-ru"
                  value={r.geosite}
                  onChange={(v) => setGeoRule(i, { geosite: v })}
                  style={{ flex: 1 }}
                />
                <TagsInput
                  label={showLabel ? 'geoip' : undefined}
                  placeholder="ru"
                  value={r.geoip}
                  onChange={(v) => setGeoRule(i, { geoip: v })}
                  style={{ flex: 1 }}
                />
                <Select
                  label={showLabel ? t('cascades.splitTarget') : undefined}
                  data={[
                    { value: 'direct', label: t('cascades.targetDirect') },
                    { value: 'link-out', label: t('cascades.targetTunnel') },
                    { value: 'block', label: t('cascades.targetBlock') },
                  ]}
                  value={r.target}
                  onChange={(v) => v && setGeoRule(i, { target: v as EgressTarget })}
                  w={130}
                  allowDeselect={false}
                />
                <Tooltip label={t('cascades.removeRule')}>
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    onClick={() => removeGeoRule(i)}
                    aria-label={t('cascades.removeRule')}
                  >
                    <IconTrash size={16} />
                  </ActionIcon>
                </Tooltip>
              </Group>
            );
          })}
        </Stack>

        <Group justify="space-between" align="center" mt="xs">
          <Text size="sm" fw={500}>
            {t('cascades.hops')}
          </Text>
          <Text size="xs" ff="monospace" c={hops.length >= MAX_HOPS ? 'orange' : 'dimmed'}>
            {hops.length}/{MAX_HOPS}
          </Text>
        </Group>
        <Text size="xs" c="dimmed">
          {t('cascades.linkHint')}
        </Text>
        <Stack gap={6}>
          {hops.map((h, i) => {
            const isEntry = i === 0;
            // balancer: every hop past the entry is a parallel exit (no transit).
            const isExit = mode === 'balancer' ? i >= 1 : i === hops.length - 1;
            // balancer: only the entry carries the (uniform) exit-link protocol.
            const showLink = mode === 'balancer' ? isEntry : !isExit;
            const role = isEntry
              ? t('cascades.entry')
              : isExit
                ? t('cascades.exit')
                : t('cascades.transit');
            return (
              <Card key={i} withBorder padding="xs" radius="sm">
                <Group gap="xs" align="flex-end" wrap="nowrap">
                  <Badge
                    size="sm"
                    color={isEntry ? 'blue' : isExit ? 'green' : 'gray'}
                    variant="light"
                    style={{ minWidth: 64 }}
                  >
                    {role}
                  </Badge>
                  <Select
                    label={t('cascades.node')}
                    placeholder="-"
                    data={nodeOptions}
                    searchable
                    value={h.nodeId || null}
                    onChange={(v) => setHop(i, { nodeId: v ?? '' })}
                    style={{ flex: 1, minWidth: 180 }}
                  />
                  {isEntry && (
                    <Select
                      label={t('cascades.entryProtocol')}
                      data={PROTOCOLS}
                      value={h.entryProtocol || null}
                      onChange={(v) => setHop(i, { entryProtocol: v ?? '' })}
                      w={150}
                    />
                  )}
                  {showLink && (
                    <Select
                      label={
                        mode === 'balancer'
                          ? t('cascades.linkProtocolBalancer')
                          : t('cascades.linkProtocol')
                      }
                      data={LINK_PROTOCOLS}
                      value={h.linkProtocol || null}
                      onChange={(v) => setHop(i, { linkProtocol: v ?? '' })}
                      w={150}
                    />
                  )}
                  <Box>
                    <ActionIcon variant="subtle" color="gray" disabled={i === 0} onClick={() => move(i, -1)}>
                      <IconArrowUp size={14} />
                    </ActionIcon>
                    <ActionIcon
                      variant="subtle"
                      color="gray"
                      disabled={i === hops.length - 1}
                      onClick={() => move(i, 1)}
                    >
                      <IconArrowDown size={14} />
                    </ActionIcon>
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      disabled={hops.length <= 2}
                      onClick={() => removeHop(i)}
                    >
                      <IconTrash size={14} />
                    </ActionIcon>
                  </Box>
                </Group>
              </Card>
            );
          })}
        </Stack>
        <Button
          variant="light"
          size="xs"
          leftSection={<IconPlus size={12} />}
          onClick={addHop}
          disabled={hops.length >= MAX_HOPS}
        >
          {t('cascades.addHop')}
        </Button>

        <Group justify="flex-end" mt="md">
          <Button variant="subtle" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button disabled={!valid} loading={saveMutation.isPending} onClick={() => saveMutation.mutate()}>
            {cascade ? t('common.save') : t('common.create')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
