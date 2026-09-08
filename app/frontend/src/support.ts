/** Web Bluetooth exists in Chromium browsers only (Chrome, Edge, Opera). */
export function isWebBluetoothAvailable(nav: { bluetooth?: unknown } | undefined): boolean {
    return !!nav && typeof nav.bluetooth === "object" && nav.bluetooth !== null;
}
