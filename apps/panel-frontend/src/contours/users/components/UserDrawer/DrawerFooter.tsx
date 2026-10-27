import { Box, Text } from '@mantine/core';
import { FooterButton } from '@/contours/users/components/UserDrawer/FooterButton';
import { HAIRLINE, MIST, MONO, RED, WELL } from '@/contours/users/lib/colors';
import { useTranslation } from 'react-i18next';
import type { Props } from '@/contours/users/components/UserDrawer';
import type { UserForm } from '@/contours/users/components/UserDrawer/useUserForm';

/**
 * The action bar: cancel, and the one button that saves.
 */
export function DrawerFooter({
  isEdit,
  onClose,
  loading,
  setCreateNext,
  saveRefusal,
}: Pick<UserForm, 'isEdit' | 'setCreateNext' | 'saveRefusal'> & {
  onClose: Props['onClose'];
  loading: Props['loading'];
}) {
  const { t } = useTranslation();

  return (
    <>
        {/* Footer */}
        <Box
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 18px 14px',
            backgroundColor: WELL,
            borderTop: `1px solid ${HAIRLINE}`,
            flexShrink: 0,
          }}
        >
          {/* A refused save in the server's words, where the eye is when the
              button did not close the form (userSaveRefusal). */}
          {saveRefusal ? (
            <Text style={{ fontSize: 12, lineHeight: '16px', color: RED, flex: 1, minWidth: 0, paddingRight: 12, overflowWrap: 'anywhere' }}>
              {saveRefusal}
            </Text>
          ) : (
            <Text style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.14em', color: MIST }}>
              ⏎ {isEdit ? t('userDrawer.saveShort') : t('userDrawer.createShort')}
            </Text>
          )}
          <Box style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {/* Making accounts is done in runs, so the second button saves this
                one and leaves the form open on a blank draft. An edit is a
                single visit and gets the way out instead. */}
            {isEdit ? (
              <FooterButton onClick={onClose}>{t('common.cancel')}</FooterButton>
            ) : (
              <FooterButton
                type="submit"
                disabled={loading}
                onClick={() => setCreateNext(true)}
              >
                {t('userDrawer.createAndNext')}
              </FooterButton>
            )}
            <FooterButton type="submit" primary disabled={loading}>
              {isEdit ? t('common.save') : t('userDrawer.create')}
            </FooterButton>
          </Box>
        </Box>
    </>
  );
}
