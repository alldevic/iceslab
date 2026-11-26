import { Text, UnstyledButton } from '@mantine/core';
import { DIM, DISPLAY, HAIRLINE, CARD, MIST, MONO, SNOW } from '@/contours/traffic/lib/colors';

/** Подпись над полем экрана гео-наборов. */
export function Label({ children }: { children: string }) {
  return (
    <Text style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase', color: MIST }}>
      {children}
    </Text>
  );
}

/** Тихая кнопка. Своя, а не из чужого контура: линт это стережёт. */
export function GhostButton({
  children,
  disabled,
  title,
  onClick,
}: {
  children: string;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <UnstyledButton
      type="button"
      disabled={disabled}
      title={title}
      onClick={onClick}
      style={{
        height: 32,
        paddingInline: 12,
        borderRadius: 8,
        border: `1px solid ${HAIRLINE}`,
        backgroundColor: CARD,
        color: disabled ? DIM : SNOW,
        fontFamily: MONO,
        fontSize: 10,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        cursor: disabled ? 'default' : 'pointer',
        flexShrink: 0,
      }}
    >
      {children}
    </UnstyledButton>
  );
}

/** Строка с причиной под полем. */
export function FieldNote({ children, tone = SNOW }: { children: string; tone?: string }) {
  return <Text style={{ fontFamily: DISPLAY, fontSize: 12, lineHeight: '17px', color: tone }}>{children}</Text>;
}
