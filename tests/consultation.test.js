// ── consultation.test.js ──────────────────────────────────────────────────────
// Tests for ClinicPing prescription and consultation logic

function formatMedicinesForWhatsApp(medicines) {
  if (!medicines || medicines.length === 0) return 'Doctor se poochhen';
  return medicines
    .filter(m => m.name)
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
    .map((m, i) => `${i + 1}. ${m.name} — ${m.dose || ''} ${m.duration ? '(' + m.duration + ')' : ''}`.trim())
    .join(' | ');
}

function formatTestsForWhatsApp(tests) {
  if (!tests || tests.length === 0) return 'Koi nahi';
  return tests.map(t => t.name).filter(Boolean).join(', ');
}

function getVisitDateIST() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Kolkata' });
}

function formatVisitDateDisplay(dateStr) {
  if (!dateStr) return '';
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-IN', {
    day: 'numeric', month: 'long', year: 'numeric'
  });
}

function buildConsultationPayload(form) {
  return {
    symptoms: form.symptoms || '',
    diagnosis: form.diagnosis || '',
    medicines: (form.medicines || []).filter(m => m.name && m.name.trim()),
    tests_ordered: (form.tests || []).map((name, i) => ({ name, sort_order: i })),
    next_appointment_date: form.apptDate || null,
    next_appointment_time: form.apptTime || null,
    next_appointment_note: form.apptNote || null,
  };
}

function hasMedicines(medicines) {
  return medicines && medicines.some(m => m.name && m.name.trim());
}

function getDoseLabel(dose) {
  if (!dose) return '';
  const parts = dose.split('-');
  if (parts.length !== 4) return dose;
  const labels = [];
  if (parts[0] === '1') labels.push('Morning');
  if (parts[1] === '1') labels.push('Afternoon');
  if (parts[2] === '1') labels.push('Evening');
  if (parts[3] === '1') labels.push('Night');
  return labels.join(', ') || dose;
}

// ── formatMedicinesForWhatsApp tests ─────────────────────────────────────────
describe('formatMedicinesForWhatsApp', () => {
  test('formats single medicine', () => {
    const meds = [{ name: 'Paracetamol', dose: '1-0-1-0', duration: '5 days', sort_order: 0 }];
    expect(formatMedicinesForWhatsApp(meds)).toBe('1. Paracetamol — 1-0-1-0 (5 days)');
  });

  test('formats multiple medicines with pipe separator', () => {
    const meds = [
      { name: 'Paracetamol', dose: '1-0-1-0', duration: '5 days', sort_order: 0 },
      { name: 'Amoxicillin', dose: '1-0-0-1', duration: '7 days', sort_order: 1 },
    ];
    const result = formatMedicinesForWhatsApp(meds);
    expect(result).toContain(' | ');
    expect(result).toContain('1. Paracetamol');
    expect(result).toContain('2. Amoxicillin');
  });

  test('no newlines in output', () => {
    const meds = [
      { name: 'Med1', dose: '1-0-0-0', duration: '30 days', sort_order: 0 },
      { name: 'Med2', dose: '0-0-0-1', duration: '15 days', sort_order: 1 },
    ];
    const result = formatMedicinesForWhatsApp(meds);
    expect(result).not.toContain('\n');
  });

  test('empty array returns fallback', () => {
    expect(formatMedicinesForWhatsApp([])).toBe('Doctor se poochhen');
  });

  test('null returns fallback', () => {
    expect(formatMedicinesForWhatsApp(null)).toBe('Doctor se poochhen');
  });

  test('sorts by sort_order', () => {
    const meds = [
      { name: 'Second', dose: '', duration: '', sort_order: 1 },
      { name: 'First', dose: '', duration: '', sort_order: 0 },
    ];
    const result = formatMedicinesForWhatsApp(meds);
    expect(result.indexOf('First')).toBeLessThan(result.indexOf('Second'));
  });

  test('filters out nameless medicines', () => {
    const meds = [
      { name: 'Paracetamol', dose: '1-0-0-0', sort_order: 0 },
      { name: '', dose: '0-0-0-1', sort_order: 1 },
    ];
    const result = formatMedicinesForWhatsApp(meds);
    expect(result).not.toContain(' | ');
  });

  test('medicine without duration', () => {
    const meds = [{ name: 'Vitamin C', dose: '0-1-0-0', duration: '', sort_order: 0 }];
    const result = formatMedicinesForWhatsApp(meds);
    expect(result).toBe('1. Vitamin C — 0-1-0-0');
  });
});

