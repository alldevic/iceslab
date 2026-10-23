import { ENGINE_NAMES, type EngineName } from '@iceslab/shared';
import { engineCoreWord } from '@/lib/domain/engines';
import type { ProfileNotOnNode } from '@/lib/domain/hosts';

type T = (key: string, vars?: Record<string, unknown>) => string;

/** An engine the contract knows gets its word; one it does not, its name as sent. */
function engineName(e: string, t: T): string {
  return (ENGINE_NAMES as readonly string[]).includes(e) ? engineCoreWord(e as EngineName, t) : e;
}

/**
 * 409 PROFILE_DOES_NOT_RUN_ON_NODE in the panel's words (A-235): which node,
 * which core the profile needs, what the node reported, and whether waiting
 * helps. It used to be read as «port taken» with the server's English.
 */
export function profileNotOnNodeWords(r: ProfileNotOnNode, t: T): string {
  const reported = r.reportedEngines.length
    ? r.reportedEngines.map((e) => engineName(e, t)).join(', ')
    : t('hostEdit.notOnNodeNothing');
  const head = t('hostEdit.notOnNode', { node: r.nodeName, needed: engineName(r.neededEngine, t), reported });
  return r.canWait ? `${head} ${t('hostEdit.notOnNodeWait', { needed: engineName(r.neededEngine, t) })}` : head;
}
