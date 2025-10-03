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
const MAX_CONCURRENT_PROCESSORS = 2; // Process 2 items (Render free tier: 512MB RAM limit)

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
  console.log(`📥 Added item ${itemId} to queue. Queue length: ${processingQueue.length}`);

  // Start processors if we have capacity
  startProcessors();
}

// Start processors up to max concurrent limit
function startProcessors() {
  while (activeProcessors < MAX_CONCURRENT_PROCESSORS && processingQueue.length > 0) {
    activeProcessors++;
    console.log(`🚀 Starting processor #${activeProcessors} (${processingQueue.length} items in queue)`);
    processQueue().catch(error => {
      console.error('❌ Queue processor error:', error);
    });
  }
}

// Process queue items continuously
async function processQueue() {
  try {
    while (true) {
      // Check if there are items in the queue
      if (processingQueue.length === 0) {
        break;
      }

      const { itemId, boardId } = processingQueue.shift();

      console.log(`⚙️ Processing item ${itemId} (${processingQueue.length} items remaining, ${activeProcessors} active processors)`);

      try {
        await processItemExtraction(itemId, boardId);
        console.log(`✅ Completed item ${itemId}`);
      } catch (error) {
        console.error(`❌ Failed to process item ${itemId}:`, error.message);
        // Continue processing queue even if one item fails
      }

      // Small delay between items
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  } catch (processorError) {
    console.error(`❌ Processor crashed:`, processorError.message);
  } finally {
    // This processor is done
    activeProcessors--;
    console.log(`✅ Processor finished (${activeProcessors} processors still active, ${processingQueue.length} items in queue)`);

    // Always restart processors if there are more items
    if (processingQueue.length > 0 && activeProcessors < MAX_CONCURRENT_PROCESSORS) {
      console.log(`🔄 Restarting processor for ${processingQueue.length} remaining items`);
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
  try {
    // Get the item and its file column
    const itemData = await mondayController.getItemFiles(itemId);

    if (!itemData || !itemData.files || itemData.files.length === 0) {
      console.log('⚠️ No files found');
      return;
    }

    // Process the first file
    const file = itemData.files[0];

    if (!file.url) {
      console.log('❌ File URL is missing');
      return;
    }

    // If URL is an asset ID (number), get the actual URL first
    let downloadUrl = file.url;
    if (typeof file.url === 'number') {
      downloadUrl = await mondayController.getAssetUrl(file.url);
    }

    const filePath = await mondayController.downloadFile(downloadUrl, file.name);

    // Extract data
    const fileObj = {
      originalname: file.name,
      path: filePath
    };

    const extractedData = await fileController.extractData(fileObj);

    console.log('✅ Extracted:', {
      totalValue: extractedData.totalValue,
      invoiceNumber: extractedData.invoiceNumber,
      supplierName: extractedData.supplierName
    });

    // Update Monday.com item
    await mondayController.updateMondayBoard(boardId, itemId, extractedData);

    console.log('✅ Item updated successfully!');

    // Clean up downloaded file
    fs.unlinkSync(filePath);

  } catch (error) {
    console.error('❌ Error processing item:', error);
    throw error;
  }
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🔘 Webhook: POST http://localhost:${PORT}/api/monday-webhook`);
});
