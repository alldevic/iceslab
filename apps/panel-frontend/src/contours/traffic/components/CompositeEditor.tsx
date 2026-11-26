import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Box, Checkbox, Select, Stack, Text, Textarea, TextInput, UnstyledButton } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery } from '@tanstack/react-query';
import { GEO_SET_KINDS } from '@iceslab/shared';
import {
  createCompositeGeoSet,
  geoSetRefusal,
  getGeoTags,
  updateCompositeGeoSet,
  type GeoSet,
  type GeoSetKind,
} from '@/lib/domain/geoSets';
import { geoNameProblem } from '@/contours/traffic/lib/geoFacts';
import {
  buildDefinition,
  checkDrafts,
  definitionReady,
  draftFromCategory,
  locateRefusal,
  newDraft,
  sourceChoices,
  type CategoryDraft,
  type DraftFault,
  type DraftProblem,
} from '@/contours/traffic/lib/geoComposite';
import { useGeoSets } from '@/contours/traffic/lib/useGeoSets';
import { CARD, DIM, DISPLAY, FAINT, HAIRLINE, MIST, MONO, RED, SNOW, WELL } from '@/contours/traffic/lib/colors';
import { FieldNote, GhostButton, Label } from './GeoFields';

/**
 * Редактор категорий составного набора (веха 10.3). Простой: список категорий,
 * у каждой имя, включение, ссылки «набор + категория», многострочные ручные
 * записи и исключения. Что отправлять и что проверить до отправки решает
 * `lib/geoComposite.ts`; здесь только вёрстка и запросы.
 */

interface Refusal {
  message: string;
  fault: DraftFault | null;
}

