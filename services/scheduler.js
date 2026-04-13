const cron = require('node-cron');
const supabase = require('../db/supabase');
const wa = require('./whatsapp');

function startFollowUpScheduler() {
  cron.schedule('*/5 * * * *', async () => {
    console.log('[Scheduler] Checking pending follow-ups...');

    const now = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' }).replace(' ', 'T') + '+05:30';

    const { data: followups, error } = await supabase
      .from('followups')
      .select(`
        *,
        patients (id, name, phone),
        clinics (id, name, phone, clinic_address, city)
      `)
      .eq('status', 'pending')
      .lte('scheduled_at', now)
      .limit(50);

    if (error) {
      console.error('[Scheduler] Error fetching follow-ups:', error);
      return;
    }

    if (!followups || followups.length === 0) {
      console.log('[Scheduler] No follow-ups due.');
      return;
    }

    console.log(`[Scheduler] Sending ${followups.length} follow-up(s)...`);

    for (const fu of followups) {
      const patient = fu.patients;
      const clinic = fu.clinics;

      if (!patient || !clinic) continue;
      if (!patient.phone || !patient.phone.trim()) {
        await supabase.from('followups').update({ status: 'failed' }).eq('id', fu.id);
        continue;
      }

      let result = { success: false };

      try {
        // Get actual treating doctor
        const doctorName = await getTreatingDoctorName(fu.patient_id, fu.clinic_id, clinic.name);
        const clinicPhone = clinic.phone || '';
        const clinicAddress = clinic.clinic_address || clinic.city || '';
        const clinicName = clinic.name || '';

        switch (fu.type) {

          case 'medicine':
            result = await wa.sendMedicineReminder({
              patient,
              doctorName,
              clinicPhone,
              clinicId: clinic.id,
            });
            break;

          case 'appointment': {
            const apptData = safeParseJSON(fu.message);
            const apptDate = apptData.date
              ? new Date(apptData.date).toLocaleDateString('en-IN', {
                  timeZone: 'Asia/Kolkata',
                  day: 'numeric', month: 'long', year: 'numeric'
                })
              : formatDate(fu.scheduled_at);
            const apptTime = apptData.time || '';

            result = await wa.sendAppointmentReminder({
              patient,
              appointmentDate: apptDate,
              appointmentTime: apptTime,
              doctorName,
              clinicAddress,
              clinicPhone,
              clinicId: clinic.id,
            });
            break;
          }

          case 'lab':
            result = await wa.sendLabReminder({
              patient,
              doctorName,
              clinicName,
              clinicPhone,
              clinicId: clinic.id,
            });
            break;

          case 'wellness':
            result = await wa.sendWellnessCheck({
              patient,
              doctorName,
              clinicPhone,
              clinicId: clinic.id,
            });
            break;
        }

        await supabase
          .from('followups')
          .update({
            status: result.success ? 'sent' : 'failed',
            sent_at: result.success ? now : null,
          })
          .eq('id', fu.id);

        console.log(`[Scheduler] ${fu.type} → ${patient.name} → ${result.success ? '✓ sent' : '✗ failed'}`);

      } catch (err) {
        console.error(`[Scheduler] Failed ${fu.id}:`, err.message);
        await supabase.from('followups').update({ status: 'failed' }).eq('id', fu.id);
      }
    }
  });

  console.log('[Scheduler] Follow-up scheduler started (every 5 min)');
}

// Get actual treating doctor name from clinic_users
async function getTreatingDoctorName(patientId, clinicId, fallback) {
  try {
    const { data: token } = await supabase
      .from('queue_tokens')
      .select('doctor_id')
      .eq('clinic_id', clinicId)
      .eq('patient_id', patientId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (!token?.doctor_id) return fallback;

    const { data: doctor } = await supabase
      .from('clinic_users')
      .select('name')
      .eq('id', token.doctor_id)
      .single();

    return doctor?.name || fallback;
  } catch {
    return fallback;
  }
}

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

module.exports = { startFollowUpScheduler };
