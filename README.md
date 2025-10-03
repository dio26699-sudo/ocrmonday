# Monday.com OCR Invoice App

Automatically extracts invoice data from uploaded files using OCR and updates Monday.com columns.

## Features
- Extracts: Total Value, Invoice Number, Supplier Name
- Portuguese/European invoice format support
- Webhook-triggered automation
- Image OCR using Tesseract.js

## Setup

1. Install dependencies:
```bash
npm install
```

2. Configure `.env`:
```
MONDAY_API_TOKEN=your_token_here
PORT=3000
```

3. Start the server:
```bash
npm start
```

4. Expose to internet (choose one):
```bash
# Option 1: Cloudflare Tunnel
npx cloudflared tunnel --url http://localhost:3000

# Option 2: ngrok
ngrok http 3000
```

5. Configure Monday.com webhook:
   - Board ID: 1443407769
   - Trigger: When status "webhook" changes to "Feito"
   - Webhook URL: `https://your-tunnel-url/api/monday-webhook`

## How It Works

1. Upload invoice to "Fatura" (arquivos) column
2. Change "webhook" status to "Feito" (green)
3. App downloads file, extracts data via OCR
4. Updates columns automatically:
   - `numeric_mkwbrpmz` → Total Value
   - `text_mkwb4nns` → Invoice Number
   - `text_mkwbcyg3` → Supplier Name

## File Structure
```
OCR/
├── src/
│   ├── index.js                    # Main server
│   └── controllers/
│       ├── fileController.js       # OCR extraction
│       └── mondayController.js     # Monday.com API
├── .env                            # Configuration
└── package.json                    # Dependencies
```

## Dependencies
- `express` - Web server
- `dotenv` - Environment variables
- `tesseract.js` - OCR engine
- `axios` - HTTP client
