// Admin UI routes for custom services (#249)
import { Router } from 'express';
import {
  createCustomService,
  getCustomService,
  listCustomServices,
  updateCustomService,
  deleteCustomService,
  createAccount,
  getAccount,
  listAccounts,
  updateAccount,
  deleteAccount,
  testConnection
} from '../../services/customServiceService.js';

const router = Router();

// ---- Service CRUD (JSON API) ----

// List all custom services
router.get('/api', (req, res) => {
  try {
    const services = listCustomServices();
    res.json({ services });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single service
router.get('/api/:name', (req, res) => {
  try {
    const service = getCustomService(req.params.name);
    if (!service) return res.status(404).json({ error: 'Service not found' });
    const accounts = listAccounts(req.params.name);
    res.json({ service, accounts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create service
router.post('/api', (req, res) => {
  try {
    const result = createCustomService(req.body);
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Update service
router.put('/api/:name', (req, res) => {
  try {
    updateCustomService(req.params.name, req.body);
    const updated = getCustomService(req.params.name);
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Delete service
router.delete('/api/:name', (req, res) => {
  try {
    deleteCustomService(req.params.name);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- Account CRUD ----

// List accounts for a service
router.get('/api/:name/accounts', (req, res) => {
  try {
    const accounts = listAccounts(req.params.name);
    res.json({ accounts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create account
router.post('/api/:name/accounts', (req, res) => {
  try {
    const { accountName, credentials } = req.body;
    const result = createAccount(req.params.name, accountName, credentials || {});
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Update account
router.put('/api/:name/accounts/:acct', (req, res) => {
  try {
    updateAccount(req.params.name, req.params.acct, req.body);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Delete account
router.delete('/api/:name/accounts/:acct', (req, res) => {
  try {
    deleteAccount(req.params.name, req.params.acct);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- Test connection ----
router.post('/api/:name/test', async (req, res) => {
  try {
    const { accountName } = req.body;
    const result = await testConnection(req.params.name, accountName);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
