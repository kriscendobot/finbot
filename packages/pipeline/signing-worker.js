/**
 * Signing worker — the executor's wallet behind a process boundary (CapTP).
 *
 * `designs/cap-attenuation.md` § Process boundary: for the executor's `--live`
 * mode the wallet runs in a SEPARATE worker process and the executor reaches it
 * only as a remote presence over CapTP. The OS process boundary is defense in
 * depth — a JS-level compartment escape is contained to the worker, and a
 * worker compromise does not hand an attacker the orchestrator's authority.
 *
 * Two surfaces:
 *
 *   - The WORKER side (`makeSigningWorkerBootstrap`) builds the wallet `@endo/exo`
 *     Far behind its InterfaceGuard and offers it as the CapTP bootstrap. This is
 *     the only place the backing signer (the real keystore handle) is ever held,
 *     and it is held in the worker process, never the executor's.
 *   - The EXECUTOR side reaches the wallet as a remote presence and `E()`s it.
 *     The executor never holds the backing signer — only a CapTP presence whose
 *     every method call is marshalled across the boundary and validated by the
 *     worker's InterfaceGuard.
 *
 * `connectSigningWorkerInProcess` wires both ends in one process (for tests and
 * as the protocol reference); it proves the executor operates the wallet purely
 * as a remote presence. The real cross-process transport (Unix socket vs. a
 * `MessageChannel` to a child process; persistent vs. spawn-fresh) is a deferred
 * OPEN QUESTION in the design, so `spawnSigningWorker` is intentionally a gated
 * stub: it refuses unless a live, authorized dispatch supplies a keystore, and
 * points at the in-process reference rather than committing to a transport that
 * has not been chosen. Dry-run never reaches any of this — the executor asserts
 * the wallet cap is absent before it would ever connect a worker.
 */

// cap-attenuation.js imports `ses` (installing the `assert` global) and the
// eventual-send shim, then calls lockdown — import it first so `@endo/captp`
// and `@endo/eventual-send` initialize against a locked-down realm.
import { makeWalletCapability, CapabilityError } from './cap-attenuation.js';

const { makeCapTP } = await import('@endo/captp');
const { E } = await import('@endo/eventual-send');

/**
 * WORKER side. Build the wallet Exo from a backing signer and return the
 * pieces a CapTP endpoint needs to offer it as the bootstrap.
 *
 * @param {object} backing   the real signer (held ONLY in the worker process)
 * @param {string[]} [methods]
 * @returns {{ bootstrap: object, revoke: () => void }}
 */
export function makeSigningWorkerBootstrap(backing, methods) {
  const { exo, revoke } = makeWalletCapability(backing, methods);
  return { bootstrap: exo, revoke };
}

/**
 * Reference / test transport: wire an executor end and a worker end to each
 * other in a single process. Returns the executor's remote wallet presence (a
 * CapTP presence, NOT the backing signer) and a teardown that aborts both ends
 * and revokes the wallet.
 *
 * The executor must drive the returned `wallet` only through `E(wallet).method(…)`
 * — it is a promise-for-presence, exactly as it would be across a socket.
 *
 * @param {object} args
 * @param {object} args.backing
 * @param {string[]} [args.methods]
 * @returns {{ wallet: object, E: typeof E, revoke: () => void, teardown: () => void }}
 */
export function connectSigningWorkerInProcess(args) {
  const { backing, methods } = args;
  const { bootstrap, revoke } = makeSigningWorkerBootstrap(backing, methods);

  let executorDispatch;
  let workerDispatch;
  const executorEnd = makeCapTP('executor', (m) => workerDispatch(m), undefined);
  const workerEnd = makeCapTP('signing-worker', (m) => executorDispatch(m), () => bootstrap);
  executorDispatch = executorEnd.dispatch;
  workerDispatch = workerEnd.dispatch;

  const wallet = executorEnd.getBootstrap();
  const teardown = () => {
    revoke();
    try { executorEnd.abort(); } catch { /* already torn down */ }
    try { workerEnd.abort(); } catch { /* already torn down */ }
  };
  return { wallet, E, revoke, teardown };
}

/**
 * EXECUTOR side, cross-process form — a GATED stub.
 *
 * The cross-process transport is a deferred open question in
 * `designs/cap-attenuation.md` (§ Open questions: Unix socket vs. TCP;
 * persistent vs. ephemeral worker). Until the maintainer settles it, this
 * refuses to run: it is reachable only on an authorized live dispatch that
 * supplies a keystore handle, and even then it throws, directing the caller to
 * the in-process reference rather than committing to an unchosen transport.
 *
 * Dry-run never calls this; the executor proves the wallet cap is absent first.
 *
 * @param {object} args
 * @param {boolean} [args.live_authorized]
 * @param {string} [args.keystorePath]
 * @returns {never}
 */
export function spawnSigningWorker(args = {}) {
  if (args.live_authorized !== true) {
    throw new CapabilityError(
      'spawnSigningWorker: refused — live signing requires live_authorized: true',
    );
  }
  if (!args.keystorePath) {
    throw new CapabilityError(
      'spawnSigningWorker: refused — no keystore handle supplied for a live signing worker',
    );
  }
  throw new Error(
    'spawnSigningWorker: cross-process transport not yet chosen ' +
    '(see designs/cap-attenuation.md § Process boundary / § Open questions). ' +
    'Use connectSigningWorkerInProcess for the protocol reference.',
  );
}
