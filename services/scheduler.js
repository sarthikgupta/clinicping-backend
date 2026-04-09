const cron = require('node-cron');
const supabase = require('../db/supabase');
const wa = require('./whatsapp');

// Runs every 5 minutes — checks for pending follow-ups due to be sent
function startFollowUpScheduler() {
  cron.schedule('*/5 * * * *', async () => {
    console.log('[Scheduler] Checking pending follow-ups...');

    const now = new Date().toISOString();

    // Fetch all pending follow-ups that are due
    const { data: followups, error } = await supabase
      .from('followups')
      .select(`
        *,
        patients (id, name, phone),
        clinics (id, name, doctor_name, phone, plan)
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

      let result = { success: false };

      try {
        switch (fu.type) {
          case 'medicine':
            result = await wa.sendMedicineReminder({
              patient,
              doctorName: clinic.doctor_name,
              clinicPhone: clinic.phone,
              clinicId: clinic.id,
            });
            break;
          case 'appointment':
            // Parse appointment date/time from message field (stored as JSON)
            const apptData = safeParseJSON(fu.message);
            result = await wa.sendAppointmentReminder({
              patient,
              appointmentDate: apptData.date || 'scheduled date',
              appointmentTime: apptData.time || 'scheduled time',
              doctorName: clinic.doctor_name,
              clinicId: clinic.id,
            });
            break;
          case 'lab':
            result = await wa.sendLabReminder({
              patient,
              doctorName: clinic.doctor_name,
              clinicName: clinic.name,
              clinicId: clinic.id,
            });
            break;
          case 'wellness':
            result = await wa.sendWellnessCheck({
              patient,
              doctorName: clinic.doctor_name,
              clinicId: clinic.id,
            });
            break;
        }

        // Mark as sent or failed
        await supabase
          .from('followups')
          .update({
            status: result.success ? 'sent' : 'failed',
            sent_at: result.success ? now : null,
          })
          .eq('id', fu.id);

      } catch (err) {
        console.error(`[Scheduler] Failed to send follow-up ${fu.id}:`, err.message);
        await supabase.from('followups').update({ status: 'failed' }).eq('id', fu.id);
      }
    }
  });

  console.log('[Scheduler] Follow-up scheduler started (every 5 min)');
}

function safeParseJSON(str) {
  try { return JSON.parse(str); } catch { return {}; }
}

module.exports = { startFollowUpScheduler };
