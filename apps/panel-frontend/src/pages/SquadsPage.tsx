import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActionIcon,
  Button,
  Card,
  Group,
  Menu,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { PageHero } from '../components/PageHero';
import { PrimaryButton } from '../components/PrimaryButton';
import { useDisclosure } from '@mantine/hooks';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  IconDotsVertical,
  IconEdit,
  IconLink,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconShieldLock,
  IconTrash,
  IconUsers,
} from '@tabler/icons-react';
import {
  ALL_SQUAD_ID,
  createSquad,
  deleteSquad,
  listBindings,
  listCascades,
  listProfiles,
  listRoutePolicies,
  listSquads,
  updateSquad,
  type CreateSquadInput,
  type Squad,
  type UpdateSquadInput,
} from '../lib/api';
import { SquadFormModal } from '../components/SquadFormModal';

export function SquadsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [createOpen, { open: openCreate, close: closeCreate }] = useDisclosure(false);
  const [editing, setEditing] = useState<Squad | null>(null);
  const [search, setSearch] = useState('');

  const squadsQuery = useQuery({ queryKey: ['squads'], queryFn: listSquads });
  const profilesQuery = useQuery({ queryKey: ['profiles'], queryFn: () => listProfiles() });
  const bindingsQuery = useQuery({ queryKey: ['bindings'], queryFn: () => listBindings() });
  // A4 increment 2 - balancer cascades for the per-squad exit allow-list.
  const cascadesQuery = useQuery({ queryKey: ['cascades'], queryFn: listCascades });
  // A4 ad-split - route-policies the squad can grant.
  const policiesQuery = useQuery({ queryKey: ['route-policies'], queryFn: listRoutePolicies });

  const createMutation = useMutation({
    mutationFn: createSquad,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['squads'] });
      notifications.show({ color: 'green', message: t('squads.notify.created') });
    },
    onError: (err) =>
      notifications.show({
        color: 'red',
        title: t('common.createError'),
        message: err instanceof Error ? err.message : String(err),
      }),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateSquadInput }) =>
      updateSquad(id, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['squads'] });
      notifications.show({ color: 'green', message: t('squads.notify.updated') });
    },
    onError: (err) =>
      notifications.show({
        color: 'red',
        title: t('common.saveError'),
        message: err instanceof Error ? err.message : String(err),
      }),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteSquad,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['squads'] });
      notifications.show({ color: 'green', message: t('squads.notify.deleted') });
    },
    onError: (err) =>
      notifications.show({
        color: 'red',
        title: t('common.deleteError'),
        message: err instanceof Error ? err.message : String(err),
      }),
  });

  function handleCreate(input: CreateSquadInput | UpdateSquadInput): Promise<void> {
    return createMutation.mutateAsync(input as CreateSquadInput).then(() => undefined);
  }

  function handleUpdate(input: CreateSquadInput | UpdateSquadInput): Promise<void> {
    if (!editing) return Promise.resolve();
    return updateMutation
      .mutateAsync({ id: editing.id, input: input as UpdateSquadInput })
      .then(() => undefined);
  }

  function handleDelete(squad: Squad) {
    modals.openConfirmModal({
      title: t('squads.deleteTitle', { name: squad.name }),
      children: (
        <Text size="sm">
          {t('squads.deleteBody')}
        </Text>
      ),
      labels: { confirm: t('common.delete'), cancel: t('common.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: () => deleteMutation.mutate(squad.id),
    });
  }

  const squads = squadsQuery.data?.squads ?? [];
  const profiles = profilesQuery.data?.profiles ?? [];
  const cascades = cascadesQuery.data?.cascades ?? [];
  const routePolicies = policiesQuery.data?.policies ?? [];
  const bindingsByProfile = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of bindingsQuery.data?.bindings ?? []) {
      m.set(b.profileId, (m.get(b.profileId) ?? 0) + 1);
    }
    return m;
  }, [bindingsQuery.data]);

  const filteredSquads = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return squads;
    return squads.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.description?.toLowerCase().includes(q) ?? false),
    );
  }, [squads, search]);

  // Pin "All" first, then alphabetical.
  const sortedSquads = useMemo(() => {
    const all: Squad[] = [];
    const others: Squad[] = [];
    for (const s of filteredSquads) {
      if (s.id === ALL_SQUAD_ID) all.push(s);
      else others.push(s);
    }
    others.sort((a, b) => a.name.localeCompare(b.name));
    return [...all, ...others];
  }, [filteredSquads]);

  return (
    <Stack gap="lg">
      <PageHero
        eyebrow={t('pageHero.squadsEyebrow', {
          count: squads.length,
          label: squads.length === 1 ? t('pageHero.squadsLabelOne') : t('pageHero.squadsLabelMany'),
        })}
        title={t('squads.title')}
        subtitle={t('squads.subtitle')}
        right={
          <Group gap={8}>
            <Tooltip label={t('common.refresh')}>
              <ActionIcon
                variant="subtle"
                size="lg"
                loading={squadsQuery.isFetching}
                onClick={() => qc.invalidateQueries({ queryKey: ['squads'] })}
                style={{ color: '#7A8BA3' }}
              >
                <IconRefresh size={18} />
              </ActionIcon>
            </Tooltip>
            <PrimaryButton leftSection={<IconPlus size={14} />} onClick={openCreate}>
              {t('squads.create')}
            </PrimaryButton>
          </Group>
        }
      />

      <TextInput
        placeholder={t('squads.searchPlaceholder')}
        leftSection={<IconSearch size={16} color="#7A8BA3" />}
        value={search}
        onChange={(e) => setSearch(e.currentTarget.value)}
        styles={{
          input: { backgroundColor: '#0F1A28', borderColor: '#1C2A3D', color: '#C8D4E3' },
        }}
      />

      {sortedSquads.length === 0 ? (
        <Card withBorder padding="xl" radius="md">
          <Stack align="center" gap="sm">
            <ThemeIcon size={48} radius="md" variant="light" color="gray">
              <IconUsers size={24} />
            </ThemeIcon>
            <Text c="dimmed" size="sm">
              {squads.length === 0 ? t('squads.empty') : t('common.nothingFound')}
            </Text>
          </Stack>
        </Card>
      ) : (
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3, xl: 4 }} spacing="md">
          {sortedSquads.map((squad) => (
            <SquadCard
              key={squad.id}
              squad={squad}
              onEdit={() => setEditing(squad)}
              onDelete={() => handleDelete(squad)}
            />
          ))}
        </SimpleGrid>
      )}

      <SquadFormModal
        opened={createOpen}
        onClose={closeCreate}
        squad={null}
        profiles={profiles} bindingsByProfile={bindingsByProfile} cascades={cascades} routePolicies={routePolicies}
        onSubmit={handleCreate}
        loading={createMutation.isPending}
      />

      <SquadFormModal
        opened={editing !== null}
        onClose={() => setEditing(null)}
        squad={editing}
        profiles={profiles} bindingsByProfile={bindingsByProfile} cascades={cascades} routePolicies={routePolicies}
        onSubmit={handleUpdate}
        loading={updateMutation.isPending}
      />
    </Stack>
  );
}

