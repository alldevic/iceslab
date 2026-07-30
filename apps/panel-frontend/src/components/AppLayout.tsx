import { Suspense } from 'react';
import { AppShell, Box, Center, Loader, Stack, Text, UnstyledButton } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Outlet, NavLink as RouterNavLink, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { IconUsersGroup } from '@tabler/icons-react';
import { DiscordIcon, GithubIcon, HeartIcon, StarIcon, TelegramIcon } from './BrandIcons';
import {
  NavDeliveryIcon,
  NavHomeIcon,
  NavHostsIcon,
  NavInsightsIcon,
  NavLogoutIcon,
  NavMetadataIcon,
  NavNodesIcon,
  NavProfilesIcon,
  NavQueuesIcon,
  NavRoutesIcon,
  NavSettingsIcon,
  NavUsersIcon,
} from './NavIcons';
import { useAuth } from '../stores/auth';
import { useBrandName } from '../hooks/useBrandName';
import { getSystemVersion } from '../lib/api';
import { useOverview } from '../hooks/useOverview';
import { PageMetaProvider, usePageMetaFacts } from '../hooks/usePageMeta';
import { DISCORD_URL, GITHUB_URL, SUPPORT_URL, TELEGRAM_URL } from '../lib/community';

const HAIRLINE = '#1C2A3D';
const GROUND = '#08101A';
const CARD = '#0F1A28';
const SNOW = '#C8D4E3';
const MIST = '#7A8BA3';
const CYAN = '#7DD3FC';
const CYAN2 = '#67E8F9';
const MOSS = '#A7D8B9';
const AMBER = '#F5B14C';
// Warm rose, used by nothing else in the panel: the donate chip is the one
// place we ask for something back, so it gets its own accent.
const ROSE = '#E08AA8';

const DISPLAY = "'Space Grotesk', Inter, sans-serif";

const MONO_LABEL = {
  fontFamily: "'Geist Mono', monospace",
  fontSize: 10,
  letterSpacing: '0.16em',
  textTransform: 'uppercase' as const,
  color: MIST,
};

type NavCount = string | number | null | undefined;

type NavItemProps = {
  to?: string;
  href?: string;
  end?: boolean;
  label: string;
  /** Rendered element, so the sidebar can mix drawn marks with icon-set ones. */
  icon: React.ReactNode;
  count?: NavCount;
  countDot?: boolean;
};

function NavItem({ to, href, end, label, icon, count, countDot }: NavItemProps) {
  const renderInner = (isActive: boolean) => (
    <Box
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '8px 12px',
        borderRadius: 8,
        color: isActive ? SNOW : MIST,
        fontFamily: DISPLAY,
        fontSize: 13,
        fontWeight: isActive ? 500 : 400,
        backgroundColor: isActive ? '#0B1420' : 'transparent',
        borderLeft: `2px solid ${isActive ? CYAN : 'transparent'}`,
        transition: 'background-color 120ms, color 120ms',
        position: 'relative',
      }}
      onMouseEnter={(e) => {
        if (!isActive) {
          (e.currentTarget as HTMLElement).style.backgroundColor = '#0B1420';
          (e.currentTarget as HTMLElement).style.color = SNOW;
        }
      }}
      onMouseLeave={(e) => {
        if (!isActive) {
          (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent';
          (e.currentTarget as HTMLElement).style.color = MIST;
        }
      }}
    >
      <Box style={{ color: isActive ? CYAN : MIST, display: 'flex' }}>{icon}</Box>
      <span style={{ flex: 1 }}>{label}</span>
      {count !== undefined && count !== null && (
        <Box
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontFamily: "'Geist Mono', monospace",
            fontSize: 11,
            color: countDot ? MOSS : MIST,
          }}
        >
          {countDot && (
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                backgroundColor: MOSS,
                boxShadow: `0 0 6px ${MOSS}99`,
              }}
            />
          )}
          {count}
        </Box>
      )}
    </Box>
  );

  if (href) {
    return (
      <UnstyledButton
        component="a"
        href={href}
        target="_blank"
        rel="noreferrer"
        style={{ display: 'block', textDecoration: 'none' }}
      >
        {renderInner(false)}
      </UnstyledButton>
    );
  }

  return (
    <RouterNavLink to={to!} end={end} style={{ textDecoration: 'none', display: 'block' }}>
      {({ isActive }) => renderInner(isActive)}
    </RouterNavLink>
  );
}

