import { ActionSelect } from '@/contours/traffic/components/RoutePolicy/ActionSelect';
import { Box, Text, TextInput, UnstyledButton } from '@mantine/core';
import { CYAN, DIM, DISPLAY, EDGE, FAINT, HAIRLINE, MONO, RED, SHADOW_BG, SHADOW_INK, SHADOW_NOTE, SNOW, WELL } from '@/contours/traffic/lib/colors';
import { PlusIcon, TrashIcon } from '@/contours/traffic/components/RoutePolicy/icons';
import { IconAction } from '@/contours/traffic/components/RoutePolicy/IconAction';
import { POLICY_ACTIONS, splitMatch } from '@/contours/traffic/lib/routeRules';
import { useTranslation } from 'react-i18next';
import { Fragment, useState } from 'react';
import { unknownInMatch } from '@/lib/domain/routePolicies';
import { GeoTagHint } from '@/contours/traffic/components/GeoTagHint';
import type { RoutePolicyForm } from '@/contours/traffic/components/RoutePolicy/useRoutePolicyForm';

/**
 * The editable rows of a route policy (entry): what each row matches and
 * whether it is blocked or sent directly, and whether another row already
 * decides it. Exactly what the server stores (A-151): two actions, no row
 * order (block is always above direct on the node), no notes.
 */
export function RulesList({
  shadows,
  setRule,
  addRule,
  removeRule,
  rules,
  unknownEntries,
  onOpenNodePolicies,
}: Pick<RoutePolicyForm, 'shadows' | 'setRule' | 'addRule' | 'removeRule' | 'rules' | 'unknownEntries'> & {
  onOpenNodePolicies: () => void;
}) {
  const { t } = useTranslation();
  // Какое поле правила в фокусе: подсказка тегов открыта только у него.
  const [focused, setFocused] = useState<string | null>(null);

  return (
    <>
      {rules.map((rule, i) => {
        const shadowedBy = shadows.get(rule.id);
        // Записи этой строки, которые сервер не принял (ROUTE_POLICY_ENTRY_UNKNOWN).
        const bad = unknownInMatch(rule.match, unknownEntries);
        return (
          <Fragment key={rule.id}>
          <Box
            className="routes-rule"
            style={{
              paddingBlock: 12,
              paddingInline: 20,
              borderTop: `1px solid ${HAIRLINE}`,
              backgroundColor: shadowedBy ? SHADOW_BG : 'transparent',
            }}
          >
            {/* The grip column stays as a spacer: the rows line up with the
                locked rows above and below, which keep their icon there. */}
            <Box style={{ width: 22, flexShrink: 0 }} />

            {/* Поле и подсказка тегов гео-набора под ним (Ф9.5). */}
            <Box className="routes-rule-match" style={{ position: 'relative' }}>
              <TextInput
                value={rule.match.join(' ')}
                placeholder={t('routes.matchPlaceholder')}
                onChange={(e) => setRule(i, { match: splitMatch(e.currentTarget.value) })}
                onFocus={() => setFocused(rule.id)}
                onBlur={() => setFocused((f) => (f === rule.id ? null : f))}
                styles={{
                  input: {
                    fontFamily: MONO,
                    fontSize: 12,
                    height: 32,
                    minHeight: 32,
                    borderRadius: 7,
                    paddingInline: 10,
                    backgroundColor: WELL,
                    borderColor: bad.length > 0 ? RED : EDGE,
                    color: shadowedBy ? SHADOW_INK : SNOW,
                    textDecoration: shadowedBy ? 'line-through' : undefined,
                  },
                }}
              />
              <GeoTagHint
                line={rule.match.join(' ')}
                open={focused === rule.id}
                onPick={(line) => setRule(i, { match: splitMatch(line) })}
              />
            </Box>

            <ActionSelect
              value={rule.action}
              choices={POLICY_ACTIONS}
              muted={Boolean(shadowedBy)}
              className="routes-rule-action"
              onChange={(a) => setRule(i, { action: a })}
            />

            <Text
              style={{ fontFamily: DISPLAY, fontSize: 12, lineHeight: '16px', color: SHADOW_NOTE, flex: 1, minWidth: 0 }}
            >
              {shadowedBy
                ? t(shadowedBy.by === 'block' ? 'routes.shadowedByBlock' : 'routes.shadowedTwice', {
                    match: shadowedBy.match,
                  })
                : ''}
            </Text>

            <IconAction title={t('common.delete')} onClick={() => removeRule(i)}>
              <TrashIcon size={14} color={DIM} />
            </IconAction>
          </Box>
          {bad.length > 0 && (
            <Text style={{ fontFamily: DISPLAY, fontSize: 12, lineHeight: '16px', color: RED, padding: '0 20px 10px 62px' }}>
              {t('routes.entryUnknownRow', { entries: bad.join(', ') })}
            </Text>
          )}
          </Fragment>
        );
      })}

      <Box style={{ padding: '12px 20px', borderTop: `1px solid ${HAIRLINE}` }}>
        <UnstyledButton
          type="button"
          onClick={addRule}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            height: 32,
            paddingInline: 12,
            marginLeft: 36,
            borderRadius: 8,
            backgroundColor: WELL,
            border: `1px dashed ${EDGE}`,
          }}
        >
          <PlusIcon size={13} color={CYAN} />
          <Text style={{ fontFamily: DISPLAY, fontSize: 13, fontWeight: 500, lineHeight: '16px', color: SNOW }}>
            {t('routes.addRule')}
          </Text>
        </UnstyledButton>
        {/* Что сервер принимает в поле правила (265e93e): имя или адрес. */}
        <Text style={{ fontFamily: DISPLAY, fontSize: 11, lineHeight: '15px', color: FAINT, marginTop: 8, marginLeft: 36 }}>
          {t('routes.entryGrammar')}
        </Text>
        {/* Where WARP and proxy by domain live: the exit node's policy (A-151). */}
        <Box style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6, marginLeft: 36 }}>
          <Text style={{ fontFamily: DISPLAY, fontSize: 11, lineHeight: '15px', color: FAINT }}>
            {t('routes.warpProxyElsewhere')}
          </Text>
          <UnstyledButton type="button" onClick={onOpenNodePolicies}>
            <Text style={{ fontFamily: DISPLAY, fontSize: 11, lineHeight: '15px', color: CYAN }}>
              {t('routes.openNodePolicies')}
            </Text>
          </UnstyledButton>
        </Box>
      </Box>
    </>
  );
}
