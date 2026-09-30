// Display-only time handling for backend timestamps.
//
// The backend stores every timestamp in UTC — and must keep doing so: the EEG /
// timeline alignment (ciq/eeg/combine.py, scripts/sync_muse_survey.py) joins on
// those UTC values, so the CSV exports stay UTC too. Most rows are written by
// datetime.utcnow().isoformat(), i.e. UTC with NO offset ("2026-09-30T06:33:04"),
// which `new Date()` would misread as browser-local time. Everything shown on
// screen goes through here instead: offset-less values are read as UTC, and all
// times are displayed in Sri Lanka time, whatever the viewer's own timezone.

export const DISPLAY_TIME_ZONE = "Asia/Colombo";

const HAS_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/** Parse a backend timestamp; one without a zone designator is UTC, not local time. */
export function parseServerDate(value: string | null | undefined): Date {
    if (!value) return new Date(NaN);
    const iso = value.trim().replace(" ", "T");
    return new Date(HAS_ZONE.test(iso) ? iso : `${iso}Z`);
}

/** Format a backend timestamp in Sri Lanka time ("—" when missing/unparseable). */
export function formatServerDate(
    value: string | null | undefined,
    options: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" },
    locale?: string
): string {
    const date = parseServerDate(value);
    if (Number.isNaN(date.getTime())) return "—";
    return date.toLocaleString(locale, { ...options, timeZone: DISPLAY_TIME_ZONE });
}
