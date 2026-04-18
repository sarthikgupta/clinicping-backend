const supabase = require('../db/supabase');

const PLAN_LIMITS = {
  free: {
    patients_per_month: 30,
    whatsapp: false,
    followups: false,
    analytics: 'basic',
    max_doctors: 1,
    allowed_wa_types: ['token_assigned', 'call_in', 'prescription'],
  },
  growth: {
    patients_per_month: Infinity,
    whatsapp: true,
    followups: true,
    analytics: 'full',
    max_doctors: 1,
    allowed_wa_types: ['token_assigned', 'call_in', 'prescription', 'medicine_reminder', 'appointment_reminder', 'lab_reminder', 'wellness_check'],
  },
  clinic: {
    patients_per_month: Infinity,
    whatsapp: true,
    followups: true,
    analytics: 'full',
    max_doctors: 3,
    allowed_wa_types: ['token_assigned', 'call_in', 'prescription', 'medicine_reminder', 'appointment_reminder', 'lab_reminder', 'wellness_check'],
  },
};

// Check if a specific WhatsApp message type is allowed for a plan
function canSendWhatsAppType(plan, type) {
  const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.free;
  return limits.allowed_wa_types.includes(type);
}

// Get clinic plan from DB
async function getClinicPlanName(clinicId) {
  const { data } = await supabase
    .from('clinics')
    .select('plan, plan_expires_at')
    .eq('id', clinicId)
    .single();

  let plan = data?.plan || 'free';

  // Check expiry
  if (plan !== 'free' && data?.plan_expires_at) {
    if (new Date(data.plan_expires_at) < new Date()) {
      plan = 'free';
      await supabase.from('clinics')
        .update({ plan: 'free', plan_expires_at: null })
        .eq('id', clinicId);
    }
  }
  return plan;
}

async function ensureMonthlyCounterFresh(clinicId) {
  const currentMonthYear = new Date()
    .toLocaleDateString('sv-SE', { timeZone: 'Asia/Kolkata' })
    .slice(0, 7);

  const { data } = await supabase
    .from('clinics')
    .select('patients_month_year, patients_this_month')
    .eq('id', clinicId)
    .single();

  if (data && data.patients_month_year !== currentMonthYear) {
    await supabase
      .from('clinics')
      .update({ patients_this_month: 0, patients_month_year: currentMonthYear })
      .eq('id', clinicId);
    return 0;
  }
  return data?.patients_this_month || 0;
}

async function checkPatientLimit(req, res, next) {
  const clinicId = req.clinic?.id;
  if (!clinicId) return next();

  try {
    const currentCount = await ensureMonthlyCounterFresh(clinicId);

    const { data: clinic } = await supabase
      .from('clinics')
      .select('plan, plan_expires_at')
      .eq('id', clinicId)
      .single();

    let plan = clinic?.plan || 'free';

    // Check expiry
    if (plan !== 'free' && clinic?.plan_expires_at) {
      if (new Date(clinic.plan_expires_at) < new Date()) {
        plan = 'free';
        await supabase.from('clinics')
          .update({ plan: 'free', plan_expires_at: null })
          .eq('id', clinicId);
      }
    }

    const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.free;

    if (limits.patients_per_month !== Infinity && currentCount >= limits.patients_per_month) {
      return res.status(403).json({
        error: 'PLAN_LIMIT_REACHED',
        message: `Free plan limit of ${limits.patients_per_month} patients/month reached. Upgrade to continue.`,
        current: currentCount,
        limit: limits.patients_per_month,
        upgrade_required: true,
      });
    }

    next();
  } catch (err) {
    console.error('[Plan] Limit check error:', err.message);
    next(); // fail open
  }
}

async function incrementPatientCount(clinicId) {
  try {
    const { data } = await supabase
      .from('clinics')
      .select('patients_this_month')
      .eq('id', clinicId)
      .single();

    await supabase
      .from('clinics')
      .update({ patients_this_month: (data?.patients_this_month || 0) + 1 })
      .eq('id', clinicId);
  } catch (err) {
    console.error('[Plan] Increment error:', err.message);
  }
}

module.exports = { checkPatientLimit, incrementPatientCount, ensureMonthlyCounterFresh, canSendWhatsAppType, getClinicPlanName, PLAN_LIMITS };
