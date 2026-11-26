import { NumberInput, Stack } from '@mantine/core';
import type { UseFormReturnType } from '@mantine/form';
import { MIERU_MTU } from '@/contours/profiles/lib/mieruMtu';
import type { FormValues } from '@/contours/profiles/lib/profileFormValues';

export function MieruSection({
  form,
}: {
  form: UseFormReturnType<FormValues>;
}) {
  return (
            <Stack>
              <NumberInput
                label="MTU"
                placeholder={String(MIERU_MTU.default)}
                min={MIERU_MTU.min}
                max={MIERU_MTU.max}
                allowDecimal={false}
                {...form.getInputProps('mieruMtu')}
              />
            </Stack>
  );
}