/** Выбор категории источника: набор из списка, тег поиском по `GET /tags`. Не `GeoTagHint`: тот привязан к строке правила. */
function RefPicker({
  sources,
  onAdd,
}: {
  sources: GeoSet[];
  onAdd: (ref: { set: string; tag: string }) => void;
}) {
  const { t } = useTranslation();
  const [setName, setSetName] = useState<string | null>(null);
  const [tag, setTag] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [dq] = useDebouncedValue(q, 250);
  const source = sources.find((s) => s.name === setName);
  const tags = useQuery({
    queryKey: ['geo-tags', source?.id, dq],
    queryFn: () => getGeoTags(source!.id, dq, 20),
    enabled: !!source && !!source.current,
    staleTime: 60_000,
  });
  const data = (tags.data?.tags ?? []).map((x) => ({ value: x.name, label: `${x.name} · ${t('geoSets.hint.entries', { count: x.entries })}` }));

  return (
    <Box style={{ display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
      <Stack gap={4} style={{ width: 180 }}>
        <Label>{t('geoSets.composite.refSet')}</Label>
        <Select
          data={sources.map((s) => s.name)}
          value={setName}
          placeholder={sources.length === 0 ? t('geoSets.composite.noSources') : undefined}
          disabled={sources.length === 0}
          onChange={(v) => {
            setSetName(v);
            setTag(null);
            setQ('');
          }}
        />
      </Stack>
      <Stack gap={4} style={{ width: 240 }}>
        <Label>{t('geoSets.composite.refTag')}</Label>
        <Select
          data={data}
          value={tag}
          searchable
          // Ищет сервер, а не список на странице: тегов тысячи.
          filter={({ options }) => options}
          searchValue={q}
          onSearchChange={setQ}
          disabled={!source || !source.current}
          nothingFoundMessage={t('geoSets.hint.noTags', { q })}
          onChange={setTag}
        />
      </Stack>
      <GhostButton
        disabled={!setName || !tag}
        onClick={() => {
          if (!setName || !tag) return;
          onAdd({ set: setName, tag });
          setTag(null);
          setQ('');
        }}
      >
        {t('geoSets.composite.refAdd')}
      </GhostButton>
      {source && !source.current && (
        <Text style={{ fontFamily: DISPLAY, fontSize: 11, color: MIST, flexBasis: '100%' }}>
          {t('geoSets.hint.noCurrent', { name: source.name })}
        </Text>
      )}
    </Box>
  );
}

function CategoryCard({
  draft,
  kind,
  sources,
  problems,
  fault,
  faultMessage,
  onChange,
  onRemove,
}: {
  draft: CategoryDraft;
  kind: GeoSetKind;
  sources: GeoSet[];
  problems: DraftProblem[];
  fault: DraftFault | null;
  faultMessage: string | null;
  onChange: (next: CategoryDraft) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const nameProblem = problems.find((p) => p.startsWith('name-'));
  const refProblems = problems.filter((p) => !p.startsWith('name-'));
  // Серверный отказ показывается у поля, где запись; без поля это общая ошибка категории.
  const at = (f: DraftFault['field']) => (fault && fault.field === f ? faultMessage : null);
  const refsFault = at('ref');
  return (
    <Stack
      gap={10}
      style={{
        padding: '12px 14px',
        borderRadius: 10,
        backgroundColor: WELL,
        border: `1px solid ${fault || problems.length > 0 ? `${RED}66` : HAIRLINE}`,
      }}
    >
      <Box style={{ display: 'flex', alignItems: 'flex-end', gap: 12 }}>
        <Stack gap={4} style={{ width: 220 }}>
          <Label>{t('geoSets.composite.name')}</Label>
          <TextInput
            value={draft.name}
            onChange={(e) => onChange({ ...draft, name: e.currentTarget.value })}
            error={nameProblem ? t(`geoSets.composite.problem.${nameProblem}`) : at('name')}
          />
        </Stack>
        <Checkbox
          label={t('geoSets.composite.enabled')}
          checked={draft.enabled}
          onChange={(e) => onChange({ ...draft, enabled: e.currentTarget.checked })}
          style={{ paddingBottom: 6 }}
        />
        <Box style={{ flex: 1 }} />
        <GhostButton onClick={onRemove}>{t('geoSets.composite.removeCategory')}</GhostButton>
      </Box>

      <Stack gap={6}>
        <Label>{t('geoSets.composite.refs')}</Label>
        {draft.refs.length === 0 && <Text style={{ fontFamily: DISPLAY, fontSize: 11, color: FAINT }}>{t('geoSets.composite.refsNone')}</Text>}
        <Box style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {draft.refs.map((r, i) => (
            <UnstyledButton
              key={`${r.set}:${r.tag}:${i}`}
              type="button"
              title={t('geoSets.composite.refRemove')}
              onClick={() => onChange({ ...draft, refs: draft.refs.filter((_, j) => j !== i) })}
              style={{
                padding: '3px 8px',
                borderRadius: 6,
                border: `1px solid ${fault?.field === 'ref' && fault.entry?.toLowerCase() === `${r.set}:${r.tag}`.toLowerCase() ? RED : HAIRLINE}`,
                backgroundColor: CARD,
                fontFamily: MONO,
                fontSize: 11,
                color: SNOW,
              }}
            >
              {r.set}:{r.tag} ×
            </UnstyledButton>
          ))}
        </Box>
        <RefPicker sources={sources} onAdd={(ref) => onChange({ ...draft, refs: [...draft.refs, ref] })} />
        {refProblems.map((p) => (
          <FieldNote key={p} tone={RED}>
            {t(`geoSets.composite.problem.${p}`)}
          </FieldNote>
        ))}
        {refsFault && <FieldNote tone={RED}>{refsFault}</FieldNote>}
      </Stack>

      <Box style={{ display: 'flex', gap: 12 }}>
        <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
          <Label>{t('geoSets.composite.manual')}</Label>
          <Textarea
            autosize
            minRows={3}
            maxRows={10}
            value={draft.manualText}
            placeholder={t(kind === 'geosite' ? 'geoSets.composite.manualSite' : 'geoSets.composite.manualIp')}
            onChange={(e) => onChange({ ...draft, manualText: e.currentTarget.value })}
            error={at('manual')}
            styles={{ input: { fontFamily: MONO, fontSize: 12 } }}
          />
        </Stack>
        <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
          <Label>{t('geoSets.composite.exclude')}</Label>
          <Textarea
            autosize
            minRows={3}
            maxRows={10}
            value={draft.excludeText}
            placeholder={t(kind === 'geosite' ? 'geoSets.composite.excludeSite' : 'geoSets.composite.excludeIp')}
            onChange={(e) => onChange({ ...draft, excludeText: e.currentTarget.value })}
            error={at('exclude')}
            styles={{ input: { fontFamily: MONO, fontSize: 12 } }}
          />
        </Stack>
      </Box>
      {/* Отказ с категорией, но без поля (запись не нашлась в черновике). */}
      {fault && fault.field === null && faultMessage && <FieldNote tone={RED}>{faultMessage}</FieldNote>}
    </Stack>
  );
}

/** Список категорий и «добавить категорию». Черновики держит вызывающий. */
function CategoryList({
  kind,
  selfName,
  drafts,
  setDrafts,
  refusal,
  onEdited,
}: {
  kind: GeoSetKind;
  selfName: string;
  drafts: CategoryDraft[];
  setDrafts: (next: CategoryDraft[]) => void;
  refusal: Refusal | null;
  onEdited: () => void;
}) {
  const { t } = useTranslation();
  const { byName } = useGeoSets();
  const sources = sourceChoices(byName.values(), kind, selfName);
  const problems = checkDrafts(selfName, drafts);
  const update = (next: CategoryDraft[]) => {
    setDrafts(next);
    onEdited();
  };
  return (
    <Stack gap={10}>
      {drafts.map((d) => (
        <CategoryCard
          key={d.key}
          draft={d}
          kind={kind}
          sources={sources}
          problems={problems.get(d.key) ?? []}
          fault={refusal?.fault?.key === d.key ? refusal.fault : null}
          faultMessage={refusal?.message ?? null}
          onChange={(next) => update(drafts.map((x) => (x.key === d.key ? next : x)))}
          onRemove={() => update(drafts.filter((x) => x.key !== d.key))}
        />
      ))}
      <Box>
        <GhostButton onClick={() => update([...drafts, newDraft()])}>{t('geoSets.composite.addCategory')}</GhostButton>
      </Box>
    </Stack>
  );
}

/** Ответ сервера после сохранения: сборка шла в самом запросе, итог сразу. */
function showBuilt(set: GeoSet, t: (k: string, o?: Record<string, unknown>) => string) {
  notifications.show(
    set.status === 'verified'
      ? { color: 'green', message: t('geoSets.composite.built', { name: set.name }) }
      : { color: 'red', title: t('geoSets.composite.notBuilt', { name: set.name }), message: set.error ?? t('geoSets.noError'), autoClose: 15000 },
  );
}

/** Отказ определения привязывается к категории; остальные отказы идут как у остальных панелей. */
function useRefusal(drafts: CategoryDraft[], onRefusal: (err: unknown) => void) {
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const handle = (err: unknown) => {
    const r = geoSetRefusal(err);
    if (r?.code === 'GEO_SET_INVALID' && r.reason === 'composite') {
      setRefusal({ message: r.message ?? r.reason, fault: locateRefusal(drafts, r.at) });
    } else {
      onRefusal(err);
    }
  };
  return { refusal, setRefusal, handle };
}

/** Третий режим добавления: имя, вид и категории. Видов два, и у каждого свой набор: домены и адреса вместе не бывают. */
export function AddCompositePanel({
  onDone,
  onCancel,
  onRefusal,
}: {
  onDone: () => void;
  onCancel: () => void;
  onRefusal: (err: unknown) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<GeoSetKind>('geosite');
  const [drafts, setDrafts] = useState<CategoryDraft[]>(() => [newDraft()]);
  const nameProblem = geoNameProblem(name.trim());
  const { refusal, setRefusal, handle } = useRefusal(drafts, onRefusal);

  const create = useMutation({
    mutationFn: () => createCompositeGeoSet({ name: name.trim(), kind, categories: buildDefinition(drafts) }),
    onSuccess: (set) => {
      showBuilt(set, t);
      onDone();
    },
    onError: handle,
  });

  return (
    <Stack gap={10} style={{ padding: '14px 16px', borderRadius: 10, backgroundColor: CARD, border: `1px solid ${HAIRLINE}` }}>
      <Box style={{ display: 'flex', alignItems: 'flex-end', gap: 12 }}>
        <Stack gap={4} style={{ width: 200 }}>
          <Label>{t('geoSets.uploadName')}</Label>
          <TextInput
            value={name}
            onChange={(e) => {
              setName(e.currentTarget.value);
              setRefusal(null);
            }}
            error={name && nameProblem ? t(`geoSets.name.${nameProblem}`) : undefined}
          />
        </Stack>
        <Stack gap={4} style={{ width: 130 }}>
          <Label>{t('geoSets.uploadKind')}</Label>
          <Select
            data={[...GEO_SET_KINDS]}
            value={kind}
            allowDeselect={false}
            onChange={(v) => {
              if (!v || v === kind) return;
              setKind(v as GeoSetKind);
              // Ссылки прежнего вида в новом не годятся.
              setDrafts(drafts.map((d) => ({ ...d, refs: [] })));
              setRefusal(null);
            }}
          />
        </Stack>
        <Box style={{ flex: 1 }} />
        <GhostButton onClick={onCancel}>{t('common.cancel')}</GhostButton>
        <GhostButton
          disabled={nameProblem !== null || !definitionReady(name.trim(), drafts) || create.isPending}
          onClick={() => create.mutate()}
        >
          {create.isPending ? t('geoSets.composite.saving') : t('geoSets.addAction')}
        </GhostButton>
      </Box>
      <CategoryList
        kind={kind}
        selfName={name.trim()}
        drafts={drafts}
        setDrafts={setDrafts}
        refusal={refusal}
        onEdited={() => setRefusal(null)}
      />
      {refusal && !refusal.fault && <FieldNote tone={RED}>{refusal.message}</FieldNote>}
      <Text style={{ fontFamily: DISPLAY, fontSize: 11, lineHeight: '16px', color: FAINT }}>{t('geoSets.composite.hint')}</Text>
    </Stack>
  );
}

/** Правка определения составного набора; сохранение пересобирает файл. */
export function EditCompositePanel({
  set,
  onDone,
  onCancel,
  onRefusal,
}: {
  set: GeoSet;
  onDone: () => void;
  onCancel: () => void;
  onRefusal: (err: unknown) => void;
}) {
  const { t } = useTranslation();
  const [drafts, setDrafts] = useState<CategoryDraft[]>(() =>
    set.source.type === 'composite' ? set.source.categories.map(draftFromCategory) : [],
  );
  const { refusal, setRefusal, handle } = useRefusal(drafts, onRefusal);

  const save = useMutation({
    mutationFn: () => updateCompositeGeoSet(set.id, buildDefinition(drafts)),
    onSuccess: (next) => {
      showBuilt(next, t);
      onDone();
    },
    onError: handle,
  });

  return (
    <Stack gap={10} style={{ padding: '14px 16px', borderRadius: 10, backgroundColor: CARD, border: `1px solid ${HAIRLINE}` }}>
      <Box style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <Text style={{ fontFamily: DISPLAY, fontSize: 13, color: SNOW }}>{t('geoSets.composite.editTitle', { name: set.name })}</Text>
        <Text style={{ fontFamily: MONO, fontSize: 10, color: DIM }}>{set.kind}</Text>
        <Box style={{ flex: 1 }} />
        <GhostButton onClick={onCancel}>{t('common.cancel')}</GhostButton>
        <GhostButton disabled={!definitionReady(set.name, drafts) || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? t('geoSets.composite.saving') : t('geoSets.composite.save')}
        </GhostButton>
      </Box>
      <CategoryList
        kind={set.kind}
        selfName={set.name}
        drafts={drafts}
        setDrafts={setDrafts}
        refusal={refusal}
        onEdited={() => setRefusal(null)}
      />
      {refusal && !refusal.fault && <FieldNote tone={RED}>{refusal.message}</FieldNote>}
      <Text style={{ fontFamily: DISPLAY, fontSize: 11, lineHeight: '16px', color: FAINT }}>{t('geoSets.composite.editHint')}</Text>
    </Stack>
  );
}
