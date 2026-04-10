const router = require('express').Router();
const supabase = require('../db/supabase');
const bcrypt = require('bcryptjs');
const { authMiddleware: auth } = require('../middleware/auth');

router.use(auth);

// ── GET /api/settings ─────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('clinics')
    .select('name, doctor_name, doctor_qualification, doctor_registration, phone, email, city, clinic_address, clinic_timings, rx_template, rx_color, rx_footer_note')
    .eq('id', req.clinic.id)
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── PATCH /api/settings ───────────────────────────────────────────────────────
router.patch('/', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const allowed = ['name', 'doctor_name', 'doctor_qualification', 'doctor_registration', 'phone', 'city', 'clinic_address', 'clinic_timings', 'rx_template', 'rx_color', 'rx_footer_note'];
  const updates = {};
  allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
  const { data, error } = await supabase
    .from('clinics').update(updates).eq('id', req.clinic.id)
    .select('name, doctor_name, doctor_qualification, doctor_registration, phone, email, city, clinic_address, clinic_timings, rx_template, rx_color, rx_footer_note')
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── GET /api/settings/profile ─────────────────────────────────────────────────
router.get('/profile', async (req, res) => {
  const { data, error } = await supabase
    .from('clinic_users')
    .select('id, name, email, username, role, qualification, registration_no, speciality')
    .eq('id', req.user.id)
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── PATCH /api/settings/profile ───────────────────────────────────────────────
router.patch('/profile', async (req, res) => {
  const { name, username, qualification, registration_no, speciality } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });

  const updates = { name: name.trim() };
  if (qualification !== undefined) updates.qualification = qualification;
  if (registration_no !== undefined) updates.registration_no = registration_no;
  if (speciality !== undefined) updates.speciality = speciality;

  // Username update — validate and check uniqueness within clinic
  if (username !== undefined && username !== '') {
    if (!/^[a-z0-9_.]{3,20}$/.test(username)) {
      return res.status(400).json({ error: 'Username must be 3-20 chars, lowercase letters/numbers/._  only' });
    }
    // Check uniqueness within clinic (excluding self)
    const { data: existing } = await supabase
      .from('clinic_users')
      .select('id')
      .eq('clinic_id', req.user.clinic_id)
      .eq('username', username)
      .neq('id', req.user.id)
      .single();
    if (existing) return res.status(409).json({ error: 'Username already taken in this clinic' });
    updates.username = username;
  }

  const { data, error } = await supabase
    .from('clinic_users')
    .update(updates)
    .eq('id', req.user.id)
    .select('id, name, email, username, role, qualification, registration_no, speciality')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── POST /api/settings/change-password ───────────────────────────────────────
router.post('/change-password', async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return res.status(400).json({ error: 'Both passwords required' });
  if (new_password.length < 6) return res.status(400).json({ error: 'Min 6 characters' });

  try {
    const { data: user, error } = await supabase
      .from('clinic_users').select('password_hash').eq('id', req.user.id).single();
    if (error || !user) return res.status(404).json({ error: 'User not found' });

    const match = await bcrypt.compare(current_password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Current password is incorrect' });

    const password_hash = await bcrypt.hash(new_password, 12);
    await supabase.from('clinic_users').update({ password_hash }).eq('id', req.user.id);
    res.json({ message: 'Password changed successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to change password' });
  }
});

// ── PATCH /api/settings/users/:id ────────────────────────────────────────────
router.patch('/users/:id', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

  const { name, username, qualification, registration_no, speciality, is_active } = req.body;
  const updates = {};
  if (name !== undefined) updates.name = name.trim();
  if (qualification !== undefined) updates.qualification = qualification;
  if (registration_no !== undefined) updates.registration_no = registration_no;
  if (speciality !== undefined) updates.speciality = speciality;
  if (is_active !== undefined) updates.is_active = is_active;

  if (username !== undefined) {
    if (username && !/^[a-z0-9_.]{3,20}$/.test(username)) {
      return res.status(400).json({ error: 'Invalid username format' });
    }
    if (username) {
      const { data: existing } = await supabase
        .from('clinic_users').select('id')
        .eq('clinic_id', req.clinic.id).eq('username', username)
        .neq('id', req.params.id).single();
      if (existing) return res.status(409).json({ error: 'Username already taken' });
    }
    updates.username = username || null;
  }

  const { data, error } = await supabase
    .from('clinic_users').update(updates)
    .eq('id', req.params.id).eq('clinic_id', req.clinic.id)
    .select('id, name, email, username, role, qualification, registration_no, speciality, is_active')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── POST /api/settings/users/:id/reset-password ──────────────────────────────
router.post('/users/:id/reset-password', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { new_password } = req.body;
  if (!new_password || new_password.length < 6) return res.status(400).json({ error: 'Min 6 characters' });
  try {
    const password_hash = await bcrypt.hash(new_password, 12);
    await supabase.from('clinic_users').update({ password_hash })
      .eq('id', req.params.id).eq('clinic_id', req.clinic.id);
    res.json({ message: 'Password reset successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

module.exports = router;
