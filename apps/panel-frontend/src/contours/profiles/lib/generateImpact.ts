import { getProfileKeyImpact, type ProfileKeyImpact } from '@/lib/domain/profiles';
import { useQuery } from '@tanstack/react-query';

/**
 * What a new key pair would cost, as the server counts it (A-225).
 *
 * The key is shared by every node of every host on the profile, so a new pair
 * is a fleet-wide event with no undo. The count used to be made here from the
 * host and binding lists, and a failed or unanswered list read as «0 hosts, 0
 * nodes», which let the key change on a deployed profile with no question
 * asked. Now the server's own count (GET /api/profiles/:id/key-impact) is the
 * only source, and not knowing it is a state of its own.
 *
 *   none     a profile not saved yet: there is nothing to break;
 *   loading  no answer yet: the button waits;
 *   failed   no count: the window still opens, with words saying so;
 *   ready    the counts.
 */
export type GenerateImpact =
  | { kind: 'none' }
  | { kind: 'loading' }
  | { kind: 'failed' }
  | ({ kind: 'ready' } & ProfileKeyImpact);

export function useGenerateImpact(profileId: string | null): GenerateImpact {
  const query = useQuery({
    queryKey: ['profile-key-impact', profileId],
    queryFn: () => getProfileKeyImpact(profileId!),
    enabled: profileId !== null,
    staleTime: 30_000,
  });
  if (profileId === null) return { kind: 'none' };
  if (query.data) return { kind: 'ready', ...query.data };
  if (query.isError) return { kind: 'failed' };
  return { kind: 'loading' };
}

/**
 * What pressing Generate does:
 *   wait     the count has not answered: nothing happens yet;
 *   run      nothing to break (a new profile, or the server counts zero
 *            everywhere): the pair is generated straight away;
 *   confirm  the window with the server's numbers;
 *   unknown  the window without numbers, saying the cost is not known.
 */
export type GenerateStep = 'wait' | 'run' | 'confirm' | 'unknown';

export function generateStep(impact: GenerateImpact): GenerateStep {
  switch (impact.kind) {
    case 'none':
      return 'run';
    case 'loading':
      return 'wait';
    case 'failed':
      return 'unknown';
    case 'ready':
      return impact.hosts === 0 && impact.nodes === 0 && impact.bindings === 0 && impact.configs === 0
        ? 'run'
        : 'confirm';
  }
}

/** The warning above the button: shown when there is a cost, or when it is unknown. */
export function showGenerateWarning(impact: GenerateImpact): boolean {
  const step = generateStep(impact);
  return step === 'confirm' || step === 'unknown';
}
