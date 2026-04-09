const router = require('express').Router();
const supabase = require('../db/supabase');
const { authMiddleware } = require('../middleware/auth');

router.use(authMiddleware);

// ── GET /api/patients ─────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const { search } = req.query;
  let query = supabase
    .from('patients')
    .select('*')
    .eq('clinic_id', req.clinic.id)
    .order('last_visit', { ascending: false })
    .limit(100);

  if (search) {
    query = query.or(`name.ilike.%${search}%,phone.ilike.%${search}%`);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── GET /api/patients/:id/history ────────────────────────────────────────────
router.get('/:id/history', async (req, res) => {
  const clinicId = req.clinic.id;
  const { id } = req.params;

  const [tokensRes, followupsRes] = await Promise.all([
    supabase.from('queue_tokens').select('*').eq('patient_id', id).eq('clinic_id', clinicId).order('created_at', { ascending: false }).limit(20),
    supabase.from('followups').select('*').eq('patient_id', id).eq('clinic_id', clinicId).order('created_at', { ascending: false }).limit(20),
  ]);

  res.json({
    visits: tokensRes.data || [],
    followups: followupsRes.data || [],
  });
});

module.exports = router;
