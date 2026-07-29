import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { Box, NumberInput, Select, Stack, Text, TextInput, UnstyledButton } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import {
  IconBox,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconChevronsDown,
  IconEye,
  IconFilter,
  IconInfoCircle,
  IconLink,
  IconLock,
  IconPlus,
  IconRoute,
  IconSearch,
  IconShield,
} from '@tabler/icons-react';
import {
  ALL_SQUAD_ID,
  createSquad,
  listBindings,
  listCascades,
  listHosts,
  listNodes,
  listProfiles,
  listRoutePolicies,
  listSquads,
  updateSquad,
  type SquadExitAclEntry,
} from '../lib/api';
import { usePageMeta } from '../hooks/usePageMeta';
import { COUNTRIES, countryName } from '../lib/countries';

/**
 * Squad editor as a page, not a modal: it is the screen where an operator
 * decides what a whole group of people can reach, and that decision needs the
 * room to show its consequences next to its controls. Left column is what you
 * change, right column is what it produces.
 *
 * NOTE: the host tree is presentational for now. Access is still stored as
 * profile ids on the squad, so ticking an individual host has nothing to save
 * against; the checkboxes reflect which hosts a squad's profiles already reach.
 * Wiring them up means moving the ACL from profiles to hosts.
 */

const HAIRLINE = '#1C2A3D';
const CARD = '#0F1A28';
const WELL = '#0B1420';
const ROW = '#152233';
const SUNK = '#08101A';
const SNOW = '#C8D4E3';
const MIST = '#7A8BA3';
const FAINT = '#5A6B82';
const DIM = '#3A4A60';
const CYAN = '#7DD3FC';
const CYAN_HI = '#67E8F9';
const MOSS = '#A7D8B9';
const AMBER = '#F5B14C';
const VIOLET = '#A78BFA';

const DISPLAY = "'Space Grotesk', Inter, sans-serif";
const MONO = "'Geist Mono', monospace";

const LABEL = {
  fontFamily: MONO,
  fontSize: 10,
  fontWeight: 500,
  letterSpacing: '0.12em',
  textTransform: 'uppercase' as const,
  color: MIST,
  lineHeight: '12px',
};

