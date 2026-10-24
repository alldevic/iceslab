import { describe, expect, it } from 'vitest';
import { policyDrawingOf } from '@/lib/domain/nodePolicies';
import { notDrawnReasonKey, policyDrawingView } from '@/contours/nodes/lib/policyDrawing';

const now = Date.parse('2026-10-24T12:00:00Z');
const rule = (id: string, position: number, domain: string[]) => ({
  id,
  position,
  match: { domain, ip: [], port: null, protocol: [], network: null },
});
const rules = [rule('r1', 0, ['geosite:ads']), rule('r2', 1, ['example.com'])];

describe('policyDrawingOf (A-232)', () => {
  it('agent null: агент не сообщает; пустой notDrawn: всё уходит; это разное', () => {
    const silent = policyDrawingOf({ policyId: 'p', drawing: 'handover', notDrawn: [], agent: null })!;
    expect(silent.agent).toBeNull();
    const reported = policyDrawingOf({
      policyId: 'p',
      drawing: 'handover',
      notDrawn: [],
      agent: { drawing: 'handover', notDrawn: [], renderedAt: '2026-10-24T11:58:00Z', observedAt: '2026-10-24T11:59:00Z' },
    })!;
    expect(reported.agent?.notDrawn).toEqual([]);
  });

  it('вход проверяется первым: без agent, с чужим рисунком или без времени это не ответ', () => {
    expect(policyDrawingOf(null)).toBeNull();
    expect(policyDrawingOf({ policyId: 'p', drawing: 'handover', notDrawn: [] })).toBeNull();
    expect(policyDrawingOf({ policyId: 'p', drawing: 'other', notDrawn: [], agent: null })).toBeNull();
    expect(
      policyDrawingOf({ policyId: 'p', drawing: 'none', notDrawn: [], agent: { drawing: 'legacy', notDrawn: [] } }),
    ).toBeNull();
  });
});

describe('policyDrawingView (A-232)', () => {
  const answer = (agent: unknown) => policyDrawingOf({ policyId: 'p', drawing: 'handover', notDrawn: [{ ruleId: 'r2', reason: 'direction-not-dialled' }], agent })!;

  it('правила, не уходящие на ноду, с причиной и меткой правила', () => {
    const v = policyDrawingView(answer(null), rules, now);
    expect(v.panelNotDrawn).toEqual([{ ruleId: 'r2', label: '#2 example.com', reason: 'direction-not-dialled' }]);
    expect(v.agent).toBeNull();
  });

  it('расхождение рисунков; ruleIds агента; выход с пустым ruleIds отдельно', () => {
    const v = policyDrawingView(
      answer({
        drawing: 'legacy',
        notDrawn: [
          { exit: 'cascade-d1', direction: 1, ruleIds: ['r1'] },
          { exit: 'cascade-d2', direction: 2, ruleIds: [] },
        ],
        renderedAt: '2026-10-24T11:50:00Z',
        observedAt: '2026-10-24T11:55:00Z',
      }),
      rules,
      now,
    );
    expect(v.agent?.mismatch).toBe(true);
    expect(v.agent?.notDrawn).toEqual([{ ruleId: 'r1', label: '#1 geosite:ads' }]);
    expect(v.agent?.orphanExits).toEqual([{ exit: 'cascade-d2', direction: 2 }]);
    expect(v.agent?.stale).toBe(false);
  });

  it('отчёт старше 15 минут: давно не видели; правило не из загруженной политики без метки', () => {
    const v = policyDrawingView(
      answer({ drawing: 'handover', notDrawn: [{ exit: 'x', direction: 3, ruleIds: ['gone'] }], renderedAt: '2026-10-24T11:00:00Z', observedAt: '2026-10-24T11:40:00Z' }),
      rules,
      now,
    );
    expect(v.agent?.stale).toBe(true);
    expect(v.agent?.mismatch).toBe(false);
    expect(v.agent?.notDrawn).toEqual([{ ruleId: 'gone', label: null }]);
  });

  it('неразборчивое время отчёта это «давно не видели», а не свежий', () => {
    const v = policyDrawingView(
      answer({ drawing: 'handover', notDrawn: [], renderedAt: '2026-10-24T11:58:00Z', observedAt: 'вчера' }),
      rules,
      now,
    );
    expect(v.agent?.stale).toBe(true);
  });

  it('незнакомая причина называется кодом, а не молчит', () => {
    expect(notDrawnReasonKey('lost-condition')).toBe('nodeEdit.policyDrawing.reason.lost-condition');
    expect(notDrawnReasonKey('something-new')).toBeNull();
  });
});