/** Chip shell shared by the version / GitHub / support pills in the topbar. */
function TopChip({
  href,
  title,
  bg = CARD,
  border = HAIRLINE,
  padding = '0 11px',
  children,
}: {
  href?: string;
  title?: string;
  bg?: string;
  border?: string;
  padding?: string;
  children: React.ReactNode;
}) {
  const body = (
    <Box
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        height: 32,
        padding,
        borderRadius: 8,
        backgroundColor: bg,
        border: `1px solid ${border}`,
        textDecoration: 'none',
      }}
    >
      {children}
    </Box>
  );
  if (!href) return body;
  return (
    <UnstyledButton
      component="a"
      href={href}
      target="_blank"
      rel="noreferrer"
      title={title}
      style={{ textDecoration: 'none' }}
    >
      {body}
    </UnstyledButton>
  );
}

/**
 * Borderless 32x32 icon link in the channel's own brand colour. Renders even
 * when this install hasn't been given a URL yet: the topbar keeps its shape,
 * the icon just doesn't navigate until `community.ts` is filled in.
 */
function IconLink({ href, title, children }: {
  href: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <UnstyledButton
      component="a"
      href={href || undefined}
      target={href ? '_blank' : undefined}
      rel="noreferrer"
      title={title}
      aria-label={title}
      style={{
        width: 32,
        height: 32,
        borderRadius: 8,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {children}
    </UnstyledButton>
  );
}

function Separator() {
  return <Box style={{ width: 1, height: 18, backgroundColor: HAIRLINE, flexShrink: 0 }} />;
}

// Breadcrumb i18n keys per pathname. Resolved via t() at render-time so the
// strings track the active locale. Anything not in this map falls back to a
// generic uppercase-from-pathname formatter (see breadcrumb derivation).
const BREADCRUMB_KEYS: Record<string, string> = {
  '/': 'breadcrumb.dashboard',
  '/users': 'breadcrumb.users',
  '/profiles': 'breadcrumb.profiles',
  '/squads': 'breadcrumb.squads',
  '/hosts': 'breadcrumb.hosts',
  '/nodes': 'breadcrumb.nodes',
  '/subscription/metadata': 'breadcrumb.subscriptionMetadata',
  '/subscription/routes': 'breadcrumb.subscriptionRoutes',
  '/subscription/delivery': 'breadcrumb.subscriptionDelivery',
  '/insights': 'breadcrumb.insights',
  '/settings': 'breadcrumb.settings',
};

export function AppLayout() {
  // The topbar renders facts published by the page below it, so the provider
  // has to sit above both.
  return (
    <PageMetaProvider>
      <AppLayoutInner />
    </PageMetaProvider>
  );
}

function AppLayoutInner() {
  const [opened, { toggle: _toggle }] = useDisclosure();
  void _toggle;
  void opened;
  const navigate = useNavigate();
  const { pathname } = useLocation();
  // F13 - select individual slices instead of the whole store object, so an
  // unrelated store update doesn't re-render the entire layout.
  const admin = useAuth((s) => s.admin);
  const clearSession = useAuth((s) => s.clearSession);
  const qc = useQueryClient();
  const brandName = useBrandName();
  const { t } = useTranslation();
  const facts = usePageMetaFacts();

  // Wave-14 #18: single dashQuery feeds every sidebar count. Pre-wave we
  // fired 4 separate count queries (users/profiles/squads/nodes) each
  // pulling full row payloads only to call .length on the client, on every
  // page transition for every signed-in admin. The dashboard response now
  // carries `inventory.{profileCount,squadCount}` alongside the existing
  // users.total and system.{total,online}NodeCount, all from the same
  // Redis-cached blob.
  const dashQuery = useOverview();

  // ROADMAP D1: update-available check. Cheap: the backend caches the GitHub
  // call for 6h, so a long staleTime + a couple of refetches a day is plenty.
  // The same response carries the repo's star count for the GitHub chip.
  const versionQuery = useQuery({
    queryKey: ['system', 'version'],
    queryFn: getSystemVersion,
    staleTime: 60 * 60 * 1000,
    refetchInterval: 6 * 60 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
  const update = versionQuery.data?.updateAvailable ? versionQuery.data : null;
  const stars = versionQuery.data?.stars ?? null;

  const userCount = dashQuery.data?.users.total;
  const profileCount = dashQuery.data?.inventory.profileCount;
  const squadCount = dashQuery.data?.inventory.squadCount;
  const hostCount = dashQuery.data?.inventory.hostCount;
  const nodesTotal = dashQuery.data?.system.totalNodeCount;
  const nodesOnline = dashQuery.data?.system.onlineNodeCount ?? nodesTotal;

  function handleLogout() {
    clearSession();
    // Drop cached queries, otherwise next admin on this browser sees the
    // previous session's data flash before refetch.
    qc.clear();
    navigate('/login', { replace: true });
  }

  // Detail routes fall back to their section's crumb, otherwise the raw path
  // lands in the topbar and a uuid becomes the page title. Walk from the
  // longest prefix down, so /subscription/delivery/new finds the two-segment
  // key the same way /squads/:id finds its one-segment one.
  const breadcrumbKey = (() => {
    const parts = pathname.split('/').filter(Boolean);
    // The root has no segments, so the loop below never runs for it and the
    // dashboard fell through to the fallback, printing a bare slash.
    if (parts.length === 0) return BREADCRUMB_KEYS['/'];
    for (let n = parts.length; n > 0; n--) {
      const key = BREADCRUMB_KEYS[`/${parts.slice(0, n).join('/')}`];
      if (key) return key;
    }
    return undefined;
  })();
  const breadcrumb = breadcrumbKey
    ? t(breadcrumbKey)
    : `/ ${pathname.replace('/', '').toUpperCase()}`;
  const crumbLine = [breadcrumb, ...facts].join(' · ');

  return (
    <AppShell
      header={{ height: 76 }}
      navbar={{ width: 240, breakpoint: 'sm', collapsed: { mobile: false } }}
      padding={0}
      styles={{
        main: { backgroundColor: GROUND, minHeight: '100vh' },
        header: {
          backgroundColor: GROUND,
          borderBottom: `1px solid ${HAIRLINE}`,
        },
        navbar: {
          backgroundColor: GROUND,
          borderRight: `1px solid ${HAIRLINE}`,
          padding: 0,
        },
      }}
    >
      <AppShell.Header>
        <Box
          style={{
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            padding: '0 28px',
            gap: 24,
          }}
        >
          {/* Brand + where you are. The brand sits here rather than in the
              sidebar so the nav starts with the account and the panel reads
              as one wide header. */}
          <Box style={{ display: 'flex', alignItems: 'center', gap: 14, flex: 1, minWidth: 0 }}>
            <Box style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <Box
                style={{
                  width: 17,
                  height: 17,
                  background: `linear-gradient(135deg, ${CYAN}, ${CYAN2})`,
                  transform: 'rotate(45deg)',
                  borderRadius: 4,
                  boxShadow: `0 0 14px ${CYAN}66`,
                  flexShrink: 0,
                }}
              />
              <Text
                style={{
                  fontFamily: DISPLAY,
                  fontWeight: 500,
                  fontSize: 16,
                  lineHeight: '20px',
                  color: SNOW,
                }}
              >
                {brandName.toLowerCase()}
              </Text>
            </Box>
            <Separator />
            <Text style={{ ...MONO_LABEL, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {crumbLine}
            </Text>
          </Box>

          <Box style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {/* Version chip. Turns cyan and links to the release notes when a
                newer tag exists, which is the whole point of the D1 check. */}
            {update ? (
              <TopChip
                href={update.releaseUrl ?? undefined}
                title={t('sidebar.updateAvailable', { version: update.latest })}
                border={`${CYAN}55`}
              >
                <Box
                  component="span"
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    backgroundColor: CYAN2,
                    boxShadow: `0 0 6px ${CYAN2}`,
                  }}
                />
                <Text
                  style={{
                    fontFamily: "'Geist Mono', monospace",
                    fontSize: 11,
                    fontWeight: 500,
                    letterSpacing: '0.04em',
                    color: CYAN2,
                  }}
                >
                  v{__APP_VERSION__}
                </Text>
              </TopChip>
            ) : (
              <TopChip>
                <Text
                  style={{
                    fontFamily: "'Geist Mono', monospace",
                    fontSize: 11,
                    fontWeight: 500,
                    letterSpacing: '0.04em',
                    color: MIST,
                  }}
                >
                  v{__APP_VERSION__}
                </Text>
              </TopChip>
            )}

            <Separator />

            {/* Project links. An AGPL panel in public alpha lives or dies by
                people finding the repo, so the way there is in the product.
                Always rendered, so the topbar looks the same on every install
                whether or not a given channel has a URL yet. */}
            <Box style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <IconLink href={TELEGRAM_URL} title="Telegram">
                <TelegramIcon />
              </IconLink>
              <IconLink href={DISCORD_URL} title="Discord">
                <DiscordIcon />
              </IconLink>
              <TopChip href={GITHUB_URL} title="GitHub">
                <GithubIcon />
                {stars !== null && (
                  <>
                    <StarIcon />
                    <Text
                      style={{
                        fontFamily: "'Geist Mono', monospace",
                        fontSize: 12,
                        fontWeight: 700,
                        letterSpacing: '0.02em',
                        lineHeight: '16px',
                        color: AMBER,
                      }}
                    >
                      {stars}
                    </Text>
                  </>
                )}
              </TopChip>
            </Box>

            <TopChip
              href={SUPPORT_URL}
              title={t('topbar.support')}
              bg={`${ROSE}17`}
              border={`${ROSE}47`}
              padding="0 13px 0 14px"
            >
              <HeartIcon />
              <Text
                style={{
                  fontFamily: "'Geist Mono', monospace",
                  fontSize: 11,
                  fontWeight: 500,
                  letterSpacing: '0.12em',
                  lineHeight: '14px',
                  textTransform: 'uppercase',
                  color: ROSE,
                }}
              >
                {t('topbar.support')}
              </Text>
            </TopChip>
          </Box>
        </Box>
      </AppShell.Header>

      <AppShell.Navbar>
        <Stack justify="space-between" h="100%" gap={0}>
          <Stack gap={0}>
            {/* Signed in as */}
            <Box style={{ padding: '20px 16px 16px' }}>
              <Box
                style={{
                  padding: '10px 12px',
                  border: `1px solid ${HAIRLINE}`,
                  borderRadius: 8,
                  backgroundColor: CARD,
                }}
              >
                <Text style={{ ...MONO_LABEL, fontSize: 9, marginBottom: 4 }}>
                  {t('sidebar.signedInAs')}
                </Text>
                <Box style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Text
                    style={{
                      color: SNOW,
                      fontFamily: DISPLAY,
                      fontWeight: 500,
                      fontSize: 13,
                    }}
                  >
                    {admin?.username ?? 'admin'}
                  </Text>
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      backgroundColor: MOSS,
                      boxShadow: `0 0 6px ${MOSS}99`,
                    }}
                  />
                </Box>
              </Box>
            </Box>

            {/* Workspace group: core resources operators manage daily. Order
                follows the model: who gets access (users, squads) before what
                they get (profiles) before the metal it runs on (nodes). */}
            <Text style={{ ...MONO_LABEL, padding: '0 28px 8px' }}>{t('sidebar.workspace')}</Text>

            <Stack gap={2} px={8}>
              <NavItem to="/" end label={t('sidebar.home')} icon={<NavHomeIcon />} />
              <NavItem
                to="/users"
                label={t('sidebar.users')}
                icon={<NavUsersIcon />}
                count={userCount}
              />
              <NavItem
                to="/squads"
                label={t('sidebar.squads')}
                icon={<IconUsersGroup size={16} stroke={1.6} />}
                count={squadCount}
              />
              <NavItem
                to="/profiles"
                label={t('sidebar.profiles')}
                icon={<NavProfilesIcon />}
                count={profileCount}
              />
              <NavItem
                to="/hosts"
                label={t('sidebar.hosts')}
                icon={<NavHostsIcon />}
                count={hostCount}
              />
              <NavItem
                to="/nodes"
                label={t('sidebar.nodes')}
                icon={<NavNodesIcon />}
                count={
                  nodesTotal !== undefined && nodesOnline !== undefined
                    ? `${nodesOnline}/${nodesTotal}`
                    : nodesTotal
                }
                // LOW: green dot reflects ONLINE nodes, not just "nodes exist".
                // With 0 online the dot was misleadingly green (looks healthy).
                countDot={nodesOnline !== undefined && nodesOnline > 0}
              />
            </Stack>

            {/* Subscription group: everything that shapes the client-facing
                subscription URL: per-instance metadata + the delivery rules
                that pick a format per client. */}
            <Text style={{ ...MONO_LABEL, padding: '20px 28px 8px' }}>
              {t('sidebar.subscriptionGroup')}
            </Text>
            <Stack gap={2} px={8}>
              <NavItem
                to="/subscription/metadata"
                label={t('sidebar.subscriptionMetadata')}
                icon={<NavMetadataIcon />}
              />
              <NavItem
                to="/subscription/routes"
                label={t('sidebar.subscriptionRoutes')}
                icon={<NavRoutesIcon />}
              />
              <NavItem
                to="/subscription/delivery"
                label={t('sidebar.subscriptionDelivery')}
                icon={<NavDeliveryIcon />}
              />
            </Stack>

            {/* System group: observability + panel-wide config */}
            <Text style={{ ...MONO_LABEL, padding: '20px 28px 8px' }}>
              {t('sidebar.systemGroup')}
            </Text>
            <Stack gap={2} px={8}>
              <NavItem to="/insights" label={t('sidebar.insights')} icon={<NavInsightsIcon />} />
              <NavItem href="/admin/queues" label={t('sidebar.queues')} icon={<NavQueuesIcon />} />
            </Stack>
          </Stack>

          {/* Bottom: settings + sign out */}
          <Stack gap={2} px={8} pb={16} pt={8} style={{ borderTop: `1px solid ${HAIRLINE}` }}>
            <NavItem to="/settings" label={t('sidebar.settings')} icon={<NavSettingsIcon />} />
            <UnstyledButton
              onClick={handleLogout}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '8px 12px',
                borderRadius: 8,
                color: MIST,
                fontFamily: DISPLAY,
                fontSize: 13,
                borderLeft: '2px solid transparent',
                transition: 'background-color 120ms, color 120ms',
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.backgroundColor = '#0B1420';
                (e.currentTarget as HTMLElement).style.color = SNOW;
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent';
                (e.currentTarget as HTMLElement).style.color = MIST;
              }}
            >
              <NavLogoutIcon />
              <span>{t('sidebar.logout')}</span>
            </UnstyledButton>
          </Stack>
        </Stack>
      </AppShell.Navbar>

      <AppShell.Main>
        <Box style={{ padding: '32px 40px 48px' }}>
          {/* F4 - lazy-loaded pages suspend while their chunk loads. Scope the
              fallback to the content area so the sidebar/topbar stay put. */}
          <Suspense
            fallback={
              <Center style={{ minHeight: '60vh' }}>
                <Loader color="#7DD3FC" />
              </Center>
            }
          >
            <Outlet />
          </Suspense>
        </Box>
      </AppShell.Main>
    </AppShell>
  );
}