export function SquadEditPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const squadsQuery = useQuery({ queryKey: ['squads'], queryFn: listSquads });
  const hostsQuery = useQuery({ queryKey: ['hosts'], queryFn: () => listHosts() });
  const bindingsQuery = useQuery({ queryKey: ['bindings'], queryFn: () => listBindings() });
  const nodesQuery = useQuery({ queryKey: ['nodes'], queryFn: () => listNodes() });
  const profilesQuery = useQuery({ queryKey: ['profiles'], queryFn: () => listProfiles() });
  const cascadesQuery = useQuery({ queryKey: ['cascades'], queryFn: listCascades });
  const policiesQuery = useQuery({ queryKey: ['route-policies'], queryFn: listRoutePolicies });

  // "/squads/new" is the same page in draft state: same layout, same controls,
  // nothing persisted until Create.
  const isNew = id === 'new';
  const squad = isNew ? null : (squadsQuery.data?.squads.find((s) => s.id === id) ?? null);
  const isAll = squad?.id === ALL_SQUAD_ID;

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [routingPreset, setRoutingPreset] = useState<string>('');
  const [hwidLimit, setHwidLimit] = useState<number | ''>('');
  const [exitAcl, setExitAcl] = useState<SquadExitAclEntry[]>([]);
  const [policyIds, setPolicyIds] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [hostSearch, setHostSearch] = useState('');
  const [dirty, setDirty] = useState(false);
  // Access is stored per profile, so picking hosts in the tree resolves to the
  // profiles behind them. Every host of the same profile therefore ticks
  // together, which is exactly what the subscription will do.
  const [profileIds, setProfileIds] = useState<string[]>([]);

  useEffect(() => {
    if (!squad) return;
    setName(squad.name);
    setDescription(squad.description ?? '');
    setRoutingPreset(squad.routingPreset ?? '');
    setHwidLimit(squad.hwidDeviceLimit ?? '');
    setExitAcl(squad.exitAcl);
    setPolicyIds(squad.policyIds);
    setProfileIds(squad.profileIds);
    setDirty(false);
  }, [squad?.id, squad?.updatedAt]);

  const saveMutation = useMutation({
    mutationFn: () => {
      const payload = {
        name: name.trim(),
        description: description.trim() || null,
        routingPreset: routingPreset ? (routingPreset as never) : null,
        hwidDeviceLimit: hwidLimit === '' ? null : Number(hwidLimit),
        profileIds,
        exitAcl,
        policyIds,
      };
      return isNew ? createSquad(payload) : updateSquad(squad!.id, payload);
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ['squads'] });
      setDirty(false);
      notifications.show({
        color: 'green',
        message: isNew ? t('squads.notify.created') : t('squads.notify.updated'),
      });
      // Land on the squad that was just created, so the next thing an operator
      // sees is the thing they made rather than the list they came from.
      if (isNew && saved) navigate(`/squads/${saved.id}`, { replace: true });
    },
    onError: (err) =>
      notifications.show({
        color: 'red',
        title: t('common.saveError'),
        message: err instanceof Error ? err.message : String(err),
      }),
  });

  /** Hosts grouped by the country of the node they run on. */
  const groups = useMemo(() => {
    const nodeById = new Map((nodesQuery.data?.nodes ?? []).map((n) => [n.id, n]));
    const bindingById = new Map((bindingsQuery.data?.bindings ?? []).map((b) => [b.id, b]));
    const profileById = new Map((profilesQuery.data?.profiles ?? []).map((p) => [p.id, p]));
    const granted = new Set(profileIds);
    const q = hostSearch.trim().toLowerCase();

    const byCountry = new Map<
      string,
      {
        code: string;
        rows: {
          id: string;
          name: string;
          port: number | null;
          profile: string;
          profileId: string;
          granted: boolean;
        }[];
      }
    >();

    for (const h of hostsQuery.data?.hosts ?? []) {
      const binding = bindingById.get(h.bindingId);
      if (!binding) continue;
      const node = nodeById.get(binding.nodeId);
      const profile = profileById.get(binding.profileId);
      const code = (node?.countryCode ?? 'zz').toUpperCase();
      const row = {
        id: h.id,
        name: h.remark,
        port: h.portOverride ?? binding.publicPort ?? binding.port,
        profile: profile?.name ?? '?',
        profileId: binding.profileId,
        granted: granted.has(binding.profileId),
      };
      if (q && !`${row.name} ${row.port} ${row.profile}`.toLowerCase().includes(q)) continue;
      const g = byCountry.get(code) ?? { code, rows: [] };
      g.rows.push(row);
      byCountry.set(code, g);
    }

    return [...byCountry.values()].sort((a, b) => a.code.localeCompare(b.code));
  }, [hostsQuery.data, bindingsQuery.data, nodesQuery.data, profilesQuery.data, profileIds, hostSearch]);

  function toggleProfile(profileId: string) {
    if (isAll) return;
    setDirty(true);
    setProfileIds((prev) =>
      prev.includes(profileId) ? prev.filter((x) => x !== profileId) : [...prev, profileId],
    );
  }

  /** Group checkbox: all-or-nothing for every profile inside that country. */
  function toggleCountryHosts(rows: { profileId: string; granted: boolean }[]) {
    if (isAll) return;
    setDirty(true);
    const ids = [...new Set(rows.map((r) => r.profileId))];
    const allOn = rows.every((r) => r.granted);
    setProfileIds((prev) =>
      allOn ? prev.filter((x) => !ids.includes(x)) : [...new Set([...prev, ...ids])],
    );
  }

  const selectedHosts = groups.reduce((sum, g) => sum + g.rows.filter((r) => r.granted).length, 0);

  const balancers = (cascadesQuery.data?.cascades ?? []).filter((c) => c.mode === 'balancer');
  const policies = policiesQuery.data?.policies ?? [];

  // The crumb reads "/ SQUADS · basic · 12 members": the section comes from the
  // route, the squad's own name has to come from here.
  usePageMeta(
    isNew
      ? [t('squadEdit.newCrumb')]
      : [
          squad ? (isAll ? t('squads.allDefaultName') : squad.name) : null,
          t('pageMeta.squadMembers', { count: squad?.memberCount ?? 0 }),
        ],
  );

  if (!squad && !isNew) {
    // A stale bookmark or a deleted squad lands here. Say so and offer the way
    // back, instead of leaving a two-word sentence alone on an empty page.
    return (
      <Box
        style={{
          padding: 40,
          borderRadius: 10,
          backgroundColor: CARD,
          border: `1px solid ${HAIRLINE}`,
        }}
      >
        <Stack align="center" gap={14}>
          <Text style={{ fontFamily: DISPLAY, fontSize: 15, fontWeight: 500, color: SNOW }}>
            {squadsQuery.isLoading ? t('common.loading') : t('squadEdit.notFound')}
          </Text>
          {!squadsQuery.isLoading && (
            <PageButton onClick={() => navigate('/squads')}>{t('squadEdit.backToList')}</PageButton>
          )}
        </Stack>
      </Box>
    );
  }

  function toggleExit(cascadeId: string, nodeId: string) {
    setDirty(true);
    setExitAcl((prev) => {
      const entry = prev.find((e) => e.cascadeId === cascadeId);
      if (!entry) return [...prev, { cascadeId, exitNodeIds: [nodeId] }];
      const has = entry.exitNodeIds.includes(nodeId);
      const nextIds = has
        ? entry.exitNodeIds.filter((x) => x !== nodeId)
        : [...entry.exitNodeIds, nodeId];
      // No rows left means "no restriction", which is how the backend reads a
      // missing entry, so drop it rather than storing an empty list.
      return nextIds.length === 0
        ? prev.filter((e) => e.cascadeId !== cascadeId)
        : prev.map((e) => (e.cascadeId === cascadeId ? { ...e, exitNodeIds: nextIds } : e));
    });
  }

  function togglePolicy(policyId: string) {
    setDirty(true);
    setPolicyIds((prev) =>
      prev.includes(policyId) ? prev.filter((x) => x !== policyId) : [...prev, policyId],
    );
  }

  function toggleCountry(code: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  return (
    <Stack gap={16}>
      {/* Page bar */}
      <Box
        style={{
          display: 'flex',
          alignItems: 'center',
          height: 64,
          padding: '8px 8px 8px 14px',
          borderRadius: 10,
          backgroundColor: CARD,
          border: `1px solid ${HAIRLINE}`,
        }}
      >
        <Box style={{ display: 'flex', alignItems: 'center', gap: 12, paddingRight: 16, flexShrink: 0 }}>
          <Box
            style={{
              width: 36,
              height: 36,
              borderRadius: 8,
              backgroundColor: `${VIOLET}1A`,
              border: `1px solid ${VIOLET}33`,
              color: VIOLET,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {isNew ? <IconPlus size={18} stroke={2} /> : <IconLink size={18} stroke={1.8} />}
          </Box>
          <Text style={{ fontFamily: DISPLAY, fontSize: 17, fontWeight: 600, color: SNOW }}>
            {isNew ? t('squadEdit.newTitle') : isAll ? t('squads.allDefaultName') : squad!.name}
          </Text>
        </Box>

        <Box style={{ width: 1, height: 26, backgroundColor: HAIRLINE, flexShrink: 0 }} />

        <Box style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 16, paddingLeft: 16 }}>
          <BarFact value={selectedHosts} label={t('squads.card.hosts')} />
          <Text style={{ fontFamily: MONO, fontSize: 10, color: DIM }}>·</Text>
          {isNew ? (
            // No members yet by definition: users are assigned to a squad that
            // already exists, so the bar says that instead of showing a zero.
            <Text style={{ fontFamily: DISPLAY, fontSize: 12, color: MIST }}>
              {t('squadEdit.membersLater')}
            </Text>
          ) : (
            <BarFact value={squad!.memberCount} label={t('squads.card.members')} />
          )}
          {isNew && (
            <>
              <Text style={{ fontFamily: MONO, fontSize: 10, color: DIM }}>·</Text>
              <Chip accent={AMBER}>{t('squadEdit.draft')}</Chip>
            </>
          )}
          {dirty && (
            <>
              <Text style={{ fontFamily: MONO, fontSize: 10, color: DIM }}>·</Text>
              <Box style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Box style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: AMBER }} />
                <Text style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.12em', color: AMBER }}>
                  {t('squadEdit.unsaved')}
                </Text>
              </Box>
            </>
          )}
          {isAll && (
            <Box
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                height: 24,
                padding: '0 10px',
                borderRadius: 6,
                backgroundColor: `${MOSS}14`,
                border: `1px solid ${MOSS}2E`,
              }}
            >
              <IconLock size={11} stroke={2} color={MOSS} />
              <Text style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.1em', color: MOSS }}>
                {t('squadEdit.builtInReadOnly')}
              </Text>
            </Box>
          )}
        </Box>

        <Box style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 8, flexShrink: 0 }}>
          {isAll ? (
            // Nothing here can be changed, so the only action is leaving.
            <PageButton onClick={() => navigate('/squads')}>{t('squadEdit.close')}</PageButton>
          ) : (
            <>
              <PageButton onClick={() => navigate('/squads')}>{t('common.cancel')}</PageButton>
              <PageButton
                primary
                onClick={() => saveMutation.mutate()}
                // A nameless squad cannot be created, and the button says so by
                // being unavailable rather than by failing on click.
                disabled={saveMutation.isPending || (isNew && name.trim().length === 0)}
              >
                {isNew ? t('squads.create') : t('common.save')}
              </PageButton>
            </>
          )}
        </Box>
      </Box>

      {isAll && (
        <Box
          style={{
            display: 'flex',
            gap: 12,
            padding: '16px 20px',
            borderRadius: 10,
            backgroundColor: CARD,
            border: `1px solid ${HAIRLINE}`,
          }}
        >
          <Box style={{ color: CYAN, display: 'flex', flexShrink: 0, paddingTop: 1 }}>
            <IconInfoCircle size={16} stroke={1.8} />
          </Box>
          <Box style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <Text style={{ fontFamily: DISPLAY, fontSize: 13, fontWeight: 500, color: SNOW }}>
              {t('squadEdit.allTitle')}
            </Text>
            <Text style={{ fontFamily: DISPLAY, fontSize: 12, lineHeight: '16px', color: MIST }}>
              {t('squadEdit.allBody')}
            </Text>
          </Box>
        </Box>
      )}

      {/* Columns */}
      <Box style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        <Stack gap={16} style={{ flex: 2, minWidth: 0 }}>
          {/* Basics */}
          <Card>
            <Box style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Box style={{ color: CYAN, display: 'flex' }}>
                <IconShield size={15} stroke={1.8} />
              </Box>
              <Text style={{ ...LABEL, letterSpacing: '0.16em' }}>{t('squadEdit.basics')}</Text>
              {isAll && <Chip accent={FAINT}>{t('squadEdit.locked')}</Chip>}
            </Box>
            <Box style={{ display: 'flex', gap: 16 }}>
              <Box style={{ flex: 1 }}>
                <TextInput
                  label={t('squadEdit.name')}
                  required
                  placeholder={t('squadEdit.namePlaceholder')}
                  value={name}
                  maxLength={32}
                  onChange={(e) => {
                    setName(e.currentTarget.value);
                    setDirty(true);
                  }}
                  rightSection={
                    <Text style={{ fontFamily: MONO, fontSize: 10, color: FAINT }}>
                      {name.length}/32
                    </Text>
                  }
                  rightSectionWidth={48}
                  disabled={isAll}
                />
                <Hint>{t('squadEdit.nameHint')}</Hint>
              </Box>
              <Box style={{ flex: 1 }}>
                <TextInput
                  label={t('squadEdit.description')}
                  placeholder={t('squadEdit.descriptionPlaceholder')}
                  value={description}
                  disabled={isAll}
                  onChange={(e) => {
                    setDescription(e.currentTarget.value);
                    setDirty(true);
                  }}
                />
                <Hint>{t('squadEdit.descriptionHint')}</Hint>
              </Box>
            </Box>

            <Box style={{ display: 'flex', gap: 16 }}>
              <Box style={{ flex: 1 }}>
                <Select
                  label={t('squadEdit.routingOverride')}
                  disabled={isAll}
                  value={routingPreset}
                  onChange={(v) => {
                    setRoutingPreset(v ?? '');
                    setDirty(true);
                  }}
                  allowDeselect={false}
                  data={[
                    { value: '', label: t('squadEdit.routingInherit') },
                    { value: 'proxy-all', label: 'proxy-all' },
                    { value: 'ru-split', label: 'ru-split' },
                    { value: 'cn-split', label: 'cn-split' },
                  ]}
                />
                <Hint>{t('squadEdit.routingHint')}</Hint>
              </Box>
              <Box style={{ flex: 1 }}>
                <NumberInput
                  label={t('squadEdit.hwidLimit')}
                  placeholder={t('squadEdit.hwidPlaceholder')}
                  value={hwidLimit}
                  disabled={isAll}
                  min={0}
                  onChange={(v) => {
                    setHwidLimit(typeof v === 'number' ? v : '');
                    setDirty(true);
                  }}
                  rightSection={
                    <Text style={{ fontFamily: MONO, fontSize: 10, color: FAINT }}>
                      {t('squadEdit.devices')}
                    </Text>
                  }
                  rightSectionWidth={60}
                />
                <Hint>{isNew ? t('squadEdit.hwidHintNew') : t('squadEdit.hwidHint')}</Hint>
              </Box>
            </Box>
          </Card>

          {/* Host tree */}
          <Card>
            <Box style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Box style={{ color: CYAN, display: 'flex' }}>
                <IconRoute size={15} stroke={1.8} />
              </Box>
              <Text style={{ ...LABEL, letterSpacing: '0.16em' }}>{t('squadEdit.hosts')}</Text>
              <Chip accent={CYAN}>
                {isAll
                  ? t('squadEdit.attachedAll', { count: selectedHosts })
                  : t('squadEdit.selected', { count: selectedHosts })}
              </Chip>
              <Box style={{ flex: 1 }} />
              {!isAll && (
                <SmallButton
                  onClick={() =>
                    toggleCountryHosts(groups.flatMap((g) => g.rows))
                  }
                >
                  <IconCheck size={12} stroke={2.2} color={MIST} />
                  {t('squadEdit.selectAll')}
                </SmallButton>
              )}
              <SmallButton
                onClick={() =>
                  setCollapsed((prev) =>
                    prev.size === groups.length ? new Set() : new Set(groups.map((g) => g.code)),
                  )
                }
              >
                <IconChevronsDown size={12} stroke={2.2} color={MIST} />
                {t('squadEdit.collapseAll')}
              </SmallButton>
              <Box
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: 280,
                  height: 28,
                  padding: '0 10px',
                  borderRadius: 8,
                  backgroundColor: SUNK,
                  border: `1px solid ${HAIRLINE}`,
                }}
              >
                <IconSearch size={13} stroke={2} color={FAINT} />
                <input
                  value={hostSearch}
                  onChange={(e) => setHostSearch(e.currentTarget.value)}
                  placeholder={t('squadEdit.hostSearch')}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    background: 'transparent',
                    border: 'none',
                    outline: 'none',
                    color: SNOW,
                    fontFamily: DISPLAY,
                    fontSize: 12,
                  }}
                />
              </Box>
            </Box>

            {groups.length === 0 && (
              <Text style={{ fontSize: 12, color: MIST }}>{t('squadEdit.noHosts')}</Text>
            )}

            {groups.map((g) => {
              const granted = g.rows.filter((r) => r.granted).length;
              const folded = collapsed.has(g.code);
              const anyGranted = granted > 0;
              return (
                <Box
                  key={g.code}
                  style={{
                    borderRadius: 10,
                    overflow: 'clip',
                    backgroundColor: WELL,
                    border: `1px solid ${HAIRLINE}`,
                    borderLeft: `3px solid ${anyGranted ? CYAN : '#2C3A4E'}`,
                  }}
                >
                  <UnstyledButton
                    onClick={() => toggleCountry(g.code)}
                    style={{
                      width: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '10px 14px',
                    }}
                  >
                    <Box style={{ color: MIST, display: 'flex' }}>
                      {folded ? (
                        <IconChevronRight size={14} stroke={2.4} />
                      ) : (
                        <IconChevronDown size={14} stroke={2.4} />
                      )}
                    </Box>
                    <Text style={{ fontSize: 15 }}>{flagEmoji(g.code)}</Text>
                    <Text
                      style={{
                        flex: 1,
                        minWidth: 0,
                        fontFamily: MONO,
                        fontSize: 11,
                        fontWeight: 500,
                        letterSpacing: '0.14em',
                        textTransform: 'uppercase',
                        color: anyGranted ? SNOW : MIST,
                      }}
                    >
                      {COUNTRIES.find((c) => c.code === g.code)?.name ?? g.code}
                    </Text>
                    <Chip accent={anyGranted ? CYAN : FAINT}>
                      {granted}/{g.rows.length}
                    </Chip>
                    <Box
                      component="span"
                      onClick={(e) => {
                        // The row folds, the checkbox grants: two actions in one
                        // strip, so the tick must not bubble into the fold.
                        e.stopPropagation();
                        toggleCountryHosts(g.rows);
                      }}
                      style={{ display: 'flex' }}
                    >
                      <CheckBox checked={anyGranted && granted === g.rows.length} />
                    </Box>
                  </UnstyledButton>

                  {!folded &&
                    g.rows.map((r) => (
                      <UnstyledButton
                        key={r.id}
                        onClick={() => toggleProfile(r.profileId)}
                        style={{
                          width: '100%',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 12,
                          padding: '11px 14px',
                          backgroundColor: ROW,
                          borderTop: `1px solid ${HAIRLINE}`,
                          cursor: isAll ? 'default' : 'pointer',
                        }}
                      >
                        <Box style={{ width: 14, flexShrink: 0 }} />
                        <CheckBox checked={r.granted} />
                        <Text
                          style={{
                            flex: 1,
                            minWidth: 0,
                            fontFamily: DISPLAY,
                            fontSize: 13,
                            fontWeight: 500,
                            color: SNOW,
                          }}
                        >
                          {r.name}
                        </Text>
                        {r.port !== null && (
                          <Text style={{ fontFamily: MONO, fontSize: 11, color: CYAN_HI }}>
                            {r.port}
                          </Text>
                        )}
                        <Text style={{ fontFamily: MONO, fontSize: 11, color: MIST }}>
                          {r.profile}
                        </Text>
                      </UnstyledButton>
                    ))}
                </Box>
              );
            })}

            <Box style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <IconInfoCircle
                size={13}
                stroke={2}
                color={isNew && selectedHosts === 0 ? AMBER : DIM}
              />
              <Text
                style={{
                  fontFamily: DISPLAY,
                  fontSize: 11,
                  lineHeight: '15px',
                  color: isNew && selectedHosts === 0 ? AMBER : FAINT,
                }}
              >
                {isNew && selectedHosts === 0 ? t('squadEdit.emptyWarning') : t('squadEdit.treeHint')}
              </Text>
            </Box>
          </Card>
        </Stack>

        {/* Side column */}
        <Stack gap={16} style={{ flex: 1, minWidth: 0 }}>
          <Card>
            <Box style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Box style={{ color: VIOLET, display: 'flex' }}>
                <IconFilter size={15} stroke={1.8} />
              </Box>
              <Text style={{ ...LABEL, letterSpacing: '0.16em' }}>{t('squadEdit.cascadeDirections')}</Text>
              {isNew && <Chip accent={FAINT}>{t('squadEdit.optional')}</Chip>}
            </Box>
            <Hint>{isAll ? t('squadEdit.cascadeDirectionsAll') : t('squadEdit.cascadeDirectionsHint')}</Hint>
            {balancers.length === 0 && (
              <Text style={{ fontSize: 12, color: MIST }}>{t('squadEdit.noDirections')}</Text>
            )}
            {balancers.map((c) => {
              const entry = exitAcl.find((e) => e.cascadeId === c.id);
              const exits = c.hops.slice(1);
              return (
                <Box
                  key={c.id}
                  style={{
                    borderRadius: 10,
                    overflow: 'clip',
                    backgroundColor: WELL,
                    border: `1px solid ${HAIRLINE}`,
                    borderLeft: `3px solid ${entry ? VIOLET : '#2C3A4E'}`,
                  }}
                >
                  <Box
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '10px 14px',
                    }}
                  >
                    <Box style={{ color: VIOLET, display: 'flex' }}>
                      <IconFilter size={13} stroke={1.8} />
                    </Box>
                    <Text style={{ flex: 1, fontFamily: DISPLAY, fontSize: 13, fontWeight: 500, color: SNOW }}>
                      {c.name}
                    </Text>
                    <Chip accent={isAll ? MOSS : entry ? VIOLET : FAINT}>
                      {isAll
                        ? t('squadEdit.allDirections')
                        : `${entry ? entry.exitNodeIds.length : exits.length}/${exits.length}`}
                    </Chip>
                  </Box>
                  {exits.map((hop, i) => {
                    // The system squad never restricts anything, so every
                    // direction reads as granted and the row is not clickable.
                    const checked = isAll || (entry ? entry.exitNodeIds.includes(hop.nodeId) : false);
                    const node = nodesQuery.data?.nodes.find((n) => n.id === hop.nodeId);
                    // The direction is what a squad grants, and it is named by
                    // its country and identified by its tag. The node under it
                    // is a detail that can be swapped without the tag moving.
                    // Tags: plain first, then one per granted policy.
                    const tags = [i + 1, ...policyIds.map((id) => {
                      const ordinal = policies.find((p) => p.id === id)?.ordinal ?? 0;
                      return ordinal * 256 + i + 1;
                    })];
                    return (
                      <UnstyledButton
                        key={hop.nodeId}
                        onClick={() => !isAll && toggleExit(c.id, hop.nodeId)}
                        style={{
                          width: '100%',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 12,
                          padding: '10px 14px',
                          backgroundColor: ROW,
                          borderTop: `1px solid ${HAIRLINE}`,
                        }}
                      >
                        <CheckBox checked={checked} accent={VIOLET} />
                        <Text style={{ flex: 1, fontFamily: DISPLAY, fontSize: 13, color: SNOW }}>
                          {node?.countryCode
                            ? `${node.countryCode.toUpperCase()} · ${countryName(node.countryCode)}`
                            : (node?.name ?? hop.nodeId.slice(0, 8))}
                        </Text>
                        <Text style={{ fontFamily: MONO, fontSize: 11, color: MIST }}>
                          {tags.map((n) => n.toString(16).padStart(4, '0')).join(' · ')}
                        </Text>
                      </UnstyledButton>
                    );
                  })}
                </Box>
              );
            })}
          </Card>

          <Card>
            <Box style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Box style={{ color: CYAN, display: 'flex' }}>
                <IconFilter size={15} stroke={1.8} />
              </Box>
              <Text style={{ ...LABEL, letterSpacing: '0.16em' }}>{t('squadEdit.routePolicies')}</Text>
              {isNew && <Chip accent={FAINT}>{t('squadEdit.optional')}</Chip>}
            </Box>
            <Hint>{isAll ? t('squadEdit.routePoliciesAll') : t('squadEdit.routePoliciesHint')}</Hint>
            {policies.length === 0 && (
              <Text style={{ fontSize: 12, color: MIST }}>{t('routes.empty')}</Text>
            )}
            {isAll && policies.length > 0 && (
              <Box
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '12px 14px',
                  borderRadius: 10,
                  backgroundColor: WELL,
                  border: `1px solid ${HAIRLINE}`,
                }}
              >
                <IconLock size={12} stroke={2} color={FAINT} />
                <Text style={{ fontFamily: MONO, fontSize: 11, color: FAINT }}>
                  {t('squadEdit.policiesExistNoneApply', { count: policies.length })}
                </Text>
              </Box>
            )}
            {!isAll &&
              policies.map((p) => {
              const checked = policyIds.includes(p.id);
              return (
                <UnstyledButton
                  key={p.id}
                  onClick={() => togglePolicy(p.id)}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '12px 14px',
                    borderRadius: 10,
                    backgroundColor: WELL,
                    border: `1px solid ${HAIRLINE}`,
                    borderLeft: `3px solid ${checked ? CYAN : '#2C3A4E'}`,
                  }}
                >
                  <CheckBox checked={checked} />
                  <Text style={{ flex: 1, fontFamily: DISPLAY, fontSize: 13, fontWeight: 500, color: SNOW }}>
                    {p.name}
                  </Text>
                  <Text style={{ fontFamily: MONO, fontSize: 10, color: MIST }}>
                    {p.blockDomains.length > 0
                      ? t('squadEdit.blocksDomains', { count: p.blockDomains.length })
                      : t('squadEdit.bypassesDomains', { count: p.directDomains.length })}
                  </Text>
                </UnstyledButton>
              );
            })}
          </Card>

          <Card>
            <CardTitle icon={<IconEye size={15} stroke={1.8} />} accent={MOSS}>
              {t('squadEdit.whatMembersGet')}
            </CardTitle>
            {selectedHosts === 0 && (
              // Empty state instead of a row of zeroes: it tells the operator
              // what to do next, which a "0 lines" line does not.
              <Stack
                align="center"
                gap={8}
                style={{
                  padding: '28px 20px',
                  borderRadius: 10,
                  border: `1px dashed ${HAIRLINE}`,
                }}
              >
                <IconBox size={20} stroke={1.6} color={DIM} />
                <Text style={{ fontFamily: DISPLAY, fontSize: 13, fontWeight: 500, color: MIST }}>
                  {t('squadEdit.previewEmptyTitle')}
                </Text>
                <Text
                  style={{ fontFamily: DISPLAY, fontSize: 11, color: FAINT, textAlign: 'center' }}
                >
                  {t('squadEdit.previewEmptyBody')}
                </Text>
              </Stack>
            )}
            {/* Hosts times variants rather than one flat number: the operator
                picked the hosts and granted the policies, and seeing the two
                factors makes the total explainable instead of magic. */}
            <Box style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Text style={{ fontFamily: MONO, fontSize: 13, fontWeight: 500, color: SNOW }}>
                {selectedHosts}
              </Text>
              <Text style={{ fontFamily: MONO, fontSize: 12, color: MIST }}>
                {t('squadEdit.hostsWord', { count: selectedHosts })}
              </Text>
              <Text style={{ fontFamily: MONO, fontSize: 12, color: DIM }}>×</Text>
              <Text style={{ fontFamily: MONO, fontSize: 13, fontWeight: 500, color: SNOW }}>
                {1 + policyIds.length}
              </Text>
              <Text style={{ fontFamily: MONO, fontSize: 12, color: MIST }}>
                {t('squadEdit.variantsWord', { count: 1 + policyIds.length })}
              </Text>
              <Text style={{ fontFamily: MONO, fontSize: 12, color: DIM }}>·</Text>
              <Text style={{ fontFamily: MONO, fontSize: 13, fontWeight: 500, color: SNOW }}>
                {squad?.memberCount ?? 0}
              </Text>
              <Text style={{ fontFamily: MONO, fontSize: 12, color: MIST }}>
                {isNew ? t('squadEdit.membersShort') : t('squadEdit.membersAffected')}
              </Text>
              {isNew && (
                <>
                  <Box style={{ flex: 1 }} />
                  <Text style={{ fontFamily: DISPLAY, fontSize: 11, color: FAINT }}>
                    {t('squadEdit.assignLater')}
                  </Text>
                </>
              )}
            </Box>
            <Stack gap={2}>
              {groups
                .flatMap((g) => g.rows.filter((r) => r.granted))
                .slice(0, 6)
                .map((r) => (
                  <Box
                    key={r.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '8px 0',
                      borderBottom: `1px solid ${HAIRLINE}`,
                    }}
                  >
                    <Box style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: CYAN }} />
                    <Text style={{ flex: 1, fontFamily: DISPLAY, fontSize: 13, color: SNOW }}>
                      {r.name}
                    </Text>
                    <Text style={{ fontFamily: MONO, fontSize: 10, color: MIST }}>
                      {policyIds.length === 0
                        ? t('squadEdit.plainOnly')
                        : t('squadEdit.plainPlus', { count: policyIds.length })}
                    </Text>
                  </Box>
                ))}
            </Stack>
            {/* Two mechanics sit on this screen and they are easy to confuse:
                a host with its policy variants, and a cascade direction with
                its tag. Say which one this list is. */}
            <Text style={{ fontFamily: DISPLAY, fontSize: 11, lineHeight: '15px', color: FAINT }}>
              {t('squadEdit.previewNote')}
            </Text>
          </Card>
        </Stack>
      </Box>
    </Stack>
  );
}

