import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Box,
  NumberInput,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  UnstyledButton,
} from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import {
  IconCheck,
  IconChevronDown,
  IconChevronUp,
  IconDeviceMobile,
  IconInfoCircle,
  IconLink,
  IconPlus,
  IconSearch,
  IconServer2,
  IconShield,
  IconStack2,
} from '@tabler/icons-react';
import {
  createHost,
  listBindings,
  listHosts,
  listNodes,
  listProfiles,
  updateHost,
  type Fingerprint,
} from '../lib/api';
import { usePageMeta } from '../hooks/usePageMeta';
import { COUNTRIES } from '../lib/countries';

/**
 * One host, as a page. The order follows the question an operator is actually
 * answering: name it (that is the line people read), say which profile it
 * speaks, then pick the metal behind it. The right column shows the line as the
 * user will see it, so naming stops being guesswork.
 *
 * NOTE on nodes: a host currently belongs to one binding, i.e. one node. The
 * list below therefore lets you move a host between nodes rather than fan it
 * out across several; multi-node hosts need the host-centric model.
 */

const HAIRLINE = '#1C2A3D';
const CARD = '#0F1A28';
const WELL = '#0B1420';
const ROW = '#152233';
const SNOW = '#C8D4E3';
const MIST = '#7A8BA3';
const FAINT = '#5A6B82';
const DIM = '#3A4A60';
const CYAN = '#7DD3FC';
const CYAN_HI = '#67E8F9';
const MOSS = '#A7D8B9';
const AMBER = '#F5B14C';
const RED = '#E07A5F';
const VIOLET = '#A78BFA';

const DISPLAY = "'Space Grotesk', Inter, sans-serif";
const MONO = "'Geist Mono', monospace";

const FINGERPRINTS = ['chrome', 'firefox', 'safari', 'ios', 'android', 'edge', 'random'];
const ALPNS = ['h2', 'http/1.1', 'h3'];
/** What the subscription can emit. Turning one off skips this host there. */
const FORMATS = ['plain', 'singbox', 'xrayjson', 'xrayjson-array', 'clash'];

const LABEL = {
  fontFamily: MONO,
  fontSize: 10,
  fontWeight: 500,
  letterSpacing: '0.12em',
  textTransform: 'uppercase' as const,
  color: MIST,
  lineHeight: '12px',
};

