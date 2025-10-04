require('dotenv').config();
const express = require('express');
const fs = require('fs');
const fileController = require('./controllers/fileController');
const mondayController = require('./controllers/mondayController');

const app = express();
const PORT = process.env.PORT || 3000;

// Processing queue to prevent concurrent overload
let processingQueue = [];
let activeProcessors = 0;
const MAX_CONCURRENT_PROCESSORS = 10; // Process 10 items concurrently (Railway: 8GB RAM)

// Middleware
app.use(express.json());

// Create uploads directory if it doesn't exist
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

// Monday.com webhook endpoint
app.post('/api/monday-webhook', async (req, res) => {
  try {
    const { event, challenge } = req.body;

    // Handle Monday.com challenge (first-time setup)
    if (challenge) {
      return res.json({ challenge });
    }

    // Handle status column change event
    if (event && event.type === 'update_column_value') {
      const { boardId, pulseId, itemId, columnId } = event;
      const actualItemId = pulseId || itemId;

      // Check if it's our extraction trigger
      if (columnId === 'button_mkwbdw8s' || columnId === 'color_mkwb6j7j') {
        // Add to queue instead of processing immediately
        addToQueue(actualItemId, boardId);

        return res.json({ success: true, message: 'Added to processing queue' });
      }
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Add item to processing queue
function addToQueue(itemId, boardId) {
  processingQueue.push({ itemId, boardId });
  console.log(`\n${'='.repeat(80)}\n📥 QUEUE: Added item ${itemId} | Queue size: ${processingQueue.length}\n${'='.repeat(80)}`);

  // Start processors if we have capacity
  startProcessors();
}

// Start processors up to max concurrent limit
function startProcessors() {
  while (activeProcessors < MAX_CONCURRENT_PROCESSORS && processingQueue.length > 0) {
    activeProcessors++;
    processQueue().catch(error => {
      console.error(`\n❌ FATAL: Queue processor crashed\n   Error: ${error.message}\n`);
    });
  }
}

// Process queue items continuously
async function processQueue() {
  try {
    while (processingQueue.length > 0) {
      const { itemId, boardId } = processingQueue.shift();
      const startTime = Date.now();

      console.log(`\n🔵 START: Processing item ${itemId} | Queue: ${processingQueue.length} remaining`);

      try {
        await processItemExtraction(itemId, boardId);
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`✅ SUCCESS: Item ${itemId} completed in ${duration}s`);
      } catch (error) {
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.error(`❌ FAILED: Item ${itemId} after ${duration}s\n   Error: ${error.message}`);
      }

      // Small delay between items
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  } catch (processorError) {
    console.error(`\n❌ FATAL: Processor crashed\n   Error: ${processorError.message}\n`);
  } finally {
    activeProcessors--;

    // Always restart processors if there are more items
    if (processingQueue.length > 0 && activeProcessors < MAX_CONCURRENT_PROCESSORS) {
      console.log(`🔄 RESTART: Queue has ${processingQueue.length} items remaining\n`);
      startProcessors();
    }
  }
}

// Process all items in a board
async function processAllBoardItems(boardId) {
  try {
    console.log(`📋 Processing all items in board: ${boardId}`);

    // Get all items from the board
    const items = await mondayController.getAllBoardItems(boardId);

    if (!items || items.length === 0) {
      console.log('⚠️ No items found in board');
      return;
    }

    console.log(`📝 Found ${items.length} items to process`);

    // Process each item
    for (const item of items) {
      await processItemExtraction(item.id, boardId);
    }

    console.log(`✅ Finished processing all ${items.length} items`);
  } catch (error) {
    console.error('❌ Error processing board:', error);
    throw error;
  }
}

// Process extraction for a Monday.com item
async function processItemExtraction(itemId, boardId) {
  let filePath = null;

  try {
    // Get the item and its file column
    const itemData = await mondayController.getItemFiles(itemId);

    if (!itemData || !itemData.files || itemData.files.length === 0) {
      console.log('  ⚠️  No files attached');
      return;
    }

    const file = itemData.files[0];
    console.log(`  📄 File: ${file.name}`);

    if (!file.url) {
      console.log('  ❌ File URL missing');
      return;
    }

    // If URL is an asset ID (number), get the actual URL first
    let downloadUrl = file.url;
    if (typeof file.url === 'number') {
      downloadUrl = await mondayController.getAssetUrl(file.url);
    }

    filePath = await mondayController.downloadFile(downloadUrl, file.name);

    // Extract data
    const extractedData = await fileController.extractData({
      originalname: file.name,
      path: filePath
    });

    // Log extracted data
    const hasData = extractedData.totalValue || extractedData.invoiceNumber || extractedData.supplierName;
    if (hasData) {
      console.log(`  📊 Extracted: Total=${extractedData.totalValue || 'N/A'} | Invoice=${extractedData.invoiceNumber || 'N/A'} | Supplier=${extractedData.supplierName || 'N/A'}`);
    } else {
      console.log(`  ⚠️  No data extracted from QR code`);
    }

    // Update Monday.com item
    await mondayController.updateMondayBoard(boardId, itemId, extractedData);

  } catch (error) {
    console.error(`  ❌ Processing error: ${error.message}`);
    throw error;
  } finally {
    // Clean up downloaded file
    if (filePath && fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (cleanupError) {
        console.log(`  ⚠️  Cleanup failed: ${cleanupError.message}`);
      }
    }
  }
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🔘 Webhook: POST http://localhost:${PORT}/api/monday-webhook`);
});
