const router = require('express').Router();
const supabase = require('../db/supabase');
const { authMiddleware: auth } = require('../middleware/auth');

router.use(auth);

// ── GET /api/analytics/dashboard ─────────────────────────────────────────────
router.get('/dashboard', async (req, res) => {
  const clinicId = req.clinic.id;
  const today = new Date().toISOString().split('T')[0];
  const isDoctor = req.user.role === 'doctor';
  const doctorId = isDoctor ? req.user.id : null;

  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const weekStart = sevenDaysAgo.toISOString().split('T')[0];

  try {
    // Build base queries — filter by doctor_id if doctor role
    let todayQuery = supabase
      .from('queue_tokens')
      .select('status')
      .eq('clinic_id', clinicId)
      .eq('queue_date', today);

    let weekQuery = supabase
      .from('queue_tokens')
      .select('queue_date, status')
      .eq('clinic_id', clinicId)
      .gte('queue_date', weekStart);

    let followupQuery = supabase
      .from('followups')
      .select('type, status')
      .eq('clinic_id', clinicId)
      .gte('created_at', sevenDaysAgo.toISOString());

    let patientsQuery = supabase
      .from('patients')
      .select('id', { count: 'exact' })
      .eq('clinic_id', clinicId);

    // Doctor filter — scope to their patients via queue_tokens
    if (doctorId) {
      todayQuery = todayQuery.eq('doctor_id', doctorId);
      weekQuery = weekQuery.eq('doctor_id', doctorId);
      // Follow-ups are harder to filter by doctor directly — filter via patient IDs
      // Get patient IDs for this doctor's tokens
      const { data: doctorTokens } = await supabase
        .from('queue_tokens')
        .select('patient_id')
        .eq('clinic_id', clinicId)
        .eq('doctor_id', doctorId);

      const patientIds = [...new Set((doctorTokens || []).map(t => t.patient_id).filter(Boolean))];

      if (patientIds.length > 0) {
        followupQuery = followupQuery.in('patient_id', patientIds);
        patientsQuery = patientsQuery.in('id', patientIds);
      }
    }

    const [todayRes, weekRes, followupRes, patientsRes] = await Promise.all([
      todayQuery,
      weekQuery,
      followupQuery,
      patientsQuery,
    ]);

    // Today stats
    const todayTokens = todayRes.data || [];
    const todayStats = {
      total: todayTokens.length,
      done: todayTokens.filter(t => t.status === 'done').length,
      waiting: todayTokens.filter(t => ['waiting', 'next'].includes(t.status)).length,
      consulting: todayTokens.filter(t => t.status === 'consulting').length,
    };

    // Week by day
    const weekData = weekRes.data || [];
    const byDay = {};
    weekData.forEach(t => {
      if (!byDay[t.queue_date]) byDay[t.queue_date] = { total: 0, done: 0 };
      byDay[t.queue_date].total++;
      if (t.status === 'done') byDay[t.queue_date].done++;
    });

    // Follow-up stats
    const followups = followupRes.data || [];
    const fuByType = {};
    followups.forEach(f => {
      if (!fuByType[f.type]) fuByType[f.type] = { sent: 0, total: 0 };
      fuByType[f.type].total++;
      if (f.status === 'sent') fuByType[f.type].sent++;
    });

    // Per-doctor breakdown (admin only)
    let doctorBreakdown = null;
    if (!isDoctor) {
      const { data: allDoctors } = await supabase
        .from('clinic_users')
        .select('id, name, role')
        .eq('clinic_id', clinicId)
        .in('role', ['doctor'])
        .eq('is_active', true);

      if (allDoctors && allDoctors.length > 0) {
        doctorBreakdown = await Promise.all(allDoctors.map(async (dr) => {
          const { data: drToday } = await supabase
            .from('queue_tokens')
            .select('status')
            .eq('clinic_id', clinicId)
            .eq('doctor_id', dr.id)
            .eq('queue_date', today);

          const { data: drWeek } = await supabase
            .from('queue_tokens')
            .select('status')
            .eq('clinic_id', clinicId)
            .eq('doctor_id', dr.id)
            .gte('queue_date', weekStart);

          return {
            id: dr.id,
            name: dr.name,
            role: dr.role,
            today: {
              total: drToday?.length || 0,
              done: drToday?.filter(t => t.status === 'done').length || 0,
              waiting: drToday?.filter(t => ['waiting', 'next', 'consulting'].includes(t.status)).length || 0,
            },
            week: drWeek?.length || 0,
          };
        }));
      }
    }

    res.json({
      today: todayStats,
      weekByDay: byDay,
      followupStats: fuByType,
      totalPatients: patientsRes.count || 0,
      doctorBreakdown,
      isDoctor,
      doctorName: isDoctor ? req.user.name : null,
    });
  } catch (err) {
    console.error('Analytics error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
