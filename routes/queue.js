const router = require('express').Router();
const supabase = require('../db/supabase');
const wa = require('../services/whatsapp');
const { authMiddleware: auth } = require('../middleware/auth');

router.use(auth);

// Helper: get doctor filter based on role
function getDoctorFilter(req) {
  // If role is doctor, filter by their user_id
  // If role is admin or receptionist, no filter (see all)
  if (req.user.role === 'doctor') {
    return req.user.id;
  }
  return null;
}

// ── GET /api/queue/today ─────────────────────────────────────────────────────
router.get('/today', async (req, res) => {
  const clinicId = req.clinic.id;
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Kolkata' });
  const doctorFilter = getDoctorFilter(req);

  let query = supabase
    .from('queue_tokens')
    .select(`*, patients(id, name, phone, visit_count), clinic_users!doctor_id(id, name, role)`)
    .eq('clinic_id', clinicId)
    .eq('queue_date', today)
    .neq('status', 'cancelled')
    .order('token_number', { ascending: true });

  if (doctorFilter) {
    query = query.eq('doctor_id', doctorFilter);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── GET /api/queue/stats ─────────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  const clinicId = req.clinic.id;
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Kolkata' });
  const doctorFilter = getDoctorFilter(req);

  let query = supabase
    .from('queue_tokens')
    .select('status')
    .eq('clinic_id', clinicId)
    .eq('queue_date', today);

  if (doctorFilter) {
    query = query.eq('doctor_id', doctorFilter);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const stats = {
    total: data.length,
    waiting: data.filter(t => t.status === 'waiting').length,
    next: data.filter(t => t.status === 'next').length,
    consulting: data.filter(t => t.status === 'consulting').length,
    done: data.filter(t => t.status === 'done').length,
    cancelled: data.filter(t => t.status === 'cancelled').length,
  };
  res.json(stats);
});

// ── GET /api/queue/doctors ───────────────────────────────────────────────────
// Get all active doctors in this clinic (for receptionist dropdown)
router.get('/doctors', async (req, res) => {
  const clinicId = req.clinic.id;
  const { data, error } = await supabase
    .from('clinic_users')
    .select('id, name, qualification, speciality')
    .eq('clinic_id', clinicId)
    .eq('role', 'doctor')
    .eq('is_active', true)
    .order('name');

  if (error) return res.status(500).json({ error: error.message });

  // Also include admin users who act as doctors
  res.json(data || []);
});

// ── POST /api/queue/add ──────────────────────────────────────────────────────
router.post('/add', checkPatientLimit, async (req, res) => {
  const clinicId = req.clinic.id;
  const { name, phone, reason, doctor_id } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Patient name is required' });
  }

  const cleanPhone = phone && phone.trim() && phone !== 'N/A' ? phone.trim() : null;
  const cleanName = name.trim();

  // Determine which doctor this token is assigned to
  // If receptionist picks a doctor → use that
  // If doctor adds patient themselves → use their own ID
  let assignedDoctorId = doctor_id || null;
  if (req.user.role === 'doctor' && !assignedDoctorId) {
    assignedDoctorId = req.user.id;
  }

  try {
    let patient;

    if (cleanPhone) {
      const { data: existing } = await supabase
        .from('patients')
        .select('*')
        .eq('clinic_id', clinicId)
        .eq('phone', cleanPhone)
        .single();

      if (existing) {
        const { data: updated } = await supabase
          .from('patients')
          .update({ visit_count: existing.visit_count + 1, last_visit: new Date().toISOString(), name: cleanName })
          .eq('id', existing.id)
          .select()
          .single();
        patient = updated;
      } else {
        const { data: created, error: pErr } = await supabase
          .from('patients')
          .insert({ clinic_id: clinicId, name: cleanName, phone: cleanPhone, reason: reason || '' })
          .select()
          .single();
        if (pErr) throw pErr;
        patient = created;
      }
    } else {
      const { data: existingByName } = await supabase
        .from('patients')
        .select('*')
        .eq('clinic_id', clinicId)
        .ilike('name', cleanName)
        .eq('phone', '')
        .order('last_visit', { ascending: false })
        .limit(1);

      if (existingByName && existingByName.length > 0) {
        const existing = existingByName[0];
        const { data: updated } = await supabase
          .from('patients')
          .update({ visit_count: existing.visit_count + 1, last_visit: new Date().toISOString() })
          .eq('id', existing.id)
          .select()
          .single();
        patient = updated;
      } else {
        const { data: created, error: pErr } = await supabase
          .from('patients')
          .insert({ clinic_id: clinicId, name: cleanName, phone: '', reason: reason || '' })
          .select()
          .single();
        if (pErr) throw pErr;
        patient = created;
      }
    }

    await incrementPatientCount(clinicId);

    // Get next token — scoped to this doctor if assigned
    const { data: tokenData } = await supabase.rpc('get_next_token', { p_clinic_id: clinicId });
    const tokenNumber = tokenData || 1;

    // Count active tokens for THIS doctor to determine wait time
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Kolkata' });
    let activeQuery = supabase
      .from('queue_tokens')
      .select('id')
      .eq('clinic_id', clinicId)
      .eq('queue_date', today)
      .in('status', ['waiting', 'next', 'consulting']);

    if (assignedDoctorId) {
      activeQuery = activeQuery.eq('doctor_id', assignedDoctorId);
    }

    const { data: activeTokens } = await activeQuery;
    const activeCount = activeTokens?.length || 0;
    const waitMinutes = wa.estimateWaitTime(activeCount);
    const initialStatus = activeCount === 0 ? 'consulting' : 'waiting';

    const { data: token, error: tErr } = await supabase
      .from('queue_tokens')
      .insert({
        clinic_id: clinicId,
        patient_id: patient.id,
        token_number: tokenNumber,
        status: initialStatus,
        reason: reason || '',
        whatsapp_sent: false,
        doctor_id: assignedDoctorId || null,
      })
      .select()
      .single();

    if (tErr) throw tErr;

    let waResult = { success: false };
    if (cleanPhone) {
      const { data: clinic } = await supabase
        .from('clinics')
        .select('name')
        .eq('id', clinicId)
        .single();

      // Get doctor name if assigned
      let doctorName = clinic?.name || '';
      if (assignedDoctorId) {
        const { data: dr } = await supabase
          .from('clinic_users')
          .select('name')
          .eq('id', assignedDoctorId)
          .single();
        if (dr) doctorName = dr.name;
      }

      waResult = await wa.sendTokenAssigned({
        patient,
        tokenNumber,
        waitMinutes,
        clinicName: `${doctorName} — ${clinic?.name || ''}`,
        clinicId,
      });

      if (waResult.success) {
        await supabase.from('queue_tokens').update({ whatsapp_sent: true }).eq('id', token.id);
      }
    }

    res.status(201).json({
      token: { ...token, patients: patient },
      waitMinutes,
      whatsappSent: waResult.success,
    });
  } catch (err) {
    console.error('Add to queue error:', err);
    res.status(500).json({ error: 'Failed to add patient to queue' });
  }
});

// ── PATCH /api/queue/:tokenId/next ──────────────────────────────────────────
router.patch('/:tokenId/next', async (req, res) => {
  const clinicId = req.clinic.id;
  const { tokenId } = req.params;
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Kolkata' });

  try {
    // Get current token to know its doctor
    const { data: currentToken } = await supabase
      .from('queue_tokens')
      .select('doctor_id')
      .eq('id', tokenId)
      .single();

    const doctorId = currentToken?.doctor_id || null;

    // Mark current as done
    await supabase
      .from('queue_tokens')
      .update({ status: 'done', updated_at: new Date().toISOString() })
      .eq('id', tokenId)
      .eq('clinic_id', clinicId);

    // Reset orphaned 'next' for this doctor's queue
    let resetQuery = supabase
      .from('queue_tokens')
      .update({ status: 'waiting' })
      .eq('clinic_id', clinicId)
      .eq('queue_date', today)
      .eq('status', 'next');
    if (doctorId) resetQuery = resetQuery.eq('doctor_id', doctorId);
    await resetQuery;

    // Get next waiting patient for THIS doctor
    let nextQuery = supabase
      .from('queue_tokens')
      .select(`*, patients(id, name, phone)`)
      .eq('clinic_id', clinicId)
      .eq('queue_date', today)
      .eq('status', 'waiting')
      .order('token_number', { ascending: true })
      .limit(1);
    if (doctorId) nextQuery = nextQuery.eq('doctor_id', doctorId);

    const { data: waitingTokens, error: wErr } = await nextQuery;
    if (wErr) throw wErr;

    if (!waitingTokens || waitingTokens.length === 0) {
      return res.json({ message: 'Queue complete for today', nextPatient: null });
    }

    const nextToken = waitingTokens[0];

    await supabase
      .from('queue_tokens')
      .update({ status: 'consulting', updated_at: new Date().toISOString() })
      .eq('id', nextToken.id)
      .eq('clinic_id', clinicId);

    // Send WhatsApp call-in
    let waResult = { success: false };
    const patientPhone = nextToken.patients?.phone;
    if (patientPhone && patientPhone.trim()) {
      // Get doctor name from clinic_users
      let doctorName = '';
      if (doctorId) {
        const { data: dr } = await supabase.from('clinic_users').select('name').eq('id', doctorId).single();
        if (dr) doctorName = dr.name;
      }

      waResult = await wa.sendCallIn({
        patient: nextToken.patients,
        doctorName,
        clinicId,
      });

      if (waResult.success) {
        await supabase.from('queue_tokens').update({ called_in_sent: true }).eq('id', nextToken.id);
      }
    }

    res.json({
      nextPatient: { ...nextToken, status: 'consulting' },
      whatsappSent: waResult.success,
    });
  } catch (err) {
    console.error('Advance queue error:', err);
    res.status(500).json({ error: 'Failed to advance queue' });
  }
});

// ── DELETE /api/queue/:tokenId ────────────────────────────────────────────────
router.delete('/:tokenId', async (req, res) => {
  const { tokenId } = req.params;
  await supabase
    .from('queue_tokens')
    .update({ status: 'cancelled' })
    .eq('id', tokenId)
    .eq('clinic_id', req.clinic.id);
  res.json({ message: 'Cancelled' });
});

module.exports = router;