export function HostEditPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const isNew = id === 'new';

  const hostsQuery = useQuery({ queryKey: ['hosts'], queryFn: () => listHosts() });
  const bindingsQuery = useQuery({ queryKey: ['bindings'], queryFn: () => listBindings() });
  const nodesQuery = useQuery({ queryKey: ['nodes'], queryFn: () => listNodes() });
  const profilesQuery = useQuery({ queryKey: ['profiles'], queryFn: () => listProfiles() });

  const host = isNew ? null : (hostsQuery.data?.hosts.find((h) => h.id === id) ?? null);
  const bindings = bindingsQuery.data?.bindings ?? [];
  const nodes = nodesQuery.data?.nodes ?? [];
  const profiles = profilesQuery.data?.profiles ?? [];

  const [name, setName] = useState('');
  const [country, setCountry] = useState<string | null>(null);
  const [port, setPort] = useState<number | ''>('');
  const [enabled, setEnabled] = useState(true);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [bindingId, setBindingId] = useState<string | null>(null);
  const [address, setAddress] = useState('');
  const [sni, setSni] = useState('');
  const [hostHeader, setHostHeader] = useState('');
  const [path, setPath] = useState('');
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [alpn, setAlpn] = useState<string[]>([]);
  const [securityLayer, setSecurityLayer] = useState<'default' | 'tls' | 'none'>('default');
  const [disabledFormats, setDisabledFormats] = useState<string[]>([]);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [nodeSearch, setNodeSearch] = useState('');
  const [onlyAttachable, setOnlyAttachable] = useState(false);
  const [dirty, setDirty] = useState(false);

  const currentBinding = bindings.find((b) => b.id === (bindingId ?? host?.bindingId));
  const currentNode = currentBinding ? nodes.find((n) => n.id === currentBinding.nodeId) : undefined;

  useEffect(() => {
    if (!host) return;
    const binding = bindings.find((b) => b.id === host.bindingId);
    const node = binding ? nodes.find((n) => n.id === binding.nodeId) : undefined;
    setName(host.remark);
    setCountry(node?.countryCode ? node.countryCode.toUpperCase() : null);
    setPort(host.portOverride ?? binding?.publicPort ?? binding?.port ?? '');
    setEnabled(host.enabled);
    setProfileId(binding?.profileId ?? null);
    setBindingId(host.bindingId);
    setAddress(host.addressOverride ?? '');
    setSni(host.sniOverride ?? '');
    setHostHeader(host.hostHeaderOverride ?? '');
    setPath(host.pathOverride ?? '');
    setFingerprint(host.fingerprintOverride ?? null);
    setAlpn(host.alpn);
    setSecurityLayer(host.securityLayer);
    setDisabledFormats(host.disableForFormats);
    setDirty(false);
  }, [host?.id, host?.updatedAt, bindings.length, nodes.length]);

  /**
   * Every node, annotated with why it can or cannot take this host: wrong core,
   * port already claimed by another host, or free. The reason travels with the
   * row so a disabled row never looks like an unexplained refusal.
   */
  const nodeRows = useMemo(() => {
    const profile = profiles.find((p) => p.id === profileId);
    const takenPort = new Map<string, string>();
    for (const b of bindings) {
      if (port !== '' && b.port === Number(port)) {
        const claimant = (hostsQuery.data?.hosts ?? []).find((h) => h.bindingId === b.id);
        if (claimant && claimant.id !== host?.id) takenPort.set(b.nodeId, claimant.remark);
      }
    }
    const q = nodeSearch.trim().toLowerCase();

    return nodes
      .map((n) => {
        const wrongCore =
          profile !== undefined &&
          n.coreVersion !== null &&
          profile.protocol === 'amneziawg' &&
          !n.coreVersion.toLowerCase().includes('awg');
        const taken = takenPort.get(n.id);
        return {
          node: n,
          selected: currentBinding?.nodeId === n.id,
          reason:
            port === ''
              ? // Without a port there is nothing to check yet, and "- free"
                // would be a claim the page cannot make.
                { kind: 'free' as const, text: t('hostEdit.portUnset') }
              : taken
                ? { kind: 'taken' as const, text: t('hostEdit.portTaken', { port, host: taken }) }
                : wrongCore
                  ? { kind: 'core' as const, text: t('hostEdit.wrongCore') }
                  : { kind: 'free' as const, text: t('hostEdit.portFree', { port }) },
        };
      })
      .filter((r) => {
        if (onlyAttachable && r.reason.kind !== 'free') return false;
        if (!q) return true;
        return `${r.node.name} ${r.node.address} ${r.node.countryCode ?? ''}`
          .toLowerCase()
          .includes(q);
      });
  }, [
    nodes,
    bindings,
    profiles,
    profileId,
    port,
    nodeSearch,
    onlyAttachable,
    currentBinding,
    host?.id,
    hostsQuery.data,
    t,
  ]);

  const saveMutation = useMutation({
    mutationFn: () => {
      const payload = {
        remark: name.trim(),
        enabled,
        addressOverride: address.trim() || null,
        portOverride: port === '' ? null : Number(port),
        sniOverride: sni.trim() || null,
        hostHeaderOverride: hostHeader.trim() || null,
        pathOverride: path.trim() || null,
        fingerprintOverride: (fingerprint as Fingerprint | null) ?? null,
        alpn,
        securityLayer,
        disableForFormats: disabledFormats,
      };
      if (isNew) {
        if (!bindingId) throw new Error(t('hostEdit.pickNodeFirst'));
        return createHost({ bindingId, ...payload });
      }
      return updateHost(host!.id, payload);
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ['hosts'] });
      setDirty(false);
      notifications.show({
        color: 'green',
        message: isNew ? t('hostEdit.created') : t('hostEdit.saved'),
      });
      if (isNew && saved) navigate(`/hosts/${saved.id}`, { replace: true });
    },
    onError: (err) =>
      notifications.show({
        color: 'red',
        title: t('common.saveError'),
        message: err instanceof Error ? err.message : String(err),
      }),
  });

  usePageMeta(isNew ? [t('hostEdit.newCrumb')] : [host?.remark ?? '']);

  if (!host && !isNew) {
    return (
      <Box style={{ padding: 40, borderRadius: 10, backgroundColor: CARD, border: `1px solid ${HAIRLINE}` }}>
        <Stack align="center" gap={14}>
          <Text style={{ fontFamily: DISPLAY, fontSize: 15, fontWeight: 500, color: SNOW }}>
            {hostsQuery.isLoading ? t('common.loading') : t('hostEdit.notFound')}
          </Text>
          {!hostsQuery.isLoading && (
            <PageButton onClick={() => navigate('/hosts')}>{t('hostEdit.backToList')}</PageButton>
          )}
        </Stack>
      </Box>
    );
  }

  const selectedProfile = profiles.find((p) => p.id === profileId);
  const overrideCount =
    (sni.trim() ? 1 : 0) +
    (hostHeader.trim() ? 1 : 0) +
    (path.trim() ? 1 : 0) +
    (fingerprint ? 1 : 0) +
    (alpn.length > 0 ? 1 : 0) +
    (securityLayer !== 'default' ? 1 : 0) +
    (disabledFormats.length > 0 ? 1 : 0);

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
        <Box style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
          <Box
            style={{
              width: 36,
              height: 36,
              borderRadius: 8,
              backgroundColor: `${CYAN}1A`,
              border: `1px solid ${CYAN}33`,
              color: CYAN,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {isNew ? <IconPlus size={18} stroke={2} /> : <IconLink size={18} stroke={1.8} />}
          </Box>
          <Text style={{ fontFamily: DISPLAY, fontSize: 17, fontWeight: 600, color: SNOW }}>
            {isNew ? t('hostEdit.newTitle') : (name || host!.remark)}
          </Text>
          {/* Flag and port sit with the name because together they are how the
              operator recognises the line a member will see. */}
          {port !== '' && (
            <Text style={{ fontFamily: MONO, fontSize: 15, fontWeight: 500, color: CYAN }}>{port}</Text>
          )}
          {currentNode && (
            <Text style={{ fontFamily: MONO, fontSize: 11, color: MIST }}>
              {currentNode.name}
            </Text>
          )}
          <Text style={{ ...LABEL, letterSpacing: '0.14em' }}>
            {isNew ? t('hostEdit.newSubtitle') : t('hostEdit.editSubtitle')}
          </Text>
          {dirty && (
            <Box style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Box style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: AMBER }} />
              <Text style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.12em', color: AMBER }}>
                {t('squadEdit.unsaved')}
              </Text>
            </Box>
          )}
        </Box>

        <Box style={{ flex: 1 }} />

        <Box style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <PageButton onClick={() => navigate('/hosts')}>{t('common.cancel')}</PageButton>
          <PageButton
            primary
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending || name.trim().length === 0 || (isNew && !bindingId)}
          >
            {isNew ? t('hostEdit.create') : t('common.save')}
          </PageButton>
        </Box>
      </Box>

      <Box style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        <Stack gap={16} style={{ flex: 2, minWidth: 0 }}>
          {/* Basics */}
          <Card>
            <CardTitle icon={<IconShield size={15} stroke={1.8} />} accent={CYAN}>
              {t('hostEdit.basics')}
            </CardTitle>
            <Box style={{ display: 'flex', gap: 16 }}>
              <Box style={{ flex: 1 }}>
                <TextInput
                  label={t('hostEdit.name')}
                  placeholder="Amsterdam"
                  value={name}
                  onChange={(e) => {
                    setName(e.currentTarget.value);
                    setDirty(true);
                  }}
                />
                <Hint>{t('hostEdit.nameHint')}</Hint>
              </Box>
              <Box style={{ flex: 1 }}>
                <Select
                  label={t('hostEdit.country')}
                  value={country}
                  onChange={(v) => {
                    setCountry(v);
                    setDirty(true);
                  }}
                  searchable
                  data={COUNTRIES.map((c) => ({ value: c.code, label: `${c.flag} ${c.name}` }))}
                />
                <Hint>{t('hostEdit.countryHint')}</Hint>
              </Box>
            </Box>
            <Box style={{ display: 'flex', gap: 16 }}>
              <Box style={{ flex: 1 }}>
                <NumberInput
                  label={t('hostEdit.port')}
                  value={port}
                  min={1}
                  max={65535}
                  onChange={(v) => {
                    setPort(typeof v === 'number' ? v : '');
                    setDirty(true);
                  }}
                />
                <Hint>{t('hostEdit.portHint')}</Hint>
              </Box>
              <Box style={{ flex: 1 }}>
                <Text style={{ ...LABEL, marginBottom: 8 }}>{t('hostEdit.state')}</Text>
                <Switch
                  checked={enabled}
                  onChange={(e) => {
                    setEnabled(e.currentTarget.checked);
                    setDirty(true);
                  }}
                  label={enabled ? t('hostEdit.enabled') : t('hostEdit.disabled')}
                />
                <Hint>{t('hostEdit.stateHint')}</Hint>
              </Box>
            </Box>

            {/* The address is one line for however many nodes stand behind the
                host, so it belongs here rather than under Advanced: with one
                node it can stay empty, with more it is the only way the client
                reaches all of them. */}
            <Box style={{ height: 1, backgroundColor: HAIRLINE, width: '100%' }} />
            <Box style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
              <Box style={{ flex: 1 }}>
                <TextInput
                  label={t('hostEdit.address')}
                  placeholder={currentNode?.address.split(':')[0] ?? 'ams.example.net'}
                  value={address}
                  onChange={(e) => {
                    setAddress(e.currentTarget.value);
                    setDirty(true);
                  }}
                />
                <Hint>{t('hostEdit.addressHint')}</Hint>
              </Box>
              <Box
                style={{
                  flex: 1,
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 10,
                  padding: '12px 14px',
                  borderRadius: 8,
                  backgroundColor: address.trim() ? '#1A1512' : WELL,
                  border: `1px solid ${address.trim() ? '#3A2320' : HAIRLINE}`,
                }}
              >
                <Box style={{ color: address.trim() ? AMBER : DIM, display: 'flex', marginTop: 1 }}>
                  <IconInfoCircle size={14} stroke={2} />
                </Box>
                <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
                  {address.trim() ? (
                    <>
                      <Text style={{ fontFamily: DISPLAY, fontSize: 12, fontWeight: 600, color: AMBER }}>
                        {t('hostEdit.aRecordTitle')}
                      </Text>
                      <Text style={{ fontFamily: MONO, fontSize: 12, color: SNOW }}>
                        {address.trim()} → {currentNode?.address.split(':')[0] ?? '—'}
                      </Text>
                    </>
                  ) : (
                    <Text style={{ fontFamily: DISPLAY, fontSize: 12, lineHeight: '17px', color: FAINT }}>
                      {t('hostEdit.aRecordEmpty')}
                    </Text>
                  )}
                </Stack>
              </Box>
            </Box>
          </Card>

          {/* Profile */}
          <Card>
            <Box style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Box style={{ color: VIOLET, display: 'flex' }}>
                <IconStack2 size={15} stroke={1.8} />
              </Box>
              <Text style={{ ...LABEL, letterSpacing: '0.16em' }}>{t('hostEdit.profile')}</Text>
              <Box style={{ flex: 1 }} />
              {profileId && (
                <UnstyledButton onClick={() => navigate('/profiles')}>
                  <Text style={{ fontFamily: DISPLAY, fontSize: 12, color: CYAN }}>
                    {t('hostEdit.openProfile')}
                  </Text>
                </UnstyledButton>
              )}
            </Box>
            <Select
              value={profileId}
              onChange={(v) => {
                setProfileId(v);
                setDirty(true);
              }}
              // Changing the profile changes which nodes can take this host, so
              // the list below re-checks itself on every switch.
              disabled={!isNew}
              placeholder={t('hostEdit.pickProfile')}
              data={profiles.map((p) => ({ value: p.id, label: `${p.name} · ${p.protocol}` }))}
            />
            <Box style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <IconInfoCircle size={13} stroke={2} color={DIM} />
              <Text style={{ fontFamily: DISPLAY, fontSize: 11, color: FAINT }}>
                {isNew ? t('hostEdit.profileHint') : t('hostEdit.profileLockedHint')}
              </Text>
            </Box>
          </Card>

          {/* Advanced */}
          <Box
            style={{
              borderRadius: 10,
              backgroundColor: CARD,
              border: `1px solid ${HAIRLINE}`,
              overflow: 'hidden',
            }}
          >
            <UnstyledButton
              onClick={() => setAdvancedOpen((v) => !v)}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '16px 20px',
              }}
            >
              <Box style={{ color: MIST, display: 'flex' }}>
                <IconLink size={15} stroke={1.8} />
              </Box>
              <Box style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <Text style={{ fontFamily: DISPLAY, fontSize: 14, fontWeight: 500, color: SNOW }}>
                  {t('hostEdit.advanced')}
                </Text>
                <Text style={{ fontFamily: DISPLAY, fontSize: 11, color: FAINT }}>
                  {t('hostEdit.advancedHint')}
                </Text>
              </Box>
              {/* How many overrides are actually set. Collapsed, this is the
                  only way to know the section is doing something. */}
              <Text style={{ ...LABEL, color: overrideCount > 0 ? AMBER : MIST }}>
                {overrideCount > 0 ? t('hostEdit.nSet', { count: overrideCount }) : t('hostEdit.optional')}
              </Text>
              <Box style={{ color: MIST, display: 'flex' }}>
                {advancedOpen ? <IconChevronUp size={16} /> : <IconChevronDown size={16} />}
              </Box>
            </UnstyledButton>
            {advancedOpen && (
              <Stack gap={0} style={{ padding: '0 20px 20px' }}>
                <GroupLabel>{t('hostEdit.groupWire')}</GroupLabel>
                <Box style={{ display: 'flex', gap: 16 }}>
                  <TextInput
                    style={{ flex: 1 }}
                    label={t('hostEdit.sni')}
                    placeholder="www.microsoft.com"
                    value={sni}
                    onChange={(e) => {
                      setSni(e.currentTarget.value);
                      setDirty(true);
                    }}
                  />
                  <TextInput
                    style={{ flex: 1 }}
                    label={t('hostEdit.hostHeader')}
                    placeholder={t('hostEdit.followsSni')}
                    value={hostHeader}
                    onChange={(e) => {
                      setHostHeader(e.currentTarget.value);
                      setDirty(true);
                    }}
                  />
                  <TextInput
                    style={{ flex: 1 }}
                    label={t('hostEdit.path')}
                    placeholder="/api/stream"
                    value={path}
                    onChange={(e) => {
                      setPath(e.currentTarget.value);
                      setDirty(true);
                    }}
                  />
                </Box>

                <Box style={{ display: 'flex', gap: 16, marginTop: 14, alignItems: 'flex-start' }}>
                  <Box style={{ flex: 1 }}>
                    <Select
                      label={t('hostEdit.fingerprint')}
                      value={fingerprint}
                      clearable
                      placeholder={t('hostEdit.fromProfile')}
                      onChange={(v) => {
                        setFingerprint(v);
                        setDirty(true);
                      }}
                      data={FINGERPRINTS.map((f) => ({ value: f, label: f }))}
                    />
                  </Box>
                  <Box style={{ flex: 1 }}>
                    <Text style={{ ...LABEL, marginBottom: 8 }}>{t('hostEdit.alpn')}</Text>
                    <Box style={{ display: 'flex', gap: 8 }}>
                      {ALPNS.map((a) => (
                        <Chip
                          key={a}
                          active={alpn.includes(a)}
                          onClick={() => {
                            setAlpn((prev) =>
                              prev.includes(a) ? prev.filter((x) => x !== a) : [...prev, a],
                            );
                            setDirty(true);
                          }}
                        >
                          {a}
                        </Chip>
                      ))}
                    </Box>
                  </Box>
                  <Box style={{ flex: 1 }}>
                    <Text style={{ ...LABEL, marginBottom: 8 }}>{t('hostEdit.securityLayer')}</Text>
                    <Box
                      style={{
                        display: 'flex',
                        padding: 3,
                        borderRadius: 8,
                        backgroundColor: WELL,
                        border: `1px solid ${HAIRLINE}`,
                      }}
                    >
                      {(['default', 'tls', 'none'] as const).map((s) => (
                        <UnstyledButton
                          key={s}
                          onClick={() => {
                            setSecurityLayer(s);
                            setDirty(true);
                          }}
                          style={{
                            flex: 1,
                            height: 28,
                            borderRadius: 6,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            backgroundColor: securityLayer === s ? ROW : 'transparent',
                          }}
                        >
                          <Text
                            style={{
                              fontFamily: DISPLAY,
                              fontSize: 12,
                              fontWeight: securityLayer === s ? 500 : 400,
                              color: securityLayer === s ? SNOW : MIST,
                            }}
                          >
                            {s}
                          </Text>
                        </UnstyledButton>
                      ))}
                    </Box>
                  </Box>
                </Box>

                <Box style={{ height: 1, backgroundColor: HAIRLINE, width: '100%', marginTop: 18 }} />
                <Box style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14 }}>
                  <Text style={{ ...LABEL }}>{t('hostEdit.formats')}</Text>
                  <Box style={{ flex: 1 }} />
                  <Text style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.1em', color: DIM }}>
                    {t('hostEdit.formatsComputed')}
                  </Text>
                </Box>
                {/* A format is on unless the operator turned it off. The list is
                    what the subscription can emit, not what this host is good
                    at: whether a client understands it is the client's problem. */}
                <Box style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
                  {FORMATS.map((f) => {
                    const on = !disabledFormats.includes(f);
                    return (
                      <Chip
                        key={f}
                        active={on}
                        onClick={() => {
                          setDisabledFormats((prev) =>
                            prev.includes(f) ? prev.filter((x) => x !== f) : [...prev, f],
                          );
                          setDirty(true);
                        }}
                      >
                        {on ? '✓ ' : ''}
                        {f}
                      </Chip>
                    );
                  })}
                </Box>
              </Stack>
            )}
          </Box>

          {/* Nodes */}
          <Card>
            <Box style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Box style={{ color: CYAN, display: 'flex' }}>
                <IconServer2 size={15} stroke={1.8} />
              </Box>
              <Text style={{ ...LABEL, letterSpacing: '0.16em' }}>{t('hostEdit.nodesBehind')}</Text>
              <Box style={{ flex: 1 }} />
              <Text style={{ fontFamily: MONO, fontSize: 11, color: MIST }}>
                {t('hostEdit.nodesSelected', {
                  selected: currentBinding ? 1 : 0,
                  total: nodeRows.length,
                })}
              </Text>
            </Box>

            <Box style={{ display: 'flex', gap: 12 }}>
              <Box
                style={{
                  flex: 1,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  height: 36,
                  padding: '0 12px',
                  borderRadius: 8,
                  backgroundColor: WELL,
                  border: `1px solid ${HAIRLINE}`,
                }}
              >
                <IconSearch size={14} stroke={1.8} color={FAINT} />
                <input
                  value={nodeSearch}
                  onChange={(e) => setNodeSearch(e.currentTarget.value)}
                  placeholder={t('hostEdit.nodeSearch')}
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
              <UnstyledButton
                onClick={() => setOnlyAttachable((v) => !v)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  height: 36,
                  padding: '0 14px',
                  borderRadius: 8,
                  backgroundColor: WELL,
                  border: `1px solid ${onlyAttachable ? CYAN : HAIRLINE}`,
                }}
              >
                <Box
                  style={{
                    width: 14,
                    height: 14,
                    borderRadius: 7,
                    border: `1px solid ${onlyAttachable ? CYAN : DIM}`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {onlyAttachable && <IconCheck size={8} stroke={3.4} color={CYAN} />}
                </Box>
                <Text style={{ fontFamily: DISPLAY, fontSize: 12, color: onlyAttachable ? SNOW : MIST }}>
                  {t('hostEdit.onlyAttachable')}
                </Text>
              </UnstyledButton>
            </Box>

            <Box style={{ borderRadius: 10, overflow: 'clip', border: `1px solid ${HAIRLINE}` }}>
              {nodeRows.length === 0 && (
                <Box style={{ padding: 20, backgroundColor: WELL }}>
                  <Text style={{ fontSize: 12, color: MIST }}>{t('common.nothingFound')}</Text>
                </Box>
              )}
              {nodeRows.map((r, i) => {
                const attachable = r.reason.kind === 'free';
                return (
                  <UnstyledButton
                    key={r.node.id}
                    onClick={() => {
                      if (!attachable && !r.selected) return;
                      const b = bindings.find(
                        (x) => x.nodeId === r.node.id && x.profileId === profileId,
                      );
                      setBindingId(b?.id ?? null);
                      setDirty(true);
                    }}
                    style={{
                      width: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      padding: '11px 14px',
                      backgroundColor: ROW,
                      borderTop: i === 0 ? 'none' : `1px solid ${HAIRLINE}`,
                      opacity: attachable || r.selected ? 1 : 0.55,
                      cursor: attachable || r.selected ? 'pointer' : 'not-allowed',
                    }}
                  >
                    <Box
                      style={{
                        width: 14,
                        height: 14,
                        borderRadius: 7,
                        border: `1px solid ${r.selected ? CYAN : DIM}`,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0,
                      }}
                    >
                      {r.selected && <IconCheck size={8} stroke={3.4} color={CYAN} />}
                    </Box>
                    <Box
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: 3,
                        backgroundColor: r.node.status === 'online' ? MOSS : AMBER,
                        flexShrink: 0,
                      }}
                    />
                    <Text
                      style={{ width: 120, fontFamily: DISPLAY, fontSize: 13, fontWeight: 500, color: SNOW }}
                    >
                      {r.node.name}
                    </Text>
                    <Text style={{ flex: 1, fontFamily: MONO, fontSize: 11, color: MIST }}>
                      {r.node.address}
                    </Text>
                    <Text style={{ width: 140, fontFamily: MONO, fontSize: 11, color: FAINT }}>
                      {r.node.coreVersion ?? '-'}
                    </Text>
                    <Text
                      style={{
                        width: 220,
                        textAlign: 'right',
                        fontFamily: MONO,
                        fontSize: 11,
                        color: port === '' ? FAINT : attachable ? MOSS : RED,
                      }}
                    >
                      {r.reason.text}
                    </Text>
                  </UnstyledButton>
                );
              })}
            </Box>
          </Card>
        </Stack>

        {/* What people see */}
        <Stack gap={16} style={{ flex: 1, minWidth: 0 }}>
          <Card>
            <CardTitle icon={<IconDeviceMobile size={15} stroke={1.8} />} accent={CYAN}>
              {t('hostEdit.whatPeopleSee')}
            </CardTitle>
            <Box
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '14px 16px',
                borderRadius: 10,
                backgroundColor: WELL,
                border: `1px solid ${HAIRLINE}`,
              }}
            >
              <Text style={{ fontSize: 16 }}>{flagEmoji(country)}</Text>
              <Text style={{ flex: 1, fontFamily: DISPLAY, fontSize: 15, fontWeight: 500, color: SNOW }}>
                {name.trim() || t('hostEdit.unnamed')}
              </Text>
              {port !== '' && (
                <Text style={{ fontFamily: MONO, fontSize: 12, color: CYAN_HI }}>{port}</Text>
              )}
            </Box>
            <Hint>{isNew ? t('hostEdit.previewHintNew') : t('hostEdit.previewHint')}</Hint>
            {selectedProfile && (
              <Text style={{ fontFamily: MONO, fontSize: 11, color: MIST }}>
                {selectedProfile.protocol.toUpperCase()}
              </Text>
            )}
          </Card>
        </Stack>
      </Box>
    </Stack>
  );
}

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

/** Groups the overrides by the question they answer, as drawn. */
function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <Text style={{ ...LABEL, letterSpacing: '0.14em', color: FAINT, marginBottom: 10 }}>
      {children}
    </Text>
  );
}

function Chip({
  children,
  active,
  onClick,
}: {
  children: ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <UnstyledButton
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        height: 28,
        padding: '0 12px',
        borderRadius: 7,
        backgroundColor: active ? `${CYAN}14` : WELL,
        border: `1px solid ${active ? `${CYAN}4D` : HAIRLINE}`,
      }}
    >
      <Text
        style={{
          fontFamily: MONO,
          fontSize: 11,
          fontWeight: active ? 500 : 400,
          color: active ? CYAN : MIST,
        }}
      >
        {children}
      </Text>
    </UnstyledButton>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return (
    <Text style={{ fontFamily: DISPLAY, fontSize: 11, lineHeight: '15px', color: FAINT }}>
      {children}
    </Text>
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
      <Text style={{ fontFamily: DISPLAY, fontSize: 13, fontWeight: 500, color: primary ? SNOW : MIST }}>
        {children}
      </Text>
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
