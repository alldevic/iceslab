import { Caption } from '@/contours/nodes/components/NodeEdit/Caption';
import { Box, NumberInput, SegmentedControl, Select, Stack, Switch, Text, TextInput } from '@mantine/core';
import { readIpv6Mode } from '@iceslab/shared';
import { tunnelPrefixChanges } from '@/contours/nodes/lib/nodeEditForm';
import { nodeServesRealPrefix } from '@/lib/domain/tunnelIpv6';
import { nodeIpv6EgressFact, nodeIpv6Fact, nodeIpv6ModeNote } from '@/contours/nodes/lib/nodeAdapterFacts';
import { CARD, CYAN, HAIRLINE } from '@/contours/nodes/lib/colors';
import { COUNTRY_OPTIONS } from '@/lib/domain/countries';
import { FIELD } from '@/contours/nodes/lib/fieldStyles';
import { PolicyReach } from '@/contours/nodes/components/NodeEdit/PolicyReach';
import { PolicyDrawingLines } from '@/contours/nodes/components/NodeEdit/PolicyDrawingLines';
import { PROTOCOL_OPTIONS } from '@/contours/nodes/lib/nodeProtocols';
import { ServerIcon } from '@/contours/nodes/components/NodeEdit/icons';
import { useTranslation } from 'react-i18next';
import { policyReachFacts, type PolicyReachFacts } from '@/contours/nodes/lib/policyReach';
import { AMBER, FAINT, MIST, MONO, MOSS } from '@/contours/nodes/lib/colors';
import type { NodeEditor } from '@/contours/nodes/components/NodeEdit/useNodeEditForm';
import { EngineChips } from '@/contours/nodes/components/EngineChips';
import { LoadFailedLine } from '@/ui/LoadFailed';

/**
 * Name, address, region and protocol of the node, plus the save bar.
 */
