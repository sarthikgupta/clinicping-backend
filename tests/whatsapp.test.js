// ── whatsapp.test.js ──────────────────────────────────────────────────────────
// Tests for ClinicPing WhatsApp service helper functions

// Extract pure functions from whatsapp.js for testing
// (without requiring axios/supabase)

function firstName(name) {
  return (name || '').split(' ')[0] || name || '';
}

function formatPhone(phone) {
  const digits = (phone || '').replace(/[\s\-\+]/g, '');
  if (digits.startsWith('91') && digits.length === 12) return digits;
  if (digits.length === 10) return '91' + digits;
  return digits;
}

function clean(str) {
  return String(str || '')
    .replace(/[\t\n\r]/g, ' ')
    .replace(/\s{3,}/g, '  ')
    .trim();
}

function toHindiTime(timeStr) {
  if (!timeStr) return '';
  let hours, minutes;
  if (timeStr.includes('AM') || timeStr.includes('PM')) {
    const [timePart, period] = timeStr.split(' ');
    const [h, m] = timePart.split(':').map(Number);
    hours = period === 'PM' && h !== 12 ? h + 12 : (period === 'AM' && h === 12 ? 0 : h);
    minutes = m || 0;
  } else {
    [hours, minutes] = timeStr.split(':').map(Number);
  }
  let prefix;
  if (hours >= 5 && hours < 12) prefix = 'subah';
  else if (hours >= 12 && hours < 16) prefix = 'dopahar';
  else if (hours >= 16 && hours < 19) prefix = 'sham';
  else prefix = 'raat';
  const h12 = hours % 12 || 12;
  const minStr = minutes > 0 ? `:${String(minutes).padStart(2, '0')}` : '';
  return `${prefix} ${h12}${minStr} baje`;
}

function estimateWaitTime(position, avgConsultMinutes = 10) {
  return position * avgConsultMinutes;
}

// ── toHindiTime tests ─────────────────────────────────────────────────────────
describe('toHindiTime', () => {
  test('morning 10:00 → subah 10 baje', () => {
    expect(toHindiTime('10:00')).toBe('subah 10 baje');
  });

  test('afternoon 14:30 → dopahar 2:30 baje', () => {
    expect(toHindiTime('14:30')).toBe('dopahar 2:30 baje');
  });

  test('evening 17:00 → sham 5 baje', () => {
    expect(toHindiTime('17:00')).toBe('sham 5 baje');
  });

  test('night 21:00 → raat 9 baje', () => {
    expect(toHindiTime('21:00')).toBe('raat 9 baje');
  });

  test('midnight 00:00 → raat 12 baje', () => {
    expect(toHindiTime('00:00')).toBe('raat 12 baje');
  });

  test('noon 12:00 → dopahar 12 baje', () => {
    expect(toHindiTime('12:00')).toBe('dopahar 12 baje');
  });

  test('early morning 05:00 → subah 5 baje', () => {
    expect(toHindiTime('05:00')).toBe('subah 5 baje');
  });

  test('evening boundary 19:00 → raat 7 baje', () => {
    expect(toHindiTime('19:00')).toBe('raat 7 baje');
  });

  test('AM/PM format 10:00 AM → subah 10 baje', () => {
    expect(toHindiTime('10:00 AM')).toBe('subah 10 baje');
  });

  test('AM/PM format 2:30 PM → dopahar 2:30 baje', () => {
    expect(toHindiTime('2:30 PM')).toBe('dopahar 2:30 baje');
  });

  test('12:00 AM (midnight) → raat 12 baje', () => {
    expect(toHindiTime('12:00 AM')).toBe('raat 12 baje');
  });

  test('12:00 PM (noon) → dopahar 12 baje', () => {
    expect(toHindiTime('12:00 PM')).toBe('dopahar 12 baje');
  });

  test('empty string → empty string', () => {
    expect(toHindiTime('')).toBe('');
  });

  test('null → empty string', () => {
    expect(toHindiTime(null)).toBe('');
  });

  test('minutes preserved correctly', () => {
    expect(toHindiTime('09:15')).toBe('subah 9:15 baje');
    expect(toHindiTime('13:45')).toBe('dopahar 1:45 baje');
  });
});

// ── firstName tests ───────────────────────────────────────────────────────────
describe('firstName', () => {
  test('extracts first word', () => {
    expect(firstName('Gurpreet Kaur')).toBe('Gurpreet');
  });

  test('single name returns as-is', () => {
    expect(firstName('Sarthak')).toBe('Sarthak');
  });

  test('three part name', () => {
    expect(firstName('Dr Anumeha Bhalla')).toBe('Dr');
  });

  test('empty string', () => {
    expect(firstName('')).toBe('');
  });

  test('null', () => {
    expect(firstName(null)).toBe('');
  });

  test('undefined', () => {
    expect(firstName(undefined)).toBe('');
  });
});

// ── formatPhone tests ─────────────────────────────────────────────────────────
describe('formatPhone', () => {
  test('10 digit number gets 91 prefix', () => {
    expect(formatPhone('9878050904')).toBe('919878050904');
  });

  test('already has 91 prefix', () => {
    expect(formatPhone('919878050904')).toBe('919878050904');
  });

  test('strips spaces', () => {
    expect(formatPhone('98780 50904')).toBe('919878050904');
  });

  test('strips dashes', () => {
    expect(formatPhone('987-805-0904')).toBe('919878050904');
  });

  test('strips + prefix', () => {
    expect(formatPhone('+919878050904')).toBe('919878050904');
  });

  test('null returns empty', () => {
    expect(formatPhone(null)).toBe('');
  });
});

// ── clean tests ───────────────────────────────────────────────────────────────
describe('clean (Interakt/AiSensy param sanitizer)', () => {
  test('removes newlines', () => {
    expect(clean('line1\nline2')).toBe('line1 line2');
  });

  test('removes tabs', () => {
    expect(clean('col1\tcol2')).toBe('col1 col2');
  });

  test('removes carriage returns', () => {
    expect(clean('line1\r\nline2')).toBe('line1  line2');
  });

  test('collapses 3+ spaces to 2', () => {
    expect(clean('too   many    spaces')).toBe('too  many  spaces');
  });

  test('trims leading/trailing whitespace', () => {
    expect(clean('  hello world  ')).toBe('hello world');
  });

  test('null → empty string', () => {
    expect(clean(null)).toBe('');
  });

  test('undefined → empty string', () => {
    expect(clean(undefined)).toBe('');
  });

  test('normal string unchanged', () => {
    expect(clean('Gurpreet Kaur')).toBe('Gurpreet Kaur');
  });
});

// ── estimateWaitTime tests ────────────────────────────────────────────────────
describe('estimateWaitTime', () => {
  test('0 patients = 0 minutes', () => {
    expect(estimateWaitTime(0)).toBe(0);
  });

  test('1 patient = 10 minutes (default)', () => {
    expect(estimateWaitTime(1)).toBe(10);
  });

  test('5 patients = 50 minutes', () => {
    expect(estimateWaitTime(5)).toBe(50);
  });

  test('custom avg time', () => {
    expect(estimateWaitTime(3, 15)).toBe(45);
  });
});
