import { Text } from '@mantine/core';
import type { RouteRule } from '@/lib/domain/routePolicies';
import { NEW_PRESET_ID, presetWrite } from '@/contours/traffic/lib/devicePresets';
import { presetRefusalWords } from '@/contours/traffic/lib/presetRefusal';
import { apiErrorMessage } from '@/lib/net/client';
import {
  createRoutingPreset,
  deleteRoutingPreset,
  routingPresetRefusal,
  updateRoutingPreset,
} from '@/lib/domain/routePolicies';
import { findShadows, seedRules, strip } from '@/contours/traffic/lib/devicePresetRules';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { RoutingPreset } from '@/lib/domain/routePolicies';

/**
 * The draft a device preset is edited as: its name, its rules in order, what is
 * dirty, which rows an earlier row already swallowed, and the save and delete
 * calls. A built-in preset is locked, and the flag travels with the draft.
 */
export function useDevicePresetForm(preset: RoutingPreset, onSaved?: (id?: string) => void) {
  const { t } = useTranslation();

  const qc = useQueryClient();
  // Счётчик ТОЛЬКО для строк, которые добавляет оператор: там мы в обработчике
  // события. Ключи пришедших с сервера строк детерминированы позицией, потому
  // что читать и увеличивать ref посреди рендера значит делать рендер нечистым.
  const nextKey = useRef(0);

  const initial = useMemo(() => seedRules(preset.rules), [preset]);
  const [name, setName] = useState(preset.name);
  const [rules, setRules] = useState<RouteRule[]>(initial);
  const [loadedFor, setLoadedFor] = useState(preset.id);
  const [dragging, setDragging] = useState<number | null>(null);
  // What the last save was refused for, at its place: entries in their rows,
  // a taken name at the name field (A-229).
  const [unknownEntries, setUnknownEntries] = useState<string[]>([]);
  const [nameError, setNameError] = useState<string | null>(null);

  if (loadedFor !== preset.id) {
    setLoadedFor(preset.id);
    setName(preset.name);
    setRules(seedRules(preset.rules));
    setDragging(null);
    setUnknownEntries([]);
    setNameError(null);
  }

  const locked = preset.builtIn;
  const write = locked ? null : presetWrite(preset, name, strip(rules), strip(initial));
  // A preset that has never been saved is dirty by definition, even straight
  // out of an imported file where nothing has been typed yet.
  const dirty = write !== null;
  const shadows = useMemo(() => findShadows(rules), [rules]);

  const saveMutation = useMutation({
    mutationFn: () => {
      if (!write) return Promise.resolve(null);
      return write.kind === 'create' ? createRoutingPreset(write.input) : updateRoutingPreset(preset.id, write.input);
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ['routing-presets'] });
      notifications.show({ color: 'green', message: t('routes.presetSaved') });
      onSaved?.(saved?.id);
    },
    onError: (err) => {
      const r = routingPresetRefusal(err);
      if (r?.code === 'ROUTING_PRESET_ENTRY_UNKNOWN' || r?.code === 'ROUTING_PRESET_GEO_TAG_UNKNOWN') setUnknownEntries(r.entries);
      if (r?.code === 'NAME_TAKEN') {
        // At the field, and nowhere else: one refusal, one place.
        setNameError(presetRefusalWords(r, t));
        return;
      }
      // Gone or built-in: the list the editor stands on is stale.
      if (r?.code === 'NOT_FOUND' || r?.code === 'ROUTING_PRESET_BUILT_IN') qc.invalidateQueries({ queryKey: ['routing-presets'] });
      notifications.show({
        color: 'red',
        title: t('common.saveError'),
        message: r ? presetRefusalWords(r, t) : apiErrorMessage(err),
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteRoutingPreset(preset.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['routing-presets'] });
      notifications.show({ color: 'green', message: t('routes.presetDeleted') });
      onSaved?.();
    },
    onError: (err) => {
      const r = routingPresetRefusal(err);
      if (r?.code === 'NOT_FOUND') qc.invalidateQueries({ queryKey: ['routing-presets'] });
      notifications.show({
        color: 'red',
        title: t('common.deleteError'),
        message: r ? presetRefusalWords(r, t) : apiErrorMessage(err),
      });
    },
  });

  function setRule(i: number, patch: Partial<RouteRule>) {
    // Правка строки: подсветка отказа про неё становится неверной, сервер
    // скажет заново на следующем сохранении.
    if (patch.match) setUnknownEntries([]);
    setRules((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }
  function addRule() {
    setRules((prev) => [...prev, { id: `new-${nextKey.current++}`, match: [], action: 'direct', note: '' }]);
  }
  function removeRule(i: number) {
    setRules((prev) => prev.filter((_, j) => j !== i));
  }
  function move(from: number, to: number) {
    if (from === to) return;
    setRules((prev) => {
      const next = [...prev];
      const [row] = next.splice(from, 1);
      next.splice(to, 0, row!);
      return next;
    });
  }
  function rename(value: string) {
    setNameError(null);
    setName(value);
  }

  function confirmDelete() {
    modals.openConfirmModal({
      title: t('routes.presetDeleteTitle', { name: preset.name }),
      children: <Text size="sm">{t('routes.presetDeleteBody')}</Text>,
      labels: { confirm: t('common.delete'), cancel: t('common.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: () => deleteMutation.mutate(),
    });
  }

  return {
    qc,
    nextKey,
    initial,
    locked,
    dirty,
    shadows,
    saveMutation,
    deleteMutation,
    setRule,
    addRule,
    removeRule,
    move,
    confirmDelete,
    name,
    setName: rename,
    nameError,
    unknownEntries,
    rules,
    setRules,
    loadedFor,
    setLoadedFor,
    dragging,
    setDragging,
    isNew: preset.id === NEW_PRESET_ID,
  };
}

/** Everything the preset editor hands to its sections. */
export type DevicePresetForm = ReturnType<typeof useDevicePresetForm>;
