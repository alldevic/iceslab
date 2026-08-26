import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders, screen, waitFor } from '../test/render';
import userEvent from '@testing-library/user-event';

/**
 * The consumption multiplier, asked of the field an operator actually types in.
 *
 * `nodes.consumption_multiplier` is a BigInt column and the API validates
 * `z.number().int().positive()`. All four node forms offered a NumberInput with
 * `min={0.1} max={10} step={0.1}`, and two of them added `decimalScale={1}
 * fixedDecimalScale`, so the control RENDERED "1.0" for a column that cannot
 * hold it. Every value the stepper could reach below 1, and every fractional
 * one, was refused by the backend after the operator had already typed it and
 * pressed save — the form's own bounds were the thing offering them.
 *
 * The English description beside the field has said "1 = standard, above 1 =
 * premium" the whole time; nothing but the numeric props ever suggested
 * fractions.
 *
 * Four copies of one decision, so the source-level comparison lives in
 * `lib/nodeMultiplier.mirror.test.ts`. This is the other half: what the field
 * DOES with a decimal keystroke, which no reading of props establishes.
 */

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    // The only query this modal makes; step 2 lists profiles to bind.
    listProfiles: vi.fn(async () => []),
  };
});

import { NodeFormModal } from './NodeFormModal';

function open(onSubmit = vi.fn(async () => {})) {
  renderWithProviders(
    <NodeFormModal opened node={null} onClose={() => {}} onSubmit={onSubmit} />,
    { language: 'en' },
  );
  return onSubmit;
}

async function multiplierField(): Promise<HTMLInputElement> {
  return (await screen.findByLabelText(/multiplier/i)) as HTMLInputElement;
}

describe('the consumption multiplier field', () => {
  it('starts at the standard 1, not at a decimal', async () => {
    open();
    const field = await multiplierField();
    // The control: if the field were absent or unlabelled, findByLabelText
    // would throw and every case below would be about something else.
    expect(field.value).toBe('1');
  });

  it('refuses a decimal point outright', async () => {
    open();
    const user = userEvent.setup();
    const field = await multiplierField();

    await user.clear(field);
    await user.type(field, '1.5');

    // Not "the save was rejected" — the operator never gets to type it. A
    // period reaching this value is the state the backend answers with a 400.
    await waitFor(() => expect(field.value).not.toContain('.'));
  });

  it('will not go below 1 with the stepper', async () => {
    open();
    const user = userEvent.setup();
    const field = await multiplierField();

    await user.clear(field);
    await user.type(field, '0');
    await user.tab(); // Mantine clamps to `min` on blur

    await waitFor(() => expect(Number(field.value)).toBeGreaterThanOrEqual(1));
  });

  it('sends an integer when the form is submitted', async () => {
    const onSubmit = open();
    const user = userEvent.setup();

    await user.clear(await screen.findByLabelText(/^name/i));
    await user.type(await screen.findByLabelText(/^name/i), 'ams-1');
    const host = await screen.findByLabelText(/address|host/i);
    await user.clear(host);
    await user.type(host, '203.0.113.10');

    const field = await multiplierField();
    await user.clear(field);
    await user.type(field, '3');

    // Walk the two-step wizard the way an operator does. The labels come from
    // the app's real i18n, so a renamed key fails here rather than skipping the
    // click and leaving the case to pass on a form that was never submitted.
    await user.click(await screen.findByRole('button', { name: /next: pick profiles/i }));
    const submit = (await screen.findAllByRole('button')).find(
      (b) => /register|create|add node/i.test(b.textContent ?? ''),
    );
    expect(submit, 'no submit button on step 2; the case would prove nothing').toBeDefined();
    await user.click(submit!);

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const sent = (onSubmit as unknown as { mock: { calls: [Record<string, unknown>][] } })
      .mock.calls[0]![0];
    const mult = sent.consumptionMultiplier as number;
    expect(Number.isInteger(mult), `sent ${mult}, which the BigInt column cannot hold`).toBe(true);
    expect(mult).toBe(3);
  });
});