// ───── Squad card ─────

function SquadCard({
  squad,
  onEdit,
  onDelete,
}: {
  squad: Squad;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const isAll = squad.id === ALL_SQUAD_ID;
  const profileCount = squad.profileIds.length;
  const memberCount = squad.memberCount;
  // The "All" squad is seeded in English from a migration. Override the
  // displayed name/description with i18n so RU users don't see English text.
  const displayName = isAll ? t('squads.allDefaultName') : squad.name;
  const displayDescription = isAll
    ? t('squads.allDefaultDescription')
    : squad.description;

  return (
    <Card
      withBorder
      padding="md"
      radius="md"
      style={{
        // Top accent bar - teal for All, indigo for others
        borderTopWidth: 3,
        borderTopColor: isAll
          ? 'var(--mantine-color-teal-6)'
          : 'var(--mantine-color-indigo-6)',
      }}
    >
      <Group justify="space-between" align="flex-start" wrap="nowrap" mb="md">
        <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
          <ThemeIcon
            size={36}
            radius="md"
            variant="light"
            color={isAll ? 'teal' : 'indigo'}
          >
            <IconLink size={18} />
          </ThemeIcon>
          <Stack gap={0} style={{ minWidth: 0 }}>
            <Group gap={6} wrap="nowrap">
              <Text fw={700} size="sm" truncate>
                {displayName}
              </Text>
              {isAll && (
                <Tooltip label={t('squadForm.builtinSystemTooltip')}>
                  <IconShieldLock size={13} color="var(--mantine-color-yellow-6)" />
                </Tooltip>
              )}
            </Group>
            {displayDescription && (
              <Text size="xs" c="dimmed" lineClamp={1}>
                {displayDescription}
              </Text>
            )}
          </Stack>
        </Group>

        <Menu shadow="md" position="bottom-end" withinPortal>
          <Menu.Target>
            <ActionIcon variant="subtle" color="gray" size="sm">
              <IconDotsVertical size={14} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item leftSection={<IconEdit size={14} />} onClick={onEdit}>
              {isAll ? t('squads.open') : t('common.edit')}
            </Menu.Item>
            <Menu.Item
              color="red"
              leftSection={<IconTrash size={14} />}
              disabled={isAll}
              onClick={onDelete}
            >
              {t('common.delete')}
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </Group>

      {/* Counts */}
      <Group gap="xs" mb="md">
        <CountBadge
          icon={<IconLink size={12} />}
          value={profileCount}
          color="indigo"
          tooltip={t('squads.form.profiles')}
        />
        <CountBadge
          icon={<IconUsers size={12} />}
          value={memberCount}
          color="blue"
          tooltip={t('squads.form.membersBadge')}
        />
      </Group>

      <Button
        variant="light"
        color={isAll ? 'teal' : 'indigo'}
        fullWidth
        leftSection={<IconEdit size={14} />}
        onClick={onEdit}
      >
        {isAll ? t('squads.open') : t('common.edit')}
      </Button>
    </Card>
  );
}

function CountBadge({
  icon,
  value,
  color,
  tooltip,
}: {
  icon: React.ReactNode;
  value: number;
  color: string;
  tooltip: string;
}) {
  return (
    <Tooltip label={tooltip}>
      <Paper
        withBorder
        px="xs"
        py={4}
        radius="sm"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
      >
        <ThemeIcon variant="subtle" color={color} size="xs">
          {icon}
        </ThemeIcon>
        <Text size="xs" fw={600} ff="monospace">
          {value}
        </Text>
      </Paper>
    </Tooltip>
  );
}
