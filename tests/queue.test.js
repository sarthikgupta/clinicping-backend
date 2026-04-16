// ── queue.test.js ─────────────────────────────────────────────────────────────
// Tests for ClinicPing queue business logic

// ── Pure helper functions extracted from queue.js ────────────────────────────

function getDoctorFilter(user) {
  if (user.role === 'doctor') return user.id;
  return null;
}

function getNextTokenNumber(existingTokens) {
  if (!existingTokens || existingTokens.length === 0) return 1;
  return Math.max(...existingTokens.map(t => t.token_number)) + 1;
}

function getInitialStatus(activeCount) {
  return activeCount === 0 ? 'consulting' : 'waiting';
}

function buildClinicName(doctorName, clinicName) {
  if (doctorName && clinicName) return `${doctorName} — ${clinicName}`;
  return clinicName || doctorName || '';
}

function formatPatientMeta(visits) {
  if (visits === 1) return '1 visit';
  return `${visits} visits`;
}

function isValidPhone(phone) {
  if (!phone || phone.trim() === '' || phone === 'N/A') return false;
  const digits = phone.replace(/[\s\-\+]/g, '');
  return digits.length === 10 || (digits.length === 12 && digits.startsWith('91'));
}

function sortByTokenNumber(tokens) {
  return [...tokens].sort((a, b) => a.token_number - b.token_number);
}

function getActiveTokens(tokens) {
  return tokens.filter(t => ['waiting', 'next', 'consulting'].includes(t.status));
}

function groupByDoctor(tokens) {
  const groups = {};
  tokens.forEach(token => {
    const key = token.doctor_id || 'unassigned';
    if (!groups[key]) groups[key] = [];
    groups[key].push(token);
  });
  return groups;
}

// ── getDoctorFilter tests ─────────────────────────────────────────────────────
describe('getDoctorFilter', () => {
  test('doctor role returns own id', () => {
    expect(getDoctorFilter({ role: 'doctor', id: 'doc-123' })).toBe('doc-123');
  });

  test('receptionist returns null', () => {
    expect(getDoctorFilter({ role: 'receptionist', id: 'rec-123' })).toBeNull();
  });

  test('admin returns null', () => {
    expect(getDoctorFilter({ role: 'admin', id: 'adm-123' })).toBeNull();
  });
});

// ── getInitialStatus tests ────────────────────────────────────────────────────
describe('getInitialStatus', () => {
  test('empty queue → consulting', () => {
    expect(getInitialStatus(0)).toBe('consulting');
  });

  test('1 active token → waiting', () => {
    expect(getInitialStatus(1)).toBe('waiting');
  });

  test('5 active tokens → waiting', () => {
    expect(getInitialStatus(5)).toBe('waiting');
  });
});

// ── buildClinicName tests ─────────────────────────────────────────────────────
describe('buildClinicName (WhatsApp token message)', () => {
  test('both doctor and clinic name', () => {
    expect(buildClinicName('Dr. Anumeha Bhalla', 'Bhalla Clinic'))
      .toBe('Dr. Anumeha Bhalla — Bhalla Clinic');
  });

  test('only clinic name', () => {
    expect(buildClinicName('', 'Bhalla Clinic')).toBe('Bhalla Clinic');
  });

  test('only doctor name', () => {
    expect(buildClinicName('Dr. Anumeha Bhalla', '')).toBe('Dr. Anumeha Bhalla');
  });

  test('both empty', () => {
    expect(buildClinicName('', '')).toBe('');
  });
});

// ── isValidPhone tests ────────────────────────────────────────────────────────
describe('isValidPhone', () => {
  test('valid 10-digit number', () => {
    expect(isValidPhone('9878050904')).toBe(true);
  });

  test('valid with 91 prefix', () => {
    expect(isValidPhone('919878050904')).toBe(true);
  });

  test('empty string is invalid', () => {
    expect(isValidPhone('')).toBe(false);
  });

  test('N/A is invalid', () => {
    expect(isValidPhone('N/A')).toBe(false);
  });

  test('null is invalid', () => {
    expect(isValidPhone(null)).toBe(false);
  });

  test('too short number', () => {
    expect(isValidPhone('98780')).toBe(false);
  });

  test('spaces-only string', () => {
    expect(isValidPhone('   ')).toBe(false);
  });
});

// ── sortByTokenNumber tests ───────────────────────────────────────────────────
describe('sortByTokenNumber', () => {
  test('sorts tokens in ascending order', () => {
    const tokens = [
      { id: 'c', token_number: 3 },
      { id: 'a', token_number: 1 },
      { id: 'b', token_number: 2 },
    ];
    const sorted = sortByTokenNumber(tokens);
    expect(sorted.map(t => t.token_number)).toEqual([1, 2, 3]);
  });

  test('does not mutate original array', () => {
    const tokens = [{ token_number: 3 }, { token_number: 1 }];
    sortByTokenNumber(tokens);
    expect(tokens[0].token_number).toBe(3);
  });

  test('empty array returns empty', () => {
    expect(sortByTokenNumber([])).toEqual([]);
  });
});

// ── getActiveTokens tests ─────────────────────────────────────────────────────
describe('getActiveTokens', () => {
  const tokens = [
    { id: '1', status: 'waiting' },
    { id: '2', status: 'consulting' },
    { id: '3', status: 'done' },
    { id: '4', status: 'cancelled' },
    { id: '5', status: 'next' },
  ];

  test('returns only active tokens', () => {
    const active = getActiveTokens(tokens);
    expect(active).toHaveLength(3);
    expect(active.map(t => t.id)).toEqual(['1', '2', '5']);
  });

  test('excludes done and cancelled', () => {
    const active = getActiveTokens(tokens);
    expect(active.find(t => t.status === 'done')).toBeUndefined();
    expect(active.find(t => t.status === 'cancelled')).toBeUndefined();
  });

  test('empty queue returns empty', () => {
    expect(getActiveTokens([])).toEqual([]);
  });
});

// ── groupByDoctor tests ───────────────────────────────────────────────────────
describe('groupByDoctor', () => {
  const tokens = [
    { id: '1', doctor_id: 'doc-1', token_number: 1 },
    { id: '2', doctor_id: 'doc-1', token_number: 2 },
    { id: '3', doctor_id: 'doc-2', token_number: 3 },
    { id: '4', doctor_id: null, token_number: 4 },
  ];

  test('groups tokens by doctor', () => {
    const groups = groupByDoctor(tokens);
    expect(groups['doc-1']).toHaveLength(2);
    expect(groups['doc-2']).toHaveLength(1);
  });

  test('null doctor_id goes to unassigned', () => {
    const groups = groupByDoctor(tokens);
    expect(groups['unassigned']).toHaveLength(1);
  });

  test('empty array returns empty object', () => {
    expect(groupByDoctor([])).toEqual({});
  });
});

// ── formatPatientMeta tests ───────────────────────────────────────────────────
describe('formatPatientMeta', () => {
  test('1 visit singular', () => {
    expect(formatPatientMeta(1)).toBe('1 visit');
  });

  test('multiple visits plural', () => {
    expect(formatPatientMeta(5)).toBe('5 visits');
  });

  test('0 visits', () => {
    expect(formatPatientMeta(0)).toBe('0 visits');
  });
});
