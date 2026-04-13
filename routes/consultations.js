const router = require('express').Router();
const supabase = require('../db/supabase');
const wa = require('../services/whatsapp');
const { authMiddleware: auth } = require('../middleware/auth');

router.use(auth);

// ── GET /api/consultations/today ──────────────────────────────────────────────
router.get('/today', async (req, res) => {
  const clinicId = req.clinic.id;
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Kolkata' });

  try {
    const isDoctor = req.user.role === 'doctor';
    const doctorId = isDoctor ? req.user.id : null;

    let tokenQuery = supabase
      .from('queue_tokens')
      .select(`id, token_number, status, reason, patients(id, name, phone, visit_count)`)
      .eq('clinic_id', clinicId)
      .eq('queue_date', today)
      .neq('status', 'cancelled')
      .order('token_number', { ascending: true });

    if (doctorId) {
      tokenQuery = tokenQuery.eq('doctor_id', doctorId);
    }

    const { data: tokens, error } = await tokenQuery;

    if (error) throw error;

    const result = await Promise.all(tokens.map(async (token) => {
      const patientId = token.patients?.id;

      const { data: prevConsults } = await supabase
        .from('consultations')
        .select(`id, visit_date, symptoms, diagnosis, next_appointment_date,
          medicines(name, dose, duration, sort_order),
          tests_ordered(name, sort_order)`)
        .eq('clinic_id', clinicId)
        .eq('patient_id', patientId)
        .lt('visit_date', today)
        .order('visit_date', { ascending: false })
        .limit(1);

      const { data: todayConsult } = await supabase
        .from('consultations')
        .select(`id, symptoms, diagnosis, next_appointment_date, next_appointment_time, next_appointment_note,
          medicines(id, name, dose, duration, sort_order),
          tests_ordered(id, name, sort_order)`)
        .eq('clinic_id', clinicId)
        .eq('patient_id', patientId)
        .eq('visit_date', today)
        .eq('token_id', token.id)
        .single();

      return {
        ...token,
        previousConsultation: prevConsults?.[0] || null,
        todayConsultation: todayConsult || null,
      };
    }));

    res.json(result);
  } catch (err) {
    console.error('Get today consultations error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/consultations/patient/:patientId ────────────────────────────────
router.get('/patient/:patientId', async (req, res) => {
  const clinicId = req.clinic.id;
  const { patientId } = req.params;

  const { data, error } = await supabase
    .from('consultations')
    .select(`id, visit_date, symptoms, diagnosis, next_appointment_date, next_appointment_time, next_appointment_note,
      medicines(name, dose, duration, sort_order),
      tests_ordered(name, sort_order)`)
    .eq('clinic_id', clinicId)
    .eq('patient_id', patientId)
    .order('visit_date', { ascending: false })
    .limit(20);

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── POST /api/consultations ───────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const clinicId = req.clinic.id;
  const {
    patient_id, token_id,
    symptoms, diagnosis,
    medicines, tests,
    next_appointment_date, next_appointment_time, next_appointment_note,
    send_whatsapp_slip, // NEW: boolean flag from frontend
  } = req.body;

  if (!patient_id) return res.status(400).json({ error: 'patient_id required' });

  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Kolkata' });

  try {
    let consultationId;

    const { data: existing } = await supabase
      .from('consultations')
      .select('id')
      .eq('clinic_id', clinicId)
      .eq('patient_id', patient_id)
      .eq('visit_date', today)
      .eq('token_id', token_id)
      .single();

    if (existing) {
      await supabase
        .from('consultations')
        .update({
          symptoms: symptoms || '',
          diagnosis: diagnosis || '',
          next_appointment_date: next_appointment_date || null,
          next_appointment_time: next_appointment_time || null,
          next_appointment_note: next_appointment_note || '',
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id);
      consultationId = existing.id;

      await supabase.from('medicines').delete().eq('consultation_id', consultationId);
      await supabase.from('tests_ordered').delete().eq('consultation_id', consultationId);
    } else {
      const { data: created, error: cErr } = await supabase
        .from('consultations')
        .insert({
          clinic_id: clinicId,
          patient_id,
          token_id: token_id || null,
          visit_date: today,
          symptoms: symptoms || '',
          diagnosis: diagnosis || '',
          next_appointment_date: next_appointment_date || null,
          next_appointment_time: next_appointment_time || null,
          next_appointment_note: next_appointment_note || '',
        })
        .select('id')
        .single();
      if (cErr) throw cErr;
      consultationId = created.id;
    }

    if (medicines && medicines.length > 0) {
      const medRows = medicines
        .filter(m => m.name && m.name.trim())
        .map((m, i) => ({
          consultation_id: consultationId,
          clinic_id: clinicId,
          name: m.name.trim(),
          dose: m.dose || '',
          duration: m.duration || '',
          sort_order: i,
        }));
      if (medRows.length > 0) await supabase.from('medicines').insert(medRows);
    }

    if (tests && tests.length > 0) {
      const testRows = tests
        .filter(t => t.name && t.name.trim())
        .map((t, i) => ({
          consultation_id: consultationId,
          clinic_id: clinicId,
          name: t.name.trim(),
          sort_order: i,
        }));
      if (testRows.length > 0) await supabase.from('tests_ordered').insert(testRows);
    }

    // Schedule follow-up for next appointment
    if (next_appointment_date) {
      const scheduledAt = new Date(`${next_appointment_date}T09:00:00`).toISOString();
      await supabase.from('followups').insert({
        clinic_id: clinicId,
        patient_id,
        type: 'appointment',
        message: JSON.stringify({ date: next_appointment_date, time: next_appointment_time || '' }),
        scheduled_at: scheduledAt,
        status: 'pending',
      });
    }

    // ── Send WhatsApp prescription slip if requested ──────────────────────────
    let whatsappSlipSent = false;
    if (send_whatsapp_slip) {
      try {
        // Get patient info
        const { data: patient } = await supabase
          .from('patients')
          .select('id, name, phone')
          .eq('id', patient_id)
          .single();

        // Get clinic info for doctor name and phone
        const { data: clinicInfo } = await supabase
          .from('clinics')
          .select('doctor_name, phone, doctor_qualification')
          .eq('id', clinicId)
          .single();

        if (patient?.phone && patient.phone.trim()) {
          const consultationData = {
            symptoms,
            diagnosis,
            medicines: (medicines || []).filter(m => m.name?.trim()).map((m, i) => ({ ...m, sort_order: i })),
            tests_ordered: (tests || []).filter(t => t.name?.trim()).map((t, i) => ({ name: t.name, sort_order: i })),
            next_appointment_date,
            next_appointment_time,
            next_appointment_note,
          };

          const result = await wa.sendPrescription({
            patient,
            consultation: consultationData,
            doctorName: clinicInfo?.doctor_name || 'Doctor',
            clinicPhone: clinicInfo?.phone || '',
            clinicId,
          });

          whatsappSlipSent = result.success;
        }
      } catch (waErr) {
        console.error('Prescription WhatsApp error:', waErr.message);
      }
    }

    // Return saved consultation
    const { data: saved } = await supabase
      .from('consultations')
      .select(`id, visit_date, symptoms, diagnosis,
        next_appointment_date, next_appointment_time, next_appointment_note,
        medicines(name, dose, duration, sort_order),
        tests_ordered(name, sort_order)`)
      .eq('id', consultationId)
      .single();


    // Update patient's last_visit date
    await supabase
    .from('patients')
    .update({ last_visit: new Date().toISOString().split('T')[0] })
    .eq('id', patient_id);

    res.status(201).json({ ...saved, whatsappSlipSent });
  } catch (err) {
    console.error('Save consultation error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
