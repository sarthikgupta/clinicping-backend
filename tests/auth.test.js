// ── auth.test.js ──────────────────────────────────────────────────────────────
// Tests for ClinicPing auth and settings business logic

function generateClinicCode(name) {
  const clean = name.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 6);
  const suffix = 'ABC'; // deterministic for testing
  return clean + suffix;
}

function generateUsername(name) {
  return name.toLowerCase()
    .replace(/^dr\.?\s*/i, 'dr.')
    .replace(/\s+/g, '.')
    .replace(/[^a-z0-9_.]/g, '')
    .slice(0, 20);
}

function isValidUsername(username) {
  return /^[a-z0-9_.]{3,20}$/.test(username);
}

function isValidClinicCode(code) {
  return /^[A-Z0-9]{3,10}$/.test(code);
}

function sanitizeUsername(input) {
  return input.toLowerCase().replace(/[^a-z0-9_.]/g, '');
}

function getRoleDefaultPath(role) {
  if (role === 'doctor') return '/doctor';
  if (role === 'receptionist') return '/queue';
  return '/dashboard';
}

function canAccessRoute(role, route) {
  const roleRoutes = {
    admin: ['/dashboard', '/queue', '/patients', '/followups', '/doctor', '/analytics', '/settings'],
    doctor: ['/dashboard', '/queue', '/patients', '/followups', '/doctor', '/analytics', '/settings'],
    receptionist: ['/dashboard', '/queue', '/patients', '/followups', '/settings'],
  };
  return (roleRoutes[role] || []).includes(route);
}

// ── generateUsername tests ────────────────────────────────────────────────────
describe('generateUsername', () => {
  test('Dr. prefix handled', () => {
    expect(generateUsername('Dr. Anumeha Bhalla')).toBe('dr.anumeha.bhalla');
  });

  test('Dr prefix without dot', () => {
    expect(generateUsername('Dr Rajendra Singh')).toBe('dr.rajendra.singh');
  });

  test('simple name', () => {
    expect(generateUsername('Sarthak Gupta')).toBe('sarthak.gupta');
  });

  test('special characters removed', () => {
    expect(generateUsername('John O\'Brien')).toBe('john.obrien');
  });

  test('truncated to 20 chars', () => {
    const long = generateUsername('Dr. Verylongfirstname Verylonglastname');
    expect(long.length).toBeLessThanOrEqual(20);
  });

  test('lowercase output', () => {
    expect(generateUsername('UPPERCASE NAME')).toMatch(/^[a-z0-9_.]+$/);
  });
});

// ── isValidUsername tests ─────────────────────────────────────────────────────
describe('isValidUsername', () => {
  test('valid simple username', () => {
    expect(isValidUsername('dr.anumeha')).toBe(true);
  });

  test('valid with underscore', () => {
    expect(isValidUsername('reception_1')).toBe(true);
  });

  test('too short (2 chars)', () => {
    expect(isValidUsername('ab')).toBe(false);
  });

  test('too long (21 chars)', () => {
    expect(isValidUsername('a'.repeat(21))).toBe(false);
  });

  test('uppercase not allowed', () => {
    expect(isValidUsername('DrAnu')).toBe(false);
  });

  test('spaces not allowed', () => {
    expect(isValidUsername('dr anu')).toBe(false);
  });

  test('special chars not allowed', () => {
    expect(isValidUsername('dr@anu')).toBe(false);
  });

  test('exactly 3 chars valid', () => {
    expect(isValidUsername('abc')).toBe(true);
  });

  test('exactly 20 chars valid', () => {
    expect(isValidUsername('a'.repeat(20))).toBe(true);
  });
});

// ── isValidClinicCode tests ───────────────────────────────────────────────────
describe('isValidClinicCode', () => {
  test('valid 6 char code', () => {
    expect(isValidClinicCode('BHALLA')).toBe(true);
  });

  test('valid alphanumeric', () => {
    expect(isValidClinicCode('CLINIC1')).toBe(true);
  });

  test('too short', () => {
    expect(isValidClinicCode('AB')).toBe(false);
  });

  test('too long', () => {
    expect(isValidClinicCode('TOOLONGCODE1')).toBe(false);
  });

  test('lowercase not allowed', () => {
    expect(isValidClinicCode('bhalla')).toBe(false);
  });

  test('special chars not allowed', () => {
    expect(isValidClinicCode('BHALL@')).toBe(false);
  });

  test('exactly 3 chars', () => {
    expect(isValidClinicCode('ABC')).toBe(true);
  });

  test('exactly 10 chars', () => {
    expect(isValidClinicCode('ABCDEFGHIJ')).toBe(true);
  });
});

// ── getRoleDefaultPath tests ──────────────────────────────────────────────────
describe('getRoleDefaultPath', () => {
  test('doctor → /doctor', () => {
    expect(getRoleDefaultPath('doctor')).toBe('/doctor');
  });

  test('receptionist → /queue', () => {
    expect(getRoleDefaultPath('receptionist')).toBe('/queue');
  });

  test('admin → /dashboard', () => {
    expect(getRoleDefaultPath('admin')).toBe('/dashboard');
  });

  test('unknown role → /dashboard', () => {
    expect(getRoleDefaultPath('unknown')).toBe('/dashboard');
  });
});

// ── canAccessRoute tests ──────────────────────────────────────────────────────
describe('canAccessRoute', () => {
  test('admin can access /doctor', () => {
    expect(canAccessRoute('admin', '/doctor')).toBe(true);
  });

  test('admin can access /analytics', () => {
    expect(canAccessRoute('admin', '/analytics')).toBe(true);
  });

  test('receptionist cannot access /doctor', () => {
    expect(canAccessRoute('receptionist', '/doctor')).toBe(false);
  });

  test('receptionist cannot access /analytics', () => {
    expect(canAccessRoute('receptionist', '/analytics')).toBe(false);
  });

  test('receptionist can access /queue', () => {
    expect(canAccessRoute('receptionist', '/queue')).toBe(true);
  });

  test('doctor can access /doctor', () => {
    expect(canAccessRoute('doctor', '/doctor')).toBe(true);
  });

  test('doctor can access /analytics', () => {
    expect(canAccessRoute('doctor', '/analytics')).toBe(true);
  });

  test('unknown role cannot access anything', () => {
    expect(canAccessRoute('hacker', '/dashboard')).toBe(false);
  });
});

// ── sanitizeUsername tests ────────────────────────────────────────────────────
describe('sanitizeUsername', () => {
  test('converts uppercase to lowercase', () => {
    expect(sanitizeUsername('DrAnu')).toBe('dranu');
  });

  test('removes special chars', () => {
    expect(sanitizeUsername('dr@anu!')).toBe('dranu');
  });

  test('preserves dots and underscores', () => {
    expect(sanitizeUsername('dr.anu_meha')).toBe('dr.anu_meha');
  });

  test('removes spaces', () => {
    expect(sanitizeUsername('dr anu')).toBe('dranu');
  });
});
