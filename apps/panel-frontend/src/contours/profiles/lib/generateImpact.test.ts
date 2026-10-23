import { beforeEach, describe, expect, it, vi } from 'vitest';

const openConfirmModal = vi.fn();
vi.mock('@mantine/modals', () => ({ modals: { openConfirmModal: (...a: unknown[]) => openConfirmModal(...a) } }));

import { generateStep, pressGenerate, showGenerateWarning, type GenerateImpact } from '@/contours/profiles/lib/generateImpact';
import { confirmGenerate } from '@/contours/profiles/lib/confirmGenerate';

const t = (k: string) => k;
const ready = (n: Partial<{ hosts: number; nodes: number; bindings: number; users: number; configs: number }>): GenerateImpact => ({
  kind: 'ready',
  hosts: 0,
  nodes: 0,
  bindings: 0,
  users: 0,
  configs: 0,
  ...n,
});

describe('generateStep (A-225)', () => {
  it('ответа нет: ждать; не сохранён: сразу; сбой: окно без чисел', () => {
    expect(generateStep({ kind: 'loading' })).toBe('wait');
    expect(generateStep({ kind: 'none' })).toBe('run');
    expect(generateStep({ kind: 'failed' })).toBe('unknown');
  });

  it('сервер считает нули: сразу; любое ненулевое: окно', () => {
    expect(generateStep(ready({}))).toBe('run');
    expect(generateStep(ready({ hosts: 1 }))).toBe('confirm');
    expect(generateStep(ready({ nodes: 2 }))).toBe('confirm');
    expect(generateStep(ready({ bindings: 1 }))).toBe('confirm');
    expect(generateStep(ready({ configs: 5 }))).toBe('confirm');
  });

  it('предупреждение над кнопкой: при цене и при неизвестной цене', () => {
    expect(showGenerateWarning(ready({ hosts: 1 }))).toBe(true);
    expect(showGenerateWarning({ kind: 'failed' })).toBe(true);
    expect(showGenerateWarning(ready({}))).toBe(false);
    expect(showGenerateWarning({ kind: 'loading' })).toBe(false);
  });
});

describe('confirmGenerate (A-225)', () => {
  beforeEach(() => openConfirmModal.mockReset());

  it('loading не запускает генерацию и окна не открывает', () => {
    const run = vi.fn();
    confirmGenerate({ kind: 'loading' }, t, run);
    expect(run).not.toHaveBeenCalled();
    expect(openConfirmModal).not.toHaveBeenCalled();
  });

  it('ошибка счёта открывает окно, генерация только по подтверждению', () => {
    const run = vi.fn();
    confirmGenerate({ kind: 'failed' }, t, run);
    expect(run).not.toHaveBeenCalled();
    expect(openConfirmModal).toHaveBeenCalledTimes(1);
    const opts = openConfirmModal.mock.calls[0][0] as { onConfirm: () => void };
    opts.onConfirm();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('нули окна не открывают, генерация сразу', () => {
    const run = vi.fn();
    confirmGenerate(ready({}), t, run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(openConfirmModal).not.toHaveBeenCalled();
  });

  it('развёрнутый профиль: окно с числами сервера', () => {
    const run = vi.fn();
    confirmGenerate(ready({ hosts: 3, nodes: 2, configs: 40 }), t, run);
    expect(run).not.toHaveBeenCalled();
    expect(openConfirmModal).toHaveBeenCalledTimes(1);
  });
});

describe('pressGenerate: нажатие решает по свежему счёту (хвост A-225)', () => {
  beforeEach(() => openConfirmModal.mockReset());

  it('в кэше 0/0/0/0, сервер на нажатие отвечает ненулём: окно открывается', async () => {
    const run = vi.fn();
    const cached = ready({});
    expect(generateStep(cached)).toBe('run');
    await pressGenerate(
      () => Promise.resolve({ hosts: 2, nodes: 2, bindings: 2, users: 5, configs: 10 }),
      (fresh) => confirmGenerate(fresh, t, run),
    );
    expect(run).not.toHaveBeenCalled();
    expect(openConfirmModal).toHaveBeenCalledTimes(1);
  });

  it('свежий счёт не пришёл: окно «цену узнать не удалось», не генерация', async () => {
    const run = vi.fn();
    await pressGenerate(() => Promise.reject(new Error('net')), (fresh) => confirmGenerate(fresh, t, run));
    expect(run).not.toHaveBeenCalled();
    expect(openConfirmModal).toHaveBeenCalledTimes(1);
  });

  it('свежие нули: сразу, без окна', async () => {
    const run = vi.fn();
    await pressGenerate(
      () => Promise.resolve({ hosts: 0, nodes: 0, bindings: 0, users: 0, configs: 0 }),
      (fresh) => confirmGenerate(fresh, t, run),
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(openConfirmModal).not.toHaveBeenCalled();
  });
});