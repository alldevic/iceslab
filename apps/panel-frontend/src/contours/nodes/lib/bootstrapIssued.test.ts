import { afterEach, describe, expect, it, vi } from 'vitest';
import { onBootstrapIssued } from '@/contours/nodes/lib/bootstrapIssued';

const info = { token: 't', expiresAt: '2026-10-22T12:00:00Z', command: 'bash <(curl …) --token t' };

describe('onBootstrapIssued (A-147)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('на http (navigator.clipboard нет): не бросает, команда показана, тост честный', () => {
    vi.stubGlobal('navigator', { clipboard: undefined });
    const shown: unknown[] = [];
    const notes: { title: string; message: string }[] = [];
    expect(() => onBootstrapIssued(info, (i) => shown.push(i), (n) => notes.push(n), (k) => k)).not.toThrow();
    expect(shown).toEqual([info]);
    expect(notes).toEqual([{ title: 'nodeEdit.bootstrapIssued', message: 'nodeEdit.bootstrapShown' }]);
  });

  it('буфер не трогается вовсе: «скопировано» здесь не говорится', () => {
    const writeText = vi.fn();
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    onBootstrapIssued(info, () => undefined, () => undefined, (k) => k);
    expect(writeText).not.toHaveBeenCalled();
  });
});
