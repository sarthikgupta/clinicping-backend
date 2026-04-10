const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const supabase = require('../db/supabase');

// ── POST /api/auth/signup ─────────────────────────────────────────────────────
// Creates clinic + first admin user (admin uses email + username)
router.post('/signup', [
  body('clinic_name').trim().notEmpty().withMessage('Clinic name required'),
  body('name').trim().notEmpty().withMessage('Your name required'),
  body('email').isEmail().withMessage('Valid email required'),
  body('phone').trim().notEmpty().withMessage('Phone required'),
  body('password').isLength({ min: 6 }).withMessage('Password min 6 chars'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { clinic_name, name, email, phone, password, city } = req.body;

  // Generate username from name for admin
  const baseUsername = generateUsername(name);

  try {
    // Check duplicate email
    const { data: existingEmail } = await supabase
      .from('clinic_users')
      .select('id')
      .eq('email', email)
      .single();
    if (existingEmail) return res.status(409).json({ error: 'Email already registered' });

    // Create clinic
    const { data: clinic, error: cErr } = await supabase
      .from('clinics')
      .insert({
        name: clinic_name,
        doctor_name: name,
        email,
        phone,
        password_hash: 'managed_by_users',
        city: city || '',
      })
      .select('id, name')
      .single();
    if (cErr) throw cErr;

    // Create admin user with username
    const password_hash = await bcrypt.hash(password, 12);
    const { data: user, error: uErr } = await supabase
      .from('clinic_users')
      .insert({
        clinic_id: clinic.id,
        name,
        email,
        username: baseUsername,
        password_hash,
        role: 'admin',
      })
      .select('id, name, email, username, role, clinic_id')
      .single();
    if (uErr) throw uErr;

    const token = makeToken(user, clinic);
    res.status(201).json({ token, user: safeUser(user), clinic });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Signup failed. ' + (err.message || '') });
  }
});

// ── POST /api/auth/login ──────────────────────────────────────────────────────
// Login with email (admin) OR username (all roles)
router.post('/login', [
  body('login').notEmpty().withMessage('Email or username required'),
  body('password').notEmpty().withMessage('Password required'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { login, password, clinic_id } = req.body;
  const isEmail = login.includes('@');

  try {
    let user;

    if (isEmail) {
      // Email login — for admin
      const { data } = await supabase
        .from('clinic_users')
        .select('*, clinics(id, name, rx_template, rx_color, doctor_name, phone, clinic_address, clinic_timings, rx_footer_note, doctor_qualification, doctor_registration)')
        .eq('email', login)
        .eq('is_active', true)
        .single();
      user = data;
    } else {
      // Username login — unique within a clinic
      // If clinic_id provided, use it. Otherwise find by username across all clinics
      // (username should be unique per clinic, so we need clinic context)
      // We find all matching usernames and let password verify the right one
      const { data: users } = await supabase
        .from('clinic_users')
        .select('*, clinics(id, name, rx_template, rx_color, doctor_name, phone, clinic_address, clinic_timings, rx_footer_note, doctor_qualification, doctor_registration)')
        .eq('username', login)
        .eq('is_active', true);

      if (!users || users.length === 0) {
        return res.status(401).json({ error: 'Invalid username or password' });
      }

      // If multiple clinics have same username, try each password
      for (const u of users) {
        const match = await bcrypt.compare(password, u.password_hash);
        if (match) { user = u; break; }
      }

      if (!user) return res.status(401).json({ error: 'Invalid username or password' });
      // Skip password check below since we already verified
      const clinic = user.clinics;
      const token = makeToken(user, clinic);
      return res.json({ token, user: safeUser(user), clinic });
    }

    if (!user) return res.status(401).json({ error: 'Invalid email or password' });

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid email or password' });

    const clinic = user.clinics;
    const token = makeToken(user, clinic);
    res.json({ token, user: safeUser(user), clinic });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ── POST /api/auth/users ──────────────────────────────────────────────────────
// Admin creates staff — username required, email optional
router.post('/users', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token' });

  let decoded;
  try { decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET); }
  catch { return res.status(401).json({ error: 'Invalid token' }); }

  if (decoded.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

  const { name, username, email, password, role, qualification, registration_no, speciality } = req.body;

  if (!name || !username || !password || !role) {
    return res.status(400).json({ error: 'name, username, password, role required' });
  }

  // Validate username format
  if (!/^[a-z0-9_.]{3,20}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-20 chars, lowercase letters/numbers/underscore/dot only' });
  }

  try {
    // Check username uniqueness within clinic
    const { data: existingUsername } = await supabase
      .from('clinic_users')
      .select('id')
      .eq('clinic_id', decoded.clinic_id)
      .eq('username', username)
      .single();
    if (existingUsername) return res.status(409).json({ error: 'Username already taken in this clinic' });

    // Check email if provided
    if (email) {
      const { data: existingEmail } = await supabase
        .from('clinic_users')
        .select('id')
        .eq('email', email)
        .single();
      if (existingEmail) return res.status(409).json({ error: 'Email already in use' });
    }

    const password_hash = await bcrypt.hash(password, 12);
    const { data: user, error } = await supabase
      .from('clinic_users')
      .insert({
        clinic_id: decoded.clinic_id,
        name,
        username,
        email: email || null,
        password_hash,
        role,
        qualification: qualification || '',
        registration_no: registration_no || '',
        speciality: speciality || '',
      })
      .select('id, name, email, username, role, qualification, registration_no, speciality, is_active, created_at')
      .single();

    if (error) throw error;
    res.status(201).json(user);
  } catch (err) {
    console.error('Create user error:', err);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// ── GET /api/auth/users ───────────────────────────────────────────────────────
router.get('/users', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token' });

  let decoded;
  try { decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET); }
  catch { return res.status(401).json({ error: 'Invalid token' }); }

  const { data, error } = await supabase
    .from('clinic_users')
    .select('id, name, email, username, role, qualification, registration_no, speciality, is_active, created_at')
    .eq('clinic_id', decoded.clinic_id)
    .order('role').order('name');

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── PATCH /api/auth/users/:id ─────────────────────────────────────────────────
router.patch('/users/:id', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token' });

  let decoded;
  try { decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET); }
  catch { return res.status(401).json({ error: 'Invalid token' }); }

  if (decoded.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

  const { name, username, qualification, registration_no, speciality, is_active } = req.body;
  const updates = {};
  if (name !== undefined) updates.name = name;
  if (qualification !== undefined) updates.qualification = qualification;
  if (registration_no !== undefined) updates.registration_no = registration_no;
  if (speciality !== undefined) updates.speciality = speciality;
  if (is_active !== undefined) updates.is_active = is_active;

  // Username change — check uniqueness
  if (username !== undefined) {
    if (!/^[a-z0-9_.]{3,20}$/.test(username)) {
      return res.status(400).json({ error: 'Invalid username format' });
    }
    const { data: existing } = await supabase
      .from('clinic_users')
      .select('id')
      .eq('clinic_id', decoded.clinic_id)
      .eq('username', username)
      .neq('id', req.params.id)
      .single();
    if (existing) return res.status(409).json({ error: 'Username already taken' });
    updates.username = username;
  }

  const { data, error } = await supabase
    .from('clinic_users')
    .update(updates)
    .eq('id', req.params.id)
    .eq('clinic_id', decoded.clinic_id)
    .select('id, name, email, username, role, qualification, registration_no, speciality, is_active')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function generateUsername(name) {
  return name
    .toLowerCase()
    .replace(/^dr\.?\s*/i, 'dr.')
    .replace(/\s+/g, '.')
    .replace(/[^a-z0-9_.]/g, '')
    .slice(0, 20);
}

function makeToken(user, clinic) {
  return jwt.sign(
    {
      user_id: user.id,
      clinic_id: user.clinic_id,
      role: user.role,
      name: user.name,
      email: user.email || null,
      username: user.username || null,
    },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );
}

function safeUser(user) {
  const { password_hash, clinics, ...safe } = user;
  return safe;
}

module.exports = router;
