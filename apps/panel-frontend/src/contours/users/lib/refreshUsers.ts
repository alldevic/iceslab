import type { QueryClient } from '@tanstack/react-query';

/**
 * Refetch the users list AND the tag list. A write to a user can add a tag to
 * the filter dropdown or take the last holder of one away; the tag query has a
 * five minute staleTime, so without this the filter shows the old list.
 */
export function refreshUsers(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: ['users'] });
  void qc.invalidateQueries({ queryKey: ['user-tags'] });
}
