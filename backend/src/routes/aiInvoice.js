import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recognizeInvoice } from '../services/aiInvoiceOrchestrator.js';
import { markTemplateFailure, markTemplateSuccess, saveOrUpdateTemplateFromResult } from '../services/invoiceTemplateService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadDir = process.env.UPLOAD_DIR || path.resolve(__dirname, '..', '..', 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({ dest: uploadDir });
const router = express.Router();

let recognitionQueue = Promise.resolve();
let activeRecognitionCount = 0;
let queuedRecognitionCount = 0;

function enqueueRecognition(task) {
  queuedRecognitionCount += 1;
  const startedAt = Date.now();
  const runTask = async () => {
    queuedRecognitionCount = Math.max(0, queuedRecognitionCount - 1);
    activeRecognitionCount += 1;
    console.log('[recognition-queue] start', {
      active: activeRecognitionCount,
      queued: queuedRecognitionCount,
      waitMs: Date.now() - startedAt
    });
    try {
      return await task();
    } finally {
      activeRecognitionCount = Math.max(0, activeRecognitionCount - 1);
      console.log('[recognition-queue] finish', {
        active: activeRecognitionCount,
        queued: queuedRecognitionCount,
        durationMs: Date.now() - startedAt
      });
    }
  };

  const queued = recognitionQueue.then(runTask, runTask);
  recognitionQueue = queued.catch(() => {});
  return queued;
}

router.post('/recognize', upload.single('image'), async (req, res) => {
  if (!req.user?.companyId) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }
  if (!req.file) {
    res.status(400).json({ success: false, error: 'No image uploaded' });
    return;
  }

  try {
    const result = await enqueueRecognition(() => recognizeInvoice(req.file, { companyId: req.user.companyId }));
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message || 'AI invoice recognition failed'
    });
  }
});

router.get('/queue-status', (req, res) => {
  res.json({
    success: true,
    active: activeRecognitionCount,
    queued: queuedRecognitionCount
  });
});

router.post('/template-success', async (req, res) => {
  if (!req.user?.companyId) return res.status(401).json({ success: false, error: 'Unauthorized' });
  await markTemplateSuccess(req.body.templateId, req.user.companyId);
  if (req.body.result) {
    await saveOrUpdateTemplateFromResult(req.body.result, req.body.sampleImageHash || '', req.user.companyId);
  }
  res.json({ success: true });
});

router.post('/template-failure', async (req, res) => {
  if (!req.user?.companyId) return res.status(401).json({ success: false, error: 'Unauthorized' });
  await markTemplateFailure(req.body.templateId, req.user.companyId);
  res.json({ success: true });
});

export default router;
