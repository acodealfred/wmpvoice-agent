// Turns a thrown Web Bluetooth error into something an operator at the bench
// can act on. The raw message is kept in the fallback so nothing is hidden.

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function explainConnectError(e: unknown): string {
    const msg = message(e);
    if (/cancel|chooser|no device|user gesture/i.test(msg)) {
        return "No headband was chosen. Turn the headband on, then click Pair headband and pick it from the list.";
    }
    if (/no reply/i.test(msg)) {
        return "The headband connected but did not answer. Turn it off and on, then try again.";
    }
    return `Could not connect: ${msg}`;
}

/** Pairing succeeded but the start/resume commands did not get through. */
export function explainStartError(e: unknown): string {
    const msg = message(e);
    if (/disconnect|not connected|network/i.test(msg)) {
        return "The headband dropped the connection before streaming started. Turn it off and on, then pair again.";
    }
    return `Could not start streaming: ${msg}`;
}
