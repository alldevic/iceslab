import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { now } from '../lib/demoFlag';
import {
  ActionIcon,
  Box,
  Card,
  Group,
  Menu,
  Popover,
  Select,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { copyToClipboard } from '../lib/clipboard';
import { useDebouncedValue, useDisclosure } from '@mantine/hooks';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  IconArrowDown,
  IconArrowUp,
  IconBan,
  IconFilter,
  IconChevronLeft,
  IconChevronRight,
  IconCircleCheck,
  IconCircleMinus,
  IconCircleOff,
  IconClockHour4,
  IconCopy,
  IconDotsVertical,
  IconEdit,
  IconExternalLink,
  IconPlus,
  IconRefresh,
  IconReload,
  IconSearch,
  IconTrash,
  IconUserOff,
  IconUsers,
} from '@tabler/icons-react';
import {
  createUser,
  deleteUser,
  fetchAuthStatus,
  listSquads,
  listUserTags,
  listUsers,
  subscriptionUrl,
  updateUser,
  revokeUserSubscription,
  rotateUserSubscription,
  resetUserTraffic,
  type CreateUserInput,
  type UpdateUserInput,
  type User,
  type UserSort,
} from '../lib/api';
import { useOverview } from '../hooks/useOverview';
import { usePageMeta } from '../hooks/usePageMeta';
import { UserDrawer } from '../components/UserDrawer';
import { Toolbar, ToolbarButton, ToolbarIconButton, ToolbarSearch } from '../components/Toolbar';

// ───── Helpers ─────

const HAIRLINE = '#1C2A3D';
const CARD = '#0F1A28';
const GROUND = '#08101A';
const SNOW = '#C8D4E3';
const MIST = '#7A8BA3';
const CYAN = '#7DD3FC';
const MOSS = '#A7D8B9';
const AMBER = '#F5B14C';
const RED = '#E07A5F';
const VIOLET = '#A78BFA';

const DISPLAY = { fontFamily: "'Space Grotesk', Inter, sans-serif" };
const MONO = { fontFamily: "'Geist Mono', monospace" };
const MONO_LABEL = {
  ...MONO,
  fontSize: 10,
  letterSpacing: '0.12em',
  textTransform: 'uppercase' as const,
  color: MIST,
};

/**
 * The pill states the user's LIFECYCLE (active / expired / limited /
 * disabled), which is what an operator acts on. Connection state is not a
 * status here: it rides the dot next to the username, which glows when the
 * user was seen in the last five minutes. Showing "online" in the pill hid
 * the fact that an account was, say, active but idle for a week.
 */
type ComputedStatus = 'active' | 'limited' | 'expired' | 'disabled';

function computedStatus(u: User): ComputedStatus {
  if (u.status === 'expired') return 'expired';
  if (u.status === 'limited') return 'limited';
  if (u.status === 'disabled') return 'disabled';
  return 'active';
}

function isOnline(u: User): boolean {
  if (!u.lastOnlineAt) return false;
  return now() - new Date(u.lastOnlineAt).getTime() < 5 * 60 * 1000;
}

const COMPUTED_STATUS_ACCENT: Record<ComputedStatus, string> = {
  active: MOSS,
  limited: AMBER,
  expired: RED,
  disabled: MIST,
};

