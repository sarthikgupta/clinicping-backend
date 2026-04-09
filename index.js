require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
}));
app.use(express.json());

app.use('/api/auth', require('./routes/auth'));
app.use('/api/queue', require('./routes/queue'));
app.use('/api/followups', require('./routes/followups'));
app.use('/api/patients', require('./routes/patients'));
app.use('/api/analytics', require('./routes/analytics'));
app.use('/api/consultations', require('./routes/consultations'));
app.use('/api/settings', require('./routes/settings'));

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'ClinicPing API' }));
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));
app.use((err, req, res, next) => { console.error(err.stack); res.status(500).json({ error: 'Internal server error' }); });

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`ClinicPing API running on port ${PORT}`);
  const { startFollowUpScheduler } = require('./services/scheduler');
  startFollowUpScheduler();
});
