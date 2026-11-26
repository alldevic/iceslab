import { describe, expect, it } from 'vitest';
import { countCascadeLinks, MAX_CASCADE_LINKS } from '@iceslab/shared';
import { MAX_LINKS } from '@/contours/cascades/lib/cascadeForm';

/**
 * Предел связей и их подсчёт у редактора и у сервера — одни и те же. Раньше у
 * редактора был свой литерал `64` и своя формула `входы x направления`, и она
 * пропускала формы, которые сервер отклонял (8 входов, 8 транзитов и два
 * направления по 8: 16 у редактора, 192 у сервера).
 *
 * Бэкенд читается как исходник через `import.meta.glob`, как в соседних
 * страж-тестах: у приложения нет `node` в типах.
 */
const SCHEMAS = import.meta.glob('../../../../../panel-backend/src/modules/cascades/cascade.schemas.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;
const SOURCES = import.meta.glob('./cascadeForm.ts', { query: '?raw', import: 'default', eager: true }) as Record<
  string,
  string
>;

const LITERAL = /\bMAX_(?:CASCADE_)?LINKS\s*(?::[^=]+)?=\s*\d+/;

describe('предел связей каскада', () => {
  it('MAX_LINKS редактора — тот же символ, что MAX_CASCADE_LINKS из shared', () => {
    expect(MAX_LINKS).toBe(MAX_CASCADE_LINKS);
  });

  it('схема бэкенда не объявляет предел заново', () => {
    const files = Object.values(SCHEMAS);
    expect(files, 'исходник cascade.schemas.ts не найден: страж ничего не проверял').toHaveLength(1);
    expect(files[0]).not.toMatch(LITERAL);
    expect(files[0]).toMatch(/MAX_CASCADE_LINKS[^;]*from '@iceslab\/shared'/);
  });

  it('cascadeForm.ts не объявляет собственный литерал предела', () => {
    const files = Object.values(SOURCES);
    expect(files).toHaveLength(1);
    expect(files[0]).not.toMatch(LITERAL);
  });
});

describe('число связей: редактор считает так же, как сервер', () => {
  const step = (n: number) => ({ nodeIds: Array.from({ length: n }, (_, i) => `n${i}`) });

  it('8 входов, 8 транзитов и два направления по 8 — 192, а не 16', () => {
    const n = countCascadeLinks([step(8), step(8)], [step(8), step(8)]);
    expect(n).toBe(192);
    expect(n).toBeGreaterThan(MAX_LINKS);
  });

  it('форма, которую редактор считает допустимой, сервер по пределу не отклоняет', () => {
    // Одно и то же число и один и тот же предел: допустимое здесь допустимо там.
    const fits = countCascadeLinks([step(2), step(2)], [step(4)]);
    expect(fits).toBe(2 * 2 + 2 * 4);
    expect(fits).toBeLessThanOrEqual(MAX_CASCADE_LINKS);
  });

  it('пустая строка выбора ноды и направление без нод не считаются', () => {
    expect(countCascadeLinks([{ nodeIds: ['a', ''] }], [{ nodeIds: [] }, { nodeIds: ['b'] }])).toBe(1);
  });
});