export function NodeParamsForm({
  regionsQuery,
  form,
  node,
  nodePoliciesQuery,
  policyRefusal,
  enginesKnown,
  enginesRefusal,
  regionsFailure,
  nodePoliciesFailure,
}: Pick<
  NodeEditor,
  | 'regionsQuery'
  | 'form'
  | 'id'
  | 'node'
  | 'nodePoliciesQuery'
  | 'policyRefusal'
  | 'enginesKnown'
  | 'enginesRefusal'
  | 'regionsFailure'
  | 'nodePoliciesFailure'
>) {
  const { t } = useTranslation();
  const reach = policyReachFacts(node?.cores?.cores);
  const applicability = reach.state;

  return (
              <Stack
                gap={16}
                style={{ padding: 20, borderRadius: 10, backgroundColor: CARD, border: `1px solid ${HAIRLINE}` }}
              >
                <Box style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <ServerIcon size={15} color={CYAN} />
                  <Caption>{t('nodeEdit.paramsTitle')}</Caption>
                </Box>

                <Box style={{ display: 'flex', alignItems: 'flex-start', gap: 20, width: '100%' }}>
                  <TextInput
                    {...FIELD}
                    style={{ flex: 1, minWidth: 0 }}
                    label={t('nodes.form.name')}
                    description={t('nodes.form.nameDesc')}
                    required
                    {...form.getInputProps('name')}
                  />
                  {/* Сервер старше intendedEngines: прежний селект протокола. */}
                  {!enginesKnown && (
                    <Select
                      {...FIELD}
                      style={{ flex: 1, minWidth: 0 }}
                      label={t('nodes.form.protocol')}
                      description={t('nodeEdit.protocolDesc')}
                      data={PROTOCOL_OPTIONS}
                      allowDeselect={false}
                      {...form.getInputProps('protocol')}
                    />
                  )}
                </Box>

                {/* Ядра, на которые нода настроена: те же чипы, что в мастере,
                    но только для чтения (E42, 2359c7e): набор сообщает нода,
                    ставят и снимают ядра командами секции «Ядра» ниже. Пустой
                    набор тоже рисуется: нода без ядер. */}
                {enginesKnown && (
                  <EngineChips engines={form.values.engines} error={enginesRefusal} readOnly />
                )}

                <Box style={{ display: 'flex', alignItems: 'flex-start', gap: 20, width: '100%' }}>
                  <TextInput
                    {...FIELD}
                    style={{ flex: 2, minWidth: 0 }}
                    label={t('nodes.form.address')}
                    description={t('nodeEdit.addressDesc')}
                    required
                    {...form.getInputProps('host')}
                  />
                  <NumberInput
                    {...FIELD}
                    style={{ width: 130, flexShrink: 0 }}
                    label={t('nodes.form.port')}
                    description={t('nodeEdit.portDesc')}
                    min={1}
                    max={65535}
                    allowDecimal={false}
                    allowNegative={false}
                    hideControls
                    {...form.getInputProps('port')}
                  />
                </Box>

                <Box style={{ display: 'flex', alignItems: 'flex-start', gap: 20, width: '100%' }}>
                  <Select
                    {...FIELD}
                    style={{ flex: 1, minWidth: 0 }}
                    label={t('nodes.form.country')}
                    description={t('nodes.form.countryDesc')}
                    placeholder={t('nodeCreate.countryPlaceholder')}
                    data={COUNTRY_OPTIONS}
                    searchable
                    clearable
                    nothingFoundMessage={t('common.nothingFound')}
                    {...form.getInputProps('countryCode')}
                  />
                  <Select
                    {...FIELD}
                    style={{ flex: 1, minWidth: 0 }}
                    label={t('nodeEdit.region')}
                    description={t('nodeEdit.regionDesc')}
                    placeholder={t('nodeEdit.noRegion')}
                    data={(regionsQuery.data?.regions ?? []).map((r) => ({
                      value: r.id,
                      label: `${r.code} · ${r.name}`,
                    }))}
                    clearable
                    {...form.getInputProps('regionId')}
                  />
                  {/* Text, not a number field (A-143): a comma and a dot are both taken,
                      and 1,25 is refused at the field instead of rounded. */}
                  <TextInput
                    {...FIELD}
                    style={{ flex: 1, minWidth: 0 }}
                    label={t('nodeEdit.multiplier')}
                    description={t('nodeEdit.multiplierDesc')}
                    inputMode="decimal"
                    placeholder="1"
                    {...form.getInputProps('consumptionMultiplier')}
                  />
                  <NumberInput
                    {...FIELD}
                    style={{ flex: 1, minWidth: 0 }}
                    label={t('nodeEdit.maxUsers')}
                    description={t('nodeEdit.maxUsersDesc')}
                    min={1}
                    max={100000}
                    allowDecimal={false}
                    allowNegative={false}
                    {...form.getInputProps('maxUsers')}
                  />
                </Box>
                <Switch
                  label={t('nodeEdit.inService')}
                  description={t('nodeEdit.inServiceDesc')}
                  checked={form.values.inService}
                  onChange={(e) => form.setFieldValue('inService', e.currentTarget.checked)}
                />
                {/* A-057: the node's own domain. Saving a new one re-pushes the
                    node, so self-steal and every link's SNI follow it. */}
                <TextInput
                  {...FIELD}
                  label={t('nodes.form.domain')}
                  description={t('nodes.form.domainDesc')}
                  placeholder="node.example.com"
                  {...form.getInputProps('domain')}
                />
                <Ipv6ModeField form={form} node={node} />
                <TunnelPrefixField form={form} node={node} />
                {/* The region list did not arrive: said, not an empty picker. */}
                {regionsFailure && <LoadFailedLine message={regionsFailure.message} onRetry={regionsFailure.onRetry} />}

                {/* Э3 layer B. One policy can sit on many nodes, so the picker
                    names the policy and how many machines already carry it,
                    and choosing "none" is a real detach: the node's config is
                    rewritten without the rules rather than keeping the last
                    ones. A policy this machine cannot run is refused on save
                    with a sentence naming the node and the reason, shown
                    underneath rather than as a toast that scrolls away. */}
                {/* Достанет ли политика до этой машины, одним словом и до
                    селектора: читатель должен увидеть это ДО того, как выберет
                    правило, а не после сохранения.

                    В «не применима» поле приглушено, но НЕ отключено и
                    назначение не снимается: чинится это отдельной работой, и
                    после починки правило должно заработать само. Снять его
                    сейчас значит потерять выбор оператора молча. */}
                <PolicyApplicabilityLine state={applicability} />
                <Box style={{ opacity: applicability === 'not-applicable' ? 0.55 : 1 }}>
                  <Select
                    {...FIELD}
                    label={t('nodeEdit.policy')}
                    description={t('nodeEdit.policyDesc')}
                    placeholder={t('nodeEdit.policyNone')}
                    clearable
                    data={(nodePoliciesQuery.data?.policies ?? []).map((p) => ({
                      value: p.id,
                      label: p.nodeCount
                        ? `${p.name} · ${t('routes.nodeOnNodes', { count: p.nodeCount })}`
                        : p.name,
                    }))}
                    value={form.values.policyId || null}
                    onChange={(v) => form.setFieldValue('policyId', v ?? '')}
                  />
                </Box>
                {nodePoliciesFailure && (
                  <LoadFailedLine message={nodePoliciesFailure.message} onRetry={nodePoliciesFailure.onRetry} />
                )}
                {/* Подробности охвата только когда политика ВООБЩЕ применяется.
                    В двух других состояниях строка выше уже всё сказала, и
                    PolicyReach повторил бы её своими словами: «не применима»
                    он показывает как красную плашку «политика здесь не
                    работает», а «панель не знает» как серую строку про те же
                    ядра. Два сообщения об одном читаются как два разных факта.

                    Здесь он остаётся тем, ради чего написан: политика
                    применяется, но достаёт не всех, потому что одно ядро из
                    двух её не рисует. */}
                {applicability === 'applies' && (
                  <PolicyReach
                    cores={node?.cores?.cores}
                    hasPolicy={Boolean(form.values.policyId)}
                  />
                )}
                {/* A-232: which rules of the SAVED policy reach the node, and
                    what the agent says it drew. */}
                {node?.policyId && (
                  <PolicyDrawingLines
                    nodeId={node.id}
                    policy={nodePoliciesQuery.data?.policies.find((p) => p.id === node.policyId)}
                  />
                )}
                {/* Пояснение у ВСЕХ трёх состояний, и это не многословие: в
                    каждом лежит факт, которого у оператора иначе нет. Кто
                    именно применяет правила и какой версии. Почему не
                    применяет и что будет дальше. Что молчание это не «нет
                    ядер», а «ещё не спрашивали». */}
                <Text style={{ fontSize: 12, lineHeight: '17px', color: MIST }}>
                  {applicability === 'applies'
                    ? t('nodeEdit.policyWhyApplies', {
                        core: reach.router?.name ?? '',
                        version: reach.router?.version ?? '',
                      }).trim()
                    : applicability === 'unknown'
                      ? t('nodeEdit.policyWhyUnknown')
                      : t(
                          reach.gap === 'router-not-installed'
                            ? 'nodeEdit.policyWhyNotInstalled'
                            : 'nodeEdit.policyApplicabilityWhy',
                        )}
                </Text>
                {policyRefusal && (
                  <Box
                    style={{
                      padding: '10px 12px',
                      borderRadius: 8,
                      backgroundColor: '#E07A5F14',
                      border: '1px solid #E07A5F40',
                    }}
                  >
                    <Text style={{ fontSize: 12, lineHeight: '17px', color: '#E07A5F' }}>
                      {policyRefusal}
                    </Text>
                  </Box>
                )}
              </Stack>
  );
}

