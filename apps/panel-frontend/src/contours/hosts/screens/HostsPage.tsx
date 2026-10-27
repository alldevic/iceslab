import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import {
  Box,
  Menu,
  Select,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
  UnstyledButton,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import {
  IconAlertTriangle,
  IconDotsVertical,
  IconEdit,
  IconLink,
  IconList,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconTrash,
  IconUser,
  IconWorld,
  IconWorldOff,
} from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { deleteHost, hostHiddenFacts, listHosts, type HostHiddenFacts } from '@/lib/domain/hosts';
import { HostHiddenLine } from '@/ui/HostHiddenLine';
import { AwgGenerationBadge } from '@/ui/AwgGenerationBadge';
import { listBindings, listProfiles } from '@/lib/domain/profiles';
import { profilePairLabel, type EngineName } from '@/lib/domain/engines';
import { listAllNodes } from '@/lib/domain/nodes';
import { usePageMeta } from '@/lib/ui/usePageMeta';
import { apiErrorMessage } from '@/lib/net/client';
import { loadFailure, loadView } from '@/lib/ui/loadView';
import { hostsBarCounts, listsArrived } from '@/contours/hosts/lib/hostsView';
import { hiddenByOperator } from '@/contours/hosts/lib/hostVisibility';
import { LoadFailed, LoadFailedLine } from '@/ui/LoadFailed';
import { COUNTRIES } from '@/lib/domain/countries';
import { AMBER, CARD, CYAN, CYAN_HI, DIM, EDGE, FAINT, HAIRLINE, MIST, MOSS, SNOW, VIOLET, WELL } from '@/contours/hosts/lib/colors';

/**
 * Hosts, first-class. A host is the one line a user reads in their client, so
 * the card leads with that line: flag, name, port. Everything under it answers
 * "and what is that, really" - which profile it speaks, which nodes serve it,
 * how many people it reaches.
 *
 * A host with no nodes serves nobody, which is the one broken state here, so it
 * gets the amber edge and says so instead of showing an empty row.
 */

const DISPLAY = "'Inter Variable', Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
const MONO = "'Geist Mono Variable', 'Geist Mono', ui-monospace, monospace";

export function HostsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [country, setCountry] = useState<string | null>(null);

  const hostsQuery = useQuery({ queryKey: ['hosts'], queryFn: () => listHosts() });
  const bindingsQuery = useQuery({ queryKey: ['bindings'], queryFn: () => listBindings() });
  const nodesQuery = useQuery({ queryKey: ['nodes'], queryFn: () => listAllNodes() });
  const profilesQuery = useQuery({ queryKey: ['profiles'], queryFn: () => listProfiles() });

  // Once for the cards and the bar (A-247): «no node» and «unbound» only with
  // both of their lists in hand (A-234).
  const nodesKnown = listsArrived(bindingsQuery, nodesQuery);
  const profileKnown = listsArrived(bindingsQuery, profilesQuery);

  const rows = useMemo(() => {
    const bindingById = new Map((bindingsQuery.data?.bindings ?? []).map((b) => [b.id, b]));
    const nodeById = new Map((nodesQuery.data?.nodes ?? []).map((n) => [n.id, n]));
    const profileById = new Map((profilesQuery.data?.profiles ?? []).map((p) => [p.id, p]));

    return (hostsQuery.data?.hosts ?? [])
      .map((h) => {
        const binding = bindingById.get(h.bindingId);
        const node = binding ? nodeById.get(binding.nodeId) : undefined;
        const profile = binding ? profileById.get(binding.profileId) : undefined;
        return {
          host: h,
          profile,
          nodes: node ? [node] : [],
          // Deleting the last host of a binding takes the binding with it, which
          // restarts xray on that node. The confirmation has to say so, and it
          // only applies in this one case.
          lastOfBinding:
            (hostsQuery.data?.hosts ?? []).filter((x) => x.bindingId === h.bindingId).length === 1,
          nodeName: node?.name ?? null,
          // Нода в каскаде не вход: подписка этот хост не выдаёт. Факт сервера,
          // здесь только имя ноды к нему.
          hidden: hostHiddenFacts(h, node?.name ?? null, node),
          port: h.portOverride ?? binding?.publicPort ?? binding?.port ?? null,
          address: h.addressOverride ?? binding?.publicHost ?? null,
          countryCode: node?.countryCode ? node.countryCode.toUpperCase() : null,
          // Reach comes from the API. It used to be worked out here by adding up
          // each squad's member count, which counted one person in two squads
          // twice, and cannot be fixed here: the squad list carries totals, not
          // user ids, so there is nothing to deduplicate against.
          // A-234: no reach in the answer is «unknown», not «nobody».
          squadCount: h.reach?.squads ?? null,
          userCount: h.reach?.users ?? null,
          // Which node carries the host is known only with both lists in
          // hand; without them «no node» would be a claim (A-234).
          nodesKnown,
          // The same for the profile: «unbound» only with both lists in hand.
          profileKnown,
        };
      })
      .filter((r) => {
        if (country && r.countryCode !== country) return false;
        const q = search.trim().toLowerCase();
        if (!q) return true;
        return `${r.host.remark} ${r.port ?? ''} ${r.profile?.name ?? ''} ${r.address ?? ''}`
          .toLowerCase()
          .includes(q);
      })
      .sort((a, b) => a.host.priority - b.host.priority);
  }, [
    hostsQuery.data,
    bindingsQuery.data,
    nodesQuery.data,
    profilesQuery.data,
    nodesKnown,
    profileKnown,
    search,
    country,
  ]);

  /**
   * Deleting a host is the one destructive action on this page, so it confirms
   * first and names the consequence rather than asking "are you sure".
   *
   * The last host of a binding is the case worth spelling out, and the reason is
   * not the host: the binding goes with it, so the inbound comes off the node
   * and xray restarts there. That restart drops live sessions on every OTHER
   * inbound of the same machine, which is a blast radius the operator cannot
   * guess from "remove one line from a client".
   */
  function confirmDelete(row: Row) {
    modals.openConfirmModal({
      title: t('hostsPage.deleteTitle', { name: row.host.remark }),
      children: (
        <Stack gap={8}>
          <Text size="sm">{t('hostsPage.deleteBody')}</Text>
          {/* The last host of its binding restarts the core whether or not the
              node list arrived: without the name it is said without it (A-234). */}
          {row.lastOfBinding && (
            <Text size="sm" style={{ color: AMBER }}>
              {row.nodeName
                ? t('hostsPage.deleteLast', { node: row.nodeName })
                : t('hostsPage.deleteLastUnknownNode')}
            </Text>
          )}
        </Stack>
      ),
      labels: { confirm: t('common.delete'), cancel: t('common.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          await deleteHost(row.host.id);
          qc.invalidateQueries({ queryKey: ['hosts'] });
          notifications.show({ color: 'green', message: t('hostsPage.deleted') });
        } catch (err) {
          // A-235: the server's sentence, not axios's «status code 404».
          notifications.show({
            color: 'red',
            title: t('common.deleteError'),
            message: apiErrorMessage(err),
          });
        }
      },
    });
  }

  const total = hostsQuery.data?.hosts.length ?? 0;
  // The bar counts the same three states the cards show, so a degraded host is
  // not filed under LIVE where it would go unnoticed.
  // A-234: «no node» and «live» only when the node lists arrived (hostsBarCounts).
  const { live, degraded, orphaned } = hostsBarCounts(rows, nodesKnown);
  // The lists that did not arrive, said above the cards with a retry; the
  // profile list too, the cards say «profile unknown» without it (A-247).
  const listFailure =
    loadFailure(bindingsQuery, apiErrorMessage) ??
    loadFailure(nodesQuery, apiErrorMessage) ??
    loadFailure(profilesQuery, apiErrorMessage);
  const countries = [...new Set(rows.map((r) => r.countryCode).filter(Boolean))] as string[];

  usePageMeta([
    t('pageMeta.hosts', { count: total }),
    t('pageMeta.hostCountries', { count: countries.length }),
  ]);

  return (
    <Stack gap="lg">
      {/* Page bar */}
      <Box
        style={{
          display: 'flex',
          alignItems: 'center',
          height: 56,
          padding: '8px 8px 8px 14px',
          borderRadius: 10,
          backgroundColor: CARD,
          border: `1px solid ${HAIRLINE}`,
        }}
      >
        <Box style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0, paddingRight: 16 }}>
          <Box
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              backgroundColor: `${CYAN}1A`,
              border: `1px solid ${CYAN}33`,
              color: CYAN,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <IconWorld size={16} stroke={1.8} />
          </Box>
          <Box style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Fact value={total} label={t('hostsPage.bar.hosts')} />
            <Dot />
            <Fact value={live} label={t('hostsPage.bar.live')} accent={MOSS} />
            {degraded > 0 && (
              <>
                <Dot />
                <Fact value={degraded} label={t('hostsPage.bar.degraded')} accent={AMBER} />
              </>
            )}
            {orphaned > 0 && (
              <>
                <Dot />
                <Fact value={orphaned} label={t('hostsPage.bar.noNodes')} accent={AMBER} />
              </>
            )}
          </Box>
        </Box>

        <Box style={{ width: 1, height: 24, backgroundColor: HAIRLINE, flexShrink: 0 }} />

        <Box style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 10, padding: '0 16px' }}>
          <IconSearch size={15} stroke={1.8} color={MIST} />
          <input
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
            placeholder={t('hostsPage.searchPlaceholder')}
            style={{
              flex: 1,
              minWidth: 0,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: SNOW,
              fontFamily: DISPLAY,
              fontSize: 13,
            }}
          />
        </Box>

        <Box style={{ width: 1, height: 24, backgroundColor: HAIRLINE, flexShrink: 0 }} />

        <Box style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 8, flexShrink: 0 }}>
          <Select
            value={country}
            onChange={setCountry}
            placeholder={t('hostsPage.allCountries')}
            clearable
            w={180}
            data={countries.map((c) => ({
              value: c,
              label: COUNTRIES.find((x) => x.code === c)?.name ?? c,
            }))}
            styles={{
              input: {
                height: 38,
                minHeight: 38,
                backgroundColor: WELL,
                borderColor: HAIRLINE,
                color: SNOW,
                fontFamily: DISPLAY,
                fontSize: 13,
              },
            }}
          />
          <BarButton
            title={t('common.refresh')}
            // Every list the cards read, not the hosts alone (A-247).
            onClick={() => {
              for (const key of ['hosts', 'bindings', 'nodes', 'profiles']) void qc.invalidateQueries({ queryKey: [key] });
            }}
          >
            <IconRefresh size={16} stroke={1.8} color={MIST} />
          </BarButton>
          <BarButton onClick={() => navigate('/hosts/new')} label={t('hostsPage.create')}>
            <IconPlus size={14} stroke={2.4} color={CYAN} />
          </BarButton>
        </Box>
      </Box>

      {listFailure && rows.length > 0 && (
        <LoadFailedLine message={listFailure.message} onRetry={listFailure.onRetry} />
      )}

      {/* A list that did not arrive is not an empty one (A-141). */}
      {rows.length === 0 && loadView(hostsQuery) === 'failed' ? (
        <LoadFailed message={apiErrorMessage(hostsQuery.error)} onRetry={() => void hostsQuery.refetch()} />
      ) : rows.length === 0 ? (
        <Box
          style={{
            padding: 40,
            borderRadius: 10,
            backgroundColor: CARD,
            border: `1px solid ${HAIRLINE}`,
          }}
        >
          <Stack align="center" gap="sm">
            <ThemeIcon size={48} radius="md" variant="light" color="gray">
              <IconWorldOff size={24} />
            </ThemeIcon>
            <Text c="dimmed" size="sm">
              {loadView(hostsQuery) === 'loading'
                ? t('common.loading')
                : total === 0
                  ? t('hostsPage.empty')
                  : t('common.nothingFound')}
            </Text>
          </Stack>
        </Box>
      ) : (
        <SimpleGrid cols={{ base: 1, lg: 2, xl: 3 }} spacing={16}>
          {rows.map((r) => (
            <HostCard
              key={r.host.id}
              row={r}
              onEdit={() => navigate(`/hosts/${r.host.id}`)}
              onDelete={() => confirmDelete(r)}
            />
          ))}
        </SimpleGrid>
      )}
    </Stack>
  );
}