function formatBytes(n: number): string {
  if (n === 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const i = Math.min(Math.floor(Math.log2(Math.max(1, n)) / 10), units.length - 1);
  const v = n / 1024 ** i;
  return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${units[i]}`;
}

function trafficPercent(used: number, limit: number | null): number | null {
  if (limit === null || limit === 0) return null;
  return Math.min(100, (used / limit) * 100);
}

type TFn = (key: string, opts?: Record<string, unknown>) => string;

function relativeTime(
  iso: string | null,
  t: TFn,
): { text: string; tone: 'fresh' | 'stale' | 'never' } {
  if (!iso) return { text: t('userTime.never'), tone: 'never' };
  const diffMs = now() - new Date(iso).getTime();
  const sec = Math.round(diffMs / 1000);
  const tone: 'fresh' | 'stale' = sec < 5 * 60 ? 'fresh' : 'stale';
  if (sec < 60) return { text: t('userTime.sAgo', { n: sec }), tone };
  const min = Math.round(sec / 60);
  if (min < 60) return { text: t('userTime.mAgo', { n: min }), tone };
  const hr = Math.round(min / 60);
  if (hr < 24) return { text: t('userTime.hAgo', { n: hr }), tone };
  const days = Math.round(hr / 24);
  return { text: t('userTime.dAgo', { n: days }), tone };
}

function expireRelative(
  iso: string | null,
  t: TFn,
): { text: string; tone: 'good' | 'warn' | 'bad' | 'never' } {
  if (!iso) return { text: t('userTime.noExpiry'), tone: 'never' };
  const diffMs = new Date(iso).getTime() - now();
  const days = Math.round(diffMs / (1000 * 60 * 60 * 24));
  if (days < 0) return { text: t('userTime.expiredAgo', { days: -days }), tone: 'bad' };
  if (days === 0) return { text: t('userTime.expiresToday'), tone: 'bad' };
  if (days <= 7) return { text: t('userTime.daysLeft', { days }), tone: 'warn' };
  return { text: t('userTime.daysLeft', { days }), tone: 'good' };
}

// ───── Table shape ─────

/**
 * Column widths, in px. Username is the only elastic one, everything to its
 * right is fixed so the lanes line up across every row on the page.
 */
const COL = {
  status: 140,
  subscription: 140,
  expires: 140,
  traffic: 260,
  squads: 200,
  tag: 100,
  actions: 56,
} as const;

function HeadCell({
  label,
  width,
  grow,
  col,
  sort,
  order,
  onSort,
}: {
  label: string;
  width?: number;
  grow?: boolean;
  /** Present = the column is sortable and clicking cycles asc/desc. */
  col?: UserSort;
  sort?: UserSort;
  order?: 'asc' | 'desc';
  onSort?: (col: UserSort) => void;
}) {
  const active = col !== undefined && col === sort;
  const content = (
    <>
      <Text style={{ ...MONO_LABEL, color: active ? SNOW : MIST }}>{label}</Text>
      {active &&
        (order === 'asc' ? (
          <IconArrowUp size={12} stroke={2} color={CYAN} />
        ) : (
          <IconArrowDown size={12} stroke={2} color={CYAN} />
        ))}
    </>
  );
  const style = {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    ...(grow ? { flex: 1, minWidth: 0 } : { width, flexShrink: 0 }),
  } as const;

  if (!col || !onSort) return <Box style={style}>{content}</Box>;
  return (
    <UnstyledButton onClick={() => onSort(col)} style={{ ...style, cursor: 'pointer' }}>
      {content}
    </UnstyledButton>
  );
}

/** Status pill: fully round, tinted fill, hairline of the same accent. */
function Pill({ accent, children }: { accent: string; children: ReactNode }) {
  return (
    <Box
      style={{
        display: 'inline-flex',
        padding: '3px 9px',
        borderRadius: 999,
        backgroundColor: `${accent}1A`,
        border: `1px solid ${accent}33`,
        color: accent,
        ...MONO,
        fontSize: 10,
        lineHeight: '12px',
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </Box>
  );
}

/**
 * Squad pill. Borderless and in the display face, because a squad name is
 * operator-written content, not a status from a fixed set.
 */
function SquadPill({ children, muted }: { children: ReactNode; muted?: boolean }) {
  const accent = muted ? MIST : VIOLET;
  return (
    <Box
      style={{
        display: 'inline-flex',
        padding: '3px 9px',
        borderRadius: 999,
        backgroundColor: `${accent}1A`,
        color: accent,
        ...DISPLAY,
        fontSize: 11,
        lineHeight: '14px',
        whiteSpace: 'nowrap',
        maxWidth: '100%',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
    >
      {children}
    </Box>
  );
}

function TrafficBar({ percent, color }: { percent: number; color: string }) {
  return (
    <Box
      style={{
        height: 6,
        width: '100%',
        borderRadius: 999,
        backgroundColor: HAIRLINE,
        overflow: 'hidden',
      }}
    >
      <Box
        style={{
          height: 6,
          borderRadius: 999,
          backgroundColor: color,
          width: `${Math.min(100, Math.max(0, percent))}%`,
        }}
      />
    </Box>
  );
}

// ───── Stats card ─────

interface StatChipProps {
  icon: React.ReactNode;
  label: string;
  value: number;
  accent: string;
  active?: boolean;
  onClick?: () => void;
}

function StatChip({ icon, label, value, accent, active, onClick }: StatChipProps) {
  return (
    <Card
      withBorder
      padding={12}
      radius={8}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      aria-pressed={onClick ? active : undefined}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
      style={{
        cursor: onClick ? 'pointer' : 'default',
        backgroundColor: CARD,
        borderColor: active ? accent : HAIRLINE,
        borderWidth: active ? 2 : 1,
      }}
    >
      {/* Bare outline icon, no filled badge: the number is the content here,
          the icon only names the bucket. */}
      <Group justify="space-between" wrap="nowrap" align="flex-start">
        <Stack gap={2}>
          <Text style={MONO_LABEL}>{label}</Text>
          <Text style={{ ...DISPLAY, fontSize: 28, fontWeight: 500, lineHeight: 1, color: SNOW }}>
            {value}
          </Text>
        </Stack>
        <Box style={{ color: accent, display: 'flex', flexShrink: 0 }}>{icon}</Box>
      </Group>
    </Card>
  );
}

// ───── Main page ─────

type StatusFilter = 'all' | 'active' | 'expired' | 'limited' | 'disabled';

export function UsersPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [createOpen, { open: openCreate, close: closeCreate }] = useDisclosure(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [page, setPage] = useState(1);
  const [rowsPerPage, setRowsPerPage] = useState(25);
  // Sorting is a server concern here: the table shows one page of N, so
  // reordering the client slice would shuffle 25 rows and call it sorted.
  const [sort, setSort] = useState<UserSort>('username');
  const [order, setOrder] = useState<'asc' | 'desc'>('asc');
  // Filters live next to the search box rather than as more chips: squad and
  // tag are "narrow the roster" questions, while the status chips above are
  // the primary split and stay one click away.
  const [squadFilter, setSquadFilter] = useState<string | null>(null);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const activeFilters = (squadFilter ? 1 : 0) + (tagFilter ? 1 : 0);

  function toggleSort(next: UserSort) {
    if (next === sort) {
      setOrder((o) => (o === 'asc' ? 'desc' : 'asc'));
    } else {
      setSort(next);
      setOrder(next === 'username' ? 'asc' : 'desc');
    }
    setPage(1);
  }

  // Wave-14 #17: server-side pagination + filter + search. Pre-wave we
  // fetched limit:500 once and paged/filtered/searched in JS; this silently
  // truncated installs >500 users and re-rendered the full table on every
  // keystroke. Backend already supported `page/limit/status/search`; UI just
  // wasn't passing them.
  const [debouncedSearch] = useDebouncedValue(search, 250);
  const serverStatus = statusFilter === 'all' ? undefined : statusFilter;
  const serverSearch = debouncedSearch.trim() || undefined;
  const usersQuery = useQuery({
    queryKey: [
      'users',
      {
        page,
        limit: rowsPerPage,
        status: serverStatus,
        search: serverSearch,
        groupId: squadFilter,
        tag: tagFilter,
        sort,
        order,
      },
    ],
    queryFn: () =>
      listUsers({
        page,
        limit: rowsPerPage,
        status: serverStatus,
        search: serverSearch,
        groupId: squadFilter ?? undefined,
        tag: tagFilter ?? undefined,
        sort,
        order,
      }),
    placeholderData: (prev) => prev,
  });
  const squadsQuery = useQuery({ queryKey: ['squads'], queryFn: listSquads });
  const tagsQuery = useQuery({
    queryKey: ['user-tags'],
    queryFn: listUserTags,
    staleTime: 5 * 60 * 1000,
  });
  const knownTags = tagsQuery.data?.tags ?? [];
  // Wave-14 #16: subscriptionUrl(token) without a second arg falls back to
  // API_BASE_URL, which defaults to http://localhost:3000, so a prod SPA
  // built without VITE_API_BASE_URL silently copies a localhost link to the
  // operator's clipboard. Same panel-metadata source UserFormModal uses.
  const authStatusQuery = useQuery({
    queryKey: ['auth', 'status'],
    queryFn: fetchAuthStatus,
    staleTime: 5 * 60 * 1000,
  });
  // Wave-14 #17: full-install counters come from dashboard.users (cached
  // server-side, ~ N/A cost) instead of computed from the current page slice
  // - the slice doesn't reflect total install state under server pagination.
  const dashQuery = useOverview();
  const squadNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of squadsQuery.data?.squads ?? []) m.set(s.id, s.name);
    return m;
  }, [squadsQuery.data]);

  const pagedUsers = usersQuery.data?.users ?? [];
  const totalUsers = usersQuery.data?.total ?? 0;

  const stats = useMemo(() => {
    const byStatus = dashQuery.data?.users.byStatus ?? {};
    return {
      total: dashQuery.data?.users.total ?? totalUsers,
      active: byStatus.active ?? 0,
      expired: byStatus.expired ?? 0,
      limited: byStatus.limited ?? 0,
      disabled: byStatus.disabled ?? 0,
    };
  }, [dashQuery.data, totalUsers]);

  // Topbar line: "/ USERS · 36 ACCOUNTS · 21 ACTIVE". `count` drives i18next
  // pluralization (one/few/many/other for RU), otherwise a single user reads
  // as "1 аккаунтов".
  usePageMeta([
    t('pageMeta.users', { count: stats.total }),
    t('pageMeta.usersActive', { count: stats.active }),
  ]);

  // Reset to page 1 whenever any server-filter input changes so a narrowed
  // result set doesn't drop us into an empty page (page 5 of 1 page).
  useEffect(() => {
    setPage(1);
  }, [statusFilter, debouncedSearch, rowsPerPage, squadFilter, tagFilter]);

  const totalPages = Math.max(1, Math.ceil(totalUsers / rowsPerPage));
  const safePage = Math.min(page, totalPages);
  const rangeStart = totalUsers === 0 ? 0 : (safePage - 1) * rowsPerPage + 1;
  const rangeEnd = Math.min(safePage * rowsPerPage, totalUsers);

  // Bug #4: the query fetches the raw `page`, but display clamps to `safePage`.
  // If the result set shrinks for a non-filter reason (users deleted, larger
  // rowsPerPage), `page` can exceed totalPages, so the query requests an empty
  // out-of-range page while the footer shows a clamped range. Reconcile `page`
  // back into range (single source of truth) so the fetch + Prev/Next stay
  // correct. Filter-driven shrink is already handled by the reset-to-1 effect.
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const createMutation = useMutation({
    mutationFn: createUser,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] });
      notifications.show({ color: 'green', message: t('users.notify.created') });
    },
    onError: (err) =>
      notifications.show({
        color: 'red',
        title: t('common.createError'),
        message: err instanceof Error ? err.message : String(err),
      }),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateUserInput }) => updateUser(id, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] });
      notifications.show({ color: 'green', message: t('users.notify.updated') });
    },
    onError: (err) =>
      notifications.show({
        color: 'red',
        title: t('common.saveError'),
        message: err instanceof Error ? err.message : String(err),
      }),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteUser,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] });
      notifications.show({ color: 'green', message: t('users.notify.deleted') });
    },
    onError: (err) =>
      notifications.show({
        color: 'red',
        title: t('common.deleteError'),
        message: err instanceof Error ? err.message : String(err),
      }),
  });

  const revokeMutation = useMutation({
    mutationFn: revokeUserSubscription,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] });
      notifications.show({ color: 'green', message: t('users.notify.revoked') });
    },
    onError: (err) =>
      notifications.show({
        color: 'red',
        message: err instanceof Error ? err.message : String(err),
      }),
  });

  const rotateMutation = useMutation({
    mutationFn: rotateUserSubscription,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] });
      notifications.show({ color: 'green', message: t('users.notify.rotated') });
    },
    onError: (err) =>
      notifications.show({
        color: 'red',
        message: err instanceof Error ? err.message : String(err),
      }),
  });

  const resetTrafficMutation = useMutation({
    mutationFn: resetUserTraffic,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] });
      notifications.show({ color: 'green', message: t('users.notify.trafficReset') });
    },
    onError: (err) =>
      notifications.show({
        color: 'red',
        message: err instanceof Error ? err.message : String(err),
      }),
  });

  function handleRevoke(user: User) {
    modals.openConfirmModal({
      title: t('users.revokeTitle', { name: user.username }),
      children: <Text size="sm">{t('users.revokeBody')}</Text>,
      labels: { confirm: t('usersTable.actionRevoke'), cancel: t('common.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: () => revokeMutation.mutate(user.id),
    });
  }

  function handleRotate(user: User) {
    modals.openConfirmModal({
      title: t('users.rotateTitle', { name: user.username }),
      children: <Text size="sm">{t('users.rotateBody')}</Text>,
      labels: { confirm: t('usersTable.actionRotate'), cancel: t('common.cancel') },
      onConfirm: () => rotateMutation.mutate(user.id),
    });
  }

  function handleResetTraffic(user: User) {
    modals.openConfirmModal({
      title: t('users.resetTrafficTitle', { name: user.username }),
      children: <Text size="sm">{t('users.resetTrafficBody')}</Text>,
      labels: { confirm: t('usersTable.actionResetTraffic'), cancel: t('common.cancel') },
      onConfirm: () => resetTrafficMutation.mutate(user.id),
    });
  }

  function handleDelete(user: User) {
    modals.openConfirmModal({
      title: t('users.deleteTitle', { name: user.username }),
      children: (
        <Text size="sm">
          {t('users.deleteBody')}
        </Text>
      ),
      labels: { confirm: t('common.delete'), cancel: t('common.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: () => deleteMutation.mutate(user.id),
    });
  }

  return (
    <Stack gap="lg">
      {/* Stats row - clickable as filters */}
      <SimpleGrid cols={{ base: 2, sm: 3, lg: 5 }} spacing="sm">
        <StatChip
          icon={<IconUsers size={20} />}
          label={t('common.all')}
          value={stats.total}
          accent={CYAN}
          active={statusFilter === 'all'}
          onClick={() => setStatusFilter('all')}
        />
        <StatChip
          icon={<IconCircleCheck size={20} />}
          label={t('users.statChips.active')}
          value={stats.active}
          accent={MOSS}
          active={statusFilter === 'active'}
          onClick={() => setStatusFilter('active')}
        />
        <StatChip
          icon={<IconClockHour4 size={20} />}
          label={t('users.statChips.expired')}
          value={stats.expired}
          accent={RED}
          active={statusFilter === 'expired'}
          onClick={() => setStatusFilter('expired')}
        />
        <StatChip
          icon={<IconCircleMinus size={20} />}
          label={t('users.statChips.limited')}
          value={stats.limited}
          accent={AMBER}
          active={statusFilter === 'limited'}
          onClick={() => setStatusFilter('limited')}
        />
        <StatChip
          icon={<IconCircleOff size={20} />}
          label={t('users.statChips.disabled')}
          value={stats.disabled}
          accent={MIST}
          active={statusFilter === 'disabled'}
          onClick={() => setStatusFilter('disabled')}
        />
      </SimpleGrid>

      {/* Search + actions (status filtering is driven by the stat chips above) */}
      <Toolbar>
        <ToolbarSearch
          value={search}
          onChange={setSearch}
          placeholder={t('users.searchPlaceholder')}
          leftSection={<IconSearch size={16} color={MIST} />}
        />
        <Popover position="bottom-end" withinPortal shadow="md" width={280}>
          <Popover.Target>
            <Box>
              <ToolbarButton
                icon={<IconFilter size={15} stroke={1.7} />}
                label={t('users.filters.button')}
                badge={activeFilters || undefined}
              />
            </Box>
          </Popover.Target>
          <Popover.Dropdown style={{ backgroundColor: CARD, borderColor: HAIRLINE }}>
            <Stack gap="sm">
              <Select
                label={t('users.filters.squad')}
                placeholder={t('users.filters.anySquad')}
                value={squadFilter}
                onChange={setSquadFilter}
                clearable
                data={(squadsQuery.data?.squads ?? []).map((s) => ({ value: s.id, label: s.name }))}
              />
              <Select
                label={t('users.filters.tag')}
                placeholder={t('users.filters.anyTag')}
                value={tagFilter}
                onChange={setTagFilter}
                clearable
                searchable
                data={knownTags}
              />
              {activeFilters > 0 && (
                <UnstyledButton
                  onClick={() => {
                    setSquadFilter(null);
                    setTagFilter(null);
                  }}
                  style={{ ...MONO_LABEL, color: CYAN, alignSelf: 'flex-start' }}
                >
                  {t('users.filters.clear')}
                </UnstyledButton>
              )}
            </Stack>
          </Popover.Dropdown>
        </Popover>
        <ToolbarIconButton
          icon={<IconRefresh size={16} />}
          title={t('common.refresh')}
          loading={usersQuery.isFetching}
          onClick={() => qc.invalidateQueries({ queryKey: ['users'] })}
        />
        <ToolbarButton
          icon={<IconPlus size={14} stroke={2.4} />}
          label={t('users.create')}
          onClick={openCreate}
          primary
        />
      </Toolbar>

      {/* Table. Fixed column widths rather than auto-layout: every row must
          land in the same vertical lanes, otherwise one long username shifts
          the traffic bars for that row only and the column stops reading as a
          column. Username takes the slack. */}
      <Box
        style={{
          width: '100%',
          borderRadius: 8,
          overflow: 'clip',
          backgroundColor: CARD,
          border: `1px solid ${HAIRLINE}`,
        }}
      >
        <Box style={{ overflowX: 'auto' }}>
          <Box style={{ minWidth: 1100 }}>
            <Box
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '12px 16px',
                borderBottom: `1px solid ${HAIRLINE}`,
              }}
            >
              <HeadCell
                grow
                label={t('users.table.username')}
                col="username"
                sort={sort}
                order={order}
                onSort={toggleSort}
              />
              <HeadCell width={COL.status} label={t('users.table.status')} />
              <HeadCell width={COL.subscription} label={t('users.table.subscription')} />
              <HeadCell
                width={COL.expires}
                label={t('users.table.expires')}
                col="expireAt"
                sort={sort}
                order={order}
                onSort={toggleSort}
              />
              <HeadCell
                width={COL.traffic}
                label={t('users.table.traffic')}
                col="traffic"
                sort={sort}
                order={order}
                onSort={toggleSort}
              />
              <HeadCell width={COL.squads} label={t('users.table.squads')} />
              <HeadCell width={COL.tag} label={t('users.table.tag')} />
              {/* Three dots, not the word "actions": the header of a column of
                  icon buttons should not shout louder than the buttons. */}
              <Box style={{ width: COL.actions, flexShrink: 0, textAlign: 'right' }}>
                <Text style={{ ...MONO_LABEL }}>···</Text>
              </Box>
            </Box>

            {pagedUsers.length === 0 && (
              <Stack align="center" py={48} gap="xs">
                <ThemeIcon size={40} radius="md" variant="light" color="gray">
                  <IconUserOff size={22} />
                </ThemeIcon>
                <Text c="dimmed" size="sm">
                  {stats.total === 0 ? t('users.empty') : t('common.nothingFound')}
                </Text>
              </Stack>
            )}

            {pagedUsers.map((u) => {
                const last = relativeTime(u.lastOnlineAt, t);
                const exp = expireRelative(u.expireAt, t);
                const trafficPct = trafficPercent(u.trafficUsedBytes, u.trafficLimitBytes);
                const trafficColor =
                  trafficPct === null
                    ? MOSS
                    : trafficPct >= 90
                      ? RED
                      : trafficPct >= 70
                        ? AMBER
                        : MOSS;
                const compStatus = computedStatus(u);
                const statusAccent = COMPUTED_STATUS_ACCENT[compStatus];
                // A tint, not a fill: it should be readable as "this row needs
                // you" out of the corner of your eye and disappear otherwise.
                const rowTint =
                  compStatus === 'expired'
                    ? `${RED}0A`
                    : compStatus === 'limited'
                      ? `${AMBER}0A`
                      : undefined;
                const isPaused = compStatus === 'limited' || compStatus === 'expired';
                const otherSquads = u.groupIds.filter(
                  (id) => id !== '00000000-0000-0000-0000-000000000001',
                );
                const subUrl = subscriptionUrl(u.subscriptionToken, authStatusQuery.data?.panel);

                return (
                  <Box
                    key={u.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      padding: '14px 16px',
                      backgroundColor: rowTint,
                      borderBottom: `1px solid ${HAIRLINE}`,
                    }}
                  >
                    <Box
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        flex: 1,
                        minWidth: 0,
                      }}
                    >
                      <StatusDot accent={statusAccent} glow={isOnline(u)} />
                      <Stack gap={2}>
                        <Text
                          style={{ ...DISPLAY, fontSize: 14, fontWeight: 500, lineHeight: '18px', color: SNOW }}
                        >
                          {u.username}
                        </Text>
                        <Text style={{ ...MONO, fontSize: 12, lineHeight: '16px', color: MIST }}>
                          {u.shortId}
                          {u.telegramId ? ` · ${u.telegramId.startsWith('@') ? u.telegramId : '@' + u.telegramId}` : ''}
                        </Text>
                      </Stack>
                    </Box>

                    <Box style={{ width: COL.status, flexShrink: 0, display: 'flex', gap: 4 }}>
                      <Pill accent={statusAccent}>{t(`userStatus.${compStatus}`)}</Pill>
                      {u.subRevokedAt && <Pill accent={RED}>{t('usersTable.revokedBadge')}</Pill>}
                    </Box>

                    <Box style={{ width: COL.subscription, flexShrink: 0 }}>
                      <Tooltip
                        label={u.lastOnlineAt ? new Date(u.lastOnlineAt).toLocaleString() : '-'}
                      >
                        <Text
                          style={{
                            ...DISPLAY,
                            fontSize: 13,
                            lineHeight: '16px',
                            color:
                              last.tone === 'fresh' ? MOSS : last.tone === 'never' ? MIST : SNOW,
                          }}
                        >
                          {last.text}
                        </Text>
                      </Tooltip>
                    </Box>

                    <Box style={{ width: COL.expires, flexShrink: 0 }}>
                      <Tooltip label={u.expireAt ? new Date(u.expireAt).toLocaleString() : '-'}>
                        <Text
                          style={{
                            ...DISPLAY,
                            fontSize: 13,
                            lineHeight: '16px',
                            color:
                              exp.tone === 'bad'
                                ? RED
                                : exp.tone === 'warn'
                                  ? AMBER
                                  : exp.tone === 'never'
                                    ? MIST
                                    : SNOW,
                          }}
                        >
                          {exp.text}
                        </Text>
                      </Tooltip>
                    </Box>

                    <Box
                      style={{
                        width: COL.traffic,
                        flexShrink: 0,
                        paddingRight: 28,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 5,
                      }}
                    >
                      <Box
                        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
                      >
                        {isPaused ? (
                          <Text
                            style={{
                              ...MONO,
                              fontSize: 12,
                              lineHeight: '16px',
                              fontWeight: 600,
                              color: compStatus === 'expired' ? RED : AMBER,
                            }}
                          >
                            {t('usersTable.paused')}
                          </Text>
                        ) : (
                          <Box style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <Text style={{ ...MONO, fontSize: 12, lineHeight: '16px', color: SNOW }}>
                              {formatBytes(u.trafficUsedBytes)}
                            </Text>
                            <Text style={{ ...MONO, fontSize: 12, lineHeight: '16px', color: MIST }}>
                              /{' '}
                              {u.trafficLimitBytes === null ? '∞' : formatBytes(u.trafficLimitBytes)}
                            </Text>
                          </Box>
                        )}
                        {isPaused ? (
                          <Text style={{ ...MONO, fontSize: 12, lineHeight: '16px', color: MIST }}>
                            {compStatus === 'expired'
                              ? t('usersTable.pausedHintExpired')
                              : t('usersTable.pausedHintQuota')}
                          </Text>
                        ) : trafficPct !== null ? (
                          <Text
                            style={{
                              ...MONO,
                              fontSize: 12,
                              lineHeight: '16px',
                              fontWeight: 600,
                              color: trafficColor,
                            }}
                          >
                            {trafficPct.toFixed(0)}%
                          </Text>
                        ) : null}
                      </Box>
                      <TrafficBar
                        percent={isPaused ? 100 : (trafficPct ?? 0)}
                        color={isPaused ? (compStatus === 'expired' ? RED : AMBER) : trafficColor}
                      />
                    </Box>

                    <Box
                      style={{ width: COL.squads, flexShrink: 0, display: 'flex', gap: 4, alignItems: 'center' }}
                    >
                      {otherSquads.length === 0 ? (
                        <SquadPill muted>All</SquadPill>
                      ) : (
                        <>
                          {otherSquads.slice(0, 2).map((id) => (
                            <SquadPill key={id}>{squadNameById.get(id) ?? id.slice(0, 6)}</SquadPill>
                          ))}
                          {otherSquads.length > 2 && (
                            <SquadPill muted>+{otherSquads.length - 2}</SquadPill>
                          )}
                        </>
                      )}
                    </Box>

                    <Box style={{ width: COL.tag, flexShrink: 0 }}>
                      <Text style={{ ...MONO, fontSize: 12, lineHeight: '16px', color: MIST }}>
                        {u.tag ?? '-'}
                      </Text>
                    </Box>

                    <Box
                      style={{
                        width: COL.actions,
                        flexShrink: 0,
                        display: 'flex',
                        justifyContent: 'flex-end',
                      }}
                    >
                      <Menu shadow="md" position="bottom-end" withinPortal>
                        <Menu.Target>
                          <ActionIcon variant="subtle" size="sm" style={{ color: MIST }}>
                            <IconDotsVertical size={16} />
                          </ActionIcon>
                        </Menu.Target>
                        <Menu.Dropdown style={{ backgroundColor: CARD, borderColor: HAIRLINE }}>
                          <Menu.Item
                            leftSection={<IconCopy size={14} />}
                            onClick={() => copyToClipboard(subUrl)}
                          >
                            {t('usersTable.actionCopySubUrl')}
                          </Menu.Item>
                          <Menu.Item
                            leftSection={<IconExternalLink size={14} />}
                            component="a"
                            href={subUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {t('usersTable.actionOpenSub')}
                          </Menu.Item>
                          <Menu.Item leftSection={<IconEdit size={14} />} onClick={() => setEditing(u)}>
                            {t('usersTable.actionEdit')}
                          </Menu.Item>
                          <Menu.Item
                            leftSection={<IconRefresh size={14} />}
                            onClick={() => handleRotate(u)}
                          >
                            {t('usersTable.actionRotate')}
                          </Menu.Item>
                          <Menu.Item
                            leftSection={<IconReload size={14} />}
                            onClick={() => handleResetTraffic(u)}
                          >
                            {t('usersTable.actionResetTraffic')}
                          </Menu.Item>
                          <Menu.Item
                            color="red"
                            leftSection={<IconBan size={14} />}
                            onClick={() => handleRevoke(u)}
                          >
                            {t('usersTable.actionRevoke')}
                          </Menu.Item>
                          <Menu.Divider />
                          <Menu.Item
                            color="red"
                            leftSection={<IconTrash size={14} />}
                            onClick={() => handleDelete(u)}
                          >
                            {t('usersTable.actionDelete')}
                          </Menu.Item>
                        </Menu.Dropdown>
                      </Menu>
                    </Box>
                  </Box>
                );
              })}
          </Box>
        </Box>

        {totalUsers > 0 && (
          <Box
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: 20,
              padding: '12px 16px',
              backgroundColor: GROUND,
              borderTop: `1px solid ${HAIRLINE}`,
            }}
          >
            <Group gap={8}>
              <Text style={MONO_LABEL}>{t('usersTable.rowsPerPage')}</Text>
              <Select
                size="xs"
                value={String(rowsPerPage)}
                onChange={(v) => setRowsPerPage(Number(v) || 25)}
                data={['10', '25', '50', '100']}
                allowDeselect={false}
                w={72}
                styles={{
                  input: {
                    backgroundColor: GROUND,
                    borderColor: HAIRLINE,
                    color: SNOW,
                    ...MONO,
                  },
                }}
              />
            </Group>
            <Text style={{ ...MONO_LABEL, color: SNOW }}>
              {rangeStart}-{rangeEnd} {t('usersTable.of')} {totalUsers}
            </Text>
            <Group gap={4}>
              <ActionIcon
                variant="subtle"
                size="sm"
                disabled={safePage <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                style={{ color: safePage <= 1 ? MIST : SNOW }}
              >
                <IconChevronLeft size={16} />
              </ActionIcon>
              <ActionIcon
                variant="subtle"
                size="sm"
                disabled={safePage >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                style={{ color: safePage >= totalPages ? MIST : SNOW }}
              >
                <IconChevronRight size={16} />
              </ActionIcon>
            </Group>
          </Box>
        )}
      </Box>

      <UserDrawer
        opened={createOpen}
        onClose={closeCreate}
        user={null}
        loading={createMutation.isPending}
        onSubmit={async (input) => {
          await createMutation.mutateAsync(input as CreateUserInput);
        }}
      />

      <UserDrawer
        opened={editing !== null}
        onClose={() => setEditing(null)}
        user={editing}
        loading={updateMutation.isPending}
        onSubmit={async (input) => {
          if (!editing) return;
          await updateMutation.mutateAsync({ id: editing.id, input: input as UpdateUserInput });
        }}
      />
    </Stack>
  );
}

/**
 * Colour = lifecycle, glow = seen in the last five minutes. Two facts in one
 * 10px mark, and the glow is the only animatedless cue that a row is live.
 */
function StatusDot({ accent, glow }: { accent: string; glow?: boolean }) {
  return (
    <span
      style={{
        width: 10,
        height: 10,
        borderRadius: '50%',
        backgroundColor: accent,
        boxShadow: glow ? `0 0 8px ${accent}99` : 'none',
        flexShrink: 0,
        display: 'inline-block',
      }}
    />
  );
}