// ───── Pieces ─────

function Card({ children }: { children: ReactNode }) {
  return (
    <Box
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        padding: 20,
        borderRadius: 10,
        backgroundColor: CARD,
        border: `1px solid ${HAIRLINE}`,
      }}
    >
      {children}
    </Box>
  );
}

function CardTitle({
  icon,
  accent,
  children,
}: {
  icon: ReactNode;
  accent: string;
  children: ReactNode;
}) {
  return (
    <Box style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <Box style={{ color: accent, display: 'flex' }}>{icon}</Box>
      <Text style={{ ...LABEL, letterSpacing: '0.16em' }}>{children}</Text>
    </Box>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return (
    <Text style={{ fontFamily: DISPLAY, fontSize: 11, lineHeight: '15px', color: FAINT }}>
      {children}
    </Text>
  );
}

function Chip({ accent, children }: { accent: string; children: ReactNode }) {
  return (
    <Box
      style={{
        display: 'flex',
        alignItems: 'center',
        height: 20,
        padding: '0 8px',
        borderRadius: 6,
        backgroundColor: `${accent}1A`,
        border: `1px solid ${accent}33`,
      }}
    >
      <Text style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.1em', color: accent }}>
        {children}
      </Text>
    </Box>
  );
}

function CheckBox({ checked, accent = CYAN }: { checked: boolean; accent?: string }) {
  return (
    <Box
      style={{
        width: 14,
        height: 14,
        borderRadius: 7,
        border: `1px solid ${checked ? accent : DIM}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      {checked && <IconCheck size={8} stroke={3.4} color={accent} />}
    </Box>
  );
}

function SmallButton({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  return (
    <UnstyledButton
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        height: 28,
        padding: '0 10px',
        borderRadius: 8,
        backgroundColor: WELL,
        border: `1px solid ${HAIRLINE}`,
        fontFamily: MONO,
        fontSize: 10,
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        color: MIST,
      }}
    >
      {children}
    </UnstyledButton>
  );
}

function BarFact({ value, label }: { value: number; label: string }) {
  return (
    <Box style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <Text style={{ fontFamily: MONO, fontSize: 13, fontWeight: 500, color: SNOW }}>{value}</Text>
      <Text style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.12em', color: MIST }}>
        {label}
      </Text>
    </Box>
  );
}

function PageButton({
  children,
  onClick,
  primary,
  disabled,
}: {
  children: ReactNode;
  onClick?: () => void;
  primary?: boolean;
  disabled?: boolean;
}) {
  return (
    <UnstyledButton
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        height: 38,
        padding: '0 16px',
        borderRadius: 8,
        backgroundColor: WELL,
        border: `1px solid ${HAIRLINE}`,
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {primary && <IconCheck size={14} stroke={2.4} color={CYAN} />}
      <Text
        style={{ fontFamily: DISPLAY, fontSize: 13, fontWeight: 500, color: primary ? SNOW : MIST }}
      >
        {children}
      </Text>
    </UnstyledButton>
  );
}

function flagEmoji(cc: string): string {
  if (cc.length !== 2) return '🏳';
  const up = cc.toUpperCase();
  const c0 = up.charCodeAt(0);
  const c1 = up.charCodeAt(1);
  if (c0 < 65 || c0 > 90 || c1 < 65 || c1 > 90) return '🏳';
  const A = 0x1f1e6;
  const a = 'A'.charCodeAt(0);
  return String.fromCodePoint(A + (c0 - a)) + String.fromCodePoint(A + (c1 - a));
}
