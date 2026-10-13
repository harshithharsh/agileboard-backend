import 'dotenv/config';
import app from './app.js';
import { closeInterruptedSyncs } from './jira/sync.js';

const port = process.env.PORT || 4000;
closeInterruptedSyncs().catch((err) => console.error('Could not tidy up interrupted syncs:', err.message));
app.listen(port, () => console.log(`AgileBoard API listening on http://localhost:${port}`));
