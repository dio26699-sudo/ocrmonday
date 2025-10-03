const Tesseract = require('tesseract.js');
const pdfParse = require('pdf-parse');
const fs = require('fs');
const path = require('path');
const jsQR = require('jsqr');
const Jimp = require('jimp');

class FileController {
  /**
   * Process uploaded file and extract text
   */
  async processFile(req, res) {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      const extractedData = await this.extractData(req.file);

      // Clean up file after processing
      fs.unlinkSync(req.file.path);

      res.json({
        success: true,
        data: extractedData,
        filename: req.file.originalname
      });
    } catch (error) {
      console.error('Error processing file:', error);
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * Extract data from different file types
   */
  async extractData(file) {
    const fileExtension = path.extname(file.originalname).toLowerCase();

    switch (fileExtension) {
      case '.pdf':
        return await this.extractFromPDF(file.path);

      case '.png':
      case '.jpg':
      case '.jpeg':
      case '.gif':
      case '.bmp':
        return await this.extractFromImage(file.path);

      case '.txt':
        return await this.extractFromText(file.path);

      default:
        throw new Error(`Unsupported file type: ${fileExtension}`);
    }
  }

  /**
   * Extract text from PDF by scanning QR code
   */
  async extractFromPDF(filePath) {
    let tempImagePath = null;

    try {
      const { createCanvas } = require('canvas');
      const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

      const data = new Uint8Array(require('fs').readFileSync(filePath));
      const loadingTask = pdfjsLib.getDocument({ data });
      const pdfDocument = await loadingTask.promise;

      const page = await pdfDocument.getPage(1);
      const viewport = page.getViewport({ scale: 2.0 });

      const canvas = createCanvas(viewport.width, viewport.height);
      const context = canvas.getContext('2d');

      await page.render({ canvasContext: context, viewport: viewport }).promise;

      const imageBuffer = canvas.toBuffer('image/png');
      tempImagePath = filePath.replace('.pdf', '_temp.png');
      require('fs').writeFileSync(tempImagePath, imageBuffer);

      const qrData = await this.scanQRCode(tempImagePath);

      if (qrData) {
        console.log(`  🔍 QR Found (PDF): ${qrData.substring(0, 50)}...`);
        const invoiceData = this.parseQRCodeData(qrData);
        return {
          text: qrData,
          method: 'qr-code-pdf',
          ...invoiceData
        };
      }

      console.log(`  ⚠️  QR code not detected in PDF`);
      return {
        text: '',
        method: 'qr-code-pdf-failed',
        totalValue: null,
        invoiceNumber: null,
        supplierName: null,
        customerNIF: null
      };
    } catch (error) {
      console.log(`  ⚠️  PDF processing error: ${error.message}`);
      return {
        text: '',
        method: 'qr-code-pdf-error',
        totalValue: null,
        invoiceNumber: null,
        supplierName: null,
        customerNIF: null
      };
    } finally {
      // Always cleanup temp file
      if (tempImagePath) {
        try {
          require('fs').unlinkSync(tempImagePath);
        } catch (cleanupError) {
          // Ignore cleanup errors
        }
      }
    }
  }

  /**
   * Extract data from image by scanning QR code only
   */
  async extractFromImage(filePath) {
    try {
      const qrData = await this.scanQRCode(filePath);

      if (qrData) {
        const invoiceData = this.parseQRCodeData(qrData);
        console.log(`  🔍 QR Found: ${qrData.substring(0, 50)}...`);
        return {
          text: qrData,
          method: 'qr-code',
          ...invoiceData
        };
      } else {
        console.log(`  ⚠️  QR code not detected`);
        return {
          text: '',
          method: 'qr-code',
          totalValue: null,
          invoiceNumber: null,
          supplierName: null,
          customerNIF: null
        };
      }
    } catch (error) {
      console.error(`  ❌ QR scan failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Extract text from plain text file
   */
  async extractFromText(filePath) {
    const text = fs.readFileSync(filePath, 'utf-8');

    const invoiceData = this.parseInvoiceData(text);

    return {
      text: text,
      length: text.length,
      lines: text.split('\n').length,
      ...invoiceData
    };
  }

  /**
   * Parse extracted text into structured data
   * This is a basic example - customize based on your needs
   */
  parseStructuredData(text) {
    const lines = text.split('\n').filter(line => line.trim());
    const data = {};

    // Example: Extract key-value pairs
    lines.forEach(line => {
      const match = line.match(/^(.+?):\s*(.+)$/);
      if (match) {
        const [, key, value] = match;
        data[key.trim()] = value.trim();
      }
    });

    return data;
  }

  /**
   * Parse invoice data and extract total value
   */
  parseInvoiceData(text) {
    const invoiceData = {
      totalValue: null,
      currency: null,
      invoiceNumber: null,
      invoiceDate: null,
      supplierName: null
    };

    // Clean up text for better parsing
    const cleanText = text.replace(/\s+/g, ' ').trim();

    // Extract total value - Multiple patterns to catch different invoice formats
    // Ordered by priority - most specific first
    const totalPatterns = [
      // Pattern: TOTAL: Eur 55,20 (Portuguese/European format)
      /(?:total|total\s*incidencias|valor\s*total|total\s*a\s*pagar)[\s:]*(?:eur|€|usd|\$|gbp|£)\s*([\d.]+,\d{2})/i,

      // Pattern: Eur 55,20 or € 55,20 (currency first, European comma format)
      /(?:eur|€|usd|\$|gbp|£|r\$)\s*([\d.]+,\d{2})/i,

      // Pattern: Total without currency: Total: 55,20 or Total 55.20
      /(?:total|total\s*a\s*pagar|valor\s*total|montante)[\s:]*(\d+[.,]\d{2})/i,

      // Pattern: PAGAR or A PAGAR: 55,20 (Portuguese)
      /(?:a\s*pagar|pagar)[\s:]*(?:eur|€)?\s*([\d.]+,\d{2})/i,

      // Pattern: Total Amount Due: $1,234.56 (US format)
      /(?:total\s*amount\s*due|amount\s*due|balance\s*due|final\s*total)[\s:]*[\$€£R\$]?\s*([\d,]+\.?\d{0,2})/i,

      // Pattern: Grand Total: $1,234.56
      /(?:grand\s*total)[\s:]*[\$€£R\$]?\s*([\d,]+\.?\d{0,2})/i,

      // Pattern: R$ 1.234,56 (Brazilian format)
      /(?:total|valor\s*total|total\s*geral)[\s:]*R\$?\s*([\d.]+,\d{2})/i,

      // Pattern: 55,20 EUR/USD (value then currency, comma format)
      /([\d.]+,\d{2})\s*(?:USD|EUR|BRL|GBP|Eur|€)/i,

      // Pattern: 1,234.56 USD/EUR (value then currency, dot format)
      /([\d,]+\.\d{2})\s*(?:USD|EUR|BRL|GBP)/i,

      // Pattern: Last resort - any number with 2 decimals near end of document
      /(\d{1,6}[.,]\d{2})(?=\s*(?:€|eur|usd|\$|gbp|£)?\s*$)/i
    ];

    for (const pattern of totalPatterns) {
      const match = cleanText.match(pattern);
      if (match) {
        let value = match[1];

        // Handle Brazilian format (1.234,56)
        if (value.includes(',') && value.lastIndexOf(',') > value.lastIndexOf('.')) {
          value = value.replace(/\./g, '').replace(',', '.');
        } else {
          // Handle US/UK format (1,234.56)
          value = value.replace(/,/g, '');
        }

        const numericValue = parseFloat(value);
        if (!isNaN(numericValue) && numericValue > 0) {
          invoiceData.totalValue = numericValue;
          break;
        }
      }
    }

    // Extract currency
    const currencyMatch = cleanText.match(/(\$|USD|€|EUR|Eur|£|GBP|R\$|BRL)/i);
    if (currencyMatch) {
      const currencyMap = {
        '$': 'USD', 'USD': 'USD',
        '€': 'EUR', 'EUR': 'EUR', 'Eur': 'EUR',
        '£': 'GBP', 'GBP': 'GBP',
        'R$': 'BRL', 'BRL': 'BRL'
      };
      invoiceData.currency = currencyMap[currencyMatch[1]] || currencyMatch[1].toUpperCase();
    }

    // Extract invoice number
    const invoiceNumberPatterns = [
      // Portuguese invoice formats: FT, FTA, FR, FA followed by numbers
      /(FT[A]?|FR|FA)\s+([A-Z0-9\/\-]+)/i,  // Captures: FT 1L2501/1343 -> "FT 1L2501/1343"
      /(?:fatura-recibo|fatura)\s*n[:\-]?\s*([A-Z0-9\/\-]+)/i,
      /invoice\s*number\s*[:\-]?\s*([A-Z0-9\-]+)/i,
      /invoice\s*#\s*[:\-]?\s*([A-Z0-9\-]+)/i,
      /invoice[:\-]\s*([A-Z0-9\-]+)/i,
      /nota\s*fiscal\s*[:\-]?\s*([A-Z0-9\-]+)/i,
      /#\s*([A-Z0-9\-]{5,})/,
      /INV[:\-\s]*([A-Z0-9\-]+)/i
    ];

    for (const pattern of invoiceNumberPatterns) {
      const match = cleanText.match(pattern);
      if (match) {
        // For Portuguese invoice formats (FT, FTA, FR, FA), combine prefix and number
        if (match[2]) {
          invoiceData.invoiceNumber = `${match[1]} ${match[2]}`.trim();
        } else {
          invoiceData.invoiceNumber = match[1].trim();
        }
        break;
      }
    }

    // Extract supplier name (usually first line or near top of invoice)
    const supplierPatterns = [
      // Pattern: Look for company name patterns (words before address/NIF)
      /^([A-ZÀ-ÿ][A-Za-zÀ-ÿ\s&,.-]+?)(?:\s+de:|NIF:|Urb\.|Rua|Av\.|Tel:|Email)/im,
      // Pattern: First non-empty line (often company name)
      /^([A-ZÀ-ÿ][A-Za-zÀ-ÿ\s&,.-]+?)$/m,
      // Pattern: After "de:" or "from:"
      /(?:de|from)[\s:]+([A-ZÀ-ÿ][A-Za-zÀ-ÿ\s&,.-]+)/i
    ];

    const lines = text.split('\n').filter(line => line.trim());

    // Try to get supplier from first few lines
    if (lines.length > 0) {
      // First line is often the supplier name
      const firstLine = lines[0].trim();
      if (firstLine && firstLine.length > 3 && firstLine.length < 100) {
        invoiceData.supplierName = firstLine;
      }
    }

    // Or try patterns
    if (!invoiceData.supplierName) {
      for (const pattern of supplierPatterns) {
        const match = text.match(pattern);
        if (match && match[1]) {
          invoiceData.supplierName = match[1].trim();
          break;
        }
      }
    }

    return invoiceData;
  }

  /**
   * Scan QR code from image with preprocessing
   */
  async scanQRCode(filePath) {
    try {
      // Load image - keep original size first for better QR detection
      let image = await Jimp.read(filePath);
      const originalWidth = image.bitmap.width;
      const originalHeight = image.bitmap.height;

      // Try scanning original first (best quality)
      let code = this.tryQRScan(image);
      if (code) {
        image = null;
        if (global.gc) global.gc();
        return code;
      }

      // Try with greyscale + contrast (helps with poor lighting)
      image.greyscale().contrast(0.5);
      code = this.tryQRScan(image);
      if (code) {
        image = null;
        if (global.gc) global.gc();
        return code;
      }

      // Try with brightness adjustment
      image.brightness(0.2);
      code = this.tryQRScan(image);
      if (code) {
        image = null;
        if (global.gc) global.gc();
        return code;
      }

      // Try with stronger contrast
      image.contrast(0.5);
      code = this.tryQRScan(image);
      if (code) {
        image = null;
        if (global.gc) global.gc();
        return code;
      }

      // Last resort: resize if image is very large (might be too detailed)
      if (originalWidth > 2000 || originalHeight > 2000) {
        image = await Jimp.read(filePath); // Reload fresh
        const maxDimension = 1200;
        if (image.bitmap.width > image.bitmap.height) {
          image.resize(maxDimension, Jimp.AUTO);
        } else {
          image.resize(Jimp.AUTO, maxDimension);
        }
        image.greyscale().contrast(0.3);
        code = this.tryQRScan(image);
      }

      // Free memory
      image = null;
      if (global.gc) global.gc();

      return code;
    } catch (error) {
      console.log(`QR scan error: ${error.message}`);
      if (global.gc) global.gc();
      return null;
    }
  }

  /**
   * Try to scan QR code from processed image using multiple libraries
   */
  tryQRScan(image) {
    const { data, width, height } = image.bitmap;

    // Try jsQR first (fast)
    const code = jsQR(new Uint8ClampedArray(data), width, height);
    if (code && code.data) {
      return code.data;
    }

    // Try ZXing as fallback (more robust)
    try {
      const { BrowserQRCodeReader, BinaryBitmap, HybridBinarizer, RGBLuminanceSource } = require('@zxing/library');

      // Convert Jimp image to luminance data for ZXing
      const luminanceSource = new RGBLuminanceSource(
        new Uint8ClampedArray(data),
        width,
        height
      );
      const binaryBitmap = new HybridBinarizer(luminanceSource);
      const reader = new BrowserQRCodeReader();

      const result = reader.decode(binaryBitmap);
      if (result && result.getText()) {
        return result.getText();
      }
    } catch (zxingError) {
      // ZXing failed, continue
    }

    return null;
  }

  /**
   * Parse Portuguese ATCUD QR code data
   */
  parseQRCodeData(qrData) {
    const invoiceData = {
      totalValue: null,
      currency: 'EUR',
      invoiceNumber: null,
      invoiceDate: null,
      supplierName: null,
      customerNIF: null
    };

    // Portuguese ATCUD QR format example:
    // A:123456789*B:FT 2025/123*C:PT*D:FT*E:N*F:20250101*G:FT 2025/123*H:0*I1:PT*I2:12345678*I3:55.20*I4:11.00*...

    const fields = qrData.split('*');

    fields.forEach(field => {
      const [key, value] = field.split(':');

      if (!key || !value) return;

      switch (key.trim()) {
        case 'G': // Invoice number (FT 0E06021225/2249)
          if (value) {
            invoiceData.invoiceNumber = value.trim();
          }
          break;

        case 'A': // Customer NIF - maps to text_mkwbb9
          if (value) {
            invoiceData.customerNIF = value.trim();
          }
          break;

        case 'O': // Total paid (base + tax)
          const totalO = parseFloat(value.replace(',', '.'));
          if (!isNaN(totalO) && totalO > 0) {
            invoiceData.totalValue = totalO;
          }
          break;

        case 'F': // Date (YYYYMMDD format)
          if (value && value.length === 8) {
            const year = value.substring(0, 4);
            const month = value.substring(4, 6);
            const day = value.substring(6, 8);
            invoiceData.invoiceDate = `${year}-${month}-${day}`;
          }
          break;

        case 'B': // Supplier NIF (not used currently)
        case 'I7': // Base value before tax
        case 'I8': // Tax amount (IVA)
          // Skip these fields - we use 'O' for total
          break;
      }
    });

    // If QR doesn't follow ATCUD standard, try simple parsing
    if (!invoiceData.totalValue && !invoiceData.invoiceNumber) {
      // Try to extract invoice number pattern
      const invoiceMatch = qrData.match(/(FT[A]?|FR|FA)\s+([A-Z0-9\/\-]+)/i);
      if (invoiceMatch) {
        invoiceData.invoiceNumber = `${invoiceMatch[1]} ${invoiceMatch[2]}`.trim();
      }

      // Try to extract total value
      const totalMatch = qrData.match(/(\d+[.,]\d{2})/);
      if (totalMatch) {
        const total = parseFloat(totalMatch[1].replace(',', '.'));
        if (!isNaN(total)) {
          invoiceData.totalValue = total;
        }
      }
    }

    return invoiceData;
  }
}

module.exports = new FileController();