/**
 * Одна строка над селектором: достанет ли политика до этой ноды.
 *
 * Слова выбраны нарочно. «Не применима на этой ноде», а не «не поддерживается»:
 * нода не сломана, у неё просто нет ядра, которое рисует правила, и это разные
 * вещи на экране. «Панель не знает» стоит отдельно от «не применима», потому
 * что отсутствие ответа это не ответ «нет».
 */
function PolicyApplicabilityLine({ state }: { state: PolicyReachFacts['state'] }) {
  const { t } = useTranslation();
  const tone = state === 'applies' ? MOSS : state === 'not-applicable' ? MIST : FAINT;

  return (
    <Box style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <Box style={{ width: 6, height: 6, borderRadius: 999, backgroundColor: tone, flexShrink: 0 }} />
      <Text
        style={{
          fontFamily: MONO,
          fontSize: 11,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color: tone,
        }}
      >
        {t(`nodeEdit.policyApplicability.${state}`)}
      </Text>
    </Box>
  );
}


/**
 * 18.6: the IPv6 switch of the node, with the facts it overrides beside it. The
 * agent's own answer is `auto` (a global address and an outbound connection
 * that went through); `on` and `off` are the operator's word over it. `on` on a
 * node whose check fails is allowed and says so. mtproto stays on IPv4 either
 * way, which the hint names.
 */
