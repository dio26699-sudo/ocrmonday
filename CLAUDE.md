# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Monday.com QR Code Invoice Processing App - Automatically extracts Portuguese/European invoice data from uploaded files using QR code scanning and updates Monday.com board columns.

## Development Commands

### Running the App

**Local Development:**
```bash
npm start
```
Server runs on port 3000 (or `PORT` from `.env`)

**Monday.com Deployment:**
```bash
# Deploy to Monday.com hosting
mapps code:push -i 11359882

# Check deployment status
mapps code:status -v 11359882

# View live logs
mapps code:logs -i 11359882 -t console -s live
mapps code:logs -i 11359882 -t http -s live

# Set environment variables
mapps code:env -i 11359882 -k MONDAY_API_TOKEN -v "your_token"
mapps code:env -i 11359882 -k PORT -v "8080"
```

**IMPORTANT:** Always use version ID `-i 11359882` (NOT app ID `-a 10591578`) when deploying.

## Architecture

### Core Components

**Processing Queue System:**
- **Concurrent Processing:** 3 items processed simultaneously (`MAX_CONCURRENT_PROCESSORS`)
- **Queue Management:** `processingQueue` array with `activeProcessors` counter
- **Auto-restart:** Processors automatically restart when queue has items
- **Delay:** 200ms between items to prevent API overload

**Request Flow:**
1. Monday.com webhook triggers on status change to "Feito" (column: `color_mkwb6j7j`)
2. Item added to processing queue
3. Up to 3 concurrent processors download files, scan QR codes, update Monday
4. Processors use connection pooling and retry logic for reliability

**Key Files:**
- `src/index.js` - Express server, webhook handler, queue management
- `src/controllers/fileController.js` - QR code scanning (jsQR, @zxing/library), PDF processing (pdfjs-dist + canvas)
- `src/controllers/mondayController.js` - Monday.com API integration with connection pooling

### Monday.com Integration

**Board Configuration:**
- Board ID: `1443407769`
- Trigger Column: `color_mkwb6j7j` (status "Feito")
- File Column: `arquivos`

**Column Mappings (Portuguese ATCUD QR Format):**
- `O` field (total) → `numeric_mkwbrpmz`
- `G` field (invoice number) → `text_mkwb4nns`
- `A` field (customer NIF) → `text_mkwbb9`
- Supplier name → `text_mkwbcyg3`

**API Features:**
- HTTP connection pooling (keepAlive: true, maxSockets: 10)
- Automatic retry on connection errors (3 attempts, 1s delay)
- 30-second timeout on all requests
- GraphQL API (v2024-01)

### QR Code Processing

**Extraction Strategy (Priority Order):**
1. **jsQR** - Primary scanner (fast, reliable)
2. **@zxing/library** - Fallback for difficult codes
3. **Tesseract.js OCR** - Last resort (slow, less accurate)

**PDF Handling:**
- Convert PDF first page to PNG using pdfjs-dist + canvas (Linux-compatible)
- Render at 2.0 scale for better QR detection
- Scan converted image with QR libraries

**Portuguese Invoice QR Format:**
```
A:NIF*B:SupplierNIF*C:PT*D:FT*E:N*F:20250929*G:InvoiceNum*H:Hash*I1:PT*I7:BaseValue*I8:TaxValue*N:TaxValue*O:TotalValue*Q:Code*R:Num
```

### Error Handling

**Connection Issues:**
- Retry logic for `ECONNRESET`, `ETIMEDOUT`, `ECONNABORTED`
- Connection pooling prevents "socket hang up" errors
- Queue prevents concurrent API overload

**Processing Failures:**
- Items logged but processing continues
- No blocking - failed items don't stop queue
- Errors caught in try-catch, logged to console

## Important Implementation Notes

### Queue Processing Bug Fix
The queue system uses a `finally` block to ensure:
1. `activeProcessors` is always decremented
2. Queue is checked for remaining items
3. New processors restart if items exist

**DO NOT** check `activeProcessors < MAX_CONCURRENT_PROCESSORS` before calling `startProcessors()` in the finally block - it will cause processors to stop after first 3 items.

### Deployment Considerations

**Monday.com Hosting:**
- Server must listen on `0.0.0.0` (not localhost)
- Linux environment requires canvas-based PDF processing (no pdf-poppler)
- Environment variables set via `mapps code:env`
- Deployment URL: `https://e1dae-service-19767679-f54d16a2.us.monday.app`

**Performance:**
- 3 concurrent processors = ~3x faster than sequential
- Connection pooling reduces overhead by 30-50%
- Processes ~10-20 seconds per item with QR code
- Queue handles bulk status changes gracefully

### Testing

**Trigger Processing:**
1. Change item status to "Feito" in Monday board
2. Check logs: `mapps code:logs -i 11359882 -t console -s live`
3. Verify columns updated with extracted data

**Monitor Queue:**
- Look for "🚀 Starting processor #X" messages
- Check "⚙️ Processing item" with remaining count
- Confirm "✅ Item updated successfully!"
