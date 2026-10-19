/**
 * An agent's ETA answers, kept for a while per (credential, request) so
 * polling hears the same answer again: a moving clock or a moving phone
 * cannot be read off a stream of slightly different numbers, and a repeat
 * spends no provider budget.
 */

export const AGENT_ANSWER_TTL_MS = 5 * 60_000;
/** Beyond this many answers the oldest go first, whether or not they have expired. */
const MAX_ANSWERS = 1000;

export class AnswerCache<T> {
  private readonly answers = new Map<string, { at: number; value: T }>();

  constructor(private readonly ttlMs: number = AGENT_ANSWER_TTL_MS) {}

  get(key: string, now: number): T | undefined {
    const hit = this.answers.get(key);
    if (!hit) return undefined;
    if (now - hit.at < this.ttlMs) return hit.value;
    this.answers.delete(key);
    return undefined;
  }

  set(key: string, value: T, now: number): void {
    this.answers.delete(key);
    // Oldest first: drop the expired, and the oldest beyond the cap.
    for (const [k, hit] of this.answers) {
      if (now - hit.at < this.ttlMs && this.answers.size < MAX_ANSWERS) break;
      this.answers.delete(k);
    }
    this.answers.set(key, { at: now, value });
  }
}
