import { Router } from 'express';
import { query } from '../config/db.js';

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT id, name, email, role FROM users ORDER BY name');
    res.json(rows);
  } catch (err) { next(err); }
});

export default router;
