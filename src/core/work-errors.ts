/**
 * Typed errors for the Works domain.
 *
 * The Works routes used to classify failures by substring-matching the thrown
 * message (`message.includes('not found')` → `404 Work not found`). That is how
 * a *card* vanishing mid-sweep turned a partially completed Work into a
 * `404 Work not found`, telling the client the Work never existed while its
 * cards were already archived. Every Works failure the routes distinguish now
 * carries its own class, and the route maps on `instanceof`.
 */

/** A Work id (or the Work behind a session link) does not exist. → 404 */
export class WorkNotFoundError extends Error {
  readonly workId?: string;

  constructor(workId?: string) {
    super(workId ? `Work not found: ${workId}` : 'Work not found');
    this.name = 'WorkNotFoundError';
    this.workId = workId;
  }
}

/** The session is in no Work at all (i.e. it is in the Inbox). → 404 */
export class WorkSessionNotLinkedError extends Error {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(`Session is not linked to any work: ${sessionId}`);
    this.name = 'WorkSessionNotLinkedError';
    this.sessionId = sessionId;
  }
}

/** The session already belongs to a *different* Work (the 1:N invariant). → 409 */
export class WorkSessionAlreadyLinkedError extends Error {
  readonly ownerWorkId: string;

  constructor(ownerWorkId: string) {
    super(`Session already linked to another work: ${ownerWorkId}`);
    this.name = 'WorkSessionAlreadyLinkedError';
    this.ownerWorkId = ownerWorkId;
  }
}

/**
 * A **new** session link was aimed at a Work that is no longer `active`. → 409
 *
 * A `done` Work has already handed its cards to the wiki pipeline and a
 * `discarded` one exists only to release its sessions, so neither may take on
 * work it never ran. The gate is on *new* links only: a same-Work re-link is how
 * the `⋯` menu edits a link's role, and that changes no grouping at all.
 */
export class WorkNotActiveError extends Error {
  readonly status: string;

  constructor(status: string, title: string) {
    super(`Cannot link a session to a ${status} work: "${title}"`);
    this.name = 'WorkNotActiveError';
    this.status = status;
  }
}

/** The session id is not on the Inbox ignore list, so there is nothing to restore. → 404 */
export class WorkSessionNotIgnoredError extends Error {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(`Session is not in the ignore list: ${sessionId}`);
    this.name = 'WorkSessionNotIgnoredError';
    this.sessionId = sessionId;
  }
}

/**
 * One end of a session move is closed to re-grouping. → 409
 *
 * `archived` — the Work's cards have already been swept into the wiki pipeline.
 * `completing` — the Work is `done` but its sweep is still deferred (awaiting
 * confirmation); moving a session in or out of it would race the archive that is
 * about to run, and the session would be grouped under a document that has
 * already been decided.
 */
export class WorkNotMovableError extends Error {
  readonly reason: 'archived' | 'completing';

  constructor(reason: 'archived' | 'completing', direction: 'out of' | 'into', title: string) {
    const what = reason === 'archived' ? 'an archived work' : 'a completing work';
    super(`Cannot move a session ${direction} ${what}: "${title}"`);
    this.name = 'WorkNotMovableError';
    this.reason = reason;
  }
}

/** A manual re-date would invert the Timeline bar. → 400 */
export class WorkDateOrderError extends Error {
  constructor() {
    super('Work resolvedAt must not precede startedAt');
    this.name = 'WorkDateOrderError';
  }
}

/** Completion is refused because agents are still running under this Work. → 409 */
export class WorkCardsRunningError extends Error {
  readonly runningCardIds: string[];

  constructor(runningCardIds: string[]) {
    super(
      `Cannot complete a Work while ${runningCardIds.length} card(s) still have a running agent`,
    );
    this.name = 'WorkCardsRunningError';
    this.runningCardIds = runningCardIds;
  }
}

/**
 * A merge names a target that cannot receive this Work. → 400
 *
 * Only reachable for a *self* merge: every other rejection has a class of its
 * own (`WorkNotFoundError` for a missing side, `WorkNotMovableError` for an
 * archived/completing one). Kept distinct so the route does not have to guess
 * `400` from a bare `Error`.
 */
export class WorkMergeTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkMergeTargetError';
  }
}

/**
 * A reopen was aimed at a Work that is already `active`. → 409
 *
 * There is nothing to restore, and a `200` here would let a stale detail dialog
 * report cards coming back that never went anywhere.
 */
export class WorkAlreadyActiveError extends Error {
  constructor(title: string) {
    super(`Work is already active: "${title}"`);
    this.name = 'WorkAlreadyActiveError';
  }
}

/** A completion cascade must not absorb another Work's cards. */
export class WorkCardsConflictError extends Error {
  constructor(readonly conflictingCardIds: string[]) {
    super('다른 Work에 연결된 하위 카드가 있어 완료할 수 없습니다. 세션 연결을 정리한 뒤 다시 시도하세요.');
    this.name = 'WorkCardsConflictError';
  }
}