type Row = {
  host: { id: string; remark: string; enabled: boolean; priority: number; isHidden?: boolean };
  // `effectiveEngine` rides along: a profile row names the pair, and the engine
  // half is not derivable here on purpose.
  profile?: { name: string; protocol: string; effectiveEngine: EngineName };
  nodes: { id: string; name: string; status: string }[];
  lastOfBinding: boolean;
  nodeName: string | null;
  hidden: HostHiddenFacts | null;
  port: number | null;
  address: string | null;
  countryCode: string | null;
  /** Null: the server sent no reach (unknown, not «nobody»). */
  squadCount: number | null;
  userCount: number | null;
  /** Whether the binding and node lists arrived, so «no node» is a fact. */
  nodesKnown: boolean;
  /** Whether the binding and profile lists arrived, so «unbound» is a fact. */
  profileKnown: boolean;
};

function HostCard({
  row,
  onEdit,
  onDelete,
}: {
  row: Row;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  // A-234: without the node lists the node is unknown, not missing.
  const unknown = !row.nodesKnown;
  const orphaned = !unknown && row.nodes.length === 0;
  // A host with nodes is not automatically serving: the state used to read
  // "a node exists" and never looked at whether the node answers. Between LIVE
  // and NO NODES there is a third state, still handing out URLs but through a
  // node that is not online, and it is the one worth catching early.
  const down = row.nodes.filter((n) => n.status !== 'online');
  const degraded = row.host.enabled && !orphaned && down.length > 0;
  const live = row.host.enabled && !unknown && !orphaned && !degraded;
  const accent = orphaned ? AMBER : degraded ? AMBER : row.host.enabled ? VIOLET : DIM;

  return (
    <Box
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        padding: 16,
        borderRadius: 10,
        backgroundColor: CARD,
        border: `1px solid ${HAIRLINE}`,
        borderTop: `3px solid ${accent}`,
      }}
    >
      {/* The line the user reads, in the order they read it. */}
      <Box style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%' }}>
        <Text style={{ fontSize: 18, flexShrink: 0 }}>{flagEmoji(row.countryCode)}</Text>
        <Text
          style={{
            fontFamily: DISPLAY,
            fontSize: 19,
            fontWeight: 600,
            letterSpacing: '-0.01em',
            lineHeight: '24px',
            color: SNOW,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {row.host.remark}
        </Text>
        {row.port !== null && (
          <Text style={{ fontFamily: MONO, fontSize: 14, fontWeight: 500, color: CYAN_HI }}>
            {row.port}
          </Text>
        )}
        {/* A-236 step 6: the operator hid it; apart from the cascade's line below. */}
        {hiddenByOperator(row.host) && (
          <Text
            title={t('hostEdit.hiddenHint')}
            style={{
              fontFamily: MONO,
              fontSize: 10,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              color: AMBER,
              padding: '2px 7px',
              borderRadius: 5,
              border: `1px solid ${AMBER}55`,
              flexShrink: 0,
            }}
          >
            {t('hostEdit.hiddenOn')}
          </Text>
        )}
        {row.address && (
          <Box style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            <IconLink size={12} stroke={1.8} color={FAINT} />
            <Text
              style={{
                fontFamily: MONO,
                fontSize: 11,
                color: MIST,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {row.address}
            </Text>
          </Box>
        )}
        <Box style={{ flex: 1 }} />
        <Menu shadow="md" position="bottom-end" withinPortal>
          <Menu.Target>
            <UnstyledButton style={{ display: 'flex', color: DIM, flexShrink: 0 }}>
              <IconDotsVertical size={16} />
            </UnstyledButton>
          </Menu.Target>
          <Menu.Dropdown style={{ backgroundColor: CARD, borderColor: HAIRLINE }}>
            <Menu.Item leftSection={<IconEdit size={14} />} onClick={onEdit}>
              {t('common.edit')}
            </Menu.Item>
            <Menu.Item color="red" leftSection={<IconTrash size={14} />} onClick={onDelete}>
              {t('common.delete')}
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </Box>

      {/* Хост есть, а подписка его не отдаёт: нода в каскаде не вход. Сразу под
          строкой, которую читает клиент, потому что именно её он и не увидит. */}
      <HostHiddenLine facts={row.hidden} compact />

      <FieldRow label={t('hostsPage.card.profile')}>
        {row.profile ? (
          <Box
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: '5px 10px',
              borderRadius: 6,
              backgroundColor: WELL,
              border: `1px solid ${EDGE}`,
            }}
          >
            <Box style={{ width: 5, height: 5, borderRadius: 999, backgroundColor: VIOLET }} />
            <Text style={{ fontFamily: DISPLAY, fontSize: 12, fontWeight: 500, color: SNOW }}>
              {row.profile.name}
            </Text>
            <AwgGenerationBadge profile={row.profile} />
            <Text
              style={{
                fontFamily: MONO,
                fontSize: 10,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: MIST,
              }}
            >
              {/* The pair, because a profile always knows its own: the server
                  resolves `effectiveEngine` and never leaves it null. */}
              {profilePairLabel(row.profile, t)}
            </Text>
          </Box>
        ) : (
          <Text style={{ fontFamily: MONO, fontSize: 11, color: MIST }}>
            {row.profileKnown ? t('hostsPage.unbound') : t('hostsPage.card.profileUnknown')}
          </Text>
        )}
      </FieldRow>

      <FieldRow label={t('hostsPage.card.nodes')}>
        {unknown ? (
          <Text style={{ fontFamily: MONO, fontSize: 11, color: MIST }}>{t('hostsPage.card.nodesUnknown')}</Text>
        ) : orphaned ? (
          <Box
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
              padding: '5px 10px',
              borderRadius: 6,
              backgroundColor: `${AMBER}14`,
              border: `1px solid ${AMBER}3D`,
            }}
          >
            <IconAlertTriangle size={12} stroke={2} color={AMBER} />
            <Text style={{ fontFamily: MONO, fontSize: 11, color: AMBER }}>
              {t('hostsPage.card.noNodesAttached')}
            </Text>
          </Box>
        ) : (
          <Box style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
            {row.nodes.map((n) => (
              <Box
                key={n.id}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '4px 9px',
                  borderRadius: 6,
                  backgroundColor: WELL,
                }}
              >
                <Box
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 999,
                    backgroundColor: n.status === 'online' ? MOSS : AMBER,
                  }}
                />
                <Text style={{ fontFamily: MONO, fontSize: 11, color: SNOW }}>{n.name}</Text>
              </Box>
            ))}
          </Box>
        )}
      </FieldRow>

      {/* Reach, then state: who gets this line and whether it is actually live. */}
      <Box
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 18,
          paddingTop: 12,
          borderTop: `1px solid ${HAIRLINE}`,
        }}
      >
        <Box style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <IconUser size={13} stroke={1.8} color={FAINT} />
          <Text style={{ fontFamily: MONO, fontSize: 11, color: MIST }}>
            {row.squadCount === null ? t('hostsPage.card.reachUnknown') : t('hostsPage.card.squads', { count: row.squadCount })}
          </Text>
        </Box>
        <Box style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <IconList size={13} stroke={1.8} color={FAINT} />
          <Text style={{ fontFamily: MONO, fontSize: 11, color: MIST }}>
            {row.userCount === null ? t('hostsPage.card.reachUnknown') : t('hostsPage.card.reach', { count: row.userCount })}
          </Text>
        </Box>
        <Box style={{ flex: 1 }} />
        <Box style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <Box
            style={{
              width: 6,
              height: 6,
              borderRadius: 999,
              backgroundColor: live ? MOSS : orphaned || degraded ? AMBER : DIM,
            }}
          />
          <Text
            style={{
              fontFamily: MONO,
              fontSize: 11,
              fontWeight: 500,
              letterSpacing: '0.08em',
              color: live ? MOSS : orphaned || degraded ? AMBER : MIST,
            }}
            // Which node is down, since the card lists several by name.
            title={degraded ? down.map((n) => n.name).join(', ') : undefined}
          >
            {unknown
              ? '-'
              : live
              ? t('hostsPage.card.live')
              : orphaned
                ? t('hostsPage.card.noNodes')
                : degraded
                  ? t('hostsPage.card.degraded', { count: down.length })
                  : t('hostsPage.card.off')}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}

function FieldRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%' }}>
      <Text
        style={{
          width: 96,
          flexShrink: 0,
          fontFamily: MONO,
          fontSize: 10,
          fontWeight: 500,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color: FAINT,
        }}
      >
        {label}
      </Text>
      <Box style={{ flex: 1, minWidth: 0 }}>{children}</Box>
    </Box>
  );
}

function Fact({ value, label, accent }: { value: number | string; label: string; accent?: string }) {
  return (
    <>
      <Text style={{ fontFamily: MONO, fontSize: 13, fontWeight: 500, color: accent ?? SNOW }}>
        {value}
      </Text>
      <Text style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.12em', color: MIST }}>
        {label}
      </Text>
    </>
  );
}

function Dot() {
  return <Text style={{ fontFamily: MONO, fontSize: 10, color: DIM }}>·</Text>;
}

function BarButton({
  children,
  label,
  onClick,
  title,
}: {
  children: ReactNode;
  label?: string;
  onClick?: () => void;
  title?: string;
}) {
  return (
    <UnstyledButton
      onClick={onClick}
      title={title}
      aria-label={title ?? label}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        height: 38,
        width: label ? undefined : 38,
        padding: label ? '0 16px' : 0,
        borderRadius: 8,
        backgroundColor: WELL,
        border: `1px solid ${HAIRLINE}`,
      }}
    >
      {children}
      {label && (
        <Text style={{ fontFamily: DISPLAY, fontSize: 13, fontWeight: 500, color: SNOW }}>
          {label}
        </Text>
      )}
    </UnstyledButton>
  );
}

function flagEmoji(cc: string | null): string {
  if (!cc || cc.length !== 2) return '🏳';
  const up = cc.toUpperCase();
  const c0 = up.charCodeAt(0);
  const c1 = up.charCodeAt(1);
  if (c0 < 65 || c0 > 90 || c1 < 65 || c1 > 90) return '🏳';
  const A = 0x1f1e6;
  const a = 'A'.charCodeAt(0);
  return String.fromCodePoint(A + (c0 - a)) + String.fromCodePoint(A + (c1 - a));
}