// ── formatTestsForWhatsApp tests ──────────────────────────────────────────────
describe('formatTestsForWhatsApp', () => {
  test('formats single test', () => {
    expect(formatTestsForWhatsApp([{ name: 'CBC' }])).toBe('CBC');
  });

  test('formats multiple tests with comma', () => {
    expect(formatTestsForWhatsApp([{ name: 'CBC' }, { name: 'LFT' }])).toBe('CBC, LFT');
  });

  test('empty array returns fallback', () => {
    expect(formatTestsForWhatsApp([])).toBe('Koi nahi');
  });

  test('null returns fallback', () => {
    expect(formatTestsForWhatsApp(null)).toBe('Koi nahi');
  });
});

// ── getDoseLabel tests ────────────────────────────────────────────────────────
describe('getDoseLabel', () => {
  test('morning only', () => {
    expect(getDoseLabel('1-0-0-0')).toBe('Morning');
  });

  test('morning and night', () => {
    expect(getDoseLabel('1-0-0-1')).toBe('Morning, Night');
  });

  test('all four times', () => {
    expect(getDoseLabel('1-1-1-1')).toBe('Morning, Afternoon, Evening, Night');
  });

  test('none selected returns dose string', () => {
    expect(getDoseLabel('0-0-0-0')).toBe('0-0-0-0');
  });

  test('custom dose returns as-is', () => {
    expect(getDoseLabel('SOS')).toBe('SOS');
  });

  test('empty returns empty', () => {
    expect(getDoseLabel('')).toBe('');
  });

  test('null returns empty', () => {
    expect(getDoseLabel(null)).toBe('');
  });
});

// ── buildConsultationPayload tests ────────────────────────────────────────────
describe('buildConsultationPayload', () => {
  test('filters empty medicine names', () => {
    const form = {
      symptoms: 'Fever',
      medicines: [
        { name: 'Paracetamol', dose: '1-0-0-0' },
        { name: '', dose: '0-0-0-1' },
        { name: '   ', dose: '1-1-0-0' },
      ],
      tests: [],
    };
    const payload = buildConsultationPayload(form);
    expect(payload.medicines).toHaveLength(1);
    expect(payload.medicines[0].name).toBe('Paracetamol');
  });

  test('maps tests to objects with sort_order', () => {
    const form = { tests: ['CBC', 'LFT', 'ECG'], medicines: [] };
    const payload = buildConsultationPayload(form);
    expect(payload.tests_ordered[0]).toEqual({ name: 'CBC', sort_order: 0 });
    expect(payload.tests_ordered[2]).toEqual({ name: 'ECG', sort_order: 2 });
  });

  test('null apptDate becomes null', () => {
    const payload = buildConsultationPayload({ medicines: [], tests: [] });
    expect(payload.next_appointment_date).toBeNull();
  });

  test('empty form produces valid payload', () => {
    const payload = buildConsultationPayload({});
    expect(payload.symptoms).toBe('');
    expect(payload.diagnosis).toBe('');
    expect(payload.medicines).toHaveLength(0);
  });
});

// ── hasMedicines tests ────────────────────────────────────────────────────────
describe('hasMedicines', () => {
  test('returns true when medicines present', () => {
    expect(hasMedicines([{ name: 'Paracetamol' }])).toBe(true);
  });

  test('returns false for empty array', () => {
    expect(hasMedicines([])).toBe(false);
  });

  test('returns false when all names empty', () => {
    expect(hasMedicines([{ name: '' }, { name: '  ' }])).toBe(false);
  });

  test('returns false for null (falsy check)', () => {
    expect(hasMedicines(null)).toBeFalsy();
  });
});