function Ipv6ModeField({ form, node }: Pick<NodeEditor, 'form' | 'node'>) {
  const { t } = useTranslation();
  const mode = readIpv6Mode(form.values.ipv6Mode);
  const fact = nodeIpv6Fact(node?.cores);
  const egress = nodeIpv6EgressFact(node?.cores);
  const note = nodeIpv6ModeNote(node?.cores, mode);
  const factText =
    fact.state === 'unknown'
      ? t('nodeEdit.ipv6.unknown')
      : [
          fact.state === 'none' ? t('nodeEdit.ipv6Mode.noAddress') : t('nodeEdit.ipv6Mode.hasAddress', { count: fact.count }),
          (egress === 'works'
            ? t('nodeEdit.ipv6Mode.egress.works')
            : egress === 'fails'
              ? t('nodeEdit.ipv6Mode.egress.fails')
              : t('nodeEdit.ipv6Mode.egress.unknown')),
        ].join(', ');
  return (
    <Stack gap={6}>
      <Text style={{ fontSize: 14, fontWeight: 500 }}>{t('nodeEdit.ipv6Mode.label')}</Text>
      <SegmentedControl
        data-testid="ipv6-mode"
        aria-label={t('nodeEdit.ipv6Mode.label')}
        value={mode}
        onChange={(v) => form.setFieldValue('ipv6Mode', readIpv6Mode(v))}
        data={[
          { value: 'auto', label: t('nodeEdit.ipv6Mode.auto') },
          { value: 'on', label: t('nodeEdit.ipv6Mode.on') },
          { value: 'off', label: t('nodeEdit.ipv6Mode.off') },
        ]}
      />
      <Text style={{ fontSize: 12, lineHeight: '17px', color: MIST }}>{t('nodeEdit.ipv6Mode.hint')}</Text>
      <Text style={{ fontSize: 12, lineHeight: '17px', color: FAINT }}>
        {t('nodeEdit.ipv6Mode.facts')}: {factText}
      </Text>
      {note && (
        <Text role="note" style={{ fontSize: 12, lineHeight: '17px', color: AMBER }}>
          {note === 'onNotWorking' ? t('nodeEdit.ipv6Mode.note.onNotWorking') : t('nodeEdit.ipv6Mode.note.agentUnsupported')}
        </Text>
      )}
    </Stack>
  );
}

/**
 * 18.11: the real IPv6 prefix the provider routes to this node. The tunnel's
 * clients on this node then get addresses from it and leave with them, no NAT66,
 * only replies coming in. Saving a change restarts the node's tunnel interfaces
 * and moves every client's IPv6 address, which the line says before the save.
 */
function TunnelPrefixField({ form, node }: Pick<NodeEditor, 'form' | 'node'>) {
  const { t } = useTranslation();
  const typed = form.values.tunnelIpv6Prefix;
  const changes = tunnelPrefixChanges(node?.tunnelIpv6Prefix, typed);
  const agentGap = typed.trim() !== '' && node?.cores != null && !nodeServesRealPrefix(node.cores);
  return (
    <Stack gap={6}>
      <TextInput
        {...FIELD}
        label={t('nodeEdit.tunnelPrefix.label')}
        description={t('nodeEdit.tunnelPrefix.hint')}
        placeholder="2001:db8:77::/48"
        data-testid="tunnel-ipv6-prefix"
        {...form.getInputProps('tunnelIpv6Prefix')}
      />
      {agentGap && (
        <Text role="note" data-testid="tunnel-prefix-agent-note" style={{ fontSize: 12, lineHeight: '17px', color: AMBER }}>
          {t('nodeEdit.tunnelPrefix.agentOld')}
        </Text>
      )}
      {changes && (
        <Text role="note" data-testid="tunnel-prefix-restart-warning" style={{ fontSize: 12, lineHeight: '17px', color: AMBER }}>
          {t('nodeEdit.tunnelPrefix.restart')}
        </Text>
      )}
    </Stack>
  );
}
