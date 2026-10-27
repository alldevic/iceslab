/**
 * A-236 step 6: what a host may say about itself to the client apps that show
 * a line under the server name, and which apps those are. One place for the
 * server's schema and the host form, so the length the screen counts and the
 * length the server refuses are one count.
 */

/** The longest `serverDescription`, in Unicode code points (an emoji is one).
 *  Happ shows the first 30 and cuts the rest with an ellipsis (happ.su
 *  dev-docs/app-management, read 24.10); the others show more. */
export const HOST_SERVER_DESCRIPTION_MAX = 200;

export type ServerDescriptionProblem = 'empty' | 'multiline' | 'too-long';

/**
 * Why a description cannot be saved, or null when it can. One line: a line
 * break (\r, \n, U+2028, U+2029) or any other control character
 * (U+0000-U+001F, U+007F) is refused, since the text goes into a client
 * config as a value and into a share link. Spaces only is empty; spaces around
 * real text stay as written.
 */
export function serverDescriptionProblem(s: string): ServerDescriptionProblem | null {
  if (s.trim() === '') return 'empty';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(s)) return 'multiline';
  if ([...s].length > HOST_SERVER_DESCRIPTION_MAX) return 'too-long';
  return null;
}

/** The words for each problem, as the server answers them. */
export const SERVER_DESCRIPTION_WORDS: Record<ServerDescriptionProblem, string> = {
  empty: 'serverDescription is empty: send null to clear it',
  multiline: 'serverDescription is one line: a line break or a control character is not allowed',
  'too-long': `serverDescription is at most ${HOST_SERVER_DESCRIPTION_MAX} characters`,
};

/**
 * The client apps that show a host's description, by the start of their
 * User-Agent. Happ from its own documentation (happ.su dev-docs/
 * app-management, read 24.10); FlClash X, Flowvy, prizrak-box, koala-clash and
 * INCY from a reference list of the UA prefixes these apps send, read 24.10,
 * not checked against each app. Every other client is handed no description.
 */
export const DESCRIPTION_CLIENTS: readonly RegExp[] = [
  /^FlClash ?X\//,
  /^Flowvy\//,
  /^prizrak-box\//,
  /^koala-clash\//,
  /^Happ\//,
  /^INCY\//,
];

export function showsServerDescription(userAgent: string | null | undefined): boolean {
  return !!userAgent && DESCRIPTION_CLIENTS.some((re) => re.test(userAgent));
}

/** Happ reads the description in a share link, after the title:
 *  `<link>#title?serverDescription=<base64 of UTF-8>`. */
export function isHappUserAgent(userAgent: string | null | undefined): boolean {
  return !!userAgent && /^Happ\//.test(userAgent);
}
