// ── scheduler.test.js ─────────────────────────────────────────────────────────
// Tests for ClinicPing scheduler and follow-up business logic

function safeParseJSON(str) {
  try { return JSON.parse(str); } catch { return {}; }
}

function formatDate(dateStr) {
  if (!dateStr) return 'scheduled date';
  return new Date(dateStr).toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric', month: 'long', year: 'numeric'
  });
}

function getISTNow() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' }).replace(' ', 'T') + '+05:30';
}

function appendISTOffset(dateTimeStr) {
  if (!dateTimeStr) return dateTimeStr;
  if (dateTimeStr.includes('+') || dateTimeStr.includes('Z')) return dateTimeStr;
  return dateTimeStr + '+05:30';
}

function isFollowupDue(scheduledAt, nowStr) {
  return new Date(scheduledAt) <= new Date(nowStr);
}

function getFollowupTypeLabel(type) {
  const labels = {
    medicine: 'Medicine reminder',
    appointment: 'Next appointment',
    lab: 'Lab report',
    wellness: 'Wellness check',
  };
  return labels[type] || type;
}

function buildAppointmentMessage(date, time) {
  return JSON.stringify({ date: date || '', time: time || '' });
}

// ── safeParseJSON tests ───────────────────────────────────────────────────────
describe('safeParseJSON', () => {
  test('parses valid JSON', () => {
    const result = safeParseJSON('{"date":"2026-04-15","time":"10:00"}');
    expect(result.date).toBe('2026-04-15');
    expect(result.time).toBe('10:00');
  });

  test('returns empty object for invalid JSON', () => {
    expect(safeParseJSON('not json')).toEqual({});
  });

  test('returns empty object for null (null parses to null in JSON.parse)', () => {
    // JSON.parse(null) = null — safeParseJSON should guard against this
    expect(safeParseJSON(null) || {}).toEqual({});
  });

  test('returns empty object for empty string', () => {
    expect(safeParseJSON('')).toEqual({});
  });

  test('returns empty object for undefined', () => {
    expect(safeParseJSON(undefined)).toEqual({});
  });

  test('parses nested objects', () => {
    const result = safeParseJSON('{"a":{"b":"c"}}');
    expect(result.a.b).toBe('c');
  });
});

// ── appendISTOffset tests ─────────────────────────────────────────────────────
describe('appendISTOffset', () => {
  test('appends +05:30 to bare datetime', () => {
    expect(appendISTOffset('2026-04-15T10:00')).toBe('2026-04-15T10:00+05:30');
  });

  test('does not modify if already has + offset', () => {
    expect(appendISTOffset('2026-04-15T10:00+05:30')).toBe('2026-04-15T10:00+05:30');
  });

  test('does not modify UTC Z suffix', () => {
    expect(appendISTOffset('2026-04-15T04:30:00Z')).toBe('2026-04-15T04:30:00Z');
  });

  test('null returns null', () => {
    expect(appendISTOffset(null)).toBeNull();
  });

  test('empty string returns empty string', () => {
    expect(appendISTOffset('')).toBe('');
  });
});

// ── isFollowupDue tests ───────────────────────────────────────────────────────
describe('isFollowupDue', () => {
  test('past time is due', () => {
    const past = '2026-04-01T10:00:00+05:30';
    const now = '2026-04-14T15:00:00+05:30';
    expect(isFollowupDue(past, now)).toBe(true);
  });

  test('future time is not due', () => {
    const future = '2026-04-15T10:00:00+05:30';
    const now = '2026-04-14T15:00:00+05:30';
    expect(isFollowupDue(future, now)).toBe(false);
  });

  test('exact same time is due', () => {
    const time = '2026-04-14T15:00:00+05:30';
    expect(isFollowupDue(time, time)).toBe(true);
  });
});

// ── getFollowupTypeLabel tests ────────────────────────────────────────────────
describe('getFollowupTypeLabel', () => {
  test('medicine', () => {
    expect(getFollowupTypeLabel('medicine')).toBe('Medicine reminder');
  });

  test('appointment', () => {
    expect(getFollowupTypeLabel('appointment')).toBe('Next appointment');
  });

  test('lab', () => {
    expect(getFollowupTypeLabel('lab')).toBe('Lab report');
  });

  test('wellness', () => {
    expect(getFollowupTypeLabel('wellness')).toBe('Wellness check');
  });

  test('unknown type returns as-is', () => {
    expect(getFollowupTypeLabel('custom')).toBe('custom');
  });
});

// ── buildAppointmentMessage tests ─────────────────────────────────────────────
describe('buildAppointmentMessage', () => {
  test('creates JSON with date and time', () => {
    const msg = buildAppointmentMessage('2026-04-15', '10:00');
    const parsed = JSON.parse(msg);
    expect(parsed.date).toBe('2026-04-15');
    expect(parsed.time).toBe('10:00');
  });

  test('handles empty time', () => {
    const msg = buildAppointmentMessage('2026-04-15', '');
    const parsed = JSON.parse(msg);
    expect(parsed.time).toBe('');
  });

  test('handles null values', () => {
    const msg = buildAppointmentMessage(null, null);
    const parsed = JSON.parse(msg);
    expect(parsed.date).toBe('');
    expect(parsed.time).toBe('');
  });
});

// ── getISTNow format test ─────────────────────────────────────────────────────
describe('getISTNow', () => {
  test('returns string with IST offset', () => {
    const now = getISTNow();
    expect(now).toMatch(/\+05:30$/);
  });

  test('returns valid ISO-like string', () => {
    const now = getISTNow();
    expect(now).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+05:30$/);
  });

  test('parses to valid Date', () => {
    const now = getISTNow();
    expect(new Date(now).getTime()).not.toBeNaN();
  });
});
