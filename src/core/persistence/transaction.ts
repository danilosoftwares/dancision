export interface PersistenceSession {
  readonly transactionKey: string;
}

export interface Transactional {
  readonly transactionKey: string;
  runInTransaction<T>(work: (session: PersistenceSession) => Promise<T>): Promise<T>;
}

export function isTransactional(value: object): value is Transactional {
  if (!("transactionKey" in value) || !("runInTransaction" in value)) {
    return false;
  }
  const candidate = value as { transactionKey?: unknown; runInTransaction?: unknown };
  return (
    typeof candidate.transactionKey === "string" &&
    candidate.transactionKey.length > 0 &&
    typeof candidate.runInTransaction === "function"
  );
}

export function sharedTransaction(left: object, right: object): Transactional | null {
  if (!isTransactional(left) || !isTransactional(right)) {
    return null;
  }
  if (left.transactionKey !== right.transactionKey) {
    return null;
  }
  return left;
}
